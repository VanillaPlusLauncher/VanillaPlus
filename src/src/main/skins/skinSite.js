'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, nativeImage, session } = require('electron');
const { assertSkinPng, MAX_SKIN_BYTES } = require('./pngValidation');
const { saveToLibrary } = require('./skinSources');
const { createLogger } = require('../core/logger');
const { getMainWindow } = require('../window');
const { showWindow } = require('../tray');

/*
 * "Скины с сайта": a window with a big catalogue of ready skins. Whatever skin is downloaded there
 * (The Skindex or NameMC; the site's "Download" button, or a link straight to a PNG) goes into the skin library by itself,
 * and the dressing room shows it at once. The site lives in its own session, sandboxed, without the
 * launcher's preload: it cannot reach the launcher, and no permission it asks for is granted.
 */
const log = createLogger('skin-site');
const SITES = {
  skindex: 'https://www.minecraftskins.com/',
  namemc: 'https://namemc.com/minecraft-skins/trending',
};
const PARTITION = 'persist:skin-site';
const WINDOW_ICON = path.join(__dirname, '..', '..', '..', 'assets', 'branding', 'vanillaplus-mark.png');

let siteWindow = null;
let siteKey = null;
let handlers = { onImported: () => {}, onError: () => {} };
const prepared = new WeakSet();

/** Slim (Alex) or classic (Steve): slim arms leave the 4th pixel column of the arm empty. */
function modelOf(png) {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  if (width !== 64 || height !== 64) return 'classic';
  const bitmap = image.toBitmap();
  const alpha = (x, y) => bitmap[(y * width + x) * 4 + 3];
  return alpha(55, 20) === 0 && alpha(55, 31) === 0 ? 'slim' : 'classic';
}

/** "2026_10_18_steve-in-a-suit-123456.png" → "Steve in a suit". */
function nameOf(fileName) {
  const base = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  const name = base
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/^(\s*\d{1,2}\b)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return name ? name[0].toUpperCase() + name.slice(1) : 'Скин с сайта';
}

/**
 * NameMC pages are titled "chromegoth Скин Minecraft | NameMC" or "Notch | Minecraft Profile | NameMC"
 * (in the site's language): the name in front, without the "Скин Minecraft" words, unless it is generic.
 */
function titleFromPage(title) {
  const first = String(title ?? '').split(' | ')[0].trim();
  const name = first.replace(/\s+\S+\s+Minecraft$|\s+Minecraft\s+\S+$/i, '').trim();
  return name && !/namemc|minecraft|just a moment/i.test(name) ? name.slice(0, 40) : null;
}

/** The skin's own title when the download link carries it (The Skindex: "?title=The+sun…"). */
function titleFromUrl(url) {
  try {
    return new URL(url).searchParams.get('title')?.trim().slice(0, 40) || null;
  } catch {
    return null;
  }
}

async function importSkin(png, name) {
  assertSkinPng(png);
  const item = await saveToLibrary(name, png, modelOf(png));
  log.info(item.duplicate ? `Скин с сайта уже в библиотеке: ${item.name}` : `Скин с сайта добавлен в библиотеку: ${item.name} (${item.model})`);
  handlers.onImported(item);
  // The skin is taken: the site closes and the dressing room comes forward with it in the middle.
  if (siteWindow && !siteWindow.isDestroyed()) siteWindow.close();
  const main = getMainWindow();
  if (main) showWindow(main);
}

function prepareSession(siteSession) {
  if (prepared.has(siteSession)) return;
  prepared.add(siteSession);
  siteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  siteSession.on('will-download', (_event, item) => {
    const fileName = item.getFilename();
    // Taken now: by the time the download is done the page may be another one.
    const pageTitle = /namemc\.com/i.test(item.getURL()) ? titleFromPage(siteWindow?.webContents.getTitle()) : null;
    const isPng = /\.png$/i.test(fileName) || item.getMimeType() === 'image/png';
    if (!isPng || item.getTotalBytes() > MAX_SKIN_BYTES) {
      item.cancel();
      handlers.onError(new Error('Это не скин: нужен PNG-файл скина.'));
      return;
    }
    const target = path.join(os.tmpdir(), `vanillaplus-skin-${crypto.randomUUID()}.png`);
    item.setSavePath(target);
    item.once('done', async (_doneEvent, state) => {
      try {
        if (state === 'completed') await importSkin(await fsp.readFile(target), titleFromUrl(item.getURL()) ?? pageTitle ?? nameOf(fileName));
      } catch (error) {
        handlers.onError(error);
      } finally {
        await fsp.rm(target, { force: true }).catch(() => {});
      }
    });
  });
}

const isWeb = (url) => /^https?:\/\//i.test(url);
const isPngLink = (url) => {
  try {
    return /\.png$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * Opens a skin site, 'skindex' or 'namemc' (or brings the window forward, switching the site when
 * another one is asked for). `onImported(item)` gets every skin taken from it.
 */
function openSkinSite(parent, nextHandlers, key = 'skindex') {
  handlers = { ...handlers, ...nextHandlers };
  const url = SITES[key] ?? SITES.skindex;
  if (siteWindow && !siteWindow.isDestroyed()) {
    if (siteWindow.isMinimized()) siteWindow.restore();
    siteWindow.focus();
    if (key !== siteKey) {
      siteKey = key;
      siteWindow.loadURL(url).catch((error) => handlers.onError(new Error(`Сайт не открылся: ${error.message}`)));
    }
    return;
  }
  siteKey = key;
  const siteSession = session.fromPartition(PARTITION);
  prepareSession(siteSession);
  siteWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: 'Скины с сайта — Vanilla+',
    autoHideMenuBar: true,
    backgroundColor: '#1b1712',
    icon: WINDOW_ICON,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const contents = siteWindow.webContents;
  // A link straight to a PNG is taken as a skin instead of being shown.
  contents.on('will-navigate', (event, url) => {
    if (!isWeb(url)) event.preventDefault();
    else if (isPngLink(url)) {
      event.preventDefault();
      contents.downloadURL(url);
    }
  });
  // Pop-ups (mostly ads) never open; a pop-up to a PNG is still taken as a skin.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url) && isPngLink(url)) contents.downloadURL(url);
    return { action: 'deny' };
  });
  siteWindow.on('page-title-updated', (event) => event.preventDefault());
  siteWindow.on('closed', () => {
    siteWindow = null;
  });
  siteWindow.loadURL(url).catch((error) => handlers.onError(new Error(`Сайт не открылся: ${error.message}`)));
}

module.exports = { openSkinSite, modelOf, nameOf, SITES };
