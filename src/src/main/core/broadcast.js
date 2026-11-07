'use strict';

const { BrowserWindow } = require('electron');

/** Main-process listeners of events (the developer API follows the game's log and state this way). */
const listeners = new Map();

/** Sends an event to every open renderer window (and to the main-process listeners of that channel). */
function broadcast(channel, payload) {
  for (const listener of listeners.get(channel) ?? []) {
    try {
      listener(payload);
    } catch {
      // A listener's mistake must not stop the event reaching the windows.
    }
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

/** Follows an event in the main process. Returns a function that stops following it. */
function onBroadcast(channel, listener) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(listener);
  return () => listeners.get(channel)?.delete(listener);
}

module.exports = { broadcast, onBroadcast };
