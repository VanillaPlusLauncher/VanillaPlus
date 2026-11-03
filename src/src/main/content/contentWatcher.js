'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS } = require('../../shared/channels');
const { broadcast } = require('../core/broadcast');
const { createLogger } = require('../core/logger');

/*
 * The open instance page is told when its mods, resource packs or shaders change on disk, whoever
 * changed them: an install finishing in the background, the helper, a file dropped in, CustomSkinLoader
 * put in at a launch, or Explorer. Its list used to be read only when the page was opened, so a mod
 * that came in a moment later stayed missing. One instance is watched at a time, the one shown; none
 * while no instance page is open (a watched folder is harder to delete on Windows).
 */
const FOLDERS = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' };
/** A download writes its file in many steps: one message, once it has settled. */
const SETTLE_MS = 400;
const log = createLogger('content-watch');

let current = null;

function stopWatching() {
  if (!current) return;
  current.root?.close();
  for (const watcher of current.folders.values()) watcher.close();
  for (const timer of current.timers.values()) clearTimeout(timer);
  current = null;
}

function changed(watched, type) {
  clearTimeout(watched.timers.get(type));
  watched.timers.set(
    type,
    setTimeout(() => {
      watched.timers.delete(type);
      if (current === watched) broadcast(CHANNELS.events.contentChanged, { instanceId: watched.instanceId, type });
    }, SETTLE_MS),
  );
}

function watchFolder(watched, folder) {
  if (watched.folders.has(folder)) return;
  try {
    const watcher = fs.watch(path.join(watched.directory, folder), () => changed(watched, FOLDERS[folder]));
    watcher.on('error', () => {
      watcher.close();
      watched.folders.delete(folder);
    });
    watched.folders.set(folder, watcher);
  } catch {
    // Not there yet: the instance folder's own watcher starts this one once it appears.
  }
}

/** Watches the content folders of one instance (its id and folder); null stops watching. */
function watchInstance(instanceId, directory) {
  if (current && current.instanceId === instanceId && current.directory === directory) return;
  stopWatching();
  if (!instanceId || !directory) return;
  const watched = { instanceId, directory, root: null, folders: new Map(), timers: new Map() };
  current = watched;
  for (const folder of Object.keys(FOLDERS)) watchFolder(watched, folder);
  try {
    // A content folder made or removed (a first shader pack makes "shaderpacks").
    watched.root = fs.watch(directory, (_event, name) => {
      if (!name || !Object.hasOwn(FOLDERS, name)) return;
      watchFolder(watched, name);
      changed(watched, FOLDERS[name]);
    });
    watched.root.on('error', () => watched.root?.close());
  } catch (error) {
    log.warn(`Папка сборки не отслеживается: ${error.message}`);
  }
}

module.exports = { watchInstance, stopWatching };
