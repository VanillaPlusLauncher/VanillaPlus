'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { SerialQueue } = require('../core/serialQueue');
const { createLogger } = require('../core/logger');
const { listInstalledVersions } = require('./installedVersions');

/*
 * Instances ("сборки"), as in Prism Launcher: each one is a folder in <game>/instances with its own
 * worlds, mods, resource packs and settings, plus instance.json describing the Minecraft version,
 * the mod loader, the group it is shown in and per-instance overrides.
 * The folder name (id) never changes; the visible name can.
 */

const INSTANCE_FILE = 'instance.json';
const MIGRATION_MARKER = '.instances-v2';
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const OVERRIDE_KEYS = [
  'ramMb',
  'extraJvmArgs',
  'javaPath',
  'gameWidth',
  'gameHeight',
  'fullscreen',
  'joinServer',
  'extraGameArgs',
  'preLaunchCommand',
  'postExitCommand',
  'afterLaunch',
  'autoUpdateMods',
  // Shader optimization's choices: { enabled, auto, level, pack } (content/shaderService.js).
  'shaders',
];
const writeQueue = new SerialQueue();
const log = createLogger('instances');

function instanceFile(layout, id) {
  return path.join(layout.instanceDirectory(id), INSTANCE_FILE);
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

/** Keeps known fields with valid types, so a hand-edited file cannot break the launcher. */
function normalize(raw, id) {
  const loaderType = LOADERS.includes(raw?.loader?.type) ? raw.loader.type : 'vanilla';
  const overrides = {};
  for (const key of OVERRIDE_KEYS) {
    const value = raw?.overrides?.[key];
    if (value !== undefined && value !== null && value !== '') {
      overrides[key] = value;
    }
  }
  return {
    id,
    name: cleanText(raw?.name, 64) || id,
    group: cleanText(raw?.group, 40),
    icon: cleanText(raw?.icon, 400) || 'grass_block',
    minecraft: cleanText(raw?.minecraft, 64),
    loader: { type: loaderType, version: loaderType === 'vanilla' ? null : cleanText(raw?.loader?.version, 64) || null },
    versionId: cleanText(raw?.versionId, 96) || null,
    createdAt: raw?.createdAt ?? new Date().toISOString(),
    lastPlayedAt: raw?.lastPlayedAt ?? null,
    playTimeMs: Number.isFinite(raw?.playTimeMs) ? raw.playTimeMs : 0,
    notes: cleanText(raw?.notes, 2000),
    overrides,
    source: raw?.source && typeof raw.source === 'object' ? raw.source : null,
  };
}

/** Folder name for a new instance: readable, safe on Windows, unique. */
async function allocateId(layout, name) {
  const base =
    String(name)
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 48) || 'instance';
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? `${base}_` : base;
  let candidate = reserved;
  for (let counter = 2; ; counter += 1) {
    try {
      await fsp.access(layout.instanceDirectory(candidate));
      candidate = `${reserved} (${counter})`;
    } catch {
      return candidate;
    }
  }
}

/** Guesses Minecraft version and loader of an installed version id (used when migrating old builds). */
async function describeInstalledVersion(layout, versionId) {
  const raw = await readJsonFile(layout.versionJsonPath(versionId), null);
  const minecraft = raw?.inheritsFrom ?? versionId;
  const lower = versionId.toLowerCase();
  let type = 'vanilla';
  let version = null;
  const fabric = /^(fabric|quilt)-loader-(.+)-(.+)$/.exec(versionId);
  if (fabric) {
    type = fabric[1];
    version = fabric[2];
  } else if (lower.includes('neoforge')) {
    type = 'neoforge';
    version = versionId.replace(/^neoforge-/i, '');
  } else if (lower.includes('forge')) {
    type = 'forge';
    version = versionId;
  }
  return { minecraft, loader: { type, version }, versionId };
}

/**
 * One-time move from "one build per Minecraft version" to instances: every existing instance
 * folder and every installed version gets an instance.json, so worlds stay where they are.
 */
async function migrateLegacyBuilds(layout) {
  const marker = path.join(layout.instancesDirectory, MIGRATION_MARKER);
  try {
    await fsp.access(marker);
    return;
  } catch {
    // Not migrated yet.
  }
  await fsp.mkdir(layout.instancesDirectory, { recursive: true });
  const installed = await listInstalledVersions(layout);
  const candidates = new Set(installed.map((version) => version.id));
  for (const entry of await fsp.readdir(layout.instancesDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidates.add(entry.name);
    }
  }
  for (const id of candidates) {
    if (await readJsonFile(instanceFile(layout, id), null)) {
      continue;
    }
    const known = installed.some((version) => version.id === id);
    const description = known ? await describeInstalledVersion(layout, id) : { minecraft: id, loader: { type: 'vanilla', version: null }, versionId: id };
    await writeJsonFileAtomic(instanceFile(layout, id), normalize({ name: id, ...description }, id));
    log.info(`Сборка ${id} перенесена в новую систему сборок`);
  }
  await fsp.writeFile(marker, new Date().toISOString());
}

async function listInstances(layout) {
  await migrateLegacyBuilds(layout);
  let entries = [];
  try {
    entries = await fsp.readdir(layout.instancesDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const instances = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const raw = await readJsonFile(instanceFile(layout, entry.name), null);
    if (raw) {
      instances.push(normalize(raw, entry.name));
    }
  }
  return instances;
}

async function getInstance(layout, id) {
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    throw new Error('Некорректная сборка.');
  }
  const raw = await readJsonFile(instanceFile(layout, id), null);
  if (!raw) {
    throw new Error('Сборка не найдена. Возможно, её папку удалили.');
  }
  return normalize(raw, id);
}

function createInstance(layout, fields) {
  return writeQueue.run(async () => {
    const name = cleanText(fields.name, 64) || fields.minecraft || 'Новая сборка';
    const id = await allocateId(layout, name);
    const instance = normalize({ ...fields, name, createdAt: new Date().toISOString() }, id);
    await fsp.mkdir(layout.instanceDirectory(id), { recursive: true });
    await writeJsonFileAtomic(instanceFile(layout, id), instance);
    log.info(`Создана сборка «${instance.name}» (${id})`);
    return instance;
  });
}

/** Applies a patch to an instance. `overrides` is merged; null values remove an override. */
function updateInstance(layout, id, patch) {
  return writeQueue.run(async () => {
    const current = await getInstance(layout, id);
    const overrides = { ...current.overrides };
    for (const [key, value] of Object.entries(patch.overrides ?? {})) {
      if (value === null || value === '' || value === undefined) {
        delete overrides[key];
      } else {
        overrides[key] = value;
      }
    }
    const loaderChanged =
      patch.minecraft !== undefined || (patch.loader && (patch.loader.type !== current.loader.type || patch.loader.version !== current.loader.version));
    const next = normalize(
      {
        ...current,
        ...patch,
        loader: patch.loader ?? current.loader,
        overrides,
        // A different version or loader must be installed again before the next launch. An explicit
        // null also clears it: `null ?? current` used to keep the old (vanilla) id, so Fabric chosen
        // for a vanilla instance was never installed and the game started without it.
        versionId: patch.versionId !== undefined ? patch.versionId : loaderChanged ? null : current.versionId,
      },
      id,
    );
    await writeJsonFileAtomic(instanceFile(layout, id), next);
    return next;
  });
}

function deleteInstance(layout, id) {
  return writeQueue.run(async () => {
    await getInstance(layout, id);
    await fsp.rm(layout.instanceDirectory(id), { recursive: true, force: true });
    log.info(`Сборка ${id} удалена`);
  });
}

/** Copies an instance folder (worlds, mods, configs) under a new name. */
function duplicateInstance(layout, id, name) {
  return writeQueue.run(async () => {
    const source = await getInstance(layout, id);
    const newName = cleanText(name, 64) || `${source.name} (копия)`;
    const newId = await allocateId(layout, newName);
    await fsp.cp(layout.instanceDirectory(id), layout.instanceDirectory(newId), { recursive: true });
    const copy = normalize({ ...source, name: newName, createdAt: new Date().toISOString(), lastPlayedAt: null, playTimeMs: 0 }, newId);
    await writeJsonFileAtomic(instanceFile(layout, newId), copy);
    return copy;
  });
}

module.exports = {
  listInstances,
  getInstance,
  createInstance,
  updateInstance,
  deleteInstance,
  duplicateInstance,
  describeInstalledVersion,
  LOADERS,
  OVERRIDE_KEYS,
};
