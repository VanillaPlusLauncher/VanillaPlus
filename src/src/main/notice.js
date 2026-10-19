'use strict';

const path = require('node:path');
const { BrowserWindow, nativeImage, screen } = require('electron');

/*
 * Vanilla+'s own notifications instead of Windows' toasts (slow, with a generic icon and the app id
 * on top): a soft card in the launcher's style — the mark, a cream title and the text in the
 * launcher's pixel font — in the bottom-right corner. It never takes the focus, hides by itself,
 * and a click runs `onClick`. Several stack upwards.
 * The card is a plain page without Node or the launcher's preload; it talks to the main process
 * only by navigating to NOTICE_URL (ready, click), and those navigations are stopped.
 */

const ICON = path.join(__dirname, '..', '..', 'assets', 'branding', 'vanillaplus-mark.png');
const WIDTH = 360;
const HEIGHT = 76;
const GAP = 8;
const SHOW_MS = 6000;
/** Shown even if the pixel font did not arrive (no network). */
const FONT_WAIT_MS = 900;
const NOTICE_URL = 'vanillaplus-notice://';

const open = [];
let iconUrl = null;

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page({ title, text }) {
  iconUrl ??= nativeImage.createFromPath(ICON).resize({ width: 80, height: 80 }).toDataURL();
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Tiny5&display=block">
  <style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; cursor: pointer; }
  /* The launcher's soft style: a rounded warm-dark card with a cream edge; text in its pixel font. */
  .toast { box-sizing: border-box; height: ${HEIGHT}px; display: flex; align-items: center; gap: 12px; padding: 10px 16px 10px 12px;
    border-radius: 12px; background: #1d1813; border: 1px solid rgba(247, 215, 148, 0.28);
    font-family: "Tiny5", "Segoe UI", sans-serif;
    animation: in 240ms cubic-bezier(.2, .9, .3, 1.15) both; }
  .toast:hover { border-color: rgba(247, 215, 148, 0.6); }
  img { width: 42px; height: 42px; flex: none; image-rendering: pixelated; }
  .lines { min-width: 0; }
  .title { color: #f7d794; font-size: 17px; line-height: 20px; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .text { color: #f3ead9; font-size: 15px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .out { animation: out 200ms ease-in both; }
  @keyframes in { from { opacity: 0; transform: translateX(28px); } }
  @keyframes out { to { opacity: 0; transform: translateX(28px); } }
  </style></head><body><div class="toast" id="toast"><img src="${iconUrl}" alt="">
  <div class="lines">${title ? `<div class="title">${escape(title)}</div>` : ''}<div class="text">${escape(text)}</div></div></div>
  <script>
    let ready = false;
    const show = () => { if (!ready) { ready = true; location.href = '${NOTICE_URL}ready'; } };
    document.fonts.load('16px Tiny5').then(show, show);
    setTimeout(show, ${FONT_WAIT_MS});
    document.body.addEventListener('click', () => { location.href = '${NOTICE_URL}click'; });
  </script></body></html>`;
}

/** Cards one above another in the bottom-right corner of the screen's work area (newest at the bottom). */
function layout() {
  const { workArea } = screen.getPrimaryDisplay();
  open.forEach((window, index) => {
    if (window.isDestroyed()) return;
    const fromBottom = open.length - index;
    window.setBounds({ x: workArea.x + workArea.width - WIDTH - GAP, y: workArea.y + workArea.height - (HEIGHT + GAP) * fromBottom, width: WIDTH, height: HEIGHT });
  });
}

function close(window) {
  const index = open.indexOf(window);
  if (index >= 0) open.splice(index, 1);
  if (!window.isDestroyed()) window.destroy();
  layout();
}

/** Slides the toast out, then closes it. */
function dismiss(window) {
  if (window.isDestroyed()) return;
  window.webContents.executeJavaScript("document.getElementById('toast').classList.add('out')").catch(() => {});
  setTimeout(() => close(window), 230);
}

/** Shows a toast: { title?, text, onClick? }. */
function showNotice({ title = null, text, onClick = null }) {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  window.setAlwaysOnTop(true, 'pop-up-menu');
  open.push(window);
  layout();
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === `${NOTICE_URL}ready`) {
      if (!window.isDestroyed() && !window.isVisible()) window.showInactive();
    } else if (url === `${NOTICE_URL}click`) {
      close(window);
      onClick?.();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page({ title, text }))}`).catch(() => close(window));
  setTimeout(() => dismiss(window), SHOW_MS);
  return window;
}

/** Notice toasts are not the launcher's main window (other modules look the main window up). */
function isNoticeWindow(window) {
  return open.includes(window);
}

module.exports = { showNotice, isNoticeWindow };
