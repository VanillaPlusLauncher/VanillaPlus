'use strict';

const { BrowserWindow, screen } = require('electron');
const { brandIconDataUrl } = require('./brandIcon');
const { popupLook, fontStack } = require('./popupLook');

/*
 * Amethyx's own notifications instead of Windows' toasts (slow, with a generic icon and the app id
 * on top): a card in the launcher's look chosen in Settings → Оформление (popupLook.js) — the mark,
 * a title in the theme colour and the text in the chosen font — in the bottom-right corner. It never
 * takes the focus, hides by itself, and a click runs `onClick`. Several stack upwards.
 * The card is a plain page without Node or the launcher's preload; it tells the main process
 * "ready" and "click" by changing the page's title, as the tray menu does. (It used to navigate to a
 * made-up address: when that happened before the page had finished loading, the load counted as
 * failed and the card was closed unseen.)
 */

const WIDTH = 360;
const HEIGHT = 84;
/** Room round the soft card for its shadow (the window is transparent). */
const SOFT_MARGIN = 5;
const GAP = 8;
const SHOW_MS = 6000;
/** Shown even if the font did not arrive (no network). */
const FONT_WAIT_MS = 900;

const open = [];

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The pixel font is drawn small for its size: brought to the text height as in the main window (mc.css). */
const fontCss = (look) =>
  look.pixelFont ? `font-family: ${fontStack(look)}; font-size-adjust: 0.62; letter-spacing: 0.03em;` : `font-family: ${fontStack(look)};`;

/* The soft look: a rounded card tinted by the theme colour, a little lighter under the pointer. */
function softCss(look) {
  const hue = look.accent.hue;
  return `
  .toast { box-sizing: border-box; height: ${HEIGHT - SOFT_MARGIN * 2}px; margin: ${SOFT_MARGIN}px; display: flex; align-items: center; gap: 12px;
    padding: 8px 16px 8px 12px; border-radius: 16px; background: hsl(${hue} 25.3% 17.8%);
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    ${fontCss(look)} animation: in 260ms cubic-bezier(0.22, 1, 0.36, 1) both; transition: background-color 220ms ease; }
  .toast:hover { background: hsl(${hue} 27.7% 23.3%); }
  img { width: 40px; height: 40px; flex: none; }
  .title { color: rgb(${look.accent.rgb}); ${look.pixelFont ? '' : 'font-weight: 600;'} }
  .text { color: hsl(${hue} 57.9% 96.3%); }`;
}

/* The pixel look: a dark panel with corners cut by one pixel step, an even frame (the theme colour
   on hover) and a dark bottom edge. */
function pixelCss(look) {
  return `
  .toast { box-sizing: border-box; height: ${HEIGHT}px; display: flex; align-items: center; gap: 12px; padding: 10px 16px 12px 12px;
    background: #16121f; box-shadow: inset 0 0 0 2px #2b2140, inset 0 -3px 0 rgba(0, 0, 0, 0.4);
    clip-path: polygon(0 5px, 5px 5px, 5px 0, calc(100% - 5px) 0, calc(100% - 5px) 5px, 100% 5px, 100% calc(100% - 5px),
      calc(100% - 5px) calc(100% - 5px), calc(100% - 5px) 100%, 5px 100%, 5px calc(100% - 5px), 0 calc(100% - 5px));
    ${fontCss(look)} animation: in 200ms steps(5, end) both; }
  .toast:hover { box-shadow: inset 0 0 0 2px rgb(${look.accent.strong}), inset 0 -3px 0 rgba(0, 0, 0, 0.4); }
  img { width: 42px; height: 42px; flex: none; image-rendering: pixelated; }
  .title { color: rgb(${look.accent.rgb}); }
  .text { color: #f1ecfb; }`;
}

function page({ title, text }, look) {
  const iconUrl = brandIconDataUrl();
  const size = look.pixelFont ? { title: 16, titleLine: 20, text: 14, textLine: 18 } : { title: 15, titleLine: 19, text: 13, textLine: 17 };
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="${escape(look.font.url)}">
  <style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; cursor: pointer; }
  ${look.soft ? softCss(look) : pixelCss(look)}
  .lines { min-width: 0; }
  .title { font-size: ${size.title}px; line-height: ${size.titleLine}px; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .text { font-size: ${size.text}px; line-height: ${size.textLine}px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .out { animation: out 200ms ease-in both; }
  @keyframes in { from { opacity: 0; transform: translateX(28px); } }
  @keyframes out { to { opacity: 0; transform: translateX(28px); } }
  </style></head><body><div class="toast" id="toast">${iconUrl ? `<img src="${iconUrl}" alt="" onerror="this.remove()">` : ''}
  <div class="lines">${title ? `<div class="title">${escape(title)}</div>` : ''}<div class="text">${escape(text)}</div></div></div>
  <script>
    let ready = false;
    const say = (message) => { document.title = message + '/' + Date.now(); };
    const show = () => { if (!ready) { ready = true; say('ready'); } };
    document.fonts.load(${JSON.stringify(`16px "${look.font.name}"`).replace(/</g, '\\u003c')}).then(show, show);
    setTimeout(show, ${FONT_WAIT_MS});
    document.body.addEventListener('click', () => say('click'));
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
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('page-title-updated', (event, pageTitle) => {
    event.preventDefault();
    const message = String(pageTitle).replace(/\/\d+$/, '');
    if (message === 'ready') {
      if (!window.isDestroyed() && !window.isVisible()) window.showInactive();
    } else if (message === 'click') {
      close(window);
      onClick?.();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popupLook().then((look) => {
    if (window.isDestroyed()) return;
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page({ title, text }, look))}`).catch(() => close(window));
  }, () => close(window));
  setTimeout(() => dismiss(window), SHOW_MS);
  return window;
}

/** Notice toasts are not the launcher's main window (other modules look the main window up). */
function isNoticeWindow(window) {
  return open.includes(window);
}

module.exports = { showNotice, isNoticeWindow };
