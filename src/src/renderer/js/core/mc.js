import { api } from '../services/api.js';
import { assetUrl } from './assets.js';

/*
 * Textures and sounds the launcher took from Minecraft itself (see main/minecraft/mcResources.js).
 * Until they are ready the UI uses its own artwork; `onMcReady` callbacks run once they arrive.
 */

let manifest = null;
const listeners = new Set();
const iconCache = new Map();

/** URL of a file in mc-ui; the version in the query makes the window reload files after an update. */
export function mcUrl(relativePath) {
  return `app://mc/${relativePath}${manifest?.sourceVersion ? `?v=${encodeURIComponent(manifest.sourceVersion)}` : ''}`;
}

export function getMcManifest() {
  return manifest;
}

export function onMcReady(callback) {
  listeners.add(callback);
  if (manifest) {
    callback(manifest);
  }
  return () => listeners.delete(callback);
}

function apply(next) {
  if (!next) {
    return;
  }
  manifest = next;
  iconCache.clear();
  document.documentElement.classList.add('mc-ready');
  for (const listener of [...listeners]) {
    listener(manifest);
  }
}

/** Loads the manifest. Resolves with true when the resources are already on disk. */
export async function initMc() {
  api.events.onMcResources(apply);
  try {
    const current = await api.minecraft.resources();
    apply(current);
    return Boolean(current);
  } catch {
    // The launcher works with its own artwork until the resources are there.
    return false;
  }
}

export function hasBlock(name) {
  return Boolean(manifest?.textures.blocks.includes(name));
}

export function hasItem(name) {
  return Boolean(manifest?.textures.items.includes(name));
}

/** Blocks that look different on top: { id: [top, side] }. Others use one texture on every face. */
const BLOCK_FACES = {
  grass_block: ['grass_block_top', 'grass_block_side'],
  crafting_table: ['crafting_table_top', 'crafting_table_front'],
  tnt: ['tnt_top', 'tnt_side'],
  oak_log: ['oak_log_top', 'oak_log'],
  pumpkin: ['pumpkin_top', 'pumpkin_side'],
  melon: ['melon_top', 'melon_side'],
  jukebox: ['jukebox_top', 'jukebox_side'],
  hay_block: ['hay_block_top', 'hay_block_side'],
  ancient_debris: ['ancient_debris_top', 'ancient_debris_side'],
  furnace: ['cobblestone', 'furnace_front'],
  bookshelf: ['oak_planks', 'bookshelf'],
  respawn_anchor: ['respawn_anchor_top', 'crying_obsidian'],
};
/** Grey textures the game colours by biome. */
const TINTS = { grass_block_top: '#86c95a', oak_leaves: '#59ae30' };

/** True when the game's textures for every face of the block are present. */
export function blockAvailable(id) {
  const [top, side] = BLOCK_FACES[id] ?? [id, id];
  return hasBlock(top) && hasBlock(side);
}

/** Block icons offered for instances. */
export const ICON_BLOCKS = [
  'grass_block', 'dirt', 'stone', 'cobblestone', 'mossy_cobblestone', 'oak_planks', 'cherry_planks', 'oak_log', 'bricks', 'bookshelf',
  'crafting_table', 'furnace', 'tnt', 'diamond_ore', 'emerald_ore', 'gold_ore', 'diamond_block', 'emerald_block', 'gold_block', 'iron_block',
  'redstone_block', 'lapis_block', 'amethyst_block', 'copper_block', 'obsidian', 'crying_obsidian', 'netherrack', 'nether_bricks',
  'ancient_debris', 'end_stone', 'purpur_block', 'prismarine_bricks', 'sea_lantern', 'glowstone', 'sculk', 'moss_block', 'oak_leaves',
  'pumpkin', 'melon', 'hay_block', 'honeycomb_block', 'jukebox', 'note_block', 'snow', 'ice', 'sand', 'clay', 'deepslate', 'respawn_anchor', 'beacon',
];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Without CORS the canvas would be "tainted" and toDataURL would throw.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

/** A 16x16 face as a canvas, tinted when the game tints it. Animated textures use their first frame. */
async function faceCanvas(name) {
  const image = await loadImage(mcUrl(`block/${name}.png`));
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, 16, 16, 0, 0, 16, 16);
  const tint = TINTS[name];
  if (tint) {
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = tint;
    context.fillRect(0, 0, 16, 16);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(image, 0, 0, 16, 16, 0, 0, 16, 16);
  }
  return canvas;
}

/** Resolution block icons are drawn at; the page scales them down smoothly. */
const BLOCK_ICON_RESOLUTION = 192;

/**
 * Draws a block like the classic grass-block icon: an isometric cube, each texture pixel a clean
 * parallelogram (no stair-stepping from rotating a bitmap), top lit, sides softly shaded.
 * Geometry in a 64×64 box: width W, top face W/2 high, vertical edges 0.61·W (as in the game).
 * Returns a data: URL (cached).
 */
export async function blockIcon(id, size = BLOCK_ICON_RESOLUTION) {
  const key = `${id}@${size}`;
  if (iconCache.has(key)) {
    return iconCache.get(key);
  }
  const [topName, sideName] = BLOCK_FACES[id] ?? [id, id];
  const promise = (async () => {
    const [top, side] = await Promise.all([faceCanvas(topName), faceCanvas(sideName)]);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const scale = size / 64;
    // Exactly the game's inventory cube: vertical edges cos30°/√2 ≈ 0.612 of the width.
    const width = 56;
    const dx = width / 32;
    const dyTop = dx / 2;
    const dySide = (width * 0.6124) / 16;
    const left = (64 - width) / 2;
    const top0 = (64 - (width / 2 + dySide * 16)) / 2;
    const faces = [
      { image: top, transform: [dx, dyTop, -dx, dyTop, 32, top0], light: 1 },
      { image: side, transform: [dx, dyTop, 0, dySide, left, top0 + width / 4], light: 0.9 },
      { image: side, transform: [dx, -dyTop, 0, dySide, 32, top0 + width / 2], light: 0.72 },
    ];
    for (const face of faces) {
      const [a, b, c, d, e, f] = face.transform;
      const point = (u, v) => [(a * u + c * v + e) * scale, (b * u + d * v + f) * scale];
      const pixels = face.image.getContext('2d').getImageData(0, 0, 16, 16).data;
      for (let v = 0; v < 16; v += 1) {
        for (let u = 0; u < 16; u += 1) {
          const index = (v * 16 + u) * 4;
          if (pixels[index + 3] < 8) {
            continue;
          }
          const color = `rgb(${Math.round(pixels[index] * face.light)}, ${Math.round(pixels[index + 1] * face.light)}, ${Math.round(pixels[index + 2] * face.light)})`;
          context.fillStyle = color;
          // A hairline of the same colour closes the gaps antialiasing leaves between cells.
          context.strokeStyle = color;
          context.lineWidth = 0.6;
          context.beginPath();
          context.moveTo(...point(u, v));
          context.lineTo(...point(u + 1, v));
          context.lineTo(...point(u + 1, v + 1));
          context.lineTo(...point(u, v + 1));
          context.closePath();
          context.fill();
          context.stroke();
        }
      }
    }
    return canvas.toDataURL('image/png');
  })().catch(() => assetUrl('icons/grass-block.png'));
  iconCache.set(key, promise);
  return promise;
}

/**
 * Resolves an instance icon value to an image URL:
 * "block:<id>" — isometric block, "item:<id>" — item texture, https:// — remote (modpack icon).
 */
export async function iconUrl(icon) {
  const value = icon || 'block:grass_block';
  if (value.startsWith('https://') || value.startsWith('data:')) {
    return value;
  }
  const [kind, name] = value.includes(':') ? value.split(':') : ['block', value];
  if (!manifest) {
    return assetUrl('icons/grass-block.png');
  }
  if (kind === 'item' && hasItem(name)) {
    return mcUrl(`item/${name}.png`);
  }
  const block = BLOCK_FACES[name] || hasBlock(name) ? name : 'grass_block';
  return blockIcon(block);
}

/** <img> that shows an instance icon; updates itself when the Minecraft textures arrive. */
export function iconImage(icon, className = 'block-icon') {
  const image = document.createElement('img');
  image.className = className;
  image.alt = '';
  image.decoding = 'async';
  image.src = assetUrl('icons/grass-block.png');
  const update = () => iconUrl(icon).then((url) => {
    // Block icons are drawn at high resolution and look best scaled smoothly; item textures stay pixelated.
    image.classList.toggle('is-smooth', url.startsWith('data:') || url.startsWith('https://'));
    image.src = url;
  });
  update();
  if (!manifest) {
    const stop = onMcReady(() => {
      stop();
      update();
    });
  }
  return image;
}
