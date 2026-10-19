'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../core/logger');
const { listInstalledVersions } = require('./installedVersions');

/*
 * Earlier launcher builds ran every version in one shared game folder, so worlds and options of
 * all versions were mixed. Now each version has its own instance folder. This moves what the
 * game wrote into the shared folder over to the newest installed version, once: a newer version
 * can open older worlds, the other way round breaks them.
 */

const MARKER_FILE = '.migrated';
/** Files and folders the game itself creates in its game directory. */
const GAME_DATA_ENTRIES = [
  'saves',
  'options.txt',
  'optionsof.txt',
  'optionsshaders.txt',
  'servers.dat',
  'servers.dat_old',
  'screenshots',
  'resourcepacks',
  'texturepacks',
  'texturepacks-mp-cache',
  'shaderpacks',
  'stats',
  'logs',
  'crash-reports',
  'downloads',
  'usercache.json',
  'usernamecache.json',
  'realms_persistence.json',
  'command_history.txt',
  'hotbar.nbt',
  'level.dat',
  'level.dat_old',
  'debug.stitched_items.png',
  'debug.stitched_terrain.png',
  'authlib-injector.log',
];
const log = createLogger('instances');

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Newest installed version by release date, or null when nothing is installed. */
async function newestInstalledVersion(layout) {
  const installed = await listInstalledVersions(layout);
  installed.sort((a, b) => (b.releaseTime ?? '').localeCompare(a.releaseTime ?? ''));
  return installed[0]?.id ?? null;
}

/**
 * Moves game data left in the shared folder into an instance, once per game folder.
 * Returns the version that received it, or null when there was nothing to do.
 */
async function migrateSharedGameData(layout) {
  const markerPath = path.join(layout.instancesDirectory, MARKER_FILE);
  if (await exists(markerPath)) {
    return null;
  }
  const present = [];
  for (const entry of GAME_DATA_ENTRIES) {
    if (await exists(path.join(layout.root, entry))) {
      present.push(entry);
    }
  }
  const targetVersion = present.length > 0 ? await newestInstalledVersion(layout) : null;
  if (present.length > 0 && !targetVersion) {
    return null; // Nothing installed yet: try again on the first launch.
  }

  if (targetVersion) {
    const targetDirectory = layout.instanceDirectory(targetVersion);
    await fsp.mkdir(targetDirectory, { recursive: true });
    for (const entry of present) {
      const destination = path.join(targetDirectory, entry);
      if (await exists(destination)) {
        log.warn(`${entry} уже есть в instances/${targetVersion}, оставляем в общей папке`);
        continue;
      }
      try {
        await fsp.rename(path.join(layout.root, entry), destination);
      } catch (error) {
        log.warn(`Не удалось перенести ${entry}: ${error.message}`);
      }
    }
    log.info(`Данные игры из общей папки перенесены в instances/${targetVersion}`);
  }
  await fsp.mkdir(layout.instancesDirectory, { recursive: true });
  await fsp.writeFile(markerPath, `${new Date().toISOString()} ${targetVersion ?? '-'}\n`);
  return targetVersion;
}

module.exports = { migrateSharedGameData };
