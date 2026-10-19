'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/*
 * The launcher used to be called RichLauncher, then Vanilla+ Launcher. Their folders are renamed on
 * the first start of Amethyx, so settings, accounts, skins, downloaded Java and instances carry over:
 *   %APPDATA%\VanillaPlus or RichLauncher      -> %APPDATA%\Amethyx      (launcher data)
 *   %APPDATA%\.vanillaplus or .richlauncher    -> %APPDATA%\.amethyx     (default game folder)
 *   <instance>\.vanillaplus or .richlauncher   -> <instance>\.amethyx    (installed content, icon, last run log)
 * The newer old name is tried first. Full paths saved in settings.json and instance.json (a picked
 * Java, a chosen game folder) are rewritten to the new folders. When a folder cannot be renamed
 * (something holds it open), the old one keeps being used.
 */

const USER_DATA_NAME = 'Amethyx';
const OLD_USER_DATA_NAMES = ['VanillaPlus', 'RichLauncher'];
const GAME_FOLDER = '.amethyx';
const OLD_GAME_FOLDERS = ['.vanillaplus', '.richlauncher'];
const INSTANCE_META = '.amethyx';
const OLD_INSTANCE_METAS = ['.vanillaplus', '.richlauncher'];
/** Default theme colours of the old names; they become Amethyx's amethyst. A colour picked by hand stays. */
const OLD_DEFAULT_ACCENTS = ['emerald', 'vanilla'];

const notes = [];
/** [old absolute path, new absolute path] of every folder moved in this start. */
const moved = [];
let gameDirectoryCache = null;

/** Files (not folders) anywhere inside a folder, stopping at the first one. */
function hasAnyFile(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => (entry.isDirectory() ? hasAnyFile(path.join(directory, entry.name)) : true));
}

function hasEntries(directory) {
  try {
    return fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

/** What counts as "this folder holds the user's data" for each kind of folder. */
const HOLDS_DATA = {
  userData: (directory) => fs.existsSync(path.join(directory, 'settings.json')) || fs.existsSync(path.join(directory, 'accounts.json')),
  game: (directory) => hasEntries(path.join(directory, 'instances')) || hasEntries(path.join(directory, 'versions')),
  instance: (directory) => hasAnyFile(directory),
};

/**
 * Renames `from` to `to` unless `to` already holds data. A `to` that exists but is empty (made by
 * an earlier start before the old folder could be moved, or by a test run) does not block the move:
 * it is deleted when it has no files at all, otherwise kept aside as "<name>.empty-<time>".
 */
function renameIfNeeded(from, to, kind) {
  const holdsData = HOLDS_DATA[kind] ?? (() => true);
  if (fs.existsSync(to)) {
    if (holdsData(to) || !fs.existsSync(from) || !holdsData(from)) {
      return to;
    }
    try {
      if (hasAnyFile(to)) {
        fs.renameSync(to, `${to}.empty-${Date.now()}`);
      } else {
        fs.rmSync(to, { recursive: true, force: true });
      }
    } catch (error) {
      notes.push(`Пустая папка ${to} мешает переносу (${error.code ?? error.message}), используется старая: ${from}`);
      return from;
    }
  }
  if (!fs.existsSync(from)) {
    return null;
  }
  try {
    fs.renameSync(from, to);
    moved.push([from, to]);
    notes.push(`Папка перенесена: ${from} -> ${to}`);
    return to;
  } catch (error) {
    notes.push(`Папку не удалось перенести (${error.code ?? error.message}), используется старая: ${from}`);
    return from;
  }
}

/**
 * Moves the first old folder (in `parent`) that holds data to `name`. Returns the folder to use:
 * the new one, an old one that could not be moved, or null when none of them exists.
 */
function renameFromOldNames(parent, oldNames, name, kind) {
  const target = path.join(parent, name);
  let result = null;
  for (const oldName of oldNames) {
    result = renameIfNeeded(path.join(parent, oldName), target, kind) ?? result;
    if (result && (result !== target || HOLDS_DATA[kind](target))) {
      return result;
    }
  }
  return result;
}

/** Rewrites moved folder paths inside a JSON file (paths are stored with escaped backslashes). */
async function rewritePaths(file) {
  if (moved.length === 0) {
    return;
  }
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return;
  }
  let next = text;
  for (const [from, to] of moved) {
    next = next.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  }
  if (next !== text) {
    await fsp.writeFile(file, next);
  }
}

/**
 * Picks the launcher data folder before anything reads it (call before app.whenReady and the
 * single-instance lock, which lives in that folder). An explicit --user-data-dir is left alone.
 */
function setupUserData(app) {
  if (app.commandLine.hasSwitch('user-data-dir')) {
    return;
  }
  const appData = app.getPath('appData');
  app.setPath('userData', renameFromOldNames(appData, OLD_USER_DATA_NAMES, USER_DATA_NAME, 'userData') ?? path.join(appData, USER_DATA_NAME));
}

/** Default game folder: the new name, or an old one when it could not be renamed. */
function defaultGameDirectory(app) {
  if (!gameDirectoryCache) {
    const appData = app.getPath('appData');
    const target = path.join(appData, GAME_FOLDER);
    // A run with its own --user-data-dir (portable or test copy) never moves the real game folder.
    gameDirectoryCache = app.commandLine.hasSwitch('user-data-dir') ? target : (renameFromOldNames(appData, OLD_GAME_FOLDERS, GAME_FOLDER, 'game') ?? target);
  }
  return gameDirectoryCache;
}

/** The old names' default colours become the amethyst one; a colour picked by hand stays. */
async function switchToAmethystAccent(settingsFile) {
  if (!moved.some(([, to]) => settingsFile.startsWith(to + path.sep))) {
    return;
  }
  try {
    const settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
    if (OLD_DEFAULT_ACCENTS.includes(settings?.ui?.accent)) {
      settings.ui.accent = 'amethyst';
      await fsp.writeFile(settingsFile, JSON.stringify(settings, null, 2));
    }
  } catch {
    // No settings yet: the defaults already use the new colour.
  }
}

/**
 * After the folders: saved paths in settings and instances follow them, and every instance's
 * own launcher folder gets the new name.
 */
async function finishMigration({ settingsFile, gameDirectory }) {
  await rewritePaths(settingsFile);
  await switchToAmethystAccent(settingsFile);
  // Read after the rewrite: a game folder chosen by hand may have been one of the moved ones.
  const instances = path.join(await gameDirectory(), 'instances');
  let entries = [];
  try {
    entries = await fsp.readdir(instances, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(instances, entry.name);
    renameFromOldNames(directory, OLD_INSTANCE_METAS, INSTANCE_META, 'instance');
    await rewritePaths(path.join(directory, 'instance.json'));
  }
}

/** What the migration did, for the log (read once the logger is ready). */
function takeMigrationNotes() {
  return notes.splice(0, notes.length);
}

module.exports = { setupUserData, defaultGameDirectory, finishMigration, takeMigrationNotes };
