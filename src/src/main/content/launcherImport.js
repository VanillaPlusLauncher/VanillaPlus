'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../core/logger');
const { createTaskReporter } = require('../core/progressReporter');
const instanceService = require('../minecraft/instanceService');

/*
 * Moving instances from other launchers. Each launcher keeps its instances in its own place and
 * format; the scanner reads them (only reads) and lists name, Minecraft version, loader and what
 * is inside. Importing makes an Amethyx instance with the same version and loader and copies the
 * game folder: mods, configs, worlds, resource packs, shaders, screenshots, settings.
 *
 *  Prism Launcher, ElyPrismLauncher, PolyMC, MultiMC — instances/<dir>/{instance.cfg, mmc-pack.json, .minecraft|minecraft}
 *  Modrinth App            — app.db (SQLite) + profiles/<path>
 *  CurseForge              — curseforge/minecraft/Instances/<dir>/minecraftinstance.json
 *  ATLauncher              — instances/<dir>/instance.json
 *  GDLauncher              — instances/<dir>/instance.json (game in instance/) or config.json (old)
 *  Millida Launcher        — profiles.json + minecraft/profiles/<name without spaces and dots>
 *  .minecraft launchers    — official launcher, TLauncher, SKLauncher, Legacy Launcher:
 *                            launcher_profiles.json, versions/<id>/<id>.json tell the loader
 */

const log = createLogger('launcher-import');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const HOME = os.homedir();

/** Never copied: caches, logs and launcher files that the new instance makes itself. */
const SKIP = new Set([
  'logs', 'crash-reports', '.cache', '.mixin.out', '.fabric', '.quilt', 'natives', 'downloads', 'debug', 'webcache', 'webcache2', '.sable', '.milli', 'CustomSkinLoader', 'dynamic-resource-pack-cache', '.physics_mod_cache', '.amethyx', '.vanillaplus', '.richlauncher',
  // The other launcher's own description of the instance: instance.json would replace Amethyx's.
  'instance.json', 'minecraftinstance.json', 'mmc-pack.json', 'instance.cfg', '.curseclient', 'millida-settings.json',
]);
/** In a shared .minecraft folder these belong to the launcher, not to the instance. */
const SHARED_SKIP = new Set(['assets', 'libraries', 'versions', 'runtime', 'bin', 'cache', 'launcher_accounts.json', 'launcher_profiles.json', 'launcher_settings.json', 'launcher_log.txt', 'launcher_ui_state.json', 'launcher_product_state.json', 'launcher_msa_credentials.bin', 'launcher_accounts_microsoft_store.json', 'treatment_tags.json', 'usercache.json', 'usernamecache.json', 'TlauncherProfiles.json', 'tlauncher_profiles.json', 'profiles', 'loader-cache', 'objects', 'version_manifest_v2.json']);
const OPTIONAL = { worlds: 'saves', screenshots: 'screenshots' };

// --- Small helpers ----------------------------------------------------------------------

const exists = (target) => fs.existsSync(target);

async function readJson(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** key=value lines (instance.cfg, prismlauncher.cfg). */
function readCfg(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([^=#[]+)=(.*)$/.exec(line);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return values;
}

async function subdirectories(directory) {
  try {
    return (await fsp.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

async function countFiles(directory, pattern) {
  try {
    return (await fsp.readdir(directory)).filter((name) => pattern.test(name)).length;
  } catch {
    return 0;
  }
}

async function countDirs(directory) {
  return (await subdirectories(directory)).length;
}

/** Forge versions are stored as "<minecraft>-<forge>" by Amethyx; NeoForge for 1.20.1 too. */
function normalizeLoader(type, version, minecraft) {
  const kind = String(type ?? 'vanilla').toLowerCase().replace(/[^a-z]/g, '');
  const known = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge', minecraftforge: 'forge', neoforged: 'neoforge', vanilla: 'vanilla', none: 'vanilla', '': 'vanilla' };
  const loader = known[kind] ?? 'vanilla';
  let clean = version ? String(version).trim() : null;
  if (clean && (loader === 'forge' || (loader === 'neoforge' && minecraft === '1.20.1'))) {
    clean = clean.replace(new RegExp(`^${minecraft.replace(/\./g, '\\.')}-`), '');
    clean = `${minecraft}-${clean}`;
  }
  return { type: loader, version: loader === 'vanilla' ? null : clean };
}

/** What the game folder holds, for the list. */
async function describe(gameDir) {
  const [mods, worlds, resourcepacks, shaderpacks] = await Promise.all([
    countFiles(path.join(gameDir, 'mods'), /\.jar$/i),
    countDirs(path.join(gameDir, 'saves')),
    countFiles(path.join(gameDir, 'resourcepacks'), /\.zip$|^[^.]+$/i),
    countFiles(path.join(gameDir, 'shaderpacks'), /\.zip$/i),
  ]);
  return { mods, worlds, resourcepacks, shaderpacks };
}

function entry({ key, name, minecraft, loader, gameDir, shared = false, icon = null }) {
  return { key, name: String(name || path.basename(gameDir)).slice(0, 64), minecraft: String(minecraft), loader, gameDir, shared, icon };
}

// --- Prism Launcher family ------------------------------------------------------------------

async function prismInstances(root, cfgNames) {
  let instancesDir = path.join(root, 'instances');
  for (const cfgName of cfgNames) {
    const cfg = readCfg(await readText(path.join(root, cfgName)));
    if (cfg.InstanceDir) {
      instancesDir = path.isAbsolute(cfg.InstanceDir) ? cfg.InstanceDir : path.join(root, cfg.InstanceDir);
      break;
    }
  }
  const found = [];
  for (const dir of await subdirectories(instancesDir)) {
    const pack = await readJson(path.join(dir, 'mmc-pack.json'));
    if (!pack?.components) continue;
    const components = new Map(pack.components.map((component) => [component.uid, component.version]));
    const minecraft = components.get('net.minecraft');
    if (!minecraft) continue;
    let loader = normalizeLoader('vanilla');
    if (components.get('net.fabricmc.fabric-loader')) loader = normalizeLoader('fabric', components.get('net.fabricmc.fabric-loader'), minecraft);
    else if (components.get('org.quiltmc.quilt-loader')) loader = normalizeLoader('quilt', components.get('org.quiltmc.quilt-loader'), minecraft);
    else if (components.get('net.neoforged')) loader = normalizeLoader('neoforge', components.get('net.neoforged'), minecraft);
    else if (components.get('net.minecraftforge')) loader = normalizeLoader('forge', components.get('net.minecraftforge'), minecraft);
    const cfg = readCfg(await readText(path.join(dir, 'instance.cfg')));
    const gameDir = exists(path.join(dir, '.minecraft')) ? path.join(dir, '.minecraft') : path.join(dir, 'minecraft');
    found.push(entry({ key: dir, name: cfg.name, minecraft, loader, gameDir }));
  }
  return found;
}

// --- Modrinth App ----------------------------------------------------------------------------

async function modrinthInstances(root) {
  const dbFile = path.join(root, 'app.db');
  if (!exists(dbFile)) return [];
  // A copy: the app may hold the database open.
  const copy = path.join(os.tmpdir(), `amethyx-modrinth-${crypto.randomBytes(4).toString('hex')}.db`);
  let rows = [];
  let profilesDir = path.join(root, 'profiles');
  try {
    await fsp.copyFile(dbFile, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (exists(dbFile + suffix)) await fsp.copyFile(dbFile + suffix, copy + suffix).catch(() => {});
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const custom = db.prepare("SELECT custom_dir FROM settings LIMIT 1").get()?.custom_dir;
      if (custom) profilesDir = path.join(custom, 'profiles');
    } catch {
      // Older or newer settings table: the default place.
    }
    try {
      rows = db.prepare('SELECT i.path AS path, i.name AS name, c.game_version AS game_version, c.loader AS loader, c.loader_version AS loader_version FROM instances i LEFT JOIN instance_content_sets c ON c.id = i.applied_content_set_id').all();
    } catch {
      rows = db.prepare('SELECT path, name, game_version, mod_loader AS loader, mod_loader_version AS loader_version FROM profiles').all();
    }
    db.close();
  } catch (error) {
    log.warn(`Modrinth App не прочитан: ${error.message}`);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) await fsp.rm(copy + suffix, { force: true }).catch(() => {});
  }
  return rows
    .filter((row) => row.game_version && exists(path.join(profilesDir, row.path)))
    .map((row) => entry({ key: path.join(profilesDir, row.path), name: row.name, minecraft: row.game_version, loader: normalizeLoader(row.loader, row.loader_version, row.game_version), gameDir: path.join(profilesDir, row.path) }));
}

// --- CurseForge -------------------------------------------------------------------------------

/** "forge-47.2.0", "fabric-0.15.11-1.20.1", "neoforge-21.1.77", "quilt-0.26.0-1.20.1". */
function curseLoader(name, minecraft) {
  const match = /^([a-z]+)-([^-]+)/i.exec(String(name ?? ''));
  return match ? normalizeLoader(match[1], match[2], minecraft) : normalizeLoader('vanilla');
}

async function curseforgeInstances(root) {
  const found = [];
  for (const dir of await subdirectories(root)) {
    const info = await readJson(path.join(dir, 'minecraftinstance.json'));
    if (!info?.gameVersion) continue;
    found.push(entry({ key: dir, name: info.name, minecraft: info.gameVersion, loader: curseLoader(info.baseModLoader?.name, info.gameVersion), gameDir: dir }));
  }
  return found;
}

// --- ATLauncher, GDLauncher -------------------------------------------------------------------

async function atlauncherInstances(root) {
  const found = [];
  for (const dir of await subdirectories(path.join(root, 'instances'))) {
    const info = await readJson(path.join(dir, 'instance.json'));
    const minecraft = info?.id ?? info?.minecraftVersion;
    if (!minecraft) continue;
    const loaderInfo = info.launcher?.loaderVersion;
    found.push(entry({ key: dir, name: info.launcher?.name ?? info.name, minecraft, loader: normalizeLoader(loaderInfo?.type, loaderInfo?.version, minecraft), gameDir: dir }));
  }
  return found;
}

async function gdlauncherInstances(root) {
  const found = [];
  for (const dir of await subdirectories(root)) {
    const carbon = await readJson(path.join(dir, 'instance.json'));
    if (carbon?.game_configuration?.version) {
      const version = carbon.game_configuration.version;
      const minecraft = version.release ?? version.Version?.Standard?.release;
      const modloader = (version.modloaders ?? version.Version?.Standard?.modloaders ?? [])[0];
      if (minecraft) found.push(entry({ key: dir, name: carbon.name, minecraft, loader: normalizeLoader(modloader?.type, modloader?.version, minecraft), gameDir: path.join(dir, 'instance') }));
      continue;
    }
    const legacy = await readJson(path.join(dir, 'config.json'));
    if (legacy?.loader?.mcVersion) {
      found.push(entry({ key: dir, name: path.basename(dir), minecraft: legacy.loader.mcVersion, loader: normalizeLoader(legacy.loader.loaderType, legacy.loader.loaderVersion, legacy.loader.mcVersion), gameDir: dir }));
    }
  }
  return found;
}

// --- Millida Launcher -------------------------------------------------------------------------

/** Millida names a profile's folder after it without spaces, brackets and dots. */
function millidaFolder(name) {
  return String(name).replace(/[^\p{L}\p{N}_-]/gu, '');
}

async function millidaInstances(root) {
  const profiles = await readJson(path.join(root, 'profiles.json'));
  if (!Array.isArray(profiles)) return [];
  const profilesDir = path.join(root, 'minecraft', 'profiles');
  const folders = await subdirectories(profilesDir);
  const loose = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const found = [];
  const used = new Set();
  // The same folder can be listed twice (with and without the loader version): the fuller one wins.
  const ordered = [...profiles].sort((a, b) => Number(Boolean(b?.loader_version)) - Number(Boolean(a?.loader_version)));
  for (const profile of ordered) {
    if (!profile?.version || !profile?.name) continue;
    const wanted = millidaFolder(profile.name);
    const dir = exists(path.join(profilesDir, wanted)) ? path.join(profilesDir, wanted) : folders.find((folder) => loose(path.basename(folder)) === loose(profile.name));
    if (!dir || used.has(dir)) continue;
    used.add(dir);
    found.push(entry({ key: dir, name: profile.name, minecraft: profile.version, loader: normalizeLoader(profile.loader ?? (profile.fabric ? 'fabric' : 'vanilla'), profile.loader_version, profile.version), gameDir: dir }));
  }
  return found;
}

// --- .minecraft launchers (official, TLauncher, SKLauncher, Legacy Launcher) ------------------

/** Minecraft version and loader of an installed version id, from its JSON (libraries tell the loader). */
async function versionInfo(root, versionId, depth = 0) {
  if (depth > 3) return null;
  const info = await readJson(path.join(root, 'versions', versionId, `${versionId}.json`));
  if (!info) return null;
  const libraries = (info.libraries ?? []).map((library) => String(library.name ?? ''));
  const find = (prefix) => libraries.find((name) => name.startsWith(prefix))?.split(':')[2];
  const parent = info.inheritsFrom ? await versionInfo(root, info.inheritsFrom, depth + 1).catch(() => null) : null;
  // A modded version inherits from the vanilla one; a vanilla version names itself.
  const minecraft = parent?.minecraft ?? info.inheritsFrom ?? info.id;
  let loader = parent?.loader ?? normalizeLoader('vanilla');
  const fabric = find('net.fabricmc:fabric-loader:');
  const quilt = find('org.quiltmc:quilt-loader:');
  const neoforge = find('net.neoforged:neoforge:') ?? find('net.neoforged:forge:');
  const forge = find('net.minecraftforge:forge:') ?? find('net.minecraftforge:fmlloader:');
  if (fabric) loader = normalizeLoader('fabric', fabric, minecraft);
  else if (quilt) loader = normalizeLoader('quilt', quilt, minecraft);
  else if (neoforge || /neoforge/i.test(info.id)) loader = normalizeLoader('neoforge', neoforge ?? null, minecraft);
  else if (forge || /forge/i.test(info.id)) loader = normalizeLoader('forge', forge ?? null, minecraft);
  return { minecraft, loader };
}

async function dotMinecraftInstances(root) {
  const profiles = (await readJson(path.join(root, 'launcher_profiles.json')))?.profiles ?? {};
  const found = [];
  const seen = new Set();
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile?.lastVersionId || profile.type === 'latest-release' || profile.type === 'latest-snapshot') continue;
    const info = await versionInfo(root, profile.lastVersionId);
    if (!info?.minecraft || !/^\d/.test(info.minecraft)) continue;
    const gameDir = profile.gameDir && exists(profile.gameDir) ? profile.gameDir : root;
    const key = `${root}|${id}`;
    if (seen.has(`${gameDir}|${profile.lastVersionId}`)) continue;
    seen.add(`${gameDir}|${profile.lastVersionId}`);
    found.push(entry({ key, name: profile.name || profile.lastVersionId, minecraft: info.minecraft, loader: info.loader, gameDir, shared: gameDir === root }));
  }
  return found;
}

// --- Launchers ------------------------------------------------------------------------------

const LAUNCHERS = [
  { id: 'prism', name: 'Prism Launcher', roots: [path.join(APPDATA, 'PrismLauncher'), path.join(LOCALAPPDATA, 'Programs', 'PrismLauncher')], read: (root) => prismInstances(root, ['prismlauncher.cfg']) },
  { id: 'elyprism', name: 'ElyPrismLauncher', roots: [path.join(APPDATA, 'ElyPrismLauncher')], read: (root) => prismInstances(root, ['elyprismlauncher.cfg', 'prismlauncher.cfg']) },
  { id: 'polymc', name: 'PolyMC', roots: [path.join(APPDATA, 'PolyMC')], read: (root) => prismInstances(root, ['polymc.cfg']) },
  { id: 'multimc', name: 'MultiMC', roots: [path.join(APPDATA, 'MultiMC'), path.join(HOME, 'MultiMC'), 'C:\\MultiMC'], read: (root) => prismInstances(root, ['multimc.cfg']) },
  { id: 'modrinth', name: 'Modrinth App', roots: [path.join(APPDATA, 'ModrinthApp'), path.join(APPDATA, 'com.modrinth.theseus')], read: modrinthInstances },
  { id: 'curseforge', name: 'CurseForge', roots: [path.join(HOME, 'curseforge', 'minecraft', 'Instances'), path.join(HOME, 'Documents', 'Curse', 'Minecraft', 'Instances')], read: curseforgeInstances },
  { id: 'atlauncher', name: 'ATLauncher', roots: [path.join(APPDATA, 'ATLauncher'), path.join(HOME, 'ATLauncher')], read: atlauncherInstances },
  { id: 'gdlauncher', name: 'GDLauncher', roots: [path.join(APPDATA, 'gdlauncher_carbon', 'data', 'instances'), path.join(APPDATA, 'gdlauncher_next', 'instances')], read: gdlauncherInstances },
  { id: 'millida', name: 'Millida Launcher', roots: [path.join(APPDATA, 'net.millida.launcher')], read: millidaInstances },
  { id: 'tlauncher', name: 'TLauncher', roots: [path.join(APPDATA, '.tlauncher', 'legacy', 'Minecraft', 'game')], read: dotMinecraftInstances },
  { id: 'legacy', name: 'Legacy Launcher', roots: [path.join(APPDATA, '.legacylauncher', 'Minecraft', 'game')], read: dotMinecraftInstances },
  { id: 'sklauncher', name: 'SKLauncher', roots: [path.join(APPDATA, '.sklauncher', 'minecraft'), path.join(APPDATA, '.sklauncher')], read: dotMinecraftInstances },
  { id: 'minecraft', name: 'Minecraft Launcher / TLauncher (.minecraft)', roots: [path.join(APPDATA, '.minecraft'), path.join(LOCALAPPDATA, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Roaming', '.minecraft')], read: dotMinecraftInstances },
];

/** Every launcher found on this computer with its instances (only the ones that have some). */
async function scanLaunchers() {
  const result = [];
  for (const launcher of LAUNCHERS) {
    for (const root of launcher.roots) {
      if (!exists(root)) continue;
      try {
        const instances = await launcher.read(root);
        if (!instances.length) continue;
        const described = await Promise.all(instances.map(async (instance) => ({ ...instance, ...(await describe(instance.gameDir)) })));
        result.push({ id: launcher.id, name: launcher.name, root, instances: described.sort((a, b) => a.name.localeCompare(b.name)) });
        break;
      } catch (error) {
        log.warn(`${launcher.name}: сборки не прочитаны (${error.message})`);
      }
    }
  }
  return result;
}

/** Copies the game folder into the new instance, top-level entry by entry (for the progress bar). */
async function copyGameFolder(source, target, { shared, worlds, screenshots }, reporter) {
  const skip = new Set(SKIP);
  if (shared) for (const name of SHARED_SKIP) skip.add(name);
  if (!worlds) skip.add(OPTIONAL.worlds);
  if (!screenshots) skip.add(OPTIONAL.screenshots);
  const entries = (await fsp.readdir(source, { withFileTypes: true })).filter((item) => !skip.has(item.name) && !/\.log(\.gz)?$/i.test(item.name) && !/-installer\.jar(\.log)?$/i.test(item.name));
  let done = 0;
  for (const item of entries) {
    reporter.report('Копирование файлов', 10 + (done / Math.max(1, entries.length)) * 80, item.name);
    await fsp.cp(path.join(source, item.name), path.join(target, item.name), { recursive: true, force: true, errorOnExist: false, preserveTimestamps: true });
    done += 1;
  }
  return done;
}

/**
 * Makes an Amethyx instance from another launcher's instance. The instance is looked up again by
 * its key (the renderer only names it). Options: worlds, screenshots (both copied by default).
 */
async function importFromLauncher(settings, { launcherId, key, name, worlds = true, screenshots = true }) {
  const launcher = LAUNCHERS.find((candidate) => candidate.id === launcherId);
  if (!launcher) throw new Error('Неизвестный лаунчер.');
  let source = null;
  for (const root of launcher.roots) {
    if (!exists(root)) continue;
    source = (await launcher.read(root)).find((instance) => instance.key === key);
    if (source) break;
  }
  if (!source) throw new Error('Сборка не найдена: возможно, её удалили в другом лаунчере.');
  const reporter = createTaskReporter({ taskId: `import:${crypto.randomBytes(4).toString('hex')}`, kind: 'modpack', label: source.name });
  let created = null;
  try {
    reporter.report('Создание сборки', 5, launcher.name);
    created = await instanceService.createInstance(settings, { name: String(name || source.name).slice(0, 64), minecraft: source.minecraft, loader: source.loader, source: { type: 'launcher', launcher: launcher.name } });
    const count = await copyGameFolder(source.gameDir, created.directory, { shared: source.shared, worlds, screenshots }, reporter);
    log.info(`Перенесено из ${launcher.name}: «${source.name}» → «${created.name}», ${count} папок и файлов`);
    reporter.report('Распознавание модов', 92, 'Modrinth');
    let recognised = 0;
    try {
      const { identifyContent } = require('./contentService');
      for (const type of ['mod', 'resourcepack', 'shader']) recognised += await identifyContent(settings, created.id, type);
    } catch (error) {
      log.warn(`Моды не распознаны: ${error.message}`);
    }
    reporter.finish('done', created.name);
    return { instance: created, recognised };
  } catch (error) {
    if (created) await instanceService.deleteInstance(settings, created.id).catch(() => {});
    reporter.finish('error', error.message);
    throw error;
  }
}

module.exports = { scanLaunchers, importFromLauncher, normalizeLoader, millidaFolder, LAUNCHERS };
