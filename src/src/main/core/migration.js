'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/*
 * The launcher used to be called RichLauncher. Its folders are renamed on the first start of
 * Vanilla+ Launcher, so settings, accounts, skins, downloaded Java and instances carry over:
 *   %APPDATA%\RichLauncher   -> %APPDATA%\VanillaPlus      (launcher data)
 *   %APPDATA%\.richlauncher  -> %APPDATA%\.vanillaplus     (default game folder)
 *   <instance>\.richlauncher -> <instance>\.vanillaplus    (installed content, icon, last run log)
 * Full paths saved in settings.json and instance.json (a picked Java, a chosen game folder) are
 * rewritten to the new folders. When a folder cannot be renamed (something holds it open), the
 * old one keeps being used.
 */

const USER_DATA_NAME = 'VanillaPlus';
const OLD_USER_DATA_NAME = 'RichLauncher';
const GAME_FOLDER = '.vanillaplus';
const OLD_GAME_FOLDER = '.richlauncher';
const INSTANCE_META = '.vanillaplus';
const OLD_INSTANCE_META = '.richlauncher';

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
  const target = path.join(appData, USER_DATA_NAME);
  app.setPath('userData', renameIfNeeded(path.join(appData, OLD_USER_DATA_NAME), target, 'userData') ?? target);
}

/** Default game folder: the new name, or the old one when it could not be renamed. */
function defaultGameDirectory(app) {
  if (!gameDirectoryCache) {
    const appData = app.getPath('appData');
    const target = path.join(appData, GAME_FOLDER);
    // A run with its own --user-data-dir (portable or test copy) never moves the real game folder.
    gameDirectoryCache = app.commandLine.hasSwitch('user-data-dir') ? target : (renameIfNeeded(path.join(appData, OLD_GAME_FOLDER), target, 'game') ?? target);
  }
  return gameDirectoryCache;
}

/** RichLauncher's default mint colour becomes Vanilla+'s cream one; a colour picked by hand stays. */
async function switchToVanillaAccent(settingsFile) {
  if (!moved.some(([, to]) => settingsFile.startsWith(to + path.sep))) {
    return;
  }
  try {
    const settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
    if (settings?.ui?.accent === 'emerald') {
      settings.ui.accent = 'vanilla';
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
  await switchToVanillaAccent(settingsFile);
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
    renameIfNeeded(path.join(directory, OLD_INSTANCE_META), path.join(directory, INSTANCE_META), 'instance');
    await rewritePaths(path.join(directory, 'instance.json'));
  }
}

/** What the migration did, for the log (read once the logger is ready). */
function takeMigrationNotes() {
  return notes.splice(0, notes.length);
}

module.exports = { setupUserData, defaultGameDirectory, finishMigration, takeMigrationNotes };
