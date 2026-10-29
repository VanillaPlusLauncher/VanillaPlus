'use strict';

/*
 * Turns the hand-drawn pixel icons of src/assets/ui/pixel-icons.txt into SVG files beside it: one
 * <rect> per run of pixels in a row, crisp edges, black on transparent (the interface uses them as
 * CSS masks, so they take the text colour), and a coloured <name>.color.svg of each (see COLOURS).
 * With --preview <file.html> it also writes a page that shows them all at 20 px and 60 px.
 * Usage: node installer/tools/make-pixel-icons.js [--preview out.html]
 */
const fs = require('node:fs');
const path = require('node:path');

const folder = path.join(__dirname, '..', '..', 'src', 'assets', 'ui');
const source = fs.readFileSync(path.join(folder, 'pixel-icons.txt'), 'utf8').replace(/\r/g, '');

/*
 * Coloured versions (<name>.color.svg, Settings → Interface → Icons: "Цветные"), each icon its own
 * colour like an item in the inventory. "fill": a drawn outline (o) with the inside painted (f), its
 * lowest row in shade (s) and inner lines in d. "solid": the pixels themselves painted (f), lit on
 * top (h) and in shade at the bottom (s).
 */
const COLOURS = {
  home: { mode: 'fill', o: '#5a3216', f: '#d39a5c', d: '#5a3216' },
  cube: { mode: 'fill', o: '#4b2a86', f: '#c4a2ff', d: '#6b40c0' },
  stack: { mode: 'fill', o: '#3c3c50', f: '#cfcfe0', d: '#7a7a92' },
  gear: { mode: 'solid', f: '#b9b9cc' },
  user: { mode: 'solid', f: '#f2c08e' },
  download: { mode: 'solid', f: '#62d870' },
  folder: { mode: 'fill', o: '#7a4e12', f: '#f2c45c', d: '#7a4e12' },
  file: { mode: 'fill', o: '#55556a', f: '#f4efe2', d: '#8a8aa0' },
  export: { mode: 'solid', f: '#62b8ff' },
  search: { mode: 'fill', o: '#4a4a5e', f: '#a8dcff', d: '#4a4a5e' },
  play: { mode: 'solid', f: '#62d870' },
  chevron: { mode: 'solid', f: '#d8cff0' },
  close: { mode: 'solid', f: '#ff6b5e' },
  minus: { mode: 'solid', f: '#d8cff0' },
  fullscreen: { mode: 'solid', f: '#d8cff0' },
  'fullscreen-exit': { mode: 'solid', f: '#d8cff0' },
  bolt: { mode: 'solid', f: '#ffd84a' },
  pencil: { mode: 'fill', o: '#8a5a1c', f: '#ffd84a', d: '#8a5a1c' },
  image: { mode: 'fill', o: '#5a4020', f: '#8fd3ff', d: '#4caf50' },
  cloud: { mode: 'solid', f: '#eef3ff' },
  globe: { mode: 'fill', o: '#1d5a8a', f: '#62b8ff', d: '#4caf50' },
};

function mix(hex, toward, amount) {
  const channel = (value, index) => parseInt(value.slice(1 + index * 2, 3 + index * 2), 16);
  const target = toward === 'white' ? 255 : 0;
  return `#${[0, 1, 2].map((index) => Math.round(channel(hex, index) + (target - channel(hex, index)) * amount).toString(16).padStart(2, '0')).join('')}`;
}

/** The colour of each pixel of one icon, row by row (null where it stays empty). */
function paint(name, rows) {
  const colours = COLOURS[name] ?? { mode: 'solid', f: '#d8cff0' };
  const at = (x, y) => (rows[y] ?? '')[x] ?? '.';
  // Empty pixels reachable from the edge are outside; the rest are the inside of a drawn outline.
  const outside = rows.map((row) => [...row].map(() => false));
  const queue = [];
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) {
    if ((x === 0 || y === 0 || x === 9 || y === 9) && at(x, y) !== '#') { outside[y][x] = true; queue.push([x, y]); }
  }
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx > 9 || ny > 9 || outside[ny][nx] || at(nx, ny) === '#') continue;
      outside[ny][nx] = true;
      queue.push([nx, ny]);
    }
  }
  const touchesOutside = (x, y) => [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].some(([nx, ny]) => nx < 0 || ny < 0 || nx > 9 || ny > 9 || outside[ny][nx]);
  return rows.map((row, y) => [...row].map((pixel, x) => {
    if (colours.mode === 'solid') {
      if (pixel !== '#') return null;
      if (at(x, y + 1) !== '#') return mix(colours.f, 'black', 0.28);
      if (at(x, y - 1) !== '#') return mix(colours.f, 'white', 0.4);
      return colours.f;
    }
    if (pixel === '#') return touchesOutside(x, y) ? colours.o : colours.d;
    if (outside[y][x]) return null;
    return at(x, y + 1) === '#' ? mix(colours.f, 'black', 0.22) : colours.f;
  }));
}

function colourSvg(name, rows) {
  const rects = [];
  paint(name, rows).forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (!row[x]) continue;
      let end = x;
      while (row[end + 1] === row[x]) end += 1;
      rects.push(`<rect x="${x}" y="${y}" width="${end - x + 1}" height="1" fill="${row[x]}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
}

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
  fs.writeFileSync(path.join(folder, `${name.trim()}.color.svg`), colourSvg(name.trim(), rows.map((row) => row.padEnd(10, '.'))));
  icons.push(name.trim());
}
console.log(`${icons.length} icons: ${icons.join(', ')}`);

const previewIndex = process.argv.indexOf('--preview');
if (previewIndex > 0) {
  const out = process.argv[previewIndex + 1];
  const cell = (name, size) => `<span style="display:inline-block;width:${size}px;height:${size}px;background:#e8e2f5;-webkit-mask:url('${path.join(folder, `${name}.svg`).replace(/\\/g, '/')}') center/contain no-repeat;filter:drop-shadow(${size / 10}px ${size / 10}px 0 rgba(0,0,0,.45))"></span>`;
  const colour = (name, size) => `<img width="${size}" height="${size}" style="image-rendering:pixelated" src="${path.join(folder, `${name}.color.svg`).replace(/\\/g, '/')}">`;
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:#16121f;font:12px Consolas,monospace;color:#c4bbd8;display:grid;grid-template-columns:repeat(4,220px);gap:14px">${icons
    .map((name) => `<div style="display:flex;align-items:center;gap:12px">${cell(name, 20)}${cell(name, 60)}${colour(name, 20)}${colour(name, 60)}<span>${name}</span></div>`)
    .join('')}</body>`;
  fs.writeFileSync(out, html);
}
