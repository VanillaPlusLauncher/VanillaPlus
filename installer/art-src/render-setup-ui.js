'use strict';

/*
 * Renders the parts of setup-ui.html into PNGs (run by make-setup-art.ps1 through a launcher build's
 * AMETHYX_MAIN_SCRIPT hook, so it has Electron). Every [data-part] is drawn alone on a transparent
 * page at 1x, 2x and 3x and saved as setup-<part>-<k>x.png, with [data-pad] px round it for its
 * shadow (kept inside the window); the places of the pictures and of every [data-rect] at 1x go to
 * setup-layout.iss as Pascal constants (SetupBtnInstallX, ...), and a padded part's own box too
 * (SetupBtnInstallBoxX, ...: where a button is clicked).
 * Environment: SETUP_UI_PAGE (the copied setup-ui.html), SETUP_UI_OUT (installer/art).
 */
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

const W = 760;
const H = 460;
const SCALES = [1, 2, 3];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const constName = (name) => `Setup${name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;

module.exports = async ({ log }) => {
  const page = process.env.SETUP_UI_PAGE;
  const out = process.env.SETUP_UI_OUT;
  const win = new BrowserWindow({ width: W, height: H, show: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true, sandbox: true } });
  await win.loadFile(page);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode())))');
  const items = await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-part], [data-rect]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { part: el.dataset.part || null, rect: el.dataset.rect || null, pad: Number(el.dataset.pad || 0), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })`);
  const lines = ['{ Made by installer/art-src/render-setup-ui.js from setup-ui.html: do not edit by hand. }', 'const'];
  for (const item of items) {
    const name = constName(item.part || item.rect);
    if (item.pad) {
      lines.push(`  ${name}BoxX = ${item.x};`, `  ${name}BoxY = ${item.y};`, `  ${name}BoxW = ${item.w};`, `  ${name}BoxH = ${item.h};`);
      const left = Math.max(0, item.x - item.pad);
      const top = Math.max(0, item.y - item.pad);
      item.w = Math.min(W, item.x + item.w + item.pad) - left;
      item.h = Math.min(H, item.y + item.h + item.pad) - top;
      item.x = left;
      item.y = top;
    }
    lines.push(`  ${name}X = ${item.x};`, `  ${name}Y = ${item.y};`, `  ${name}W = ${item.w};`, `  ${name}H = ${item.h};`);
  }
  fs.writeFileSync(path.join(out, 'setup-layout.iss'), `${lines.join('\r\n')}\r\n`);

  for (const k of SCALES) {
    win.setContentSize(W * k, H * k);
    win.webContents.setZoomFactor(k);
    await wait(400);
    for (const item of items.filter((entry) => entry.part)) {
      await win.webContents.executeJavaScript(`document.querySelectorAll('[data-part]').forEach((el) => { el.style.visibility = el.dataset.part === ${JSON.stringify(item.part)} ? 'visible' : 'hidden'; })`);
      await wait(120);
      const image = await win.webContents.capturePage({ x: item.x * k, y: item.y * k, width: item.w * k, height: item.h * k });
      fs.writeFileSync(path.join(out, `setup-${item.part}-${k}x.png`), image.toPNG());
    }
    log(`rendered ${k}x`);
  }
  win.destroy();
};
