'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { openZip } = require('../core/zipPeek');

/*
 * Reads what a mod jar says about itself (name, version, authors, icon), for every common loader:
 * fabric.mod.json, quilt.mod.json, META-INF/mods.toml / neoforge.mods.toml and old mcmod.info.
 * Only those few files are read from the jar (core/zipPeek.js), asynchronously, so a pack of 200
 * mods does not hold up the launcher. Results are cached by path, size and modification time, in
 * memory and on disk (<userData>/cache/content-meta.json), so the next start reads nothing at all.
 */
const MAX_ICON_BYTES = 96 * 1024;
const MAX_CACHED = 6000;
const SAVE_DELAY_MS = 2000;
/** Raised when the readers learn something new: older entries are read again once. */
const CACHE_VERSION = 3;
const cache = new Map();
let diskCacheFile = null;
let diskLoaded = null;
let saveTimer = null;

/** What the readers below need from a zip: async text, bytes and sizes of entries. */
function peekSource(zip) {
  return {
    size: (name) => zip.size(name),
    readText: async (name) => (zip.has(name) ? (await zip.read(name))?.toString('utf8') ?? null : null),
    readBuffer: (name) => zip.read(name),
  };
}

/** The same over adm-zip, for archives zipPeek does not read (ZIP64 and other oddities). */
function admSource(filePath) {
  const zip = new AdmZip(filePath);
  return {
    size: (name) => zip.getEntry(name)?.header.size ?? null,
    readText: async (name) => {
      const entry = zip.getEntry(name);
      return entry ? zip.readAsText(entry) : null;
    },
    readBuffer: async (name) => zip.getEntry(name)?.getData() ?? null,
  };
}

function readText(zip, name) {
  return zip.readText(name);
}

async function iconDataUrl(zip, iconPath) {
  if (typeof iconPath !== 'string' || !iconPath) {
    return null;
  }
  const name = iconPath.replace(/^\/+/, '');
  const size = zip.size(name);
  if (size === null || size > MAX_ICON_BYTES) {
    return null;
  }
  const data = await zip.readBuffer(name);
  return data ? `data:image/png;base64,${data.toString('base64')}` : null;
}

/** Where a mod runs, from its own file: 'client', 'server', 'both' or null. */
function environmentOf(value) {
  if (value === 'client') return 'client';
  if (value === 'server' || value === 'dedicated_server') return 'server';
  if (value === '*') return 'both';
  return null;
}

function personNames(list) {
  return (list ?? []).map((person) => (typeof person === 'string' ? person : person?.name)).filter(Boolean);
}

/** Minimal TOML reading for the first [[mods]] table: only simple key = "value" lines are needed. */
function parseModsToml(text) {
  const result = {};
  const block = text.split(/^\s*\[\[mods\]\]\s*$/m)[1] ?? '';
  const section = block.split(/^\s*\[/m)[0];
  for (const key of ['modId', 'version', 'displayName', 'description', 'authors', 'logoFile', 'displayTest']) {
    const triple = new RegExp(`^\\s*${key}\\s*=\\s*'''([\\s\\S]*?)'''`, 'm').exec(section);
    const plain = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(section);
    const value = triple?.[1] ?? plain?.[1];
    if (value !== undefined) {
      result[key] = value.trim();
    }
  }
  const topLogo = /^\s*logoFile\s*=\s*"([^"]*)"/m.exec(text.split(/^\s*\[\[mods\]\]/m)[0]);
  result.logoFile ??= topLogo?.[1];
  return result;
}

/** Mods a NeoForge / Forge mod says it cannot run with: [{ modId, versionRange, reason }]. */
function tomlIncompatible(text) {
  const result = [];
  for (const block of text.split(/^\s*\[\[dependencies\.[^\]]+\]\]\s*$/m).slice(1)) {
    const section = block.split(/^\s*\[/m)[0];
    const value = (key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(section)?.[1];
    if (value('type')?.toLowerCase() === 'incompatible' && value('modId')) {
      result.push({ modId: value('modId'), versionRange: value('versionRange') ?? null, reason: value('reason') ?? null });
    }
  }
  return result;
}

/** Fabric "breaks" ({ id: range | [ranges] }) and Quilt "breaks" ([id | { id, versions }]). */
function jsonBreaks(breaks) {
  if (Array.isArray(breaks)) {
    return breaks
      .map((item) => (typeof item === 'string' ? { modId: item, versionRange: null } : { modId: item?.id, versionRange: typeof item?.versions === 'string' ? item.versions : null }))
      .filter((item) => item.modId)
      .map((item) => ({ ...item, reason: null }));
  }
  return Object.entries(breaks ?? {}).map(([modId, range]) => ({ modId, versionRange: typeof range === 'string' ? range : Array.isArray(range) ? range.join(' || ') : null, reason: null }));
}

async function readFabric(zip) {
  const text = await readText(zip, 'fabric.mod.json');
  if (!text) {
    return null;
  }
  const json = JSON.parse(text.replace(/^﻿/, ''));
  const icon = typeof json.icon === 'string' ? json.icon : Object.values(json.icon ?? {}).pop();
  return { loader: 'fabric', modId: json.id, name: json.name, version: json.version, description: json.description, authors: personNames(json.authors), icon: await iconDataUrl(zip, icon), environment: environmentOf(json.environment), incompatible: jsonBreaks(json.breaks) };
}

async function readQuilt(zip) {
  const text = await readText(zip, 'quilt.mod.json');
  if (!text) {
    return null;
  }
  const loader = JSON.parse(text).quilt_loader ?? {};
  const meta = loader.metadata ?? {};
  const icon = typeof meta.icon === 'string' ? meta.icon : Object.values(meta.icon ?? {}).pop();
  return { loader: 'quilt', modId: loader.id, name: meta.name, version: loader.version, description: meta.description, authors: Object.keys(meta.contributors ?? {}), icon: await iconDataUrl(zip, icon), environment: environmentOf(JSON.parse(text).minecraft?.environment), incompatible: jsonBreaks(loader.breaks) };
}

async function readForge(zip) {
  for (const [file, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    const text = await readText(zip, file);
    if (text) {
      const toml = parseModsToml(text);
      let version = toml.version;
      if (version === '${file.jarVersion}') {
        const manifest = (await readText(zip, 'META-INF/MANIFEST.MF')) ?? '';
        version = /^Implementation-Version:\s*(.+)$/m.exec(manifest)?.[1]?.trim() ?? null;
      }
      // A client-only mod says so: "clientSideOnly = true" (Forge 1.19+, NeoForge), or displayTest
      // IGNORE_SERVER_VERSION ("the server may not have me"). IGNORE_ALL_VERSION is used by mods that
      // are optional on both sides (server-only tools too), so it says nothing about the side.
      const clientOnly = /^\s*clientSideOnly\s*=\s*true\b/m.test(text) || toml.displayTest === 'IGNORE_SERVER_VERSION';
      const environment = clientOnly ? 'client' : null;
      return { loader, modId: toml.modId, name: toml.displayName, version, description: toml.description, authors: toml.authors ? [toml.authors] : [], icon: await iconDataUrl(zip, toml.logoFile), environment, incompatible: tomlIncompatible(text) };
    }
  }
  const legacy = await readText(zip, 'mcmod.info');
  if (legacy) {
    const json = JSON.parse(legacy.replace(/^﻿/, ''));
    const mod = Array.isArray(json) ? json[0] : json.modList?.[0];
    if (mod) {
      return { loader: 'forge', modId: mod.modid, name: mod.name, version: mod.version, description: mod.description, authors: mod.authorList ?? mod.authors ?? [], icon: await iconDataUrl(zip, mod.logoFile) };
    }
  }
  return null;
}

/** pack.mcmeta of resource packs and shader packs: description and pack.png. */
async function readPack(zip) {
  const text = await readText(zip, 'pack.mcmeta');
  let description = null;
  if (text) {
    try {
      const raw = JSON.parse(text.replace(/^﻿/, '')).pack?.description;
      description = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? part).join('') : (raw?.text ?? null);
    } catch {
      // Broken pack.mcmeta: no description.
    }
  }
  return { description: description?.replace(/§./g, ''), icon: await iconDataUrl(zip, 'pack.png') };
}

/**
 * The files each loader looks for in a mod jar: its descriptor, or a service it loads the jar through
 * without one. CustomSkinLoader's "Universal" jar has only fabric.mod.json and comes into Forge and
 * NeoForge as a mod locator and a transformation service (both loaders run on ModLauncher).
 */
const DESCRIPTORS = [
  ['fabric.mod.json', ['fabric']],
  ['quilt.mod.json', ['quilt']],
  ['META-INF/neoforge.mods.toml', ['neoforge']],
  ['META-INF/mods.toml', ['forge']],
  ['mcmod.info', ['forge-legacy']],
  ['META-INF/services/net.neoforged.neoforgespi.locating.IModFileCandidateLocator', ['neoforge']],
  ['META-INF/services/net.neoforged.neoforgespi.locating.IModLocator', ['neoforge']],
  ['META-INF/services/net.neoforged.neoforgespi.locating.IDependencyLocator', ['neoforge']],
  ['META-INF/services/net.minecraftforge.forgespi.locating.IModLocator', ['forge']],
  ['META-INF/services/net.minecraftforge.fml.loading.moddiscovery.IModLocator', ['forge']],
  ['META-INF/services/cpw.mods.modlauncher.api.ITransformationService', ['forge', 'neoforge']],
];

async function readFrom(zip, type) {
  if (type !== 'mod') {
    return readPack(zip);
  }
  const meta = (await readFabric(zip)) ?? (await readQuilt(zip)) ?? (await readForge(zip)) ?? {};
  // Every loader the jar is made for: some jars carry several descriptors (one jar for Fabric and NeoForge).
  const loaders = [...new Set(DESCRIPTORS.filter(([file]) => zip.size(file) !== null).flatMap(([, names]) => names))];
  return loaders.length ? { ...meta, loaders } : meta;
}

/** The disk cache, read once (a missing or broken file is just an empty cache). */
function loadDiskCache() {
  if (!diskLoaded) {
    diskLoaded = (async () => {
      try {
        const { app } = require('electron');
        diskCacheFile = path.join(app.getPath('userData'), 'cache', 'content-meta.json');
        const saved = JSON.parse(await fsp.readFile(diskCacheFile, 'utf8'));
        if (saved?.version === CACHE_VERSION) {
          for (const [key, value] of Object.entries(saved.entries ?? {})) if (!cache.has(key)) cache.set(key, value);
        }
      } catch {
        // First start or no electron (tests): nothing cached yet.
      }
    })();
  }
  return diskLoaded;
}

function scheduleSave() {
  if (!diskCacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // The oldest entries go first when the cache is full.
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    const text = JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(cache) });
    fs.mkdirSync(path.dirname(diskCacheFile), { recursive: true });
    fsp.writeFile(`${diskCacheFile}.tmp`, text).then(() => fsp.rename(`${diskCacheFile}.tmp`, diskCacheFile)).catch(() => {});
  }, SAVE_DELAY_MS);
  saveTimer.unref?.();
}

/** Metadata for a content file, or {} when nothing can be read (not a zip, damaged). */
async function readContentMetadata(filePath, stat, type) {
  await loadDiskCache();
  const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  let result = {};
  const peek = await openZip(filePath).catch(() => null);
  try {
    result = await readFrom(peek ? peekSource(peek) : admSource(filePath), type);
  } catch {
    result = {};
  } finally {
    await peek?.close().catch(() => {});
  }
  cache.set(key, result);
  scheduleSave();
  return result;
}

module.exports = { readContentMetadata };
