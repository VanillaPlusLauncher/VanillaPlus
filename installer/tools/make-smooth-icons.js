'use strict';

/*
 * The smooth icons of the soft look (renderer/css/icons.css): the same set and the same colours as the
 * coloured pixel icons (make-pixel-icons.js), drawn as round shapes on a 24 × 24 grid with a light-to-
 * dark gradient instead of pixel shading. Writes src/assets/ui/<name>.smooth.svg. As CSS masks (the
 * single-colour setting, window buttons, arrows) only the outline counts, so the line icons are lines.
 * Usage: node installer/tools/make-smooth-icons.js
 */
const fs = require('node:fs');
const path = require('node:path');

const folder = path.join(__dirname, '..', '..', 'src', 'assets', 'ui');

/** A top-to-bottom gradient called `id`. */
const grad = (id, top, bottom) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;
/** Round corners for straight-edged shapes: a stroke of the shape's own paint. */
const round = (paint, width = 1.6) => `stroke="${paint}" stroke-width="${width}" stroke-linejoin="round"`;
const line = (colour, width) => `fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

const ICONS = {
  home: {
    defs: grad('w', '#ecbd84', '#c98b52'),
    body: `<rect x="5" y="10.5" width="14" height="10.5" rx="2" fill="url(#w)"/>
      <path d="M12 3.4 2.9 11.1a1.1 1.1 0 0 0 .7 1.9h16.8a1.1 1.1 0 0 0 .7-1.9z" fill="#a9653a"/>
      <rect x="10" y="14.5" width="4" height="6.5" rx="1.2" fill="#6e3d1e"/>`,
  },
  cube: {
    body: `<path d="M12 2.8 20.8 7.6 12 12.4 3.2 7.6z" fill="#e6d6ff" ${round('#e6d6ff')}/>
      <path d="M3.2 7.6 12 12.4v9L3.2 16.6z" fill="#b28af5" ${round('#b28af5')}/>
      <path d="M20.8 7.6 12 12.4v9l8.8-4.8z" fill="#7a4fd3" ${round('#7a4fd3')}/>`,
  },
  stack: {
    body: `<path d="M12 11.5 21 16 12 20.5 3 16z" fill="#8a8aa6" ${round('#8a8aa6')}/>
      <path d="M12 7.5 21 12 12 16.5 3 12z" fill="#b3b3cb" ${round('#b3b3cb')}/>
      <path d="M12 3.5 21 8 12 12.5 3 8z" fill="#e4e4f2" ${round('#e4e4f2')}/>`,
  },
  gear: {
    defs: `${grad('s', '#e6e6f0', '#9898ae')}<mask id="h"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="12" r="3.2" fill="#000"/></mask>`,
    body: `<g fill="url(#s)" mask="url(#h)"><circle cx="12" cy="12" r="7.2"/>${[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => `<rect x="10.3" y="1.6" width="3.4" height="5" rx="1.2" transform="rotate(${angle} 12 12)"/>`).join('')}</g>`,
  },
  user: {
    defs: grad('k', '#ffdcb6', '#f0b07a') + grad('t', '#7fbcff', '#3f86e8'),
    body: `<path d="M3.8 21.2c0-4.6 3.7-7.7 8.2-7.7s8.2 3.1 8.2 7.7z" fill="url(#t)"/>
      <circle cx="12" cy="7.8" r="4.4" fill="url(#k)"/>`,
  },
  download: {
    defs: grad('g', '#86f292', '#3caf4c'),
    body: `<rect x="3" y="17" width="18" height="4.2" rx="2.1" fill="#b48cff"/>
      <rect x="10" y="2.8" width="4" height="9" rx="1.6" fill="url(#g)"/>
      <path d="M6.6 10.4h10.8L12 15.8z" fill="#3caf4c" ${round('#3caf4c', 1.8)}/>`,
  },
  folder: {
    defs: grad('f', '#ffdd7a', '#f0b43a'),
    body: `<path d="M3 6.6A2 2 0 0 1 5 4.6h4.3l2 2.1H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#cf9a2a"/>
      <rect x="3" y="8.8" width="18" height="11.2" rx="2" fill="url(#f)"/>`,
  },
  file: {
    defs: grad('p', '#ffffff', '#e4dcc6'),
    body: `<path d="M6.5 2.5H14l5 5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20.5V4a1.5 1.5 0 0 1 1.5-1.5z" fill="url(#p)"/>
      <path d="M14 2.5V6a1.5 1.5 0 0 0 1.5 1.5H19z" fill="#cdbf9e"/>
      <path d="M8.5 11.5h7M8.5 14.8h7M8.5 18.1h4.5" ${line('#ab9f84', 1.6)}/>`,
  },
  export: {
    defs: grad('b', '#8ccbff', '#3d8fe6'),
    body: `<rect x="3" y="17" width="18" height="4.2" rx="2.1" fill="#b48cff"/>
      <rect x="10" y="7.2" width="4" height="8.6" rx="1.6" fill="#3d8fe6"/>
      <path d="M6.6 9.2h10.8L12 3.8z" fill="url(#b)" ${round('#6fb6ff', 1.8)}/>`,
  },
  search: {
    defs: grad('l', '#e2f4ff', '#93d2ff'),
    body: `<path d="M15.6 15.6 20.6 20.6" ${line('#8a5a2a', 3.4)}/>
      <circle cx="10.5" cy="10.5" r="6.3" fill="url(#l)" stroke="#6c6c84" stroke-width="2.4"/>
      <path d="M7.6 9.2a3.2 3.2 0 0 1 2.4-2.4" ${line('#ffffff', 1.6)}/>`,
  },
  play: {
    defs: grad('g', '#8af596', '#3caf4c'),
    body: `<path d="M7 4.7v14.6a1.3 1.3 0 0 0 2 1.1l11.3-7.3a1.3 1.3 0 0 0 0-2.2L9 3.6a1.3 1.3 0 0 0-2 1.1z" fill="url(#g)"/>`,
  },
  chevron: { body: `<path d="M6.5 9.5 12 15l5.5-5.5" ${line('#d8cff0', 2.6)}/>` },
  close: { body: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" ${line('#ff6b5e', 3)}/>` },
  minus: { body: `<path d="M5.5 12h13" ${line('#d8cff0', 2.4)}/>` },
  fullscreen: { body: `<path d="M4.5 9V6A1.5 1.5 0 0 1 6 4.5h3M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3M19.5 15v3a1.5 1.5 0 0 1-1.5 1.5h-3M9 19.5H6A1.5 1.5 0 0 1 4.5 18v-3" ${line('#d8cff0', 2.2)}/>` },
  'fullscreen-exit': { body: `<path d="M9 4.5v3A1.5 1.5 0 0 1 7.5 9h-3M19.5 9h-3A1.5 1.5 0 0 1 15 7.5v-3M15 19.5v-3a1.5 1.5 0 0 1 1.5-1.5h3M4.5 15h3A1.5 1.5 0 0 1 9 16.5v3" ${line('#d8cff0', 2.2)}/>` },
  bolt: {
    defs: grad('y', '#ffeb8a', '#f3b31c'),
    body: `<path d="M13.6 2.4 5.2 13.4h6.1l-1.8 8.2 9.3-12.1h-6.3z" fill="url(#y)" ${round('#f8cf4a', 1.4)}/>`,
  },
  pencil: {
    defs: grad('y', '#ffe46a', '#f2b72e'),
    body: `<path d="M15.1 4.6 19.4 8.9 9.2 19.1 4.9 14.8z" fill="url(#y)" ${round('#f6c843', 1.2)}/>
      <path d="M4.9 14.8 9.2 19.1 3.4 20.6z" fill="#f2d3a5" ${round('#f2d3a5', 1.2)}/>
      <path d="M3.4 20.6 4.1 18l1.9 1.9z" fill="#3c3c4c"/>
      <path d="M15.1 4.6 16.6 3.1a1.8 1.8 0 0 1 2.5 0l1.8 1.8a1.8 1.8 0 0 1 0 2.5l-1.5 1.5z" fill="#ff8ea4"/>`,
  },
  image: {
    defs: `${grad('a', '#c7ebff', '#7cc3ff')}<clipPath id="c"><rect x="3" y="4" width="18" height="16" rx="2.6"/></clipPath>`,
    body: `<rect x="3" y="4" width="18" height="16" rx="2.6" fill="url(#a)"/>
      <circle cx="16.4" cy="8.8" r="2" fill="#ffe066"/>
      <g clip-path="url(#c)"><path d="M2 20.5V17l6.3-6.3 5 5.2 2.6-2.5 6.1 6.1v1z" fill="#4fb85a"/></g>`,
  },
  cloud: {
    defs: grad('c', '#ffffff', '#cdd8f2'),
    body: `<path d="M7.2 19.2a4.6 4.6 0 0 1-.6-9.15 6 6 0 0 1 11.3-.85 4.3 4.3 0 0 1-.3 10z" fill="url(#c)"/>`,
  },
  globe: {
    defs: `${grad('o', '#92d2ff', '#3a8ae0')}<clipPath id="r"><circle cx="12" cy="12" r="9"/></clipPath>`,
    body: `<circle cx="12" cy="12" r="9" fill="url(#o)"/>
      <g clip-path="url(#r)" fill="#5cc867">
        <path d="M4.5 6.8c2.4.2 4.1 1.6 3.6 3.4-.4 1.5-2.4 1.6-2.7 3.3-.2 1.3-1.7 1.6-2.6.8L2 9z"/>
        <path d="M14.2 12.2c1.7-.7 3.6.1 3.9 1.8.3 1.9-1.4 3.1-2.5 4.6-.6.9-2 .6-2-.6 0-1.7-1.5-2.5-1.1-4 .2-.9.9-1.5 1.7-1.8z"/>
        <path d="M12.5 3.6c1.2.6 1.4 1.8.6 2.6-.7.7-2 .6-2.4-.3-.3-.8.3-1.8 1.8-2.3z"/>
      </g>
      <path d="M7.4 6.4a7 7 0 0 1 4.4-1.9" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.4" stroke-linecap="round"/>`,
  },
};

for (const [name, icon] of Object.entries(ICONS)) {
  const defs = icon.defs ? `<defs>${icon.defs}</defs>` : '';
  const body = icon.body.replace(/\n\s+/g, '');
  fs.writeFileSync(path.join(folder, `${name}.smooth.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${defs}${body}</svg>\n`);
}
console.log(`${Object.keys(ICONS).length} smooth icons`);
