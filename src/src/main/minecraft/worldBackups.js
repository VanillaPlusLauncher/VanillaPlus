'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../core/logger');
const { SerialQueue } = require('../core/serialQueue');

/*
 * World backups of an instance: zip archives in <instance>/.amethyx/backups with an index.
 * Made by hand or automatically before risky changes (mod updates, another Minecraft version);
 * restoring keeps a copy of the current world first, so a restore can itself be undone.
 * Archives are written by the bsdtar that ships with Windows, in its own process: big worlds do
 * not freeze the launcher.
 */

const AUTO_KEEP = 5;
const INDEX = 'index.json';
const log = createLogger('backups');
const queue = new SerialQueue();

function backupsDirectory(instanceDirectory) {
  return path.join(instanceDirectory, '.amethyx', 'backups');
}

function tarPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

/** bsdtar reads "C:" in a path as a remote host: it only ever gets paths relative to `cwd`. */
function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarPath(), args, { cwd, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar завершился с кодом ${code}`))));
  });
}

async function readIndex(instanceDirectory) {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(backupsDirectory(instanceDirectory), INDEX), 'utf8'));
    return Array.isArray(data.backups) ? data.backups : [];
  } catch {
    return [];
  }
}

async function writeIndex(instanceDirectory, backups) {
  const directory = backupsDirectory(instanceDirectory);
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, INDEX);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify({ backups }, null, 2));
  await fsp.rename(`${file}.tmp`, file);
}

function assertWorldName(world) {
  const name = String(world ?? '');
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error('Неверное имя мира.');
  }
  return name;
}

async function worldNames(instanceDirectory) {
  const saves = path.join(instanceDirectory, 'saves');
  const entries = await fsp.readdir(saves, { withFileTypes: true }).catch(() => []);
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await fsp.stat(path.join(saves, entry.name, 'level.dat')).catch(() => null))) {
      names.push(entry.name);
    }
  }
  return names;
}

/** Backups of an instance, newest first: [{ id, world, createdAt, size, reason, auto }]. */
async function listBackups(instanceDirectory) {
  const backups = await readIndex(instanceDirectory);
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Zips one world. `reason` is shown in the list; automatic backups are pruned to the last few. */
function createBackup(instanceDirectory, world, { reason = 'Вручную', auto = false } = {}) {
  return queue.run(async () => {
    const name = assertWorldName(world);
    if (!(await fsp.stat(path.join(instanceDirectory, 'saves', name)).catch(() => null))) {
      throw new Error(`Мир «${name}» не найден.`);
    }
    const createdAt = new Date().toISOString();
    const id = `${createdAt.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
    const relativeZip = path.join('.amethyx', 'backups', `${id}.zip`);
    await fsp.mkdir(backupsDirectory(instanceDirectory), { recursive: true });
    // -a picks the format from the extension (.zip); entries are "saves/<world>/…".
    await runTar(['-a', '-c', '-f', relativeZip, path.join('saves', name)], instanceDirectory);
    const size = (await fsp.stat(path.join(instanceDirectory, relativeZip))).size;
    const backups = await readIndex(instanceDirectory);
    backups.push({ id, world: name, createdAt, size, reason, auto });
    // Keep the last few automatic copies of each world; copies made by hand stay.
    const autoOfWorld = backups.filter((backup) => backup.auto && backup.world === name).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of autoOfWorld.slice(AUTO_KEEP)) {
      await fsp.rm(path.join(backupsDirectory(instanceDirectory), `${old.id}.zip`), { force: true });
      backups.splice(backups.indexOf(old), 1);
    }
    await writeIndex(instanceDirectory, backups);
    log.info(`Копия мира «${name}» (${reason}): ${Math.round(size / 1024)} КБ`);
    return { id, world: name, createdAt, size, reason, auto };
  });
}

/** Backs up every world of an instance before a risky change. Returns how many were saved. */
async function backupAllWorlds(instanceDirectory, reason) {
  let count = 0;
  for (const world of await worldNames(instanceDirectory)) {
    try {
      await createBackup(instanceDirectory, world, { reason, auto: true });
      count += 1;
    } catch (error) {
      log.warn(`Копия мира «${world}» не сделана: ${error.message}`);
    }
  }
  return count;
}

/**
 * Puts a world back as it was in a backup. The current world is backed up first and moved aside
 * while extracting, so nothing is lost if extracting fails.
 */
function restoreBackup(instanceDirectory, id) {
  return queue.run(async () => {
    const backups = await readIndex(instanceDirectory);
    const backup = backups.find((candidate) => candidate.id === id);
    if (!backup) {
      throw new Error('Копия не найдена.');
    }
    const world = assertWorldName(backup.world);
    const worldDirectory = path.join(instanceDirectory, 'saves', world);
    const aside = `${worldDirectory}.restore-${Date.now()}`;
    const exists = Boolean(await fsp.stat(worldDirectory).catch(() => null));
    if (exists) {
      // A copy of what is replaced: the restore can be undone from the same list.
      const createdAt = new Date().toISOString();
      const safetyId = `${createdAt.replace(/[:.]/g, '-')}-before-restore`;
      await runTar(['-a', '-c', '-f', path.join('.amethyx', 'backups', `${safetyId}.zip`), path.join('saves', world)], instanceDirectory);
      const size = (await fsp.stat(path.join(backupsDirectory(instanceDirectory), `${safetyId}.zip`))).size;
      backups.push({ id: safetyId, world, createdAt, size, reason: 'Перед восстановлением', auto: false });
      await writeIndex(instanceDirectory, backups);
      await fsp.rename(worldDirectory, aside);
    }
    try {
      await runTar(['-x', '-f', path.join('.amethyx', 'backups', `${backup.id}.zip`)], instanceDirectory);
    } catch (error) {
      await fsp.rm(worldDirectory, { recursive: true, force: true }).catch(() => {});
      if (exists) await fsp.rename(aside, worldDirectory).catch(() => {});
      throw new Error(`Не удалось восстановить мир: ${error.message}`);
    }
    if (exists) await fsp.rm(aside, { recursive: true, force: true }).catch(() => {});
    log.info(`Мир «${world}» восстановлен из копии ${backup.createdAt}`);
    return { world };
  });
}

function deleteBackup(instanceDirectory, id) {
  return queue.run(async () => {
    const backups = await readIndex(instanceDirectory);
    const index = backups.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    await fsp.rm(path.join(backupsDirectory(instanceDirectory), `${backups[index].id}.zip`), { force: true });
    backups.splice(index, 1);
    await writeIndex(instanceDirectory, backups);
  });
}

module.exports = { listBackups, createBackup, backupAllWorlds, restoreBackup, deleteBackup, worldNames };
