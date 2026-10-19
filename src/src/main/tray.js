'use strict';

const path = require('node:path');
const { app, Tray, nativeImage } = require('electron');
const { getSettings } = require('./settings/settingsService');
const { showNotice } = require('./notice');
const { openTrayMenu, closeTrayMenu } = require('./trayMenu');

/*
 * Closing the window keeps the launcher in the system tray (settings.closeToTray, on by default):
 * friends' messages and downloads go on. The tray icon brings the window back; "Выйти" in its menu
 * quits for real. With the setting off, closing the window quits as before.
 */

const ICON = path.join(__dirname, '..', '..', 'assets', 'branding', 'amethyx-mark.png');
const TEXTS = {
  ru: { open: 'Открыть Amethyx', quit: 'Выйти', title: 'Amethyx свёрнут в трей', hint: 'Выйти совсем: правой кнопкой по значку → «Выйти»' },
  en: { open: 'Open Amethyx', quit: 'Quit', title: 'Amethyx is in the tray', hint: 'To quit: right-click its icon → "Quit"' },
};

let tray = null;
let quitting = false;
let hintShown = false;

/** Russian for a Russian interface (or a Russian system while no language is chosen), else English. */
async function texts() {
  const settings = await getSettings().catch(() => null);
  const language = settings?.ui?.language ?? app.getLocale();
  return String(language).toLowerCase().startsWith('ru') ? TEXTS.ru : TEXTS.en;
}

function showWindow(window) {
  if (window.isDestroyed()) return;
  if (!window.isVisible()) window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
}

async function ensureTray(window) {
  if (tray) return;
  const text = await texts();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Amethyx Launcher');
  // The menu in the launcher's own style (trayMenu.js), not Windows' grey one.
  tray.on('right-click', (_event, bounds) => {
    openTrayMenu(
      [
        { label: text.open, click: () => showWindow(window) },
        { separator: true },
        { label: text.quit, danger: true, click: () => app.quit() },
      ],
      bounds,
    );
  });
  tray.on('click', () => {
    closeTrayMenu();
    showWindow(window);
  });
}

/** Makes the main window close to the tray when the setting says so. */
function setupTray(window) {
  app.on('before-quit', () => {
    quitting = true;
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    getSettings()
      .catch(() => ({ closeToTray: true }))
      .then(async (settings) => {
        if (settings.closeToTray === false) {
          app.quit();
          return;
        }
        await ensureTray(window);
        window.hide();
        // Once per run: where the launcher went and how to quit it (Amethyx's own card, see notice.js).
        if (!hintShown) {
          hintShown = true;
          const text = await texts();
          showNotice({ title: text.title, text: text.hint, onClick: () => showWindow(window) });
        }
      });
  });
}

module.exports = { setupTray, showWindow };
