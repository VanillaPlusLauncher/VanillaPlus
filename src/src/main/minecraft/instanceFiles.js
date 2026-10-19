'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { shell } = require('electron');
const { analyzeLog } = require('./logAnalyzer');

const gunzip = promisify(zlib.gunzip);

/*
 * What the instance page shows from an instance folder: screenshots, a file browser and the
 * game's logs. Every path comes from the renderer relative to the instance folder and is checked
 * to stay inside it.
 */

const SCREENSHOT_PATTERN = /\.(png|jpe?g)$/i;
const MAX_LOG_BYTES = 6 * 1024 * 1024;
const MAX_OLD_LOGS = 15;
/** Opening these would run them: they are shown in the file manager instead. */
const RUNNABLE = /\.(exe|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|wsh|msi|scr|lnk|jar|sh|command|app)$/i;
/** Launcher's own copy of the last game output (written by gameService). */
const LAST_RUN_LOG = path.join('.amethyx', 'last-run.log');

function insideInstance(directory, relative = '') {
  const root = path.resolve(directory);
  const target = path.resolve(root, ...String(relative).split(/[\\/]+/).filter(Boolean));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Путь выходит за папку сборки.');
  }
  return target;
}

async function statOrNull(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

// --- Screenshots -------------------------------------------------------------------------

async function listScreenshots(directory) {
  const folder = insideInstance(directory, 'screenshots');
  let names;
  try {
    names = await fsp.readdir(folder);
  } catch {
    return [];
  }
  const items = await Promise.all(
    names
      .filter((name) => SCREENSHOT_PATTERN.test(name))
      .map(async (name) => {
        const stat = await statOrNull(path.join(folder, name));
        return stat?.isFile() ? { name, size: stat.size, modifiedAt: stat.mtime.toISOString(), path: path.join(folder, name) } : null;
      }),
  );
  return items.filter(Boolean).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Moves a screenshot to the recycle bin (it can be restored from there). */
async function deleteScreenshot(directory, name) {
  if (!SCREENSHOT_PATTERN.test(String(name)) || /[\\/]/.test(String(name))) {
    throw new Error('Это не скриншот.');
  }
  await shell.trashItem(insideInstance(directory, `screenshots/${name}`));
}

/** Absolute path of a screenshot for the app://instance protocol, or null. */
function screenshotPath(directory, name) {
  if (!SCREENSHOT_PATTERN.test(String(name)) || /[\\/]/.test(String(name))) {
    return null;
  }
  try {
    return insideInstance(directory, `screenshots/${name}`);
  } catch {
    return null;
  }
}

// --- Files -------------------------------------------------------------------------------

/** One folder of the instance: { path, entries: [{ name, dir, size, modifiedAt }] }, folders first. */
async function listFiles(directory, relative = '') {
  const folder = insideInstance(directory, relative);
  const dirents = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const stat = await statOrNull(path.join(folder, dirent.name));
      return {
        name: dirent.name,
        dir: dirent.isDirectory(),
        size: dirent.isDirectory() ? null : stat?.size ?? 0,
        modifiedAt: stat?.mtime.toISOString() ?? null,
      };
    }),
  );
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ru', { numeric: true }));
  return { path: path.relative(path.resolve(directory), folder).split(path.sep).join('/'), entries };
}

/** Opens a file with its program; programs and scripts are only shown in the file manager. */
async function openEntry(directory, relative, { reveal = false } = {}) {
  const target = insideInstance(directory, relative);
  const stat = await statOrNull(target);
  if (!stat) {
    throw new Error('Файл не найден.');
  }
  if (reveal || (stat.isFile() && RUNNABLE.test(target))) {
    shell.showItemInFolder(target);
    return { revealed: true };
  }
  const error = await shell.openPath(target);
  if (error) {
    throw new Error(error);
  }
  return { revealed: false };
}

// --- Logs --------------------------------------------------------------------------------

/**
 * Logs of an instance, newest first: the launcher's copy of the last run, latest.log,
 * crash reports and older archived logs. { id, label, kind, modifiedAt, size }.
 */
async function listLogs(directory) {
  const sources = [];
  const add = async (relative, label, kind) => {
    const stat = await statOrNull(insideInstance(directory, relative));
    if (stat?.isFile()) {
      sources.push({ id: relative.split(path.sep).join('/'), label, kind, modifiedAt: stat.mtime.toISOString(), size: stat.size });
    }
  };
  await add(LAST_RUN_LOG, 'Последний запуск (вывод игры)', 'run');
  await add('logs/latest.log', 'latest.log', 'log');
  await add('logs/debug.log', 'debug.log', 'log');

  const crashes = (await fsp.readdir(insideInstance(directory, 'crash-reports')).catch(() => [])).filter((name) => name.endsWith('.txt'));
  for (const name of crashes) {
    await add(`crash-reports/${name}`, `Отчёт о вылете ${name.replace(/^crash-|-client\.txt$|-server\.txt$|\.txt$/g, '')}`, 'crash');
  }
  const archived = (await fsp.readdir(insideInstance(directory, 'logs')).catch(() => [])).filter((name) => name.endsWith('.log.gz')).sort().reverse().slice(0, MAX_OLD_LOGS);
  for (const name of archived) {
    await add(`logs/${name}`, name.replace(/\.log\.gz$/, ''), 'archive');
  }
  const order = { run: 0, crash: 1, log: 2, archive: 3 };
  return sources.sort((a, b) => (a.kind === 'crash' && b.kind === 'crash' ? b.modifiedAt.localeCompare(a.modifiedAt) : order[a.kind] - order[b.kind] || b.modifiedAt.localeCompare(a.modifiedAt)));
}

/** Text of one log (the end of it when huge) with the problems found in it. */
async function readLog(directory, id) {
  const relative = String(id);
  if (!/^(logs\/[\w.-]+\.log(\.gz)?|crash-reports\/[\w.-]+\.txt|\.amethyx\/last-run\.log)$/.test(relative)) {
    throw new Error('Неизвестный журнал.');
  }
  const target = insideInstance(directory, relative);
  let buffer = await fsp.readFile(target);
  if (relative.endsWith('.gz')) {
    buffer = await gunzip(buffer);
  }
  const truncated = buffer.length > MAX_LOG_BYTES;
  const text = (truncated ? buffer.subarray(buffer.length - MAX_LOG_BYTES) : buffer).toString('utf8');
  return { id: relative, text, truncated, path: target, ...analyzeLog(text) };
}

/** Saves the output of a finished run so the journal can show it after a restart. */
async function saveLastRun(directory, lines) {
  const target = insideInstance(directory, LAST_RUN_LOG);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${lines.join('\n')}\n`);
}

/** Newest crash report written at or after `since` (a Date), or null. */
async function crashReportSince(directory, since) {
  const folder = insideInstance(directory, 'crash-reports');
  const names = (await fsp.readdir(folder).catch(() => [])).filter((name) => name.endsWith('.txt'));
  let newest = null;
  for (const name of names) {
    const stat = await statOrNull(path.join(folder, name));
    if (stat && stat.mtime >= since && (!newest || stat.mtime > newest.mtime)) {
      newest = { name, mtime: stat.mtime };
    }
  }
  if (!newest) {
    return null;
  }
  return { id: `crash-reports/${newest.name}`, text: await fsp.readFile(path.join(folder, newest.name), 'utf8') };
}

module.exports = { listScreenshots, deleteScreenshot, screenshotPath, listFiles, openEntry, listLogs, readLog, saveLastRun, crashReportSince, LAST_RUN_LOG };
