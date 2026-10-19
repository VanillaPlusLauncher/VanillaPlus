'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { writeZip } = require('../core/zipWriter');
const instanceService = require('../minecraft/instanceService');
const contentService = require('./contentService');
const modrinth = require('./modrinth');

/*
 * Sharing an instance.
 *  - A share code ("VP1-…"): Minecraft version, loader and the exact versions of the mods, resource
 *    packs and shaders that came from Modrinth or CurseForge, compressed into one line. Pasting it
 *    builds the same instance. Files added by hand cannot travel in a code and are listed as left out.
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

/** { code, included, skipped: [titles of files that cannot travel in a code] } */
async function makeShareCode(settings, instanceId) {
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
  const code = CODE_PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(data)), { level: 9 }).toString('base64url');
  return {
    code,
    included: shared.length,
    skipped: items.filter((item) => !shared.includes(item)).map((item) => item.title),
  };
}

/** Reads a share code: { name, minecraft, loader, content: [{ type, platform, projectId, versionId, enabled }] }. */
function parseShareCode(code) {
  const text = String(code ?? '').trim().replace(/\s+/g, '');
  if (!text.startsWith(CODE_PREFIX)) {
    throw new Error('Это не код сборки Vanilla+ (он начинается с VP1-).');
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
  };
}

/** Builds a new instance from a share code. Content that fails is listed, the rest is installed. */
async function importShareCode(settings, code, { name, group } = {}) {
  const pack = parseShareCode(code);
  const reporter = createTaskReporter({ taskId: `share:${crypto.randomBytes(4).toString('hex')}`, kind: 'modpack', label: name || pack.name });
  try {
    const instance = await instanceService.createInstance(settings, { name: name || pack.name, group, minecraft: pack.minecraft, loader: pack.loader, icon: 'block:grass_block' });
    const failed = [];
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
      reporter.report('Моды и ресурсы', 5 + (done / Math.max(1, pack.content.length)) * 85, `${done}/${pack.content.length}`);
    }
    reporter.report('Minecraft и загрузчик', 92, pack.minecraft);
    await instanceService.ensureInstanceReady(settings, instance.id).catch((error) => log.warn(`Сборка по коду создана, игра не установлена: ${error.message}`));
    reporter.finish('done', instance.name);
    return { instance, failed };
  } catch (error) {
    reporter.finish('error', error.message);
    throw error;
  }
}

const DEPENDENCY_KEYS = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };

/**
 * Writes the instance as a Modrinth .mrpack to `target`. includeConfigs adds the config folder
 * (settings of the mods) to the overrides.
 */
async function exportMrpack(settings, instanceId, target, { includeConfigs = true } = {}) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const items = await installedItems(settings, instanceId);
  const fromModrinth = items.filter((item) => item.platform === 'modrinth' && item.versionId);
  const versions = fromModrinth.length ? await modrinth.getVersionsByIds(fromModrinth.map((item) => item.versionId)) : [];
  const byId = new Map(versions.map((version) => [version.id, version]));
  const zip = new AdmZip();
  const files = [];
  const overrides = [];
  for (const item of items) {
    const folder = contentService.FOLDERS[item.type];
    const version = item.platform === 'modrinth' ? byId.get(item.versionId) : null;
    const file = version?.files.find((candidate) => candidate.primary) ?? version?.files[0];
    if (file?.sha1 && file?.sha512 && item.enabled) {
      files.push({ path: `${folder}/${file.filename}`, hashes: { sha1: file.sha1, sha512: file.sha512 }, downloads: [file.url], fileSize: file.size, env: { client: 'required', server: item.side === 'client' ? 'unsupported' : 'required' } });
    } else {
      overrides.push(`${folder}/${item.file}`);
      zip.addLocalFile(path.join(instance.directory, folder, item.file), `overrides/${folder}`);
    }
  }
  if (includeConfigs) {
    const config = path.join(instance.directory, 'config');
    if (await fsp.stat(config).catch(() => null)) {
      zip.addLocalFolder(config, 'overrides/config');
    }
  }
  const dependencies = { minecraft: instance.minecraft };
  if (DEPENDENCY_KEYS[instance.loader.type] && instance.loader.version) {
    // Forge/NeoForge versions are stored with the Minecraft prefix in some cases ("1.20.1-47.4.10").
    dependencies[DEPENDENCY_KEYS[instance.loader.type]] = instance.loader.version.replace(`${instance.minecraft}-`, '');
  }
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: instance.name, summary: 'Сборка из Vanilla+ Launcher', files, dependencies }, null, 2)));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await new Promise((resolve, reject) => zip.writeZip(target, (error) => (error ? reject(error) : resolve())));
  log.info(`Сборка «${instance.name}» сохранена в ${target}: ${files.length} ссылок, ${overrides.length} файлов внутри`);
  return { path: target, linked: files.length, bundled: overrides.length };
}

/** CurseForge's names for loaders in manifest.json: "forge-47.4.10", "fabric-0.15.11". */
function curseForgeLoaderId(instance) {
  const { type, version } = instance.loader;
  if (type === 'vanilla' || !version) return null;
  return `${type}-${version.replace(`${instance.minecraft}-`, '')}`;
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

/**
 * Writes the instance as a CurseForge modpack (.zip with manifest.json) to `target`. Files from
 * CurseForge are referenced by project and file id; everything else goes into "overrides".
 */
async function exportCurseForge(settings, instanceId, target, { includeConfigs = true } = {}) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const items = await installedItems(settings, instanceId);
  const files = [];
  const bundled = [];
  const listed = [];
  for (const item of items) {
    const projectID = Number(item.projectId);
    const fileID = Number(item.versionId);
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
  await writeZip(target, async (zip) => {
    await zip.addBuffer('manifest.json', JSON.stringify(manifest, null, 2));
    await zip.addBuffer('modlist.html', `<ul>\n${listed.map((title) => `<li>${escapeHtml(title)}</li>`).join('\n')}\n</ul>\n`);
    for (const item of bundled) {
      const folder = contentService.FOLDERS[item.type];
      await zip.addFile(`overrides/${folder}/${item.file}`, path.join(instance.directory, folder, item.file));
    }
    if (includeConfigs) {
      await zip.addFolder('overrides/config', path.join(instance.directory, 'config'));
    }
  });
  log.info(`Сборка «${instance.name}» сохранена для CurseForge в ${target}: ${files.length} ссылок, ${bundled.length} файлов внутри`);
  return { path: target, linked: files.length, bundled: bundled.length };
}

/** Prism Launcher / MultiMC component ids of the loaders. */
const PRISM_LOADERS = { fabric: 'net.fabricmc.fabric-loader', quilt: 'org.quiltmc.quilt-loader', forge: 'net.minecraftforge', neoforge: 'net.neoforged' };
// Never worth carrying: caches, logs, our world backups and the launcher's own record of the instance.
const ZIP_ALWAYS_SKIP = new Set(['.fabric', '.cache', 'natives', 'logs', 'crash-reports', 'instance.json', '.vanillaplus/backups']);

/**
 * Writes the whole instance as a plain .zip: the game folder under ".minecraft" with instance.cfg
 * and mmc-pack.json beside it, the layout Prism Launcher and MultiMC import (Vanilla+ too).
 * Worlds, mod settings and screenshots go in when asked.
 */
async function exportInstanceZip(settings, instanceId, target, { includeConfigs = true, includeWorlds = true, includeScreenshots = false } = {}) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const components = [{ uid: 'net.minecraft', version: instance.minecraft, important: true }];
  if (PRISM_LOADERS[instance.loader.type] && instance.loader.version) {
    components.push({ uid: PRISM_LOADERS[instance.loader.type], version: instance.loader.version.replace(`${instance.minecraft}-`, '') });
  }
  const cfg = ['[General]', 'ConfigVersion=1.2', 'InstanceType=OneSix', `name=${instance.name}`, 'iconKey=default', ''].join('\n');
  const skip = (relative) =>
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

module.exports = { makeShareCode, parseShareCode, importShareCode, exportMrpack, exportCurseForge, exportInstanceZip };
