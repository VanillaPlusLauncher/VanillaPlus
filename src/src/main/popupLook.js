'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getSettings } = require('./settings/settingsService');

/*
 * The look of the launcher's little windows outside the main one (the tray menu, the notice cards):
 * the same choices as the main window (Settings → Оформление) — the buttons' style (soft or pixel),
 * the font, the theme colour and the icons. These windows are plain data: pages, so everything they
 * need comes as values and data URLs from here.
 */

const UI_ICONS = path.join(__dirname, '..', '..', 'assets', 'ui');

/** Theme colours as in renderer/css/tokens.css: the colour and its hue (the soft look tints its panels with it). */
const ACCENTS = {
  amethyst: { rgb: '190, 160, 255', strong: '150, 112, 245', hue: 257.1 },
  vanilla: { rgb: '247, 215, 148', strong: '236, 186, 92', hue: 39.2 },
  berry: { rgb: '255, 138, 168', strong: '242, 88, 128', hue: 344.4 },
  lavender: { rgb: '194, 176, 255', strong: '150, 122, 250', hue: 253.1 },
  diamond: { rgb: '124, 236, 255', strong: '74, 214, 238', hue: 188.8 },
  gold: { rgb: '255, 216, 107', strong: '246, 192, 64', hue: 42.2 },
  redstone: { rgb: '255, 120, 112', strong: '236, 72, 64', hue: 2.8 },
  lapis: { rgb: '138, 172, 255', strong: '88, 128, 242', hue: 224.4 },
  copper: { rgb: '255, 176, 128', strong: '226, 128, 80', hue: 19.7 },
};

/** The fonts of Settings → Оформление → Шрифт (renderer/css/tokens.css), as Google Fonts families. */
const FONTS = {
  pixel: { name: 'Tiny5', query: 'Tiny5' },
  clean: { name: 'Inter', query: 'Inter:wght@400;500;600' },
  golos: { name: 'Golos Text', query: 'Golos+Text:wght@400;500;600' },
  onest: { name: 'Onest', query: 'Onest:wght@400;500;600' },
  manrope: { name: 'Manrope', query: 'Manrope:wght@400;500;600' },
  nunito: { name: 'Nunito', query: 'Nunito:wght@400;600' },
  rubik: { name: 'Rubik', query: 'Rubik:wght@400;500;600' },
  montserrat: { name: 'Montserrat', query: 'Montserrat:wght@400;500;600' },
  comfortaa: { name: 'Comfortaa', query: 'Comfortaa:wght@400;500;600' },
  exo: { name: 'Exo 2', query: 'Exo+2:wght@400;500;600' },
  unbounded: { name: 'Unbounded', query: 'Unbounded:wght@400;500;600' },
};

const iconCache = new Map();

/** One of the launcher's icons (src/assets/ui/<file>) as a data URL, or null when it cannot be read. */
function iconFile(file) {
  if (!iconCache.has(file)) {
    let url = null;
    try {
      const type = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      url = `data:${type};base64,${fs.readFileSync(path.join(UI_ICONS, file)).toString('base64')}`;
    } catch {}
    iconCache.set(file, url);
  }
  return iconCache.get(file);
}

/**
 * The look chosen in the settings: { soft, pixelFont, font: { name, url }, accent, icons }.
 * Unreadable settings give the defaults (soft, the pixel font, amethyst, coloured icons).
 */
async function popupLook() {
  const settings = await getSettings().catch(() => null);
  const ui = settings?.ui ?? {};
  const font = FONTS[ui.font] ?? FONTS.pixel;
  return {
    soft: ui.style !== 'pixel',
    pixelFont: font === FONTS.pixel,
    font: { name: font.name, url: `https://fonts.googleapis.com/css2?family=${font.query}&display=block` },
    accent: ACCENTS[ui.accent] ?? ACCENTS.amethyst,
    icons: ui.icons === 'mono' ? 'mono' : 'color',
  };
}

/**
 * An icon of the soft look as the main window shows it (css/icons.css): the 3D picture with
 * "Цветные", the smooth silhouette (to use as a mask in the text colour) with "Одноцветные".
 * { url, mask } or null.
 */
function softIcon(name, look) {
  if (look.icons === 'mono') {
    const url = iconFile(`${name}.smooth.svg`);
    return url ? { url, mask: true } : null;
  }
  const url = iconFile(`${name}.3d.png`);
  return url ? { url, mask: false } : null;
}

/** The font's family for CSS: the chosen one, then the system's. */
const fontStack = (look) => `"${look.font.name}", "Segoe UI", system-ui, sans-serif`;

module.exports = { popupLook, softIcon, fontStack };
