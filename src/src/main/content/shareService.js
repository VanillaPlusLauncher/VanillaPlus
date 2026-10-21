'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { writeZip } = require('../core/zipWriter');
const instanceService = require('../minecraft/instanceService');
const contentService = require('./contentService');
const modrinth = require('./modrinth');
const packFiles = require('./packFiles');

/*
 * Sharing an instance.
 *  - A share code ("VP1-…"): Minecraft version, loader and the exact versions of the mods, resource
 *    packs and shaders that came from Modrinth or CurseForge, compressed into one line. Pasting it
 *    builds the same instance. Files added by hand travel only when the player agrees: they go to
 *    the Amethyx server for 14 days (packFiles.js) and the code names them; otherwise they are
 *    listed as left out.
 *  - A .mrpack file: Modrinth's modpack format, which Prism and other launchers open too. Modrinth
 *    files are referenced by URL and hash; everything else (CurseForge and local files, and the
 *    config folder when asked) goes into "overrides".
 */

const CODE_PREFIX = 'VP1-';
const TYPES = ['mod', 'resourcepack', 'shader'];
const TYPE_CODES = { mod: 'm', resourcepack: 'r', shader: 's' };
const PLATFORM_CODES = { modrinth: 'm', curseforge: 'c' };
const log = createLogger('share');

const invert = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [value, key]));
const CODE_TYPES = invert(TYPE_CODES);
const CODE_PLATFORMS = invert(PLATFORM_CODES);

async function installedItems(settings, instanceId) {
  const items = [];
  for (const type of TYPES) {
    for (const item of await contentService.listContent(settings, instanceId, type)) {
      if (!item.folder) items.push({ ...item, type });
    }
  }
  return items;
}

/**
 * { code, included, skipped: [titles left out], extra: { count, bytes, tooBig: [titles] }, uploaded }.
 * `extra` is what the server could carry; with `upload` those files are uploaded first and the code
 * names them (`uploaded`: { count, bytes, expiresAt }).
 */
async function makeShareCode(settings, instanceId, { upload = false } = {}) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const items = await installedItems(settings, instanceId);
  const shared = items.filter((item) => item.platform && item.projectId && item.versionId && PLATFORM_CODES[item.platform]);
  const data = {
    n: instance.name,
    v: instance.minecraft,
    l: instance.loader.type,
    lv: instance.loader.version ?? null,
    // [type, platform, project, version, enabled]
    c: shared.map((item) => [TYPE_CODES[item.type], PLATFORM_CODES[item.platform], item.projectId, item.versionId, item.enabled ? 1 : 0]),
  };
  const byHand = items.filter((item) => !shared.includes(item));
  const fitting = byHand.filter((item) => item.size <= packFiles.MAX_FILE_BYTES);
  let uploaded = null;
  if (upload && fitting.length) {
    const reporter = createTaskReporter({ taskId: `share-upload:${crypto.randomBytes(4).toString('hex')}`, kind: 'content', label: `Файлы для кода: ${instance.name}` });
    try {
      const files = fitting.map((item) => {
        const relative = `${contentService.FOLDERS[item.type]}/${item.file}`;
        return { path: relative, file: path.join(instance.directory, ...relative.split('/')), size: item.size };
      });
      const pack = await packFiles.uploadPackFiles(files, (sent, total) => reporter.report('Загрузка на сервер', total ? (sent / total) * 100 : 100, `${Math.round(sent / 1048576)}/${Math.round(total / 1048576)} МБ`));
      reporter.finish('done', `${pack.files} шт.`);
      // The server is named only when it is not the built-in one: codes stay short.
      data.f = { i: pack.id, n: pack.files, b: pack.bytes, e: pack.expiresAt, ...(pack.server !== packFiles.BUILT_IN_SERVER ? { s: pack.server } : {}) };
      uploaded = { count: pack.files, bytes: pack.bytes, expiresAt: pack.expiresAt };
    } catch (error) {
      reporter.finish('error', error.message);
      throw error;
    }
  }
  const code = CODE_PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(data)), { level: 9 }).toString('base64url');
  const tooBig = byHand.filter((item) => !fitting.includes(item));
  return {
    code,
    included: shared.length,
    skipped: (uploaded ? tooBig : byHand).map((item) => item.title),
    extra: { count: fitting.length, bytes: fitting.reduce((sum, item) => sum + item.size, 0), tooBig: tooBig.map((item) => item.title) },
    uploaded,
  };
}

/**
 * Reads a share code: { name, minecraft, loader, content: [{ type, platform, projectId, versionId, enabled }],
 * files: { id, count, bytes, expiresAt, server } | null — the author's files on the server }.
 */
function parseShareCode(code) {
  const text = String(code ?? '').trim().replace(/\s+/g, '');
  if (!text.startsWith(CODE_PREFIX)) {
    throw new Error('Это не код сборки Amethyx (он начинается с VP1-).');
  }
  let data;
  try {
    data = JSON.parse(zlib.inflateRawSync(Buffer.from(text.slice(CODE_PREFIX.length), 'base64url'), { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8'));
  } catch {
    throw new Error('Код повреждён: скопируйте его целиком.');
  }
  if (typeof data?.v !== 'string' || !Array.isArray(data.c)) {
    throw new Error('Код повреждён: скопируйте его целиком.');
  }
  return {
    name: String(data.n ?? 'Сборка по коду').slice(0, 64),
    minecraft: data.v,
    loader: { type: String(data.l ?? 'vanilla'), version: data.lv ? String(data.lv) : null },
    content: data.c
      .filter((entry) => Array.isArray(entry) && CODE_TYPES[entry[0]] && CODE_PLATFORMS[entry[1]])
      .slice(0, 1000)
      .map(([type, platform, projectId, versionId, enabled]) => ({ type: CODE_TYPES[type], platform: CODE_PLATFORMS[platform], projectId: String(projectId), versionId: String(versionId), enabled: enabled !== 0 })),
    files:
      data.f && /^[0-9a-f]{32}$/.test(String(data.f.i))
        ? {
            id: String(data.f.i),
            count: Number(data.f.n) || 0,
            bytes: Number(data.f.b) || 0,
            expiresAt: Number(data.f.e) || null,
            server: typeof data.f.s === 'string' && /^https?:\/\/[^/]+$/.test(data.f.s) ? data.f.s : null,
          }
        : null,
  };
}

/**
 * Builds a new instance from a share code. Content that fails is listed, the rest is installed.
 * The author's files on the server come too unless `withFiles` is false; when they are gone
 * already, `filesError` says so. Resolves with { instance, failed, filesError }.
 */
async function importShareCode(settings, code, { name, group, withFiles = true } = {}) {
  const pack = parseShareCode(code);
  const reporter = createTaskReporter({ taskId: `share:${crypto.randomBytes(4).toString('hex')}`, kind: 'modpack', label: name || pack.name });
  try {
    const instance = await instanceService.createInstance(settings, { name: name || pack.name, group, minecraft: pack.minecraft, loader: pack.loader, icon: 'block:grass_block' });
    const failed = [];
    const files = withFiles ? pack.files : null;
    // Progress: mods and packs, then the author's files, then the game.
    const contentShare = files ? 70 : 85;
    let filesError = null;
    let done = 0;
    for (const entry of pack.content) {
      try {
        await contentService.installProject(settings, { instanceId: instance.id, platform: entry.platform, projectId: entry.projectId, versionId: entry.versionId, type: entry.type });
        if (!entry.enabled) {
          const items = await contentService.listContent(settings, instance.id, entry.type);
          const item = items.find((candidate) => candidate.projectId === entry.projectId);
          if (item) await contentService.setEnabled(settings, instance.id, entry.type, item.file, false);
        }
      } catch (error) {
        failed.push(entry.projectId);
        log.warn(`Из кода не установлено ${entry.projectId}: ${error.message}`);
      }
      done += 1;
      reporter.report('Моды и ресурсы', 5 + (done / Math.max(1, pack.content.length)) * contentShare, `${done}/${pack.content.length}`);
    }
    if (files) {
      try {
        const result = await packFiles.downloadPackFiles(files, instance.directory, (received, total) =>
          reporter.report('Файлы автора', 75 + (total ? received / total : 1) * 15, `${Math.round(received / 1048576)}/${Math.round(total / 1048576)} МБ`),
        );
        failed.push(...result.failed);
      } catch (error) {
        filesError = error.message;
        log.warn(`Файлы автора кода не скачаны: ${error.message}`);
      }
    }
    reporter.report('Minecraft и загрузчик', 92, pack.minecraft);
    await instanceService.ensureInstanceReady(settings, instance.id).catch((error) => log.warn(`Сборка по коду создана, игра не установлена: ${error.message}`));
    reporter.finish('done', instance.name);
    return { instance, failed, filesError };
  } catch (error) {
    reporter.finish('error', error.message);
    throw error;
  }
}

const DEPENDENCY_KEYS = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };

// --- Choosing what goes into an exported file (the export dialog's tree) ---------------------------

/** The launcher's own files in an instance folder: never shown in the tree, never exported. */
const INTERNAL = new Set(['instance.json', '.amethyx', 'natives']);

const cleanRelative = (value) =>
  String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

/**
 * The paths ticked in the export dialog (relative, "/"-separated; a folder means everything inside
 * it): chosen(rel) — is it in; skip(rel) — may a folder walk leave rel out (not chosen and no
 * chosen path inside it).
 */
function selection(paths) {
  const list = [...new Set((paths ?? []).map(cleanRelative))].filter((rel) => rel && !rel.split('/').includes('..') && !INTERNAL.has(rel.split('/')[0]));
  const chosen = (rel) => list.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
  const onTheWay = (rel) => list.some((entry) => entry.startsWith(`${rel}/`));
  return { list, chosen, skip: (rel) => INTERNAL.has(rel.split('/')[0]) || (!chosen(rel) && !onTheWay(rel)) };
}

/** What a modpack carried before the tree existed: its mods, packs and shaders, and the mods' settings. */
function defaultPackPaths(includeConfigs) {
  return ['mods', 'resourcepacks', 'shaderpacks', ...(includeConfigs ? ['config', 'defaultconfigs'] : [])];
}

/** One level of the instance folder for the tree: [{ name, path, dir, size? }], folders first. */
async function listInstanceFiles(settings, instanceId, relativeDir = '') {
  const instance = await instanceService.getInstance(settings, instanceId);
  const relative = cleanRelative(relativeDir);
  if (relative.split('/').includes('..')) throw new Error('Путь выходит за папку сборки.');
  const directory = path.join(instance.directory, relative);
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (!relative && INTERNAL.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push({ name: entry.name, path: child, dir: true });
    } else if (entry.isFile()) {
      const stat = await fsp.stat(path.join(directory, entry.name)).catch(() => null);
      result.push({ name: entry.name, path: child, dir: false, size: stat?.size ?? 0 });
    }
  }
  return result.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Sizes of folders for the tree: { [path]: bytes }. A huge folder stops counting at 100 000 files. */
async function folderSizes(settings, instanceId, relativePaths) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const sizes = {};
  for (const relative of (relativePaths ?? []).map(cleanRelative).slice(0, 200)) {
    if (!relative || relative.split('/').includes('..')) continue;
    let total = 0;
    let count = 0;
    const walk = async (directory) => {
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (count > 100000) return;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          count += 1;
          total += (await fsp.stat(full).catch(() => null))?.size ?? 0;
        }
      }
    };
    await walk(path.join(instance.directory, relative));
    sizes[relative] = total;
  }
  return sizes;
}

/** Adds the chosen path (a file, or a folder with everything in it) under `prefix`, except `handled` files. */
async function addChosen(zip, root, relative, prefix, handled) {
  const full = path.join(root, relative);
  const stat = await fsp.stat(full).catch(() => null);
  if (!stat) return 0;
  if (stat.isFile()) {
    if (handled.has(relative)) return 0;
    await zip.addFile(`${prefix}/${relative}`, full);
    return 1;
  }
  let added = 0;
  for (const entry of await fsp.readdir(full, { withFileTypes: true }).catch(() => [])) {
    added += await addChosen(zip, root, `${relative}/${entry.name}`, prefix, handled);
  }
  return added;
}

/**
 * Writes the instance as a Modrinth .mrpack to `target`. Only the chosen paths go in (`paths`, else
 * mods, packs and shaders, and the config folder with includeConfigs). Chosen files from Modrinth are
 * referenced by URL and hash; everything else chosen goes into "overrides".
 */
async function exportMrpack(settings, instanceId, target, { includeConfigs = true, paths } = {}) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const pick = selection(paths ?? defaultPackPaths(includeConfigs));
  const items = (await installedItems(settings, instanceId)).filter((item) => pick.chosen(`${contentService.FOLDERS[item.type]}/${item.file}`));
  const fromModrinth = items.filter((item) => item.platform === 'modrinth' && item.versionId);
  const versions = fromModrinth.length ? await modrinth.getVersionsByIds(fromModrinth.map((item) => item.versionId)) : [];
  const byId = new Map(versions.map((version) => [version.id, version]));
  const files = [];
  const handled = new Set();
  let bundled = 0;
  await writeZip(target, async (zip) => {
    for (const item of items) {
      const folder = contentService.FOLDERS[item.type];
      const relative = `${folder}/${item.file}`;
      handled.add(relative);
      const version = item.platform === 'modrinth' ? byId.get(item.versionId) : null;
      const file = version?.files.find((candidate) => candidate.primary) ?? version?.files[0];
      if (file?.sha1 && file?.sha512 && item.enabled) {
        files.push({ path: `${folder}/${file.filename}`, hashes: { sha1: file.sha1, sha512: file.sha512 }, downloads: [file.url], fileSize: file.size, env: { client: 'required', server: item.side === 'client' ? 'unsupported' : 'required' } });
      } else {
        await zip.addFile(`overrides/${relative}`, path.join(instance.directory, relative));
        bundled += 1;
      }
    }
    for (const relative of pick.list) bundled += await addChosen(zip, instance.directory, relative, 'overrides', handled);
    const dependencies = { minecraft: instance.minecraft };
    if (DEPENDENCY_KEYS[instance.loader.type] && instance.loader.version) {
      // Forge/NeoForge versions are stored with the Minecraft prefix in some cases ("1.20.1-47.4.10").
      dependencies[DEPENDENCY_KEYS[instance.loader.type]] = instance.loader.version.replace(`${instance.minecraft}-`, '');
    }
    await zip.addBuffer('modrinth.index.json', JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: instance.name, summary: 'Сборка из Amethyx Launcher', files, dependencies }, null, 2));
  });
  log.info(`Сборка «${instance.name}» сохранена в ${target}: ${files.length} ссылок, ${bundled} файлов внутри`);
  return { path: target, linked: files.length, bundled };
}

/** CurseForge's names for loaders in manifest.json: "forge-47.4.10", "fabric-0.15.11". */
function curseForgeLoaderId(instance) {
  const { type, version } = instance.loader;
  if (type === 'vanilla' || !version) return null;
  return `${type}-${version.replace(`${instance.minecraft}-`, '')}`;
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

/**
 * Writes the instance as a CurseForge modpack (.zip with manifest.json) to `target`. Only the chosen
 * paths go in (as in exportMrpack). Chosen files from CurseForge are referenced by project and file
 * id; everything else chosen goes into "overrides".
 */
async function exportCurseForge(settings, instanceId, target, { includeConfigs = true, paths } = {}) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const pick = selection(paths ?? defaultPackPaths(includeConfigs));
  const items = (await installedItems(settings, instanceId)).filter((item) => pick.chosen(`${contentService.FOLDERS[item.type]}/${item.file}`));
  const files = [];
  const bundled = [];
  const listed = [];
  const handled = new Set();
  for (const item of items) {
    const projectID = Number(item.projectId);
    const fileID = Number(item.versionId);
    handled.add(`${contentService.FOLDERS[item.type]}/${item.file}`);
    if (item.platform === 'curseforge' && Number.isInteger(projectID) && Number.isInteger(fileID)) {
      files.push({ projectID, fileID, required: Boolean(item.enabled) });
      listed.push(item.title);
    } else {
      bundled.push(item);
    }
  }
  const loaderId = curseForgeLoaderId(instance);
  const manifest = {
    minecraft: { version: instance.minecraft, modLoaders: loaderId ? [{ id: loaderId, primary: true }] : [] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: instance.name,
    version: '1.0.0',
    author: '',
    files,
    overrides: 'overrides',
  };
  let extra = 0;
  await writeZip(target, async (zip) => {
    await zip.addBuffer('manifest.json', JSON.stringify(manifest, null, 2));
    await zip.addBuffer('modlist.html', `<ul>\n${listed.map((title) => `<li>${escapeHtml(title)}</li>`).join('\n')}\n</ul>\n`);
    for (const item of bundled) {
      const folder = contentService.FOLDERS[item.type];
      await zip.addFile(`overrides/${folder}/${item.file}`, path.join(instance.directory, folder, item.file));
    }
    for (const relative of pick.list) extra += await addChosen(zip, instance.directory, relative, 'overrides', handled);
  });
  log.info(`Сборка «${instance.name}» сохранена для CurseForge в ${target}: ${files.length} ссылок, ${bundled.length + extra} файлов внутри`);
  return { path: target, linked: files.length, bundled: bundled.length + extra };
}

/** Prism Launcher / MultiMC component ids of the loaders. */
const PRISM_LOADERS = { fabric: 'net.fabricmc.fabric-loader', quilt: 'org.quiltmc.quilt-loader', forge: 'net.minecraftforge', neoforge: 'net.neoforged' };
// Never worth carrying: caches, logs, our world backups and the launcher's own record of the instance.
const ZIP_ALWAYS_SKIP = new Set(['.fabric', '.cache', 'natives', 'logs', 'crash-reports', 'instance.json', '.amethyx/backups']);

/**
 * Writes the instance as a plain .zip: the game folder under ".minecraft" with instance.cfg and
 * mmc-pack.json beside it, the layout Prism Launcher and MultiMC import (Amethyx too). With `paths`
 * only the chosen files and folders go in; without, the whole folder, worlds, mod settings and
 * screenshots as asked.
 */
async function exportInstanceZip(settings, instanceId, target, { includeConfigs = true, includeWorlds = true, includeScreenshots = false, paths } = {}) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const components = [{ uid: 'net.minecraft', version: instance.minecraft, important: true }];
  if (PRISM_LOADERS[instance.loader.type] && instance.loader.version) {
    components.push({ uid: PRISM_LOADERS[instance.loader.type], version: instance.loader.version.replace(`${instance.minecraft}-`, '') });
  }
  const cfg = ['[General]', 'ConfigVersion=1.2', 'InstanceType=OneSix', `name=${instance.name}`, 'iconKey=default', ''].join('\n');
  const skip = paths
    ? selection(paths).skip
    : (relative) =>
        ZIP_ALWAYS_SKIP.has(relative) ||
        (!includeWorlds && relative === 'saves') ||
        (!includeConfigs && (relative === 'config' || relative === 'defaultconfigs')) ||
        (!includeScreenshots && relative === 'screenshots');
  await writeZip(target, async (zip) => {
    await zip.addBuffer('instance.cfg', cfg);
    await zip.addBuffer('mmc-pack.json', JSON.stringify({ components, formatVersion: 1 }, null, 2));
    await zip.addFolder('.minecraft', instance.directory, skip);
  });
  const size = (await fsp.stat(target)).size;
  log.info(`Сборка «${instance.name}» сохранена архивом в ${target}: ${Math.round(size / 1048576)} МБ`);
  return { path: target, size };
}

module.exports = { makeShareCode, parseShareCode, importShareCode, exportMrpack, exportCurseForge, exportInstanceZip, listInstanceFiles, folderSizes };
