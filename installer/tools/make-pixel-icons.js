'use strict';

/*
 * Turns the hand-drawn pixel icons of src/assets/ui/pixel-icons.txt into SVG files beside it: one
 * <rect> per run of pixels in a row, crisp edges, black on transparent (the interface uses them as
 * CSS masks, so they take the text colour). With --preview <file.html> it also writes a page that
 * shows them all at 20 px and 60 px.
 * Usage: node installer/tools/make-pixel-icons.js [--preview out.html]
 */
const fs = require('node:fs');
const path = require('node:path');

const folder = path.join(__dirname, '..', '..', 'src', 'assets', 'ui');
const source = fs.readFileSync(path.join(folder, 'pixel-icons.txt'), 'utf8').replace(/\r/g, '');

const icons = [];
for (const block of source.split(/\n\s*\n/)) {
  // Comments start with "# " (a pixel row has no spaces).
  const lines = block.split('\n').filter((line) => line && !line.startsWith('# '));
  if (lines.length < 2) continue;
  const [name, ...rows] = lines;
  const width = Math.max(...rows.map((row) => row.length));
  if (rows.length !== 10 || width !== 10) throw new Error(`${name}: ${width}×${rows.length}, expected 10×10`);
  const rects = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== '#') continue;
      let end = x;
      while (row[end + 1] === '#') end += 1;
      rects.push(`<rect x="${x}" y="${y}" width="${end - x + 1}" height="1"/>`);
      x = end;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
  fs.writeFileSync(path.join(folder, `${name.trim()}.svg`), svg);
  icons.push(name.trim());
}
console.log(`${icons.length} icons: ${icons.join(', ')}`);

const previewIndex = process.argv.indexOf('--preview');
if (previewIndex > 0) {
  const out = process.argv[previewIndex + 1];
  const cell = (name, size) => `<span style="display:inline-block;width:${size}px;height:${size}px;background:#e8e2f5;-webkit-mask:url('${path.join(folder, `${name}.svg`).replace(/\\/g, '/')}') center/contain no-repeat;filter:drop-shadow(${size / 10}px ${size / 10}px 0 rgba(0,0,0,.45))"></span>`;
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:#16121f;font:12px Consolas,monospace;color:#c4bbd8;display:grid;grid-template-columns:repeat(5,150px);gap:14px">${icons
    .map((name) => `<div style="display:flex;align-items:center;gap:12px">${cell(name, 20)}${cell(name, 60)}<span>${name}</span></div>`)
    .join('')}</body>`;
  fs.writeFileSync(out, html);
}
