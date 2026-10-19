'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { downloadFile } = require('../core/fileDownloader');
const { runWithConcurrency } = require('../core/taskPool');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const { updateIndex, entryKey, FOLDERS } = require('./contentService');
const instanceService = require('../minecraft/instanceService');

/*
 * Modpacks: Modrinth (.mrpack) and CurseForge (.zip with manifest.json), from the sites or from a
 * file. A pack becomes a new instance: its Minecraft version and loader, its files and its
 * "overrides" folder (configs, resource packs, options) copied over.
 */

// Mod files are small: many at once is what makes a big pack install fast (Modrinth and
// CurseForge's CDNs take it easily).
const DOWNLOAD_CONCURRENCY = 12;

/**
 * Files already downloaded once (for any instance) are kept by SHA-1 in <game folder>/cache/content
 * as hard links: a second pack with the same mods, or the same pack again, takes them from the disk
 * instantly. Hard links cost no extra space while the instance has the file; a copy is the fallback.
 */
function cachePath(settings, sha1) {
  return path.join(settings.gameDirectory, 'cache', 'content', sha1.slice(0, 2), sha1);
}

async function linkOrCopy(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rm(to, { force: true });
  try {
    await fsp.link(from, to);
  } catch {
    await fsp.copyFile(from, to);
  }
}

async function fetchFile(settings, url, target, { sha1, size }) {
  const hash = typeof sha1 === 'string' && /^[0-9a-f]{40}$/i.test(sha1) ? sha1.toLowerCase() : null;
  if (hash) {
    const cached = cachePath(settings, hash);
    const stat = await fsp.stat(cached).catch(() => null);
    if (stat && (!size || stat.size === size)) {
      await linkOrCopy(cached, target);
      return;
    }
  }
  await downloadFile(url, target, { sha1: sha1 ?? undefined, size });
  if (hash) await linkOrCopy(target, cachePath(settings, hash)).catch(() => {});
}
const log = createLogger('modpacks');

/** Joins a path from a pack file to the instance folder, refusing anything that escapes it. */
function safeJoin(root, relative) {
  const target = path.resolve(root, ...String(relative).split(/[\\/]+/).filter(Boolean));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Модпак содержит недопустимый путь: ${relative}`);
  }
  return target;
}

/** Loader of a pack: { type, version } in the form loaderInstaller expects. */
function loaderFromMrpack(dependencies) {
  const minecraft = dependencies.minecraft;
  if (dependencies['fabric-loader']) return { type: 'fabric', version: dependencies['fabric-loader'] };
  if (dependencies['quilt-loader']) return { type: 'quilt', version: dependencies['quilt-loader'] };
  if (dependencies.neoforge) {
    return { type: 'neoforge', version: minecraft === '1.20.1' ? `1.20.1-${dependencies.neoforge}` : dependencies.neoforge };
  }
  if (dependencies.forge) return { type: 'forge', version: `${minecraft}-${dependencies.forge}` };
  return { type: 'vanilla', version: null };
}

function loaderFromCurseForge(minecraft, modLoaders) {
  const primary = modLoaders?.find((loader) => loader.primary) ?? modLoaders?.[0];
  if (!primary?.id) {
    return { type: 'vanilla', version: null };
  }
  const [name, ...rest] = primary.id.split('-');
  const version = rest.join('-');
  switch (name) {
    case 'fabric':
      return { type: 'fabric', version };
    case 'quilt':
      return { type: 'quilt', version };
    case 'neoforge':
      return { type: 'neoforge', version: minecraft === '1.20.1' ? `1.20.1-${version}` : version };
    case 'forge':
      return { type: 'forge', version: `${minecraft}-${version}` };
    default:
      throw new Error(`Загрузчик ${primary.id} не поддерживается.`);
  }
}

async function extractOverrides(zip, prefixes, directory) {
  let count = 0;
  for (const entry of zip.getEntries()) {
    const prefix = prefixes.find((candidate) => entry.entryName.startsWith(`${candidate}/`));
    if (!prefix || entry.isDirectory) {
      continue;
    }
    const target = safeJoin(directory, entry.entryName.slice(prefix.length + 1));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, entry.getData());
    count += 1;
  }
  return count;
}

async function importMrpack({ settings, zip, fields, reporter, created }) {
  const index = JSON.parse(zip.readAsText('modrinth.index.json'));
  const minecraft = index.dependencies?.minecraft;
  if (!minecraft) {
    throw new Error('В модпаке не указана версия Minecraft.');
  }
  const instance = await instanceService.createInstance(settings, {
    name: fields.name || index.name,
    group: fields.group,
    icon: fields.icon,
    minecraft,
    loader: loaderFromMrpack(index.dependencies),
    source: fields.source ?? { platform: 'modrinth', name: index.name, versionNumber: index.versionId },
  });
  created.instance = instance;
  const files = (index.files ?? []).filter((file) => file.env?.client !== 'unsupported');
  let done = 0;
  await runWithConcurrency(files, DOWNLOAD_CONCURRENCY, async (file) => {
    const target = safeJoin(instance.directory, file.path);
    await fetchFile(settings, file.downloads[0], target, { sha1: file.hashes?.sha1, size: file.fileSize });
    done += 1;
    reporter.report('Файлы модпака', 10 + (done / Math.max(1, files.length)) * 80, `${done}/${files.length}`);
  });
  reporter.report('Настройки модпака', 92, 'overrides');
  await extractOverrides(zip, ['overrides', 'client-overrides'], instance.directory);
  return instance;
}

async function importCurseForge({ settings, zip, fields, reporter, created }) {
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  const minecraft = manifest.minecraft?.version;
  if (!minecraft) {
    throw new Error('В модпаке CurseForge не указана версия Minecraft.');
  }
  const apiKey = curseforge.apiKey(settings);
  if (!apiKey) {
    throw new curseforge.MissingCurseForgeKey();
  }
  const instance = await instanceService.createInstance(settings, {
    name: fields.name || manifest.name,
    group: fields.group,
    icon: fields.icon,
    minecraft,
    loader: loaderFromCurseForge(minecraft, manifest.minecraft.modLoaders),
    source: fields.source ?? { platform: 'curseforge', name: manifest.name, versionNumber: manifest.version },
  });
  created.instance = instance;

  const wanted = (manifest.files ?? []).filter((file) => file.required !== false);
  reporter.report('Список файлов', 8, `${wanted.length} файлов`);
  const [files, mods] = await Promise.all([
    curseforge.getFiles(apiKey, wanted.map((file) => file.fileID)),
    curseforge.getMods(apiKey, [...new Set(wanted.map((file) => file.projectID))]),
  ]);
  const modsById = new Map(mods.map((mod) => [mod.id, mod]));
  const failed = [];
  const indexed = {};
  let done = 0;
  await runWithConcurrency(files, DOWNLOAD_CONCURRENCY, async (file) => {
    const mod = modsById.get(file.modId);
    const type = curseforge.TYPE_BY_CLASS[mod?.classId] ?? 'mod';
    const folder = FOLDERS[type] ?? 'mods';
    const version = curseforge.toVersion(file);
    try {
      const target = safeJoin(instance.directory, `${folder}/${file.fileName}`);
      await fetchFile(settings, version.files[0].url, target, { sha1: version.files[0].sha1 ?? undefined, size: file.fileLength });
      // Written to the index once at the end, not after every file.
      indexed[entryKey(type === 'modpack' ? 'mod' : type, file.fileName)] = {
        platform: 'curseforge',
        projectId: String(file.modId),
        versionId: String(file.id),
        versionNumber: file.displayName,
        title: mod?.name ?? file.displayName,
        iconUrl: mod?.logo?.thumbnailUrl ?? null,
        installedAt: new Date().toISOString(),
      };
    } catch (error) {
      failed.push(mod?.name ?? file.fileName);
      log.warn(`Файл ${file.fileName} не скачан: ${error.message}`);
    }
    done += 1;
    reporter.report('Файлы модпака', 10 + (done / Math.max(1, files.length)) * 80, `${done}/${files.length}`);
  });
  await updateIndex(instance.directory, (entries) => Object.assign(entries, indexed));
  reporter.report('Настройки модпака', 92, 'overrides');
  await extractOverrides(zip, [manifest.overrides || 'overrides'], instance.directory);
  return { ...instance, failed };
}

/** mmc-pack.json of a Prism Launcher / MultiMC instance zip, possibly inside one top folder. */
function findPrismPack(zip) {
  return zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && /(^|\/)mmc-pack\.json$/.test(entry.entryName) && entry.entryName.split('/').length <= 2)
    .sort((a, b) => a.entryName.length - b.entryName.length)[0];
}

/** An instance zip of Prism Launcher, MultiMC or Vanilla+ («Обычный .zip»): the game folder copied as is. */
async function importInstanceZip({ settings, zip, fields, reporter, created }) {
  const packEntry = findPrismPack(zip);
  const root = packEntry.entryName.slice(0, -'mmc-pack.json'.length);
  const components = new Map((JSON.parse(zip.readAsText(packEntry)).components ?? []).map((component) => [component.uid, component.version]));
  const minecraft = components.get('net.minecraft');
  if (!minecraft) {
    throw new Error('В архиве сборки не указана версия Minecraft.');
  }
  let loader = { type: 'vanilla', version: null };
  if (components.get('net.fabricmc.fabric-loader')) loader = { type: 'fabric', version: components.get('net.fabricmc.fabric-loader') };
  else if (components.get('org.quiltmc.quilt-loader')) loader = { type: 'quilt', version: components.get('org.quiltmc.quilt-loader') };
  else if (components.get('net.neoforged')) loader = { type: 'neoforge', version: minecraft === '1.20.1' ? `1.20.1-${components.get('net.neoforged')}` : components.get('net.neoforged') };
  else if (components.get('net.minecraftforge')) loader = { type: 'forge', version: `${minecraft}-${components.get('net.minecraftforge')}` };
  const cfgEntry = zip.getEntry(`${root}instance.cfg`);
  const cfgName = cfgEntry ? /^name=(.*)$/m.exec(zip.readAsText(cfgEntry))?.[1]?.trim() : null;
  const instance = await instanceService.createInstance(settings, {
    name: fields.name || cfgName || 'Сборка из архива',
    group: fields.group,
    icon: fields.icon,
    minecraft,
    loader,
  });
  created.instance = instance;
  reporter.report('Файлы сборки', 40, 'распаковка');
  const hasDotFolder = zip.getEntries().some((entry) => entry.entryName.startsWith(`${root}.minecraft/`));
  const count = await extractOverrides(zip, [`${root}${hasDotFolder ? '.minecraft' : 'minecraft'}`], instance.directory);
  log.info(`Сборка «${instance.name}» из архива: ${count} файлов`);
  return instance;
}

/** Creates an instance from a pack file on disk. */
async function importPackFile(settings, filePath, fields = {}, reporter = null) {
  const ownReporter = reporter ?? createTaskReporter({ taskId: `modpack:${crypto.randomBytes(4).toString('hex')}`, kind: 'modpack', label: fields.name || path.basename(filePath) });
  // The instance is made before the pack's files arrive: a failed import removes it again,
  // so no empty half-installed instance is left behind.
  const created = { instance: null };
  try {
    ownReporter.report('Чтение модпака', 5, path.basename(filePath));
    const zip = new AdmZip(filePath);
    let instance;
    if (zip.getEntry('modrinth.index.json')) {
      instance = await importMrpack({ settings, zip, fields, reporter: ownReporter, created });
    } else if (zip.getEntry('manifest.json')) {
      instance = await importCurseForge({ settings, zip, fields, reporter: ownReporter, created });
    } else if (findPrismPack(zip)) {
      instance = await importInstanceZip({ settings, zip, fields, reporter: ownReporter, created });
    } else {
      throw new Error('Это не сборка: лаунчер открывает .mrpack (Modrinth), .zip CurseForge и архивы сборок Prism Launcher и Vanilla+.');
    }
    ownReporter.report('Установка Minecraft и загрузчика', 95, instance.minecraft);
    try {
      await instanceService.ensureInstanceReady(settings, instance.id);
    } catch (error) {
      // The pack itself is in place; the game can still be installed on the first launch.
      log.warn(`Сборка «${instance.name}» создана, но игра не установлена: ${error.message}`);
    }
    ownReporter.finish('done', instance.name);
    return instance;
  } catch (error) {
    if (created.instance) {
      await Promise.resolve()
        .then(() => instanceService.deleteInstance(settings, created.instance.id))
        .then(() => log.info(`Недоустановленная сборка «${created.instance.name}» удалена`))
        .catch((cleanupError) => log.warn(`Не удалось убрать недоустановленную сборку: ${cleanupError.message}`));
    }
    ownReporter.finish('error', error.message);
    throw error;
  }
}

/** Installs a modpack from Modrinth or CurseForge as a new instance. */
async function installModpack(settings, { platform, projectId, versionId, name, group, title, iconUrl }) {
  const reporter = createTaskReporter({ taskId: `modpack:${platform}:${projectId}`, kind: 'modpack', label: title ?? name ?? projectId });
  const workDirectory = path.join(getAppPaths().tempDirectory, `modpack-${crypto.randomBytes(4).toString('hex')}`);
  try {
    reporter.report('Поиск версии', 2, '');
    let version;
    if (platform === 'curseforge') {
      const key = curseforge.apiKey(settings);
      version = versionId ? await curseforge.getVersion(key, projectId, versionId) : (await curseforge.getVersions(key, projectId))[0];
    } else {
      version = versionId ? await modrinth.getVersion(versionId) : (await modrinth.getVersions(projectId)).find((candidate) => candidate.type === 'release');
    }
    if (!version) {
      throw new Error('У модпака нет доступных версий.');
    }
    const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
    const packPath = path.join(workDirectory, path.basename(file.filename));
    await downloadFile(file.url, packPath, {
      sha1: file.sha1 ?? undefined,
      size: file.size,
      onProgress: (received, total) => total && reporter.report('Загрузка модпака', 2 + (received / total) * 6, file.filename),
    });
    return await importPackFile(
      settings,
      packPath,
      {
        name: name || title,
        group,
        icon: iconUrl ?? undefined,
        source: { platform, projectId, versionId: version.id, versionNumber: version.versionNumber, name: title ?? null, iconUrl: iconUrl ?? null },
      },
      reporter,
    );
  } catch (error) {
    reporter.finish('error', error.message);
    throw error;
  } finally {
    await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { importPackFile, installModpack };
