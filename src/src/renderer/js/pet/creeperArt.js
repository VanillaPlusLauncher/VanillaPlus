/*
 * The pet creeper's pixel textures, drawn here (nothing from the game is needed): the mottled
 * greens of a creeper and its face, one canvas per side of every part, one texel per model pixel.
 * The same random seed gives the same creeper every time.
 */

const GREENS = ['#0e9a12', '#12b416', '#0b7f0f', '#16c41b', '#3fd843', '#07650a', '#5fe262', '#0f8c12'];
/** The face, 8×8: '#' black, 'd' dark green (the mouth's corners), '.' skin. */
const FACE = [
  '........',
  '........',
  '.##..##.',
  '.##..##.',
  '...##...',
  '..####..',
  '..####..',
  '..#..#..',
];

/** A small seeded random (mulberry32): the same creeper on every start. */
function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mottled(width, height, random, face = null) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Mostly the middle greens, now and then a light or a dark speck.
      const roll = random();
      const color = roll < 0.07 ? GREENS[6] : roll < 0.14 ? GREENS[5] : GREENS[Math.floor(random() * 5)];
      context.fillStyle = color;
      context.fillRect(x, y, 1, 1);
    }
  }
  if (face) {
    face.forEach((row, y) =>
      [...row].forEach((cell, x) => {
        if (cell === '#') {
          context.fillStyle = (x + y) % 3 === 0 ? '#101010' : '#060606';
          context.fillRect(x, y, 1, 1);
        }
      }),
    );
  }
  return canvas.toDataURL();
}

let textures = null;

/**
 * Textures of every side of the creeper's parts: { head, body, leg } each { front, back, left,
 * right, top, bottom } as data URLs (sizes in model pixels: head 8×8×8, body 8×12×4, leg 4×6×4).
 */
export function creeperTextures() {
  if (textures) return textures;
  const random = seeded(4242);
  const part = (w, h, d, face = null) => ({
    front: mottled(w, h, random, face),
    back: mottled(w, h, random),
    left: mottled(d, h, random),
    right: mottled(d, h, random),
    top: mottled(w, d, random),
    bottom: mottled(w, d, random),
  });
  textures = { head: part(8, 8, 8, FACE), body: part(8, 12, 4), leg: part(4, 6, 4) };
  return textures;
}

/** Just the face (for the sidebar icon). */
export function creeperFaceIcon() {
  return creeperTextures().head.front;
}

/** The grass block the creeper stands on: { top, side, bottom } textures, `size` texels square. */
export function grassTextures(size = 16) {
  const random = seeded(77);
  const draw = (paint) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) paint(context, x, y);
    return canvas.toDataURL();
  };
  const grass = ['#5d9c36', '#6aad3e', '#4f8a2c', '#78bb47', '#578f33'];
  const dirt = ['#8a5a36', '#7a4f2f', '#966442', '#6b4428', '#a06d48'];
  const pick = (list) => list[Math.floor(random() * list.length)];
  return {
    top: draw((context, x, y) => {
      context.fillStyle = pick(grass);
      context.fillRect(x, y, 1, 1);
    }),
    side: draw((context, x, y) => {
      // Grass hangs a few uneven texels over the dirt, like the game's side texture.
      const edge = 3 + ((x * 7 + 3) % 3);
      context.fillStyle = y < edge ? pick(grass) : pick(dirt);
      context.fillRect(x, y, 1, 1);
    }),
    bottom: draw((context, x, y) => {
      context.fillStyle = pick(dirt);
      context.fillRect(x, y, 1, 1);
    }),
  };
}
