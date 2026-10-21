'use strict';

const path = require('node:path');
const { app, Menu, Tray, nativeImage } = require('electron');
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
  uk: { open: 'Відкрити Amethyx', quit: 'Вийти', title: 'Amethyx згорнуто в трей', hint: 'Вийти зовсім: правою кнопкою по значку → «Вийти»' },
  pl: { open: 'Otwórz Amethyx', quit: 'Zakończ', title: 'Amethyx jest w zasobniku', hint: 'Aby zakończyć: prawy przycisk na ikonie → „Zakończ”' },
  es: { open: 'Abrir Amethyx', quit: 'Salir', title: 'Amethyx está en la bandeja', hint: 'Para salir: clic derecho en su icono → «Salir»' },
  pt: { open: 'Abrir Amethyx', quit: 'Sair', title: 'Amethyx está na bandeja', hint: 'Para sair: clique direito no ícone → "Sair"' },
  de: { open: 'Amethyx öffnen', quit: 'Beenden', title: 'Amethyx ist im Infobereich', hint: 'Zum Beenden: Rechtsklick auf das Symbol → „Beenden“' },
  fr: { open: 'Ouvrir Amethyx', quit: 'Quitter', title: 'Amethyx est dans la zone de notification', hint: 'Pour quitter : clic droit sur son icône → « Quitter »' },
  zh: { open: '打开 Amethyx', quit: '退出', title: 'Amethyx 已最小化到托盘', hint: '完全退出：右键点击图标 →「退出」' },
};

let tray = null;
let quitting = false;
let hintShown = false;

/** In the interface's language (the system's while none is chosen), else English. */
async function texts() {
  const settings = await getSettings().catch(() => null);
  const language = String(settings?.ui?.language ?? app.getLocale()).slice(0, 2).toLowerCase();
  return TEXTS[language] ?? TEXTS.en;
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
  // The menu in the launcher's own style (trayMenu.js); Windows' grey one only if that cannot appear.
  const items = [
    { label: text.open, icon: 'open', click: () => showWindow(window) },
    { separator: true },
    { label: text.quit, icon: 'quit', danger: true, click: () => app.quit() },
  ];
  const plainMenu = () => tray?.popUpContextMenu(Menu.buildFromTemplate(items.map((item) => (item.separator ? { type: 'separator' } : { label: item.label, click: item.click }))));
  tray.on('right-click', (_event, bounds) => openTrayMenu(items, bounds, plainMenu));
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
