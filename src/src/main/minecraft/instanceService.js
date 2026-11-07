'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { nativeImage } = require('electron');
const { SerialQueue } = require('../core/serialQueue');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { createGameLayout } = require('./gameLayout');
const { isComplete } = require('./installedVersions');
const { ensureVersionInstalled } = require('./versionService');
const { getRequiredJavaMajor } = require('./gameLauncher');
const { installLoader, predictableVersionId } = require('./loaderInstaller');
const { pickLoaderVersion, LOADER_LABELS } = require('./loaderMeta');
const { resolveJavaForLaunch } = require('../java/javaService');
const store = require('./instanceStore');

/** Loader installs share the libraries folder: one at a time. */
const loaderQueue = new SerialQueue();
const pending = new Map();
const log = createLogger('instance-service');

function layoutFor(settings) {
  return createGameLayout(settings.gameDirectory);
}

const CUSTOM_ICON = 'custom';
const CUSTOM_ICON_SIZE = 128;
const MAX_ICON_SOURCE_BYTES = 8 * 1024 * 1024;

function customIconPath(layout, id) {
  return path.join(layout.instanceDirectory(id), '.amethyx', 'icon.png');
}

/** An instance's own picture becomes a data: URL for the window; the file stays in the instance. */
async function withIcon(layout, instance) {
  if (instance.icon !== CUSTOM_ICON) {
    return instance;
  }
  try {
    const png = await fsp.readFile(customIconPath(layout, instance.id));
    return { ...instance, icon: `data:image/png;base64,${png.toString('base64')}` };
  } catch {
    return { ...instance, icon: 'block:grass_block' };
  }
}

/** Instances with their install state, for the UI. */
async function listInstances(settings) {
  const layout = layoutFor(settings);
  const instances = await store.listInstances(layout);
  return Promise.all(
    instances.map(async (instance) => ({
      ...(await withIcon(layout, instance)),
      installed: Boolean(instance.versionId && (await isComplete(layout, instance.versionId))),
      installing: pending.has(instance.id),
      directory: layout.instanceDirectory(instance.id),
      // Still being copied now, or a copy that broke off (the launcher closed in the middle).
      copying: Boolean(instance.copying && copies.has(instance.id)),
      copyFailed: Boolean(instance.copying && !copies.has(instance.id)),
    })),
  );
}

async function getInstance(settings, id) {
  const layout = layoutFor(settings);
  const instance = await store.getInstance(layout, id);
  return { ...instance, directory: layout.instanceDirectory(id) };
}

/**
 * Uses a picture from disk (PNG, JPG, WebP, GIF…) as the instance icon: centred, cropped to a
 * square and scaled to 128 px, stored in the instance folder.
 */
async function setCustomIcon(settings, id, filePath) {
  const layout = layoutFor(settings);
  await store.getInstance(layout, id);
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_ICON_SOURCE_BYTES) {
    throw new Error('Картинка слишком большая (больше 8 МБ).');
  }
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    throw new Error('Не удалось прочитать картинку. Подойдут PNG, JPG и WebP.');
  }
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  // Pixel art stays sharp when scaled up; photos get a smooth resize.
  const scaled = square.resize({ width: CUSTOM_ICON_SIZE, height: CUSTOM_ICON_SIZE, quality: side < CUSTOM_ICON_SIZE ? 'good' : 'best' });
  const target = customIconPath(layout, id);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, scaled.toPNG());
  return store.updateInstance(layout, id, { icon: CUSTOM_ICON });
}

function validateFields(fields) {
  if (!fields?.minecraft || typeof fields.minecraft !== 'string') {
    throw new Error('Выберите версию Minecraft.');
  }
  if (fields.loader && !store.LOADERS.includes(fields.loader.type)) {
    throw new Error('Неизвестный загрузчик модов.');
  }
}

async function createInstance(settings, fields) {
  validateFields(fields);
  const loader = fields.loader?.type && fields.loader.type !== 'vanilla' ? fields.loader : { type: 'vanilla', version: null };
  const layout = layoutFor(settings);
  // Modpack import writes files straight into the new instance: it needs the folder too.
  const instance = await store.createInstance(layout, {
    name: fields.name,
    group: fields.group,
    icon: fields.icon,
    minecraft: fields.minecraft,
    loader,
    versionId: loader.type === 'vanilla' ? fields.minecraft : null,
    source: fields.source ?? null,
  });
  return { ...instance, directory: layout.instanceDirectory(instance.id) };
}

function updateInstance(settings, id, patch) {
  const allowed = {};
  for (const key of ['name', 'group', 'icon', 'notes', 'minecraft', 'loader', 'overrides', 'lastPlayedAt', 'playTimeMs', 'versionId', 'source']) {
    if (patch?.[key] !== undefined) {
      allowed[key] = patch[key];
    }
  }
  if (allowed.loader && !store.LOADERS.includes(allowed.loader.type)) {
    throw new Error('Неизвестный загрузчик модов.');
  }
  return store.updateInstance(layoutFor(settings), id, allowed);
}

function deleteInstance(settings, id) {
  if (pending.has(id)) {
    throw new Error('Дождитесь окончания установки сборки.');
  }
  if (copies.has(id)) {
    throw new Error('Дождитесь окончания копирования сборки.');
  }
  return store.deleteInstance(layoutFor(settings), id);
}

/** Copies being made now, by the new instance's id. */
const copies = new Set();
/** Files copied at the same time. */
const COPY_WORKERS = 8;
/** Never copied: the folder's own description (written anew), natives, the launcher's leftovers. */
const COPY_SKIPPED = new Set(['instance.json', 'natives', '.amethyx/backups', '.amethyx/last-run.log']);
const cleanRelative = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/**
 * The files to copy: [{ from, to, size }]. `paths` are the ticked files and folders (relative, "/"),
 * a folder meaning all of it; null means everything. The launcher's own data of the instance (its
 * picture, what it knows of the mods) always goes along.
 */
async function filesToCopy(sourceDir, targetDir, paths) {
  const chosen = paths ? [...new Set(paths.map(cleanRelative))].filter((rel) => rel && !rel.split('/').includes('..')) : null;
  const wanted = (rel) => !chosen || rel.startsWith('.amethyx') || chosen.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
  const onTheWay = (rel) => !chosen || rel === '.amethyx' || chosen.some((entry) => entry.startsWith(`${rel}/`));
  const files = [];
  const folders = [];
  const walk = async (rel) => {
    const entries = await fsp.readdir(path.join(sourceDir, rel), { withFileTypes: true }).catch(() => []);
    const here = [];
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (COPY_SKIPPED.has(child) || /^\.amethyx\/map-/.test(child)) continue;
      if (entry.isDirectory()) {
        if (wanted(child)) folders.push(path.join(targetDir, child));
        if (wanted(child) || onTheWay(child)) await walk(child);
      } else if (entry.isFile() && wanted(child)) {
        here.push(child);
      }
    }
    // The sizes of a folder's files all at once (a world folder holds thousands of them).
    const stats = await Promise.all(here.map((child) => fsp.stat(path.join(sourceDir, child)).catch(() => null)));
    here.forEach((child, index) => {
      if (stats[index]) files.push({ from: path.join(sourceDir, child), to: path.join(targetDir, child), size: stats[index].size, rel: child });
    });
  };
  await walk('');
  return { files, folders };
}

/**
 * "Копировать сборку", as Prism Launcher: the copy appears at once (marked `copying`, the list shows it
 * busy and it cannot be played), its files are copied in the background with progress in the top bar
 * (task `instance:<new id>`), then the mark goes. Resolves with the new instance right away;
 * `onDone()` runs when the files are in (or the copying failed).
 * options: { name, group, playTime, paths } (instanceStore.beginCopy, filesToCopy).
 */
async function copyInstance(settings, id, options = {}, { onDone = () => {} } = {}) {
  const layout = layoutFor(settings);
  const { source, copy } = await store.beginCopy(layout, id, options);
  copies.add(copy.id);
  // The top bar shows the copy's name and "Копирование" (one word, so it is translated).
  const reporter = createTaskReporter({ taskId: `instance:${copy.id}`, kind: 'instance', label: 'Копирование', instance: copy.name });
  reporter.report('Копирование', 0);
  (async () => {
    try {
      const { files, folders } = await filesToCopy(layout.instanceDirectory(id), layout.instanceDirectory(copy.id), Array.isArray(options.paths) ? options.paths : null);
      const made = new Set();
      const ensureFolder = async (folder) => {
        if (made.has(folder)) return;
        await fsp.mkdir(folder, { recursive: true });
        made.add(folder);
      };
      for (const folder of folders) await ensureFolder(folder);
      const total = files.reduce((sum, file) => sum + file.size, 0) || 1;
      let done = 0;
      let next = 0;
      let failed = false;
      // Several files at once: a world is thousands of small region files, and one by one the copy
      // mostly waited for the disk to answer each (12 000 small files took 23 s).
      const worker = async () => {
        while (!failed && next < files.length) {
          const file = files[next++];
          try {
            await ensureFolder(path.dirname(file.to));
            await fsp.copyFile(file.from, file.to);
          } catch (error) {
            // A world open in the game keeps its lock file busy; the game makes a new one anyway.
            if (path.basename(file.from) !== 'session.lock') {
              failed = true;
              throw error;
            }
          }
          done += file.size;
          reporter.report('Копирование', (done / total) * 99, file.rel);
        }
      };
      await Promise.all(Array.from({ length: Math.min(COPY_WORKERS, files.length) }, worker));
      await store.finishCopy(layout, copy.id);
      reporter.finish('done', `${files.length}`);
      log.info(`Сборка «${source.name}» скопирована в «${copy.name}»: ${files.length} файлов`);
    } catch (error) {
      reporter.finish('error', error.message);
      log.warn(`Копия сборки «${copy.name}» не доделана: ${error.message}`);
    } finally {
      copies.delete(copy.id);
      onDone(copy.id);
    }
  })();
  return { ...copy, directory: layout.instanceDirectory(copy.id) };
}

/**
 * Makes an instance launchable: installs its Minecraft version and mod loader when needed.
 * Returns the instance with `versionId` set. Concurrent calls for one instance share the work.
 */
function ensureInstanceReady(settings, id) {
  const existing = pending.get(id);
  if (existing) {
    return existing;
  }
  const work = (async () => {
    const layout = layoutFor(settings);
    let instance = await store.getInstance(layout, id);
    if (instance.copying) {
      throw new Error(copies.has(id) ? 'Сборка ещё копируется: подождите, пока копирование закончится.' : 'Копирование этой сборки не закончилось. Удалите её и скопируйте заново.');
    }
    // An instance with a loader but the plain Minecraft version id was switched from vanilla by an
    // older launcher that kept the old id: it still needs its loader installed.
    const staleVanillaId = instance.loader.type !== 'vanilla' && instance.versionId === instance.minecraft;
    if (instance.versionId && !staleVanillaId && (await isComplete(layout, instance.versionId))) {
      return instance;
    }
    await ensureVersionInstalled(instance.minecraft, settings);
    if (instance.loader.type === 'vanilla') {
      return store.updateInstance(layout, id, { versionId: instance.minecraft });
    }

    const loaderVersion = instance.loader.version ?? (await pickLoaderVersion(instance.loader.type, instance.minecraft));
    const predicted = predictableVersionId(instance.loader.type, instance.minecraft, loaderVersion);
    if (predicted && (await isComplete(layout, predicted))) {
      return store.updateInstance(layout, id, { loader: { type: instance.loader.type, version: loaderVersion }, versionId: predicted });
    }

    const label = `${LOADER_LABELS[instance.loader.type]} ${loaderVersion}`;
    const reporter = createTaskReporter({ taskId: `instance:${id}`, kind: 'instance', label: instance.name });
    try {
      const versionId = await loaderQueue.run(async () => {
        reporter.report(label, 1, 'подготовка');
        const needsJava = instance.loader.type === 'forge' || instance.loader.type === 'neoforge';
        const java = needsJava ? await resolveJavaForLaunch(await getRequiredJavaMajor(layout, instance.minecraft), settings) : null;
        return installLoader({
          type: instance.loader.type,
          minecraft: instance.minecraft,
          loaderVersion,
          layout,
          java,
          onProgress: (fraction, stage) => reporter.report(stage ? `${label}: ${stage}` : label, 2 + fraction * 97),
        });
      });
      instance = await store.updateInstance(layout, id, { loader: { type: instance.loader.type, version: loaderVersion }, versionId });
      reporter.finish('done', 'Загрузчик установлен');
      log.info(`${label} установлен для «${instance.name}» (${versionId})`);
      return instance;
    } catch (error) {
      reporter.finish('error', error.message);
      throw error;
    }
  })();
  pending.set(id, work);
  work.finally(() => pending.delete(id)).catch(() => {});
  return work;
}

/**
 * "Repair": forgets that the instance's Minecraft and loader are installed, then installs them
 * again. Files that are intact are kept (the installer checks them), broken or missing ones are
 * downloaded anew. Mods, worlds and settings in the instance folder are not touched.
 */
async function repairInstance(settings, id) {
  const layout = layoutFor(settings);
  const instance = await store.getInstance(layout, id);
  for (const versionId of new Set([instance.versionId, instance.minecraft].filter(Boolean))) {
    await fsp.rm(layout.completeMarkerPath(versionId), { force: true });
  }
  return ensureInstanceReady(settings, id);
}

/** Global settings with the instance's overrides applied. */
function effectiveSettings(settings, instance) {
  const overrides = instance.overrides ?? {};
  const result = { ...settings };
  if (Number.isFinite(overrides.ramMb)) {
    result.ramMb = overrides.ramMb;
  }
  if (typeof overrides.extraJvmArgs === 'string') {
    result.extraJvmArgs = overrides.extraJvmArgs;
  }
  if (typeof overrides.javaPath === 'string' && overrides.javaPath.trim()) {
    result.javaMode = 'custom';
    result.javaPath = overrides.javaPath.trim();
  }
  return result;
}

/** Window size, server and extra arguments for a launch: instance values win over global ones. */
function launchOptions(settings, instance) {
  const overrides = instance.overrides ?? {};
  return {
    width: overrides.gameWidth ?? settings.gameWidth,
    height: overrides.gameHeight ?? settings.gameHeight,
    fullscreen: overrides.fullscreen ?? settings.fullscreen,
    joinServer: overrides.joinServer ?? '',
    extraGameArgs: overrides.extraGameArgs ?? '',
  };
}

function isInstancePending(id) {
  return pending.has(id);
}

module.exports = {
  listInstances,
  getInstance,
  createInstance,
  updateInstance,
  deleteInstance,
  copyInstance,
  repairInstance,
  ensureInstanceReady,
  setCustomIcon,
  effectiveSettings,
  launchOptions,
  isInstancePending,
  layoutFor,
};
