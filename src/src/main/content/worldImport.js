'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractArchive } = require('../core/archive');
const { createLogger } = require('../core/logger');

/*
 * A map — a world in an archive — into an instance: saves/<name>. Archives from map sites hold the
 * world folder itself, a folder around it, a few worlds at once, or the world's files at the top; a
 * world is a folder with level.dat. The archive is unpacked next to the instance's saves first (the
 * same disk, so the world is then only moved in) and each world goes in under a free name.
 */
const log = createLogger('maps');
const MAX_DEPTH = 4;

const exists = (target) => fsp.stat(target).then(() => true, () => false);

/** Folders with level.dat, not looking inside a world (its DIM folders are not worlds of their own). */
async function findWorlds(directory, depth = 0, found = []) {
  if (await exists(path.join(directory, 'level.dat'))) {
    found.push(directory);
    return found;
  }
  if (depth >= MAX_DEPTH) return found;
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== '__MACOSX') await findWorlds(path.join(directory, entry.name), depth + 1, found);
  }
  return found;
}

/** A free folder name in saves/, from the world's own folder or the map's title. */
async function freeName(savesDirectory, wanted) {
  const base = String(wanted ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim().slice(0, 60) || 'Карта';
  let name = base;
  for (let index = 2; await exists(path.join(savesDirectory, name)); index += 1) name = `${base} ${index}`;
  return name;
}

/**
 * Unpacks the map archive `archivePath` into `instanceDirectory`/saves. `title` names a world whose
 * files lie at the top of the archive. Resolves with the names of the worlds put in.
 */
async function importWorldArchive(instanceDirectory, archivePath, title) {
  const saves = path.join(instanceDirectory, 'saves');
  const work = path.join(instanceDirectory, '.amethyx', `map-${crypto.randomUUID()}`);
  await fsp.mkdir(work, { recursive: true });
  await fsp.mkdir(saves, { recursive: true });
  try {
    try {
      await extractArchive(archivePath, work);
    } catch (error) {
      log.warn(`Архив карты не распаковался: ${error.message}`);
      throw new Error('Не получилось распаковать архив карты. Подходят zip и rar с миром Minecraft Java.');
    }
    const worlds = await findWorlds(work);
    if (worlds.length === 0) {
      throw new Error('В архиве нет мира Minecraft Java (папки с level.dat). Возможно, это карта для Bedrock.');
    }
    const names = [];
    for (const world of worlds) {
      const name = await freeName(saves, world === work ? title : path.basename(world));
      await fsp.rename(world, path.join(saves, name));
      // A lock left by the author's game would stop the world from opening.
      await fsp.rm(path.join(saves, name, 'session.lock'), { force: true });
      names.push(name);
    }
    log.info(`Карта «${title}» → ${names.join(', ')}`);
    return names;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { importWorldArchive, findWorlds };
