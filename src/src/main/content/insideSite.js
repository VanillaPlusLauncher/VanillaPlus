'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, session } = require('electron');
const { importWorldArchive } = require('./worldImport');
const { BASE } = require('./mcinside');
const instanceService = require('../minecraft/instanceService');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { getMainWindow } = require('../window');
const { showWindow } = require('../tray');

/*
 * Maps from Minecraft Inside are downloaded by the player on the site itself: its download links are
 * closed to programs (robots.txt). The map's page opens in a window of its own; the archive the player
 * downloads there goes into the chosen instance as a new world (worldImport.js), and the window closes.
 * The site lives in its own sandboxed session without the launcher's preload, like the skin sites
 * (skins/skinSite.js): it cannot reach the launcher, and no permission it asks for is granted.
 */
const log = createLogger('maps');
const PARTITION = 'persist:mcinside';
const WINDOW_ICON = path.join(__dirname, '..', '..', '..', 'assets', 'branding', 'amethyx-mark.png');
const ARCHIVE = /\.(zip|rar|7z)$/i;
const MAX_BYTES = 4 * 1024 ** 3;

let siteWindow = null;
/** The map being waited for: { instance, title, resolve, reject, settled }. */
let pending = null;
const prepared = new WeakSet();

const isInside = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && /(^|\.)minecraft-inside\.ru$/i.test(hostname);
  } catch {
    return false;
  }
};

function settle(result, error) {
  const current = pending;
  if (!current || current.settled) return;
  current.settled = true;
  pending = null;
  if (error) current.reject(error);
  else current.resolve(result);
}

function prepareSession(siteSession) {
  if (prepared.has(siteSession)) return;
  prepared.add(siteSession);
  siteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  siteSession.on('will-download', (_event, item) => {
    const current = pending;
    const fileName = item.getFilename();
    if (!current || !ARCHIVE.test(fileName) || item.getTotalBytes() > MAX_BYTES) {
      item.cancel();
      if (current && !ARCHIVE.test(fileName)) log.warn(`С сайта карт пришёл не архив: ${fileName}`);
      return;
    }
    const target = path.join(current.instance.directory, '.amethyx', `map-${crypto.randomUUID()}${path.extname(fileName).toLowerCase()}`);
    item.setSavePath(target);
    // Closing the window now no longer means "not downloaded".
    current.downloading = true;
    const reporter = createTaskReporter({ taskId: `map:${current.instance.id}:${fileName}`, kind: 'content', label: current.title, instance: current.instance.name });
    item.on('updated', () => {
      const total = item.getTotalBytes();
      if (total) reporter.report(current.title, 5 + (item.getReceivedBytes() / total) * 80, fileName);
    });
    item.once('done', async (_doneEvent, state) => {
      try {
        if (state !== 'completed') throw new Error('Загрузка карты прервалась.');
        reporter.report(current.title, 90, 'Распаковываем');
        const worlds = await importWorldArchive(current.instance.directory, target, current.title);
        reporter.finish('done', worlds.join(', '));
        settle({ worlds });
        // The map is in: the site closes and the launcher comes forward.
        if (siteWindow && !siteWindow.isDestroyed()) siteWindow.close();
        const main = getMainWindow();
        if (main) showWindow(main);
      } catch (error) {
        reporter.finish('error', error.message);
        settle(null, error);
      } finally {
        await fsp.rm(target, { force: true }).catch(() => {});
      }
    });
  });
}

/**
 * Opens the page of a Minecraft Inside map for `instanceId`. Resolves with { worlds } once the
 * downloaded map is in the instance, or { cancelled: true } when the window is closed before.
 */
async function installInsideMap(settings, { instanceId, projectId, title }) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const id = String(projectId ?? '');
  if (!/^\d+-[a-z0-9-]+$/i.test(id)) throw new Error('Неизвестная карта.');
  // Another map asked for while one is open: the first one is no longer waited for.
  settle({ cancelled: true });
  const result = new Promise((resolve, reject) => {
    pending = { instance, title: String(title || 'Карта').slice(0, 80), resolve, reject, settled: false };
  });
  const url = `${BASE}/maps/${id}.html`;
  if (siteWindow && !siteWindow.isDestroyed()) {
    if (siteWindow.isMinimized()) siteWindow.restore();
    siteWindow.focus();
    siteWindow.loadURL(url).catch(() => {});
    return result;
  }
  const siteSession = session.fromPartition(PARTITION);
  prepareSession(siteSession);
  siteWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    title: 'Карта с Minecraft Inside — Amethyx',
    autoHideMenuBar: true,
    backgroundColor: '#15111e',
    icon: WINDOW_ICON,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const contents = siteWindow.webContents;
  contents.on('will-navigate', (event, next) => {
    if (!/^https?:\/\//i.test(next)) event.preventDefault();
  });
  // Pop-ups (mostly ads) never open; one of the site's own pages opens in this window.
  contents.setWindowOpenHandler(({ url: next }) => {
    if (isInside(next)) contents.loadURL(next).catch(() => {});
    return { action: 'deny' };
  });
  siteWindow.on('page-title-updated', (event) => event.preventDefault());
  siteWindow.on('closed', () => {
    siteWindow = null;
    if (!pending?.downloading) settle({ cancelled: true });
  });
  siteWindow.loadURL(url).catch((error) => {
    if (/ERR_ABORTED/.test(error.message)) return;
    log.warn(`Сайт карт не открылся: ${error.message}`);
  });
  return result;
}

module.exports = { installInsideMap };
