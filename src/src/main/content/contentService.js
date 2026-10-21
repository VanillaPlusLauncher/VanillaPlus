'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { downloadFile } = require('../core/fileDownloader');
const { sha1File } = require('../core/hashing');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { SerialQueue } = require('../core/serialQueue');
const { runWithConcurrency } = require('../core/taskPool');
const { parallelDownloads } = require('../core/downloadConfig');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { readContentMetadata } = require('./modMetadata');
const { fingerprintFile } = require('./curseFingerprint');
const modrinth = require('./modrinth');
const curseforge = require('./curseforge');
const instanceService = require('../minecraft/instanceService');

/*
 * Mods, resource packs and shaders of an instance, from Modrinth and CurseForge.
 * What the launcher installed is remembered in <instance>/.amethyx/content.json
 * (site, project, version), which makes updates and dependency checks possible.
 */

const CONTENT_TYPES = ['mod', 'resourcepack', 'shader'];
const FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const FILE_PATTERNS = { mod: /\.(jar|zip|litemod)(\.disabled)?$/i, resourcepack: /\.zip(\.disabled)?$/i, shader: /\.zip(\.disabled)?$/i };
const DISABLED_SUFFIX = '.disabled';
const MAX_DEPENDENCY_DEPTH = 6;
/** Index writes of one instance must not overlap. */
const indexQueue = new SerialQueue();
const log = createLogger('content');

function assertType(type) {
  if (!CONTENT_TYPES.includes(type)) {
    throw new Error('Неизвестный тип содержимого.');
  }
  return type;
}

function assertFileName(file) {
  const name = String(file ?? '');
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Некорректное имя файла.');
  }
  return name;
}

function indexPath(directory) {
  return path.join(directory, '.amethyx', 'content.json');
}

async function readIndex(directory) {
  const index = await readJsonFile(indexPath(directory), null);
  return index && typeof index.entries === 'object' ? index : { entries: {} };
}

function updateIndex(directory, change) {
  return indexQueue.run(async () => {
    const index = await readIndex(directory);
    change(index.entries);
    await writeJsonFileAtomic(indexPath(directory), index);
    return index;
  });
}

/** Index key of a file: "<folder>/<name without .disabled>". */
function entryKey(type, fileName) {
  return `${FOLDERS[type]}/${fileName.replace(/\.disabled$/i, '')}`;
}

// --- Searching ------------------------------------------------------------------

function platformApi(settings, platform) {
  if (platform === 'curseforge') {
    const key = curseforge.apiKey(settings);
    return {
      search: (params) => curseforge.search(key, params),
      getProject: (id) => curseforge.getProject(key, id),
      getVersions: (id, filters) => curseforge.getVersions(key, id, filters),
      getVersion: (projectId, versionId) => curseforge.getVersion(key, projectId, versionId),
    };
  }
  return {
    search: (params) => modrinth.search(params),
    getProject: (id) => modrinth.getProject(id),
    getVersions: (id, filters) => modrinth.getVersions(id, filters),
    getVersion: (_projectId, versionId) => modrinth.getVersion(versionId),
  };
}

function search(settings, params) {
  const limit = Math.min(Math.max(Number(params?.limit) || 20, 1), 50);
  const offset = Math.max(Number(params?.offset) || 0, 0);
  return platformApi(settings, params?.platform).search({ ...params, limit, offset, query: String(params?.query ?? '').slice(0, 200) });
}

function getProject(settings, platform, id) {
  return platformApi(settings, platform).getProject(id);
}

function getVersions(settings, platform, id, filters) {
  return platformApi(settings, platform).getVersions(id, filters ?? {});
}

/** Icons found for projects that have none of their own (name → URL or null), for this run. */
const iconCache = new Map();
const normalName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');

/**
 * An icon for a project that has none where it came from (BadOptimizations has no icon on
 * Modrinth, but one on CurseForge): looked up by name on CurseForge, then on Modrinth, and only a
 * project with the same name or slug counts. Resolves with a URL or null.
 */
async function findIcon(settings, query = {}) {
  const key = `${query.type ?? 'mod'}:${normalName(query.slug || query.title)}`;
  if (key.endsWith(':')) return null;
  // The same name asked twice at once waits for one answer; three look-ups at a time at most
  // (a list of 200 mods without pictures must not flood the sites).
  if (!iconCache.has(key)) iconCache.set(key, iconQueue.run(() => lookUpIcon(settings, query)));
  return iconCache.get(key);
}

const iconQueue = (() => {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= 3 || waiting.length === 0) return;
    running += 1;
    const { job, resolve } = waiting.shift();
    job()
      .catch(() => null)
      .then((value) => {
        running -= 1;
        resolve(value);
        next();
      });
  };
  return { run: (job) => new Promise((resolve) => { waiting.push({ job, resolve }); next(); }) };
})();

async function lookUpIcon(settings, { title, slug, type = 'mod' }) {
  const wanted = new Set([normalName(title), normalName(slug)].filter(Boolean));
  let url = null;
  for (const platform of ['curseforge', 'modrinth']) {
    if (platform === 'curseforge' && !curseforge.apiKey(settings)) continue;
    try {
      const { hits } = await platformApi(settings, platform).search({ type, query: title || slug, limit: 8 });
      const same = hits.find((hit) => hit.iconUrl && (wanted.has(normalName(hit.title)) || wanted.has(normalName(hit.slug))));
      if (same) {
        url = same.iconUrl;
        break;
      }
    } catch (error) {
      log.warn(`Иконка «${title || slug}» на ${platform} не найдена: ${error.message}`);
    }
  }
  return url;
}

/** Filters that make a version fit an instance: its Minecraft version and, for mods, its loader. */
function instanceFilters(instance, type) {
  return { gameVersion: instance.minecraft, loader: type === 'mod' || type === 'modpack' ? instance.loader.type : null, type };
}

/**
 * Best version for the instance: newest release, else newest anything. `override` ({ gameVersion,
 * loader }) is what the user picked in the catalog — say Fabric mods for Forge with Sinytra Connector.
 */
async function pickVersion(api, projectId, instance, type, override = null) {
  const filters = instanceFilters(instance, type);
  if (override?.gameVersion) filters.gameVersion = String(override.gameVersion).slice(0, 32);
  if (override?.loader && type === 'mod') filters.loader = String(override.loader).slice(0, 16);
  const versions = await api.getVersions(projectId, filters);
  return versions.find((version) => version.type === 'release') ?? versions[0] ?? null;
}

// --- Installing -------------------------------------------------------------------

async function removeIndexedProject(directory, type, platform, projectId, keepFile) {
  const index = await readIndex(directory);
  for (const [key, entry] of Object.entries(index.entries)) {
    if (entry.platform === platform && entry.projectId === projectId && key.startsWith(`${FOLDERS[type]}/`)) {
      const fileName = key.slice(FOLDERS[type].length + 1);
      if (fileName === keepFile) {
        continue;
      }
      const base = path.join(directory, FOLDERS[type], fileName);
      await fsp.rm(base, { force: true });
      await fsp.rm(`${base}${DISABLED_SUFFIX}`, { force: true });
      await updateIndex(directory, (entries) => delete entries[key]);
    }
  }
}

async function installVersionFiles({ directory, type, version, meta, onProgress, replaceFile }) {
  const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
  if (!file) {
    throw new Error(`У версии ${version.versionNumber} нет файлов для загрузки.`);
  }
  const fileName = assertFileName(file.filename);
  const target = path.join(directory, FOLDERS[type], fileName);
  await downloadFile(file.url, target, { sha1: file.sha1 ?? undefined, size: file.size, onProgress });
  await removeIndexedProject(directory, type, version.platform, version.projectId, fileName);
  if (replaceFile && replaceFile !== fileName) {
    const old = path.join(directory, FOLDERS[type], assertFileName(replaceFile));
    await fsp.rm(old, { force: true });
  }
  await updateIndex(directory, (entries) => {
    entries[entryKey(type, fileName)] = {
      platform: version.platform,
      projectId: version.projectId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      title: meta?.title ?? null,
      iconUrl: meta?.iconUrl ?? null,
      // Modrinth tells it on the project, CurseForge on the file (curseforge.js sidesOfFile).
      clientSide: meta?.clientSide ?? version.clientSide ?? null,
      serverSide: meta?.serverSide ?? version.serverSide ?? null,
      installedAt: new Date().toISOString(),
    };
  });
  return fileName;
}

/**
 * Installs a project into an instance with its required dependencies.
 * `versionId` is optional: without it the newest compatible version is used.
 * Returns { installed: [titles], skipped: [titles] }.
 */
async function installProject(settings, { instanceId, platform, projectId, versionId, type = 'mod', title, iconUrl, replaceFile, filters = null, quiet = false }) {
  assertType(type);
  const instance = await instanceService.getInstance(settings, instanceId);
  const api = platformApi(settings, platform);
  // `quiet`: one of many updates at once — the batch has one task of its own in the top bar.
  const reporter = quiet ? { report() {}, finish() {} } : createTaskReporter({ taskId: `content:${instanceId}:${projectId}`, kind: 'content', label: title ?? projectId, instance: instance.name });
  const installed = [];
  const skipped = [];
  const visited = new Set();

  async function installOne(currentProjectId, currentVersionId, meta, depth) {
    if (visited.has(currentProjectId) || depth > MAX_DEPENDENCY_DEPTH) {
      return;
    }
    visited.add(currentProjectId);
    const version = currentVersionId
      ? await api.getVersion(currentProjectId, currentVersionId)
      : await pickVersion(api, currentProjectId, instance, type, filters);
    if (!version) {
      const loader = filters?.loader ?? instance.loader.type;
      const loaderText = type === 'mod' && loader !== 'vanilla' ? ` и ${loader}` : '';
      if (depth === 0) {
        throw new Error(`Нет версии «${meta?.title ?? currentProjectId}» для Minecraft ${filters?.gameVersion ?? instance.minecraft}${loaderText}.`);
      }
      skipped.push(meta?.title ?? currentProjectId);
      return;
    }
    let projectMeta = meta;
    if (!projectMeta?.title) {
      projectMeta = await api
        .getProject(currentProjectId)
        .then((project) => ({ title: project.title, iconUrl: project.iconUrl, clientSide: project.clientSide ?? null, serverSide: project.serverSide ?? null }))
        .catch(() => ({ title: currentProjectId, iconUrl: null }));
    }
    reporter.report(projectMeta.title, depth === 0 ? 10 : 60, version.versionNumber);
    await installVersionFiles({
      directory: instance.directory,
      type,
      version: { ...version, projectId: version.projectId ?? currentProjectId },
      meta: projectMeta,
      replaceFile: depth === 0 ? replaceFile : null,
      onProgress: (received, total) => total && reporter.report(projectMeta.title, (depth === 0 ? 10 : 60) + (received / total) * 30, version.versionNumber),
    });
    installed.push(projectMeta.title);

    if (type !== 'mod') {
      return;
    }
    const index = await readIndex(instance.directory);
    const present = new Set(Object.values(index.entries).map((entry) => entry.projectId));
    // Required libraries all at once (Zoomify needs three), not one after another.
    const missing = version.dependencies.filter((candidate) => candidate.type === 'required' && candidate.projectId && !present.has(candidate.projectId));
    await runWithConcurrency(missing, parallelDownloads(), (dependency) => installOne(dependency.projectId, platform === 'modrinth' ? dependency.versionId : null, null, depth + 1));
  }

  try {
    await installOne(projectId, versionId ?? null, title ? { title, iconUrl } : null, 0);
    reporter.finish('done', installed.join(', '));
    log.info(`В «${instance.name}» установлено: ${installed.join(', ')}`);
    return { installed, skipped };
  } catch (error) {
    reporter.finish('error', error.message);
    throw error;
  }
}

/**
 * A data pack goes into one world: saves/<world>/datapacks. Data packs on Modrinth are versions
 * with the "datapack" loader (many projects also ship a mod build of the same pack).
 */
async function installDatapack(settings, { instanceId, world, platform, projectId, versionId, gameVersion }) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const worldName = assertFileName(world);
  const worldDirectory = path.join(instance.directory, 'saves', worldName);
  await fsp.access(path.join(worldDirectory, 'level.dat')).catch(() => {
    throw new Error(`Мир «${worldName}» не найден.`);
  });
  const api = platformApi(settings, platform);
  let version = versionId ? await api.getVersion(projectId, versionId) : null;
  if (!version) {
    const versions = await api.getVersions(projectId, { gameVersion: gameVersion || instance.minecraft, loader: platform === 'modrinth' ? 'datapack' : null, type: 'datapack' });
    version = versions.find((candidate) => candidate.type === 'release') ?? versions[0] ?? null;
  }
  if (!version) {
    throw new Error(`Нет версии датапака для Minecraft ${gameVersion || instance.minecraft}.`);
  }
  const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
  if (!file) {
    throw new Error(`У версии ${version.versionNumber} нет файлов для загрузки.`);
  }
  const fileName = assertFileName(file.filename);
  await downloadFile(file.url, path.join(worldDirectory, 'datapacks', fileName), { sha1: file.sha1 ?? undefined, size: file.size });
  log.info(`Датапак ${fileName} установлен в мир «${worldName}» сборки «${instance.name}»`);
  return { file: fileName, world: worldName };
}

// --- Managing installed content ------------------------------------------------------

/**
 * Where a mod is needed: 'client' (only the game: minimaps, shaders, menus), 'server' (only a
 * server), 'both', or null when unknown. Modrinth's project data wins; otherwise the mod's own
 * file (fabric.mod.json "environment", Forge displayTest) is used.
 */
function sideOf(indexed, environment, modId) {
  const client = indexed?.clientSide;
  const server = indexed?.serverSide;
  if (client && server && client !== 'unknown' && server !== 'unknown') {
    if (server === 'unsupported' && client !== 'unsupported') return 'client';
    if (client === 'unsupported' && server !== 'unsupported') return 'server';
    return 'both';
  }
  if (environment) return environment;
  // Nothing else known (a mod from CurseForge or a file): well-known client-only mods by their id.
  return modId && KNOWN_CLIENT_MODS.has(String(modId).toLowerCase()) ? 'client' : null;
}

/** Mod ids of popular mods that only change what the player sees or uses (never needed on a server). */
const KNOWN_CLIENT_MODS = new Set([
  'sodium', 'sodiumextra', 'sodium_extra', 'reeses_sodium_options', 'embeddium', 'rubidium', 'iris', 'oculus', 'indium', 'modmenu',
  'xaerominimap', 'xaerominimapfair', 'xaeroworldmap', 'mousetweaks', 'controlling', 'betterf3', 'entityculling', 'immediatelyfast',
  'lambdynlights', 'dynamiclights', 'continuity', 'zoomify', 'okzoomer', 'dynamic_fps', 'dynamicfps', 'cullleaves', 'notenoughanimations',
  'skinlayers3d', 'fallingleaves', 'presencefootsteps', 'sound_physics_remastered', 'soundphysics', 'ambientsounds', 'chat_heads', 'chatheads',
  'legendarytooltips', 'citresewn', 'customskinloader', 'entity_model_features', 'entity_texture_features', 'fpsreducer', 'betterthirdperson',
  'shouldersurfing', 'firstperson', 'firstpersonmod', 'cameraoverhaul', 'visuality', 'particlerain', 'enhancedblockentities', 'cit_resewn',
  'betterclouds', 'paperdoll', 'blur', 'smoothscroll', 'smoothswapping', 'nochatreports', 'fancymenu', 'drippyloadingscreen', 'loadingscreentips',
  'searchables', 'craftpresence', 'appleskin_client', 'jeresources_client', 'itemphysiclite', 'betterbiomeblend', 'bobby', 'distanthorizons',
  'voxy', 'nvidium', 'moreculling', 'krypton_client', 'yosbr', 'catalogue', 'configured', 'mod_menu', 'inventoryprofilesnext', 'mouse_wheelie',
  'clumps_client', 'farsight', 'iris_flywheel', 'oculusflywheelcompat', 'euphoria_patcher', 'physicsmod', 'resourcepackoverrides',
]);

/** Files of one content type in an instance, with what is known about each. */
async function listContent(settings, instanceId, type) {
  assertType(type);
  const instance = await instanceService.getInstance(settings, instanceId);
  const folder = path.join(instance.directory, FOLDERS[type]);
  let entries = [];
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const index = await readIndex(instance.directory);
  const result = [];
  const wanted = entries.filter((entry) => (entry.isDirectory() && type !== 'mod') || (entry.isFile() && FILE_PATTERNS[type].test(entry.name)));
  // Several files at once: reading them is asynchronous (modMetadata.js), and mostly cached.
  await runWithConcurrency(wanted, 8, async (entry) => {
    const isFolderPack = entry.isDirectory() && type !== 'mod';
    const filePath = path.join(folder, entry.name);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat) return;
    const meta = isFolderPack ? {} : await readContentMetadata(filePath, stat, type);
    const indexed = index.entries[entryKey(type, entry.name)] ?? null;
    result.push({
      file: entry.name,
      enabled: !entry.name.toLowerCase().endsWith(DISABLED_SUFFIX),
      folder: isFolderPack,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      title: indexed?.title ?? meta.name ?? entry.name.replace(/\.(jar|zip)(\.disabled)?$/i, ''),
      version: meta.version ?? indexed?.versionNumber ?? null,
      description: meta.description ?? null,
      authors: meta.authors ?? [],
      icon: indexed?.iconUrl ?? meta.icon ?? null,
      platform: indexed?.platform ?? null,
      projectId: indexed?.projectId ?? null,
      versionId: indexed?.versionId ?? null,
      side: type === 'mod' ? sideOf(indexed, meta.environment, meta.modId) : null,
      modId: meta.modId ?? null,
      incompatible: meta.incompatible ?? [],
    });
  });
  return result.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

async function setEnabled(settings, instanceId, type, file, enabled) {
  assertType(type);
  const instance = await instanceService.getInstance(settings, instanceId);
  const name = assertFileName(file);
  const folder = path.join(instance.directory, FOLDERS[type]);
  const base = name.replace(/\.disabled$/i, '');
  const from = path.join(folder, name);
  const to = path.join(folder, enabled ? base : `${base}${DISABLED_SUFFIX}`);
  if (from !== to) {
    await fsp.rename(from, to);
  }
  return path.basename(to);
}

async function removeContent(settings, instanceId, type, file) {
  assertType(type);
  const instance = await instanceService.getInstance(settings, instanceId);
  const name = assertFileName(file);
  await fsp.rm(path.join(instance.directory, FOLDERS[type], name), { recursive: true, force: true });
  await updateIndex(instance.directory, (entries) => delete entries[entryKey(type, name)]);
}

/** Copies files the user picked (or dropped) into the instance. Returns the copied names. */
async function addLocalFiles(settings, instanceId, type, filePaths) {
  assertType(type);
  const instance = await instanceService.getInstance(settings, instanceId);
  const folder = path.join(instance.directory, FOLDERS[type]);
  await fsp.mkdir(folder, { recursive: true });
  const added = [];
  for (const source of filePaths ?? []) {
    const name = path.basename(String(source));
    if (!FILE_PATTERNS[type].test(name)) {
      continue;
    }
    await fsp.copyFile(source, path.join(folder, name));
    added.push(name);
  }
  if (added.length === 0) {
    throw new Error(type === 'mod' ? 'Выберите файлы модов (.jar).' : 'Выберите архивы .zip.');
  }
  return added;
}

/** Files neither site knew, by path, size and date: not asked about again in this run. */
const unrecognised = new Set();

/**
 * Recognises files added by hand, so they get an icon, a title, a site, client/server and updates:
 * first on Modrinth by SHA-1, then what Modrinth does not have on CurseForge by its fingerprint
 * (curseFingerprint.js; needs the CurseForge key). Returns how many files were recognised.
 */
async function identifyContent(settings, instanceId, type) {
  const items = await listContent(settings, instanceId, type);
  const instance = await instanceService.getInstance(settings, instanceId);
  const pathOf = (item) => path.join(instance.directory, FOLDERS[type], item.file);
  const unknown = items.filter((item) => !item.platform && !item.folder && !unrecognised.has(`${pathOf(item)}|${item.size}|${item.modifiedAt}`));
  if (unknown.length === 0) {
    return 0;
  }
  let recognised = 0;
  const left = new Set(unknown);

  // Modrinth.
  try {
    const hashes = new Map();
    for (const item of unknown) {
      hashes.set(await sha1File(pathOf(item)), item);
    }
    const versions = await modrinth.versionsForHashes([...hashes.keys()]);
    const projects = await modrinth.getProjectsBrief([...new Set(Object.values(versions).map((version) => version.projectId))]);
    const byId = new Map(projects.map((project) => [project.id, project]));
    await updateIndex(instance.directory, (entries) => {
      for (const [hash, version] of Object.entries(versions)) {
        const item = hashes.get(hash);
        const project = byId.get(version.projectId);
        if (!item || !project) continue;
        entries[entryKey(type, item.file)] = {
          platform: 'modrinth',
          projectId: version.projectId,
          versionId: version.id,
          versionNumber: version.versionNumber,
          title: project.title,
          iconUrl: project.iconUrl,
          clientSide: project.clientSide ?? null,
          serverSide: project.serverSide ?? null,
          installedAt: new Date().toISOString(),
        };
        left.delete(item);
        recognised += 1;
      }
    });
  } catch (error) {
    log.warn(`Моды не распознаны на Modrinth: ${error.message}`);
  }

  // CurseForge, for what Modrinth does not have.
  const key = curseforge.apiKey(settings);
  if (left.size > 0 && key) {
    try {
      const byFingerprint = new Map();
      for (const item of left) {
        byFingerprint.set(await fingerprintFile(pathOf(item)), item);
      }
      const files = await curseforge.matchFingerprints(key, [...byFingerprint.keys()]);
      const mods = await curseforge.getMods(key, [...new Set(Object.values(files).map((file) => file.modId))]);
      const modById = new Map(mods.map((mod) => [mod.id, mod]));
      await updateIndex(instance.directory, (entries) => {
        for (const [fingerprint, item] of byFingerprint) {
          const file = files[fingerprint];
          const mod = file && modById.get(file.modId);
          if (!mod) continue;
          entries[entryKey(type, item.file)] = {
            platform: 'curseforge',
            projectId: String(mod.id),
            versionId: String(file.id),
            versionNumber: file.displayName ?? null,
            title: mod.name,
            iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || null,
            ...curseforge.sidesOfFile(file),
            installedAt: new Date().toISOString(),
          };
          left.delete(item);
          recognised += 1;
        }
      });
    } catch (error) {
      log.warn(`Моды не распознаны на CurseForge: ${error.message}`);
    }
  }

  for (const item of left) unrecognised.add(`${pathOf(item)}|${item.size}|${item.modifiedAt}`);
  if (recognised) log.info(`Распознано файлов: ${recognised} из ${unknown.length}`);
  return recognised;
}
// --- Compatibility check before installing ---------------------------------------------

/** Mods that do the same job and are known not to work together (Modrinth slugs). */
const KNOWN_CONFLICTS = [
  ['sodium', 'embeddium', 'Оба меняют отрисовку: нужен только один'],
  ['sodium', 'rubidium', 'Оба меняют отрисовку: нужен только один'],
  ['embeddium', 'rubidium', 'Оба меняют отрисовку: нужен только один'],
  ['sodium', 'magnesium', 'Оба меняют отрисовку: нужен только один'],
  ['lithium', 'canary', 'Canary — порт Lithium: вместе не нужны'],
  ['phosphor', 'starlight', 'Оба переписывают освещение'],
  ['iris', 'oculus', 'Оба загружают шейдеры: нужен только один'],
  ['optifabric', 'sodium', 'OptiFine не работает вместе с Sodium'],
  ['optifabric', 'iris', 'OptiFine не работает вместе с Iris'],
  ['modernfix', 'smoothboot-fabric', 'Оба ускоряют загрузку одним способом'],
];

/**
 * Possible problems with a mod before it is installed: [{ key, title, detail }]. Never blocks the
 * install by itself: the window asks, and warnings the user dismissed (settings.compat) are left out.
 */
/** Answers about the mods already in an instance, kept for a few minutes (key -> { at, promise }). */
const REMEMBER_MS = 10 * 60 * 1000;
const rememberedAnswers = new Map();

function remembered(key, load) {
  const known = rememberedAnswers.get(key);
  if (known && Date.now() - known.at < REMEMBER_MS) return known.promise;
  const promise = load();
  rememberedAnswers.set(key, { at: Date.now(), promise });
  promise.catch(() => rememberedAnswers.delete(key));
  // Old answers are dropped so the map does not grow without end.
  for (const [oldKey, value] of rememberedAnswers) if (Date.now() - value.at >= REMEMBER_MS) rememberedAnswers.delete(oldKey);
  return promise;
}

async function checkCompatibility(settings, instanceId, { platform, projectId, versionId, type = 'mod', title }) {
  if (type !== 'mod' || settings.compat?.warn === false) {
    return [];
  }
  const instance = await instanceService.getInstance(settings, instanceId);
  const api = platformApi(settings, platform);
  const version = versionId ? await api.getVersion(projectId, versionId).catch(() => null) : await pickVersion(api, projectId, instance, type).catch(() => null);
  if (!version) {
    return [];
  }
  const name = title ?? projectId;
  const warnings = [];
  const loader = instance.loader.type;
  const loaders = version.loaders ?? [];
  const loaderFits = loader === 'vanilla' || loaders.length === 0 || loaders.includes(loader) || (loader === 'quilt' && loaders.includes('fabric'));
  if (!loaderFits) {
    warnings.push({ key: `loader:${projectId}:${loader}`, title: 'Мод для другого загрузчика', detail: `«${name}» сделан для ${loaders.join(', ')}, а у сборки ${loader}.` });
  }
  if ((version.gameVersions ?? []).length > 0 && !version.gameVersions.includes(instance.minecraft)) {
    warnings.push({ key: `game:${projectId}:${instance.minecraft}`, title: 'Мод для другой версии игры', detail: `Эта версия «${name}» для ${version.gameVersions.slice(-4).join(', ')}, а сборка на ${instance.minecraft}.` });
  }

  // What is installed: titles by project, and the Modrinth versions behind the files.
  const index = await readIndex(instance.directory);
  const installed = Object.entries(index.entries).filter(([key, entry]) => key.startsWith(`${FOLDERS.mod}/`) && entry.projectId && entry.projectId !== projectId);
  const titleOf = new Map(installed.map(([, entry]) => [entry.projectId, entry.title ?? entry.projectId]));

  for (const dependency of version.dependencies ?? []) {
    if (dependency.type === 'incompatible' && dependency.projectId && titleOf.has(dependency.projectId)) {
      const other = titleOf.get(dependency.projectId);
      warnings.push({ key: `pair:${[projectId, dependency.projectId].sort().join('|')}`, title: 'Авторы указали несовместимость', detail: `«${name}» не работает вместе с «${other}», который уже стоит в сборке.` });
    }
  }
  if (platform === 'modrinth') {
    const versionIds = installed.filter(([, entry]) => entry.platform === 'modrinth' && entry.versionId).map(([, entry]) => entry.versionId);
    const installedIds = [...new Set(installed.filter(([, entry]) => entry.platform === 'modrinth').map(([, entry]) => entry.projectId))].sort();
    // All at once; what the instance has is remembered for a while (several mods are usually
    // added one after another), only the new mod is asked about each time.
    const [installedVersions, installedProjects, newProject] = await Promise.all([
      versionIds.length ? remembered(`versions:${[...versionIds].sort().join(',')}`, () => modrinth.getVersionsByIds(versionIds)).catch(() => []) : [],
      installedIds.length ? remembered(`projects:${installedIds.join(',')}`, () => modrinth.getProjectsBrief(installedIds)).catch(() => []) : [],
      modrinth.getProjectsBrief([projectId]).catch(() => []),
    ]);
    const projects = [...newProject, ...installedProjects];
    for (const other of installedVersions) {
      if (other.dependencies.some((dependency) => dependency.type === 'incompatible' && dependency.projectId === projectId)) {
        const key = `pair:${[projectId, other.projectId].sort().join('|')}`;
        if (!warnings.some((warning) => warning.key === key)) {
          warnings.push({ key, title: 'Авторы указали несовместимость', detail: `«${titleOf.get(other.projectId) ?? other.projectId}» в сборке не работает вместе с «${name}».` });
        }
      }
    }
    const slugOf = new Map(projects.map((project) => [project.id, project.slug]));
    const mySlug = slugOf.get(projectId);
    for (const [a, b, why] of KNOWN_CONFLICTS) {
      const otherSlug = mySlug === a ? b : mySlug === b ? a : null;
      const other = otherSlug && projects.find((project) => project.slug === otherSlug && project.id !== projectId);
      if (other) {
        const key = `pair:${[projectId, other.id].sort().join('|')}`;
        if (!warnings.some((warning) => warning.key === key)) {
          warnings.push({ key, title: 'Известный конфликт', detail: `«${name}» и «${other.title}»: ${why}.` });
        }
      }
    }
  }
  const ignored = new Set(settings.compat?.ignored ?? []);
  return warnings.filter((warning) => !ignored.has(warning.key));
}

/** Turns several files on or off at once (server preparation). Returns { changed, files }. */
async function setEnabledMany(settings, instanceId, type, files, enabled) {
  let changed = 0;
  const result = [];
  for (const file of files ?? []) {
    const isEnabled = !String(file).toLowerCase().endsWith(DISABLED_SUFFIX);
    if (isEnabled === Boolean(enabled)) {
      result.push(file);
      continue;
    }
    result.push(await setEnabled(settings, instanceId, type, file, enabled));
    changed += 1;
  }
  return { changed, files: result };
}

/**
 * Fills in client/server sides from Modrinth for mods that came from there but were installed
 * before the launcher stored sides. Returns how many entries got their sides.
 */
async function resolveSides(settings, instanceId) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const index = await readIndex(instance.directory);
  const lacking = Object.entries(index.entries).filter(([key, entry]) => key.startsWith(`${FOLDERS.mod}/`) && entry.projectId && !entry.clientSide);
  const fromModrinth = lacking.filter(([, entry]) => entry.platform === 'modrinth');
  // CurseForge: the sides are on the file (its "Client" / "Server" tags), not on the project.
  const key = curseforge.apiKey(settings);
  const fromCurseForge = key ? lacking.filter(([, entry]) => entry.platform === 'curseforge' && entry.versionId) : [];
  if (fromModrinth.length === 0 && fromCurseForge.length === 0) {
    return 0;
  }
  const projects = fromModrinth.length ? await modrinth.getProjectsBrief([...new Set(fromModrinth.map(([, entry]) => entry.projectId))]) : [];
  const byId = new Map(projects.map((project) => [project.id, project]));
  const files = fromCurseForge.length ? await curseforge.getFiles(key, [...new Set(fromCurseForge.map(([, entry]) => entry.versionId))]).catch(() => []) : [];
  const fileById = new Map(files.map((file) => [String(file.id), file]));
  let filled = 0;
  await updateIndex(instance.directory, (entries) => {
    for (const [entryName, entry] of fromModrinth) {
      const project = byId.get(entry.projectId);
      if (project && entries[entryName]) {
        entries[entryName].clientSide = project.clientSide;
        entries[entryName].serverSide = project.serverSide;
        filled += 1;
      }
    }
    for (const [entryName, entry] of fromCurseForge) {
      const file = fileById.get(String(entry.versionId));
      const sides = file ? curseforge.sidesOfFile(file) : null;
      if (sides?.clientSide && entries[entryName]) {
        Object.assign(entries[entryName], sides);
        filled += 1;
      }
    }
  });
  return filled;
}
/**
 * Installs every available update of one content type (automatic updates before a launch).
 * onLog(text) reports each step. Returns { updated: [titles], failed: [titles] }.
 */
async function updateAllContent(settings, instanceId, type, onLog = () => {}, { beforeChange } = {}) {
  const updates = await checkUpdates(settings, instanceId, type);
  if (updates.length > 0 && beforeChange) {
    await beforeChange(updates);
  }
  return updateMany(settings, instanceId, type, updates, onLog);
}

const UPDATE_LABELS = { mod: 'Обновление модов', resourcepack: 'Обновление ресурспаков', shader: 'Обновление шейдеров' };

/**
 * Installs the given updates (from checkUpdates) all at once — as many in parallel as Settings →
 * "Загрузки" allows — under one task in the top bar ("3 из 12"). onLog(text) reports each one.
 * Returns { updated: [titles], failed: [{ title, error }] }.
 */
async function updateMany(settings, instanceId, type, updates, onLog = () => {}) {
  assertType(type);
  const instance = await instanceService.getInstance(settings, instanceId);
  const list = (Array.isArray(updates) ? updates : []).filter((update) => update?.projectId && update?.version?.id);
  const reporter = createTaskReporter({ taskId: `update:${instanceId}:${type}`, kind: 'content', label: UPDATE_LABELS[type] ?? 'Обновление', instance: instance.name });
  const updated = [];
  const failed = [];
  let done = 0;
  reporter.report(`0 из ${list.length}`, 0);
  await runWithConcurrency(list, parallelDownloads(), async (update) => {
    try {
      await installProject(settings, {
        instanceId,
        platform: update.platform,
        projectId: update.projectId,
        versionId: update.version.id,
        type,
        title: update.title,
        iconUrl: update.icon?.startsWith('https://') ? update.icon : null,
        replaceFile: update.file,
        quiet: true,
      });
      updated.push(update.title);
      onLog(`Обновлён: ${update.title} ${update.currentVersion ?? ''} → ${update.version.versionNumber}`);
    } catch (error) {
      failed.push({ title: update.title, error: error.message });
      onLog(`Не удалось обновить ${update.title}: ${error.message}`);
    }
    done += 1;
    reporter.report(`${done} из ${list.length}`, (done / Math.max(1, list.length)) * 100, update.title);
  });
  reporter.finish(failed.length ? 'error' : 'done', `${updated.length} из ${list.length}`);
  log.info(`В «${instance.name}» обновлено: ${updated.length} из ${list.length}`);
  return { updated, failed };
}

/** Available updates: [{ file, title, platform, projectId, currentVersion, version: { id, versionNumber } }]. */
async function checkUpdates(settings, instanceId, type) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const items = (await listContent(settings, instanceId, type)).filter((item) => item.platform && !item.folder);
  const updates = [];
  const filters = instanceFilters(instance, type);

  const fromModrinth = items.filter((item) => item.platform === 'modrinth');
  if (fromModrinth.length > 0) {
    const hashes = new Map();
    for (const item of fromModrinth) {
      hashes.set(await sha1File(path.join(instance.directory, FOLDERS[type], item.file)), item);
    }
    const latest = await modrinth.latestForHashes([...hashes.keys()], { gameVersion: filters.gameVersion, loader: filters.loader });
    for (const [hash, version] of Object.entries(latest)) {
      const item = hashes.get(hash);
      if (item && version.id !== item.versionId && !version.files.some((file) => file.sha1 === hash)) {
        updates.push({ file: item.file, title: item.title, icon: item.icon, platform: 'modrinth', projectId: item.projectId, currentVersion: item.version, version: { id: version.id, versionNumber: version.versionNumber } });
      }
    }
  }

  const fromCurseForge = items.filter((item) => item.platform === 'curseforge');
  if (fromCurseForge.length > 0 && curseforge.apiKey(settings)) {
    for (const item of fromCurseForge) {
      try {
        const versions = await curseforge.getVersions(curseforge.apiKey(settings), item.projectId, filters);
        const newest = versions.find((version) => version.type === 'release') ?? versions[0];
        if (newest && newest.id !== item.versionId) {
          updates.push({ file: item.file, title: item.title, icon: item.icon, platform: 'curseforge', projectId: item.projectId, currentVersion: item.version, version: { id: newest.id, versionNumber: newest.versionNumber } });
        }
      } catch (error) {
        log.warn(`Не удалось проверить обновление ${item.title}: ${error.message}`);
      }
    }
  }
  return updates;
}

module.exports = {
  search,
  getProject,
  getVersions,
  installProject,
  installDatapack,
  installVersionFiles,
  listContent,
  setEnabled,
  removeContent,
  addLocalFiles,
  identifyContent,
  checkUpdates,
  setEnabledMany,
  checkCompatibility,
  resolveSides,
  updateAllContent,
  updateMany,
  findIcon,
  updateIndex,
  entryKey,
  CONTENT_TYPES,
  FOLDERS,
};
