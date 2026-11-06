'use strict';

const { app, BrowserWindow, screen } = require('electron');
const { brandIconDataUrl } = require('./brandIcon');
const { popupLook, softIcon, fontStack } = require('./popupLook');

/*
 * The tray icon's menu in the launcher's own look instead of Windows' grey one, the one chosen in
 * Settings → Оформление (popupLook.js): soft — a rounded panel tinted by the theme colour, rows that
 * light up under the pointer and sink when pressed, the 3D icons; pixel — a dark panel with corners
 * cut by one pixel step and an even frame, pixel buttons with little pixel icons. The mark, the name
 * and the version on top, in the chosen font. It opens next to the tray icon and goes away when it
 * loses the focus or on Esc.
 * The menu is a plain page without Node or the launcher's preload; what it has to say ("ready" with
 * its height, the chosen item, "close") reaches the main process as a change of the page's title
 * (Chromium lets a data: page navigate nowhere, not even to its own #hash).
 */

const WIDTH = 236;
/** Room round the soft panel for its shadow (the window is transparent). */
const SOFT_PAD = 14;
/** Shown even if the font did not arrive (no network). */
const FONT_WAIT_MS = 400;
/** Not on screen by then: Windows' own menu instead, so quitting always works. */
const FAIL_MS = 1500;
const BLUR_GRACE_MS = 400;

/** 16 × 16 pixel icons (one SVG unit is one pixel), by name: the pixel look. */
const ICONS = {
  open: '<path d="M2 3h12v10H2z" fill="#8b5cf6"/><path d="M3 6h10v6H3z" fill="#16121f"/><path d="M3 4h2v1H3zm3 0h2v1H6z" fill="#e2d4ff"/>',
  quit: '<path d="M7 1h2v7H7z" fill="#ff8f84"/><path d="M4 3h2v2H4zM3 5h2v5H3zm1 5h2v2H4zm2 2h4v2H6zm4-2h2v2h-2zm1-5h2v5h-2zm-1-2h2v2h-2z" fill="#ff8f84"/>',
};
/** The same items' icons in the soft look (src/assets/ui/<name>.3d.png / .smooth.svg). */
const SOFT_ICONS = { open: 'home', quit: 'close' };

let menuWindow = null;

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** "1.7-beta.57" → "v1.7 β57", as in the window's corner. */
const shortVersion = (version) => `v${String(version).replace(/-beta\.(\d+)$/i, ' β$1')}`;

function icon(name, look) {
  if (look.soft) {
    const picture = SOFT_ICONS[name] ? softIcon(SOFT_ICONS[name], look) : null;
    if (!picture) return '<i></i>';
    return picture.mask ? `<i class="mask" style="-webkit-mask-image: url(${picture.url})"></i>` : `<img src="${picture.url}" alt="">`;
  }
  return ICONS[name] ? `<svg viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges">${ICONS[name]}</svg>` : '<i></i>';
}

/** The pixel font is drawn small for its size: brought to the text height as in the main window (mc.css). */
const fontCss = (look) =>
  look.pixelFont ? `font-family: ${fontStack(look)}; font-size-adjust: 0.62; letter-spacing: 0.03em;` : `font-family: ${fontStack(look)}; font-weight: 500;`;

function softCss(look) {
  const hue = look.accent.hue;
  const size = look.pixelFont ? { head: 17, item: 15 } : { head: 15, item: 13.5 };
  return `
  body { padding: ${SOFT_PAD}px; }
  .menu { box-sizing: border-box; width: ${WIDTH}px; padding: 8px; border-radius: 18px; background: hsl(${hue} 25.3% 17.8%);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    ${fontCss(look)} color: hsl(${hue} 57.9% 96.3%); animation: in 200ms cubic-bezier(0.22, 1, 0.36, 1) both; }
  .head { display: flex; align-items: center; gap: 10px; padding: 6px 8px 10px; }
  .head img { width: 28px; height: 28px; }
  .head span { font-size: ${size.head}px; }
  .head small { margin-left: auto; color: hsl(${hue} 14.3% 57.5%); font-size: 12px; }
  .item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 12px; background: transparent;
    color: inherit; font: inherit; font-size: ${size.item}px; letter-spacing: inherit; text-align: left; cursor: pointer;
    transition: background-color 220ms ease, box-shadow 220ms ease; }
  .item img, .item i { flex: none; width: 24px; height: 24px; }
  .item .mask { background: currentColor; -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; }
  .item:hover, .item:focus-visible { outline: none; background: rgba(${look.accent.rgb}, 0.14); }
  .item:active { background: hsl(${hue} 25% 9.4%); box-shadow: inset 4px 4px 8px rgba(0, 0, 0, 0.5), inset -3px -3px 7px rgba(255, 255, 255, 0.06); transition: none; }
  .item--danger { color: #ffa499; }
  .item--danger:hover, .item--danger:focus-visible { background: rgba(255, 107, 94, 0.14); }
  .line { height: 1px; margin: 6px 10px; background: hsl(${hue} 100% 92% / 0.08); }
  @keyframes in { from { opacity: 0; transform: translateY(6px) scale(0.98); } }`;
}

function pixelCss(look) {
  const cut = (size) => `polygon(0 ${size}, ${size} ${size}, ${size} 0, calc(100% - ${size}) 0, calc(100% - ${size}) ${size}, 100% ${size},
    100% calc(100% - ${size}), calc(100% - ${size}) calc(100% - ${size}), calc(100% - ${size}) 100%, ${size} 100%, ${size} calc(100% - ${size}), 0 calc(100% - ${size}))`;
  const size = look.pixelFont ? { head: 17, item: 15 } : { head: 15, item: 13.5 };
  return `
  .menu { box-sizing: border-box; width: ${WIDTH}px; padding: 10px; background: #16121f; clip-path: ${cut('5px')};
    box-shadow: inset 0 0 0 2px #2b2140, inset 0 -3px 0 rgba(0, 0, 0, 0.4);
    ${fontCss(look)} color: #f1ecfb; animation: in 160ms steps(4, end) both; }
  .head { display: flex; align-items: center; gap: 10px; padding: 2px 4px 10px; }
  .head img { width: 28px; height: 28px; image-rendering: pixelated; }
  .head span { font-size: ${size.head}px; }
  .head small { margin-left: auto; color: #8d82a3; font-size: 12px; }
  .item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px 10px; border: 0; background: transparent;
    color: inherit; font: inherit; font-size: ${size.item}px; letter-spacing: inherit; text-align: left; cursor: pointer; clip-path: ${cut('3px')}; }
  .item svg, .item i { flex: none; width: 16px; height: 16px; }
  .item:hover, .item:focus-visible { outline: none; background: #2a2533; box-shadow: inset 0 -3px 0 rgb(${look.accent.strong}); }
  .item:active { background: #231e2c; box-shadow: inset 0 3px 0 rgba(0, 0, 0, 0.38); padding: 10px 10px 8px; }
  .item--danger { color: #ffb3a8; }
  .item--danger:hover, .item--danger:focus-visible { background: #3a1f27; box-shadow: inset 0 -3px 0 #ff6b5e; }
  .line { height: 2px; margin: 6px 4px; background: #2b2140; }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } }`;
}

function page(items, version, look) {
  const iconUrl = brandIconDataUrl();
  const rows = items
    .map((item, index) =>
      item.separator
        ? '<div class="line"></div>'
        : `<button class="item${item.danger ? ' item--danger' : ''}" data-index="${index}">${icon(item.icon, look)}<span>${escape(item.label)}</span></button>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="${escape(look.font.url)}">
  <style>
  html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
  ${look.soft ? softCss(look) : pixelCss(look)}
  </style></head><body><div class="menu" id="menu">
  <div class="head">${iconUrl ? `<img src="${iconUrl}" alt="" onerror="this.remove()">` : ''}<span>Amethyx</span>${version ? `<small>${escape(version)}</small>` : ''}</div>${rows}</div>
  <script>
    let ready = false;
    const say = (message) => { document.title = message + '/' + Date.now(); };
    const show = () => { if (!ready) { ready = true; say('ready/' + document.getElementById('menu').offsetHeight); } };
    document.fonts.load(${JSON.stringify(`16px "${look.font.name}"`).replace(/</g, '\\u003c')}).then(show, show);
    setTimeout(show, ${FONT_WAIT_MS});
    document.querySelectorAll('.item').forEach((item) => item.addEventListener('click', () => say('pick/' + item.dataset.index)));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') say('close'); });
  </script></body></html>`;
}

function closeMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
  menuWindow = null;
}

/**
 * Opens the menu by the tray icon. `items`: [{ label, click, icon?, danger? } | { separator: true }]
 * (icon: a name from ICONS).
 * `anchor`: the tray icon's bounds (from the tray's click event), else the mouse position is used.
 * `onFail`: called when the menu could not appear (tray.js then shows Windows' own menu).
 */
function openTrayMenu(items, anchor = null, onFail = null) {
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
  // Right after it appears Windows may hand the focus back to the taskbar for a moment: a blur
  // that early does not close the menu (a click elsewhere later does).
  let shownAt = 0;
  window.on('blur', () => {
    if (menuWindow !== window) return;
    if (Date.now() - shownAt < BLUR_GRACE_MS) {
      setTimeout(() => window.isDestroyed() || window.focus(), 0);
      return;
    }
    closeMenu();
  });
  let shown = false;
  const fail = () => {
    if (shown) return;
    shown = true;
    if (menuWindow === window) closeMenu();
    onFail?.();
  };
  const failTimer = setTimeout(fail, FAIL_MS);
  // The soft panel has room for its shadow round it: the window is that much bigger on every side.
  let pad = 0;
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', fail);
  window.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    const message = String(title).replace(/\/\d+$/, '');
    if (message.startsWith('ready/')) {
      if (shown) return;
      shown = true;
      clearTimeout(failTimer);
      // The menu's real height is known now: it stands above the tray icon, inside the screen.
      const height = Math.max(60, Math.min(400, Number(message.slice('ready/'.length)) || 120));
      const x = Math.round(Math.min(workArea.x + workArea.width - WIDTH - 6, Math.max(workArea.x + 6, point.x - WIDTH / 2)));
      const below = point.y < workArea.y + workArea.height / 2;
      const y = Math.round(below ? Math.max(workArea.y + 6, point.y + 12) : Math.min(point.y, workArea.y + workArea.height) - height - 8);
      window.setBounds({ x: x - pad, y: y - pad, width: WIDTH + pad * 2, height: height + pad * 2 });
      shownAt = Date.now();
      window.show();
      window.focus();
    } else if (message.startsWith('pick/')) {
      const item = items[Number(message.slice('pick/'.length))];
      closeMenu();
      item?.click?.();
    } else if (message === 'close') {
      closeMenu();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popupLook().then((look) => {
    if (menuWindow !== window || window.isDestroyed()) return;
    pad = look.soft ? SOFT_PAD : 0;
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(items, shortVersion(app.getVersion()), look))}`).catch(fail);
  }, fail);
}

module.exports = { openTrayMenu, closeTrayMenu: closeMenu };
