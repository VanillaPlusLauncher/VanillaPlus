'use strict';

const AdmZip = require('adm-zip');

/*
 * Reads what a mod jar says about itself (name, version, authors, icon), for every common loader:
 * fabric.mod.json, quilt.mod.json, META-INF/mods.toml / neoforge.mods.toml and old mcmod.info.
 * Results are cached by file size and modification time.
 */
const MAX_ICON_BYTES = 96 * 1024;
const cache = new Map();

function readText(zip, name) {
  const entry = zip.getEntry(name);
  return entry ? zip.readAsText(entry) : null;
}

function iconDataUrl(zip, iconPath) {
  if (typeof iconPath !== 'string' || !iconPath) {
    return null;
  }
  const entry = zip.getEntry(iconPath.replace(/^\/+/, ''));
  if (!entry || entry.header.size > MAX_ICON_BYTES) {
    return null;
  }
  return `data:image/png;base64,${entry.getData().toString('base64')}`;
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

function readFabric(zip) {
  const text = readText(zip, 'fabric.mod.json');
  if (!text) {
    return null;
  }
  const json = JSON.parse(text.replace(/^﻿/, ''));
  const icon = typeof json.icon === 'string' ? json.icon : Object.values(json.icon ?? {}).pop();
  return { loader: 'fabric', modId: json.id, name: json.name, version: json.version, description: json.description, authors: personNames(json.authors), icon: iconDataUrl(zip, icon), environment: environmentOf(json.environment), incompatible: jsonBreaks(json.breaks) };
}

function readQuilt(zip) {
  const text = readText(zip, 'quilt.mod.json');
  if (!text) {
    return null;
  }
  const loader = JSON.parse(text).quilt_loader ?? {};
  const meta = loader.metadata ?? {};
  const icon = typeof meta.icon === 'string' ? meta.icon : Object.values(meta.icon ?? {}).pop();
  return { loader: 'quilt', modId: loader.id, name: meta.name, version: loader.version, description: meta.description, authors: Object.keys(meta.contributors ?? {}), icon: iconDataUrl(zip, icon), environment: environmentOf(JSON.parse(text).minecraft?.environment), incompatible: jsonBreaks(loader.breaks) };
}

function readForge(zip) {
  for (const [file, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    const text = readText(zip, file);
    if (text) {
      const toml = parseModsToml(text);
      let version = toml.version;
      if (version === '${file.jarVersion}') {
        const manifest = readText(zip, 'META-INF/MANIFEST.MF') ?? '';
        version = /^Implementation-Version:\s*(.+)$/m.exec(manifest)?.[1]?.trim() ?? null;
      }
      // IGNORE_ALL_VERSION tells the game not to require the mod on servers: client-only mods use it.
      const environment = toml.displayTest === 'IGNORE_ALL_VERSION' ? 'client' : null;
      return { loader, modId: toml.modId, name: toml.displayName, version, description: toml.description, authors: toml.authors ? [toml.authors] : [], icon: iconDataUrl(zip, toml.logoFile), environment, incompatible: tomlIncompatible(text) };
    }
  }
  const legacy = readText(zip, 'mcmod.info');
  if (legacy) {
    const json = JSON.parse(legacy.replace(/^﻿/, ''));
    const mod = Array.isArray(json) ? json[0] : json.modList?.[0];
    if (mod) {
      return { loader: 'forge', modId: mod.modid, name: mod.name, version: mod.version, description: mod.description, authors: mod.authorList ?? mod.authors ?? [], icon: iconDataUrl(zip, mod.logoFile) };
    }
  }
  return null;
}

/** pack.mcmeta of resource packs and shader packs: description and pack.png. */
function readPack(zip) {
  const text = readText(zip, 'pack.mcmeta');
  let description = null;
  if (text) {
    try {
      const raw = JSON.parse(text.replace(/^﻿/, '')).pack?.description;
      description = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? part).join('') : (raw?.text ?? null);
    } catch {
      // Broken pack.mcmeta: no description.
    }
  }
  return { description: description?.replace(/§./g, ''), icon: iconDataUrl(zip, 'pack.png') };
}

/** Metadata for a content file, or {} when nothing can be read (not a zip, damaged). */
function readContentMetadata(filePath, stat, type) {
  const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  let result = {};
  try {
    const zip = new AdmZip(filePath);
    result = type === 'mod' ? (readFabric(zip) ?? readQuilt(zip) ?? readForge(zip) ?? {}) : readPack(zip);
  } catch {
    result = {};
  }
  cache.set(key, result);
  return result;
}

module.exports = { readContentMetadata };
