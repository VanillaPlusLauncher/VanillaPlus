import { getMcManifest, hasBlock, mcUrl, onMcReady } from '../core/mc.js';

/*
 * The start screen (its markup is in index.html, so it is there from the very first frame): the
 * launcher's X, its name, a piece of an amethyst geode turning slowly in the air — amethyst and
 * budding amethyst on top, calcite and smooth basalt below, the way a geode is layered in the game —
 * with crystals growing on the budding blocks stage by stage (small bud, medium, large, cluster),
 * sparkles around it, and what is loading with a bar. Meanwhile everything the launcher needs is
 * fetched (the game's textures, instances, accounts, fonts, news); when all of it is in, the screen
 * fades and the launcher is ready. Shown once per start of the launcher.
 *
 * The blocks use the game's own textures once they are on disk (main/minecraft/mcResources.js);
 * until then the launcher's look-alike drawings stand in, swapped as soon as the real ones arrive.
 */

/** The piece is SIDE × SIDE columns, LAYERS blocks tall. */
const SIDE = 3;
const LAYERS = 3;
/** One block, in px. */
const CELL = 26;
/** Top layer to bottom: what each layer is made of. */
const LAYER_BLOCKS = ['amethyst_block', 'calcite', 'smooth_basalt'];
/** Top-layer places (row-major) where budding amethyst grows crystals. */
const BUDDING = [0, 4, 8];
const STAGES = ['small_amethyst_bud', 'medium_amethyst_bud', 'large_amethyst_bud', 'amethyst_cluster'];
/** How long each crystal stage lasts, in ms; the cluster stays a little longer, then breaks. */
const STAGE_MS = 650;
const CLUSTER_MS = 1500;
/** Shading by the side a face looks to: a light from above and the front. */
const SHADE = { top: 1.08, south: 0.82, east: 0.92, north: 0.66, west: 0.74 };

// --- Look-alike drawings (16 × 16, like the game's textures) -------------------------------------

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    return value / 0x7fffffff;
  };
}

/** Mottled texture: soft patches from a coarse grid plus per-pixel grain, coloured from `palette`. */
function mottled(palette, { seed = 1, highlights = null, cracks = null } = {}) {
  const random = seeded(seed);
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d');
  const coarse = Array.from({ length: 25 }, () => random());
  const at = (x, y) => {
    const gx = x / 4;
    const gy = y / 4;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const v = (i, j) => coarse[Math.min(4, y0 + j) * 5 + Math.min(4, x0 + i)];
    return v(0, 0) * (1 - fx) * (1 - fy) + v(1, 0) * fx * (1 - fy) + v(0, 1) * (1 - fx) * fy + v(1, 1) * fx * fy;
  };
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const value = Math.min(0.999, Math.max(0, at(x, y) * 0.75 + random() * 0.4 - 0.08));
      context.fillStyle = palette[Math.floor(value * palette.length)];
      context.fillRect(x, y, 1, 1);
    }
  }
  if (highlights) {
    for (let index = 0; index < 7; index += 1) {
      const x = Math.floor(random() * 15);
      const y = Math.floor(random() * 15);
      context.fillStyle = highlights[index % highlights.length];
      context.fillRect(x, y, 1 + Math.round(random()), 1);
      context.fillStyle = highlights[(index + 1) % highlights.length];
      context.fillRect(x, y + 1, 1, 1);
    }
  }
  if (cracks) {
    context.fillStyle = cracks;
    for (const [x, y, w, h] of [[2, 3, 3, 1], [4, 3, 1, 2], [10, 2, 1, 3], [9, 4, 3, 1], [6, 10, 1, 3], [6, 12, 3, 1], [12, 11, 2, 1], [13, 9, 1, 3]]) {
      context.fillRect(x, y, w, h);
    }
  }
  return canvas.toDataURL();
}

/** A crystal of the given stage (0 small bud … 3 cluster): violet spikes with light tips. */
function crystal(stage, seed = 3) {
  const random = seeded(seed + stage * 17);
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d');
  const height = [5, 8, 11, 14][stage];
  const spikes = stage === 3 ? [[3, 9], [7, 14], [11, 10], [5, 6], [10, 6]] : [[7, height]];
  if (stage === 2) spikes.push([4, 7], [10, 8]);
  if (stage === 1) spikes.push([10, 5]);
  for (const [x, tall] of spikes) {
    for (let y = 0; y < tall; y += 1) {
      const row = 15 - y;
      const width = y > tall - 3 ? 1 : 2;
      context.fillStyle = y > tall - 3 ? '#f3d6ff' : random() < 0.3 ? '#b78cf0' : y % 3 === 0 ? '#6c44c4' : '#8a5ddc';
      context.fillRect(x, row, width, 1);
    }
  }
  return canvas.toDataURL();
}

const AMETHYST = ['#3b2470', '#4a2d8a', '#5b39a3', '#6f48bb', '#8459d0', '#9a70de'];
const AMETHYST_LIGHT = ['#c99cf0', '#e9c6f7', '#ffe3fb'];

function drawnTextures() {
  return {
    amethyst_block: mottled(AMETHYST, { seed: 11, highlights: AMETHYST_LIGHT }),
    budding_amethyst: mottled(AMETHYST, { seed: 23, highlights: AMETHYST_LIGHT, cracks: '#26144f' }),
    calcite: mottled(['#bdbeb9', '#cacbc6', '#d6d7d2', '#e2e3de', '#eeeeea'], { seed: 5 }),
    smooth_basalt: mottled(['#2f2f35', '#38383f', '#424249', '#4c4c54', '#56565e'], { seed: 7 }),
    ...Object.fromEntries(STAGES.map((name, stage) => [name, crystal(stage)])),
  };
}

// --- The geode piece -------------------------------------------------------------------------------

function face(texture, side, transform) {
  const element = document.createElement('span');
  element.className = `geode__face geode__face--${side}`;
  element.dataset.texture = texture;
  element.style.transform = transform;
  element.style.setProperty('--shade', String(SHADE[side]));
  return element;
}

/**
 * Builds the faces that can be seen (tops of the top layer, sides along the edge) of a SIDE × SIDE
 * × LAYERS piece, in a plane where x goes right, y towards the viewer and z up.
 */
function buildPiece(slab) {
  const c = CELL;
  for (let layer = 0; layer < LAYERS; layer += 1) {
    const z = LAYERS - 1 - layer; // the top layer is the highest
    for (let y = 0; y < SIDE; y += 1) {
      for (let x = 0; x < SIDE; x += 1) {
        const place = y * SIDE + x;
        const block = layer === 0 && BUDDING.includes(place) ? 'budding_amethyst' : LAYER_BLOCKS[layer];
        if (layer === 0) slab.append(face(block, 'top', `translate3d(${x * c}px, ${y * c}px, ${(z + 1) * c}px)`));
        if (y === SIDE - 1) slab.append(face(block, 'south', `translate3d(${x * c}px, ${(y + 1) * c}px, ${(z + 1) * c}px) rotateX(-90deg)`));
        if (y === 0) slab.append(face(block, 'north', `translate3d(${(x + 1) * c}px, ${y * c}px, ${(z + 1) * c}px) rotateZ(180deg) rotateX(-90deg)`));
        if (x === SIDE - 1) slab.append(face(block, 'east', `translate3d(${(x + 1) * c}px, ${(y + 1) * c}px, ${(z + 1) * c}px) rotateZ(-90deg) rotateX(-90deg)`));
        if (x === 0) slab.append(face(block, 'west', `translate3d(${x * c}px, ${y * c}px, ${(z + 1) * c}px) rotateZ(90deg) rotateX(-90deg)`));
      }
    }
  }
}

/** A crystal standing on a budding block: two crossed pictures, like plants and buds in the game. */
function buildCrystal(slab, place) {
  const c = CELL;
  const holder = document.createElement('span');
  holder.className = 'geode__crystal';
  holder.style.transform = `translate3d(${(place % SIDE) * c + c / 2}px, ${Math.floor(place / SIDE) * c + c / 2}px, ${LAYERS * c}px)`;
  const grow = document.createElement('span');
  grow.className = 'geode__grow';
  const sprites = [45, -45].map((angle) => {
    const sprite = document.createElement('span');
    sprite.className = 'geode__sprite';
    sprite.style.transform = `rotateZ(${angle}deg) rotateX(-90deg)`;
    grow.append(sprite);
    return sprite;
  });
  holder.append(grow);
  slab.append(holder);
  return { grow, sprites };
}

/** Grows one crystal through its stages, again and again; `offset` staggers the crystals. */
function growLoop(crystalParts, textureOf, offset, alive) {
  let stage = -1;
  const step = () => {
    if (!alive()) return;
    stage += 1;
    if (stage < STAGES.length) {
      const url = textureOf(STAGES[stage]);
      for (const sprite of crystalParts.sprites) sprite.style.backgroundImage = `url("${url}")`;
      crystalParts.grow.classList.remove('geode__grow--gone');
      crystalParts.grow.classList.remove('geode__grow--pop');
      void crystalParts.grow.offsetWidth; // restart the little "pop" of a new stage
      crystalParts.grow.classList.add('geode__grow--pop');
      setTimeout(step, stage === STAGES.length - 1 ? CLUSTER_MS : STAGE_MS);
    } else {
      // The cluster breaks off, and a new bud starts.
      crystalParts.grow.classList.add('geode__grow--gone');
      stage = -1;
      setTimeout(step, 520);
    }
  };
  setTimeout(step, offset);
}

/** Little four-pointed sparkles that blink here and there around the geode. */
function sparkleLoop(row, alive) {
  const spawn = () => {
    if (!alive()) return;
    const spark = document.createElement('span');
    spark.className = 'geode__spark';
    spark.style.left = `${18 + Math.random() * 64}%`;
    spark.style.top = `${8 + Math.random() * 58}%`;
    spark.style.setProperty('--size', `${2 + Math.round(Math.random())}px`);
    spark.addEventListener('animationend', () => spark.remove());
    row.append(spark);
    setTimeout(spawn, 160 + Math.random() * 260);
  };
  spawn();
}

/** Builds the geode in `row` and starts it. Returns a function that stops it. */
function startGeode(row) {
  let running = true;
  const alive = () => running;
  const drawn = drawnTextures();
  let real = false;
  const textureOf = (name) => (real ? mcUrl(`block/${name}.png`) : drawn[name]);

  const float = document.createElement('div');
  float.className = 'geode__float';
  const shadow = document.createElement('div');
  shadow.className = 'geode__shadow';
  const slab = document.createElement('div');
  slab.className = 'geode__slab';
  slab.style.setProperty('--cell', `${CELL}px`);
  slab.style.width = `${SIDE * CELL}px`;
  slab.style.height = `${SIDE * CELL}px`;
  buildPiece(slab);
  const crystals = BUDDING.map((place) => buildCrystal(slab, place));
  float.append(slab);
  row.replaceChildren(shadow, float);

  const paint = () => {
    for (const element of slab.querySelectorAll('.geode__face')) element.style.backgroundImage = `url("${textureOf(element.dataset.texture)}")`;
  };
  const useReal = () => {
    const names = [...new Set([...LAYER_BLOCKS, 'budding_amethyst', ...STAGES])];
    if (!real && getMcManifest() && names.every((name) => hasBlock(name))) {
      real = true;
      paint();
    }
  };
  paint();
  const stopListening = onMcReady(useReal);
  crystals.forEach((parts, index) => growLoop(parts, textureOf, index * 900, alive));
  sparkleLoop(row, alive);
  return () => {
    running = false;
    stopListening();
  };
}

/**
 * Runs the start-up `tasks` ([{ label, run: () => Promise }]) all at once behind the start screen,
 * shows what is loading, and fades the screen out when all are done — never before `minMs` (the
 * first crystals get to grow) and never later than `maxMs`. Resolves when the launcher can be used.
 */
export function runSplash({ tasks, minMs = 1700, maxMs = 15000 }) {
  const splash = document.getElementById('splash');
  if (!splash) return Promise.all(tasks.map((task) => task.run().catch(() => {})));
  const row = splash.querySelector('.splash__blocks');
  const status = splash.querySelector('.splash__status');
  const bar = splash.querySelector('.splash__bar');
  const stopGeode = startGeode(row);
  const started = performance.now();
  const pending = new Set(tasks);
  let done = 0;

  const showProgress = () => {
    bar.style.width = `${Math.round((done / Math.max(1, tasks.length)) * 100)}%`;
    const next = [...pending][0];
    status.textContent = next ? `${next.label}…` : 'Готово';
  };
  showProgress();

  const all = Promise.all(
    tasks.map((task) =>
      Promise.resolve()
        .then(() => task.run())
        .catch(() => {})
        .finally(() => {
          pending.delete(task);
          done += 1;
          showProgress();
        }),
    ),
  );
  const timeout = new Promise((resolve) => setTimeout(resolve, maxMs));
  return Promise.race([all, timeout])
    .then(() => new Promise((resolve) => setTimeout(resolve, Math.max(0, minMs - (performance.now() - started)))))
    .then(
      () =>
        new Promise((resolve) => {
          splash.classList.add('splash--leaving');
          setTimeout(() => {
            stopGeode();
            splash.remove();
            resolve();
          }, 520);
        }),
    );
}
