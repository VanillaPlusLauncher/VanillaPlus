'use strict';

const { BrowserWindow } = require('electron');

/** Sends an event to every open renderer window. */
function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

module.exports = { broadcast };
