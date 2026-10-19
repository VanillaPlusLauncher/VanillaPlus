'use strict';

const path = require('node:path');
const { BrowserWindow, shell } = require('electron');
const { appUrl, APP_SCHEME } = require('./appProtocol');

const PRELOAD_SCRIPT = path.join(__dirname, '..', 'preload', 'preload.js');
const WINDOW_ICON = path.join(__dirname, '..', '..', 'assets', 'branding', 'amethyx-mark.png');
const RENDERER_PAGE = appUrl('src/renderer/index.html');

/** Creates the frameless main window. The renderer draws its own title bar. */
function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#0a080f',
    title: 'Amethyx Launcher',
    icon: WINDOW_ICON,
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Only the launcher's own pages may load inside the window; everything else opens in the browser.
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      event.preventDefault();
      if (url.startsWith('https://')) {
        shell.openExternal(url);
      }
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.loadURL(RENDERER_PAGE);
  mainWindow = window;
  return window;
}

let mainWindow = null;

/** The launcher's window (not the skin site or a notice card), or null once it is gone. */
function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

module.exports = { createMainWindow, getMainWindow };
