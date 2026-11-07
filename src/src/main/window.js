'use strict';

const path = require('node:path');
const { BrowserWindow, session, shell } = require('electron');
const { appUrl, APP_SCHEME } = require('./appProtocol');

const PRELOAD_SCRIPT = path.join(__dirname, '..', 'preload', 'preload.js');
const WINDOW_ICON = path.join(__dirname, '..', '..', 'assets', 'branding', 'amethyx-mark.png');
const RENDERER_PAGE = appUrl('src/renderer/index.html');
/** Sites opened from links inside the launcher (renderer components/webPage.js) live here, apart from it. */
const LINKS_PARTITION = 'persist:links';
const isWeb = (url) => /^https?:\/\//i.test(String(url ?? ''));

/*
 * Links open inside the launcher, in a <webview> of the renderer's own "browser" dialog. The page there
 * is a stranger: its own session, sandboxed, no preload, no Node, no permission granted; it can only go
 * to other web pages, and a page that opens a new window opens in the same view.
 */
function guardLinkViews(window) {
  const linksSession = session.fromPartition(LINKS_PARTITION);
  linksSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  linksSession.setPermissionCheckHandler(() => false);
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isWeb(params.src) || params.partition !== LINKS_PARTITION) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    Object.assign(webPreferences, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webviewTag: false });
  });
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isWeb(url)) event.preventDefault();
    });
  });
}

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
      // Links open inside the launcher (guardLinkViews).
      webviewTag: true,
    },
  });
  guardLinkViews(window);

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
