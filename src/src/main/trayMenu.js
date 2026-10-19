'use strict';

const path = require('node:path');
const { BrowserWindow, nativeImage, screen } = require('electron');

/*
 * The tray icon's menu in the launcher's own style instead of Windows' grey one: the same soft
 * amethyst-dark card as the notices (notice.js), the mark and the name on top, items in the pixel
 * font. It opens next to the tray icon and goes away when it loses the focus or on Esc.
 * The menu is a plain page without Node or the launcher's preload; a chosen item reaches the main
 * process only as a navigation to MENU_URL, which is stopped.
 */

const ICON = path.join(__dirname, '..', '..', 'assets', 'branding', 'amethyx-mark.png');
const WIDTH = 230;
const MENU_URL = 'amethyx-menu://';
/** Shown even if the pixel font did not arrive (no network). */
const FONT_WAIT_MS = 400;

let menuWindow = null;
let iconUrl = null;

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(items) {
  iconUrl ??= nativeImage.createFromPath(ICON).resize({ width: 64, height: 64 }).toDataURL();
  const rows = items
    .map((item, index) => (item.separator ? '<div class="line"></div>' : `<button class="item${item.danger ? ' item--danger' : ''}" data-index="${index}">${escape(item.label)}</button>`))
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Tiny5&display=block">
  <style>
  html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
  .menu { box-sizing: border-box; width: ${WIDTH}px; padding: 8px; border-radius: 12px; background: #161220;
    border: 1px solid rgba(190, 160, 255, 0.32); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    font-family: "Tiny5", "Segoe UI", sans-serif; animation: in 180ms cubic-bezier(.2, .9, .3, 1.2) both; transform-origin: bottom center; }
  .head { display: flex; align-items: center; gap: 10px; padding: 4px 8px 8px; color: #cbb4ff; font-size: 16px; }
  .head img { width: 26px; height: 26px; }
  .head b { color: #b48cff; font-weight: normal; }
  .item { display: block; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: #f4f0fb;
    font: inherit; font-size: 15px; text-align: left; cursor: pointer; transition: background 120ms, transform 120ms, color 120ms; }
  .item:hover, .item:focus-visible { outline: none; background: rgba(190, 160, 255, 0.16); color: #ffffff; transform: translateX(3px); }
  .item:active { transform: translateX(3px) scale(0.98); }
  .item--danger:hover { background: rgba(255, 107, 94, 0.16); color: #ffb3a8; }
  .line { height: 1px; margin: 6px 6px; background: rgba(226, 214, 255, 0.1); }
  @keyframes in { from { opacity: 0; transform: translateY(8px) scale(0.96); } }
  </style></head><body><div class="menu" id="menu">
  <div class="head"><img src="${iconUrl}" alt=""><span>Amethy<b>x</b></span></div>${rows}</div>
  <script>
    let ready = false;
    const show = () => { if (!ready) { ready = true; location.href = '${MENU_URL}ready/' + document.getElementById('menu').offsetHeight; } };
    document.fonts.load('16px Tiny5').then(show, show);
    setTimeout(show, ${FONT_WAIT_MS});
    document.querySelectorAll('.item').forEach((item) => item.addEventListener('click', () => { location.href = '${MENU_URL}pick/' + item.dataset.index; }));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') location.href = '${MENU_URL}close'; });
  </script></body></html>`;
}

function closeMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
  menuWindow = null;
}

/**
 * Opens the menu by the tray icon. `items`: [{ label, click, danger? } | { separator: true }].
 * `anchor`: the tray icon's bounds (from the tray's click event), else the mouse position is used.
 */
function openTrayMenu(items, anchor = null) {
  closeMenu();
  const point = anchor && anchor.width ? { x: anchor.x + anchor.width / 2, y: anchor.y } : screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  const window = new BrowserWindow({
    width: WIDTH,
    height: 200,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  menuWindow = window;
  window.setAlwaysOnTop(true, 'pop-up-menu');
  window.on('blur', () => {
    if (menuWindow === window) closeMenu();
  });
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith(`${MENU_URL}ready/`)) {
      // The menu's real height is known now: it stands above the tray icon, inside the screen.
      const height = Math.max(60, Math.min(400, Number(url.slice(`${MENU_URL}ready/`.length)) || 120));
      const x = Math.round(Math.min(workArea.x + workArea.width - WIDTH - 6, Math.max(workArea.x + 6, point.x - WIDTH / 2)));
      const below = point.y < workArea.y + workArea.height / 2;
      const y = Math.round(below ? Math.max(workArea.y + 6, point.y + 12) : Math.min(point.y, workArea.y + workArea.height) - height - 8);
      window.setBounds({ x, y, width: WIDTH, height });
      window.show();
      window.focus();
    } else if (url.startsWith(`${MENU_URL}pick/`)) {
      const item = items[Number(url.slice(`${MENU_URL}pick/`.length))];
      closeMenu();
      item?.click?.();
    } else {
      closeMenu();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(items))}`).catch(() => closeMenu());
}

module.exports = { openTrayMenu, closeTrayMenu: closeMenu };
