import { api } from '../services/api.js';
import { getMcManifest, mcUrl, onMcReady } from './mc.js';

/** Player heads (face + hat layer) drawn from account skins, cached per account. */
const cache = new Map();
let steveHead = null;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

/** URL of the game's default skin ('steve' or 'alex'), or null before the game's textures are there. */
export function defaultSkinUrl(name = 'steve') {
  const path = getMcManifest()?.textures.skins?.[name];
  return path ? mcUrl(path) : null;
}

/** Steve's head: what a profile without its own skin looks like in the game. */
export function defaultHead() {
  const url = defaultSkinUrl('steve');
  if (!url) {
    return Promise.resolve(null);
  }
  steveHead ??= headFromUrl(url).catch(() => null);
  return steveHead;
}

onMcReady(() => {
  steveHead = null;
});

async function headFromUrl(url, size = 64) {
  return drawHead(await loadImage(url), size);
}

/** Face of a skin PNG (base64) as a data: URL of `size` pixels. */
export async function headFromSkin(pngBase64, size = 64) {
  return drawHead(await loadImage(`data:image/png;base64,${pngBase64}`), size);
}

function drawHead(image, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 8, 8, 8, 8, 0, 0, size, size);
  if (image.height >= 64 || image.width >= 64) {
    context.drawImage(image, 40, 8, 8, 8, 0, 0, size, size);
  }
  return canvas.toDataURL('image/png');
}

/** Head of an account's current skin; Steve's head when it has none (or there is no account). */
export function accountHead(account, { refresh = false } = {}) {
  if (!account) {
    return defaultHead();
  }
  if (refresh) {
    cache.delete(account.id);
  }
  if (!cache.has(account.id)) {
    cache.set(
      account.id,
      api.skins
        .accountSkin(account.id)
        .then((skin) => (skin ? headFromSkin(skin.pngBase64) : null))
        .catch(() => null),
    );
  }
  return cache.get(account.id).then((head) => head ?? defaultHead());
}

let revision = 0;

export function forgetAccountHead(accountId) {
  cache.delete(accountId);
  revision += 1;
}

/** Changes whenever a head is forgotten, so views know to redraw it. */
export function headRevision() {
  return revision;
}
