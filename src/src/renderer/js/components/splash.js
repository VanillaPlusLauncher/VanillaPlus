import { getMcManifest, hasBlock, mcUrl, onMcReady } from '../core/mc.js';

/*
 * The start screen (its markup is in index.html, so it is there from the very first frame): the
 * launcher's X, its name, a plate of budding amethyst turning slowly in the air, and what is
 * loading with a bar. On the plate crystals grow like a snake: from its outer edge round and round
 * into the middle, each one through the game's stages (small bud, medium, large, cluster); then they
 * shrink back through the same stages, the same way round, and grow again. Sparkles blink around it.
 * Meanwhile everything the launcher needs is fetched (the game's textures, instances, accounts,
 * fonts, news); when all of it is in, the screen fades and the launcher is ready.
 *
 * Only the game's own textures are used (main/minecraft/mcResources.js puts them on disk). The
 * plate is not shown at all until every one of them is loaded and decoded, so there is never an
 * empty stand-in: it fades in whole and the crystals start (on the very first start, once the
 * textures have been downloaded).
 */

/** The plate is SIDE × SIDE blocks, one block thick. */
const SIDE = 3;
/** One block, in px. */
const CELL = 28;
const TOP_BLOCK = 'budding_amethyst';
const EDGE_BLOCK = 'amethyst_block';
const STAGES = ['small_amethyst_bud', 'medium_amethyst_bud', 'large_amethyst_bud', 'amethyst_cluster'];
/** Each growth stage, in ms; the snake's head moves on to the next block every STEP_MS. */
const STAGE_MS = 210;
const STEP_MS = 260;
/** The full plate stays a moment, the crystals shrink back the same way, a short rest, again. */
const HOLD_MS = 1300;
const REST_MS = 450;
/** Shading by the side a face looks to: a light from above and the front. */
const SHADE = { top: 1.06, south: 0.8, east: 0.9, north: 0.64, west: 0.72 };

const TEXTURES = [TOP_BLOCK, EDGE_BLOCK, ...STAGES];

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    return value / 0x7fffffff;
  };
}

/** The blocks of an n × n plate from its outer edge round and round into the middle (clockwise). */
function spiralOrder(n) {
  const order = [];
  let [left, top, right, bottom] = [0, 0, n - 1, n - 1];
  while (left <= right && top <= bottom) {
    for (let x = left; x <= right; x += 1) order.push([x, top]);
    for (let y = top + 1; y <= bottom; y += 1) order.push([right, y]);
    if (top < bottom) for (let x = right - 1; x >= left; x -= 1) order.push([x, bottom]);
    if (left < right) for (let y = bottom - 1; y > top; y -= 1) order.push([left, y]);
    [left, top, right, bottom] = [left + 1, top + 1, right - 1, bottom - 1];
  }
  return order;
}

function face(texture, side, transform) {
  const element = document.createElement('span');
  element.className = `geode__face geode__face--${side}`;
  element.dataset.texture = texture;
  element.style.transform = transform;
  element.style.setProperty('--shade', String(SHADE[side]));
  return element;
}

/**
 * The faces that can be seen of the plate (the tops, and the sides along its edge), in a plane
 * where x goes right, y towards the viewer and z up.
 */
function buildPlate(slab) {
  const c = CELL;
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      slab.append(face(TOP_BLOCK, 'top', `translate3d(${x * c}px, ${y * c}px, ${c}px)`));
      if (y === SIDE - 1) slab.append(face(EDGE_BLOCK, 'south', `translate3d(${x * c}px, ${(y + 1) * c}px, ${c}px) rotateX(-90deg)`));
      if (y === 0) slab.append(face(EDGE_BLOCK, 'north', `translate3d(${(x + 1) * c}px, ${y * c}px, ${c}px) rotateZ(180deg) rotateX(-90deg)`));
      if (x === SIDE - 1) slab.append(face(EDGE_BLOCK, 'east', `translate3d(${(x + 1) * c}px, ${(y + 1) * c}px, ${c}px) rotateZ(-90deg) rotateX(-90deg)`));
      if (x === 0) slab.append(face(EDGE_BLOCK, 'west', `translate3d(${x * c}px, ${y * c}px, ${c}px) rotateZ(90deg) rotateX(-90deg)`));
    }
  }
}

/** A crystal standing on a block: two crossed pictures, like buds in the game; turned a little each. */
function buildCrystal(slab, [x, y], turn) {
  const c = CELL;
  const holder = document.createElement('span');
  holder.className = 'geode__crystal';
  holder.style.transform = `translate3d(${x * c + c / 2}px, ${y * c + c / 2}px, ${c}px) rotateZ(${turn}deg)`;
  const grow = document.createElement('span');
  grow.className = 'geode__grow geode__grow--gone';
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

/** Shows one stage of a crystal (-1: none) with a little pop. */
function showStage({ grow, sprites }, stage) {
  if (stage < 0) {
    grow.classList.add('geode__grow--gone');
    return;
  }
  const url = mcUrl(`block/${STAGES[stage]}.png`);
  for (const sprite of sprites) sprite.style.backgroundImage = `url("${url}")`;
  grow.classList.remove('geode__grow--gone', 'geode__grow--pop');
  void grow.offsetWidth; // restart the pop of a new stage
  grow.classList.add('geode__grow--pop');
}

/** One crystal through its stages: up to a cluster, or (shrink) back down to nothing. */
function stepCrystal(crystal, shrink, alive) {
  const stages = shrink ? [2, 1, 0, -1] : [0, 1, 2, 3];
  stages.forEach((stage, index) =>
    setTimeout(() => {
      if (alive()) showStage(crystal, stage);
    }, index * STAGE_MS),
  );
}

/**
 * The snake: crystals grow block after block into the middle; after a moment they shrink back
 * through the same stages, block after block the same way round, and it starts again.
 */
function snakeLoop(crystals, alive) {
  const run = (shrink) => crystals.forEach((crystal, index) => setTimeout(() => stepCrystal(crystal, shrink, alive), index * STEP_MS));
  const snake = (crystals.length - 1) * STEP_MS + STAGES.length * STAGE_MS;
  const cycle = () => {
    if (!alive()) return;
    run(false);
    setTimeout(() => {
      if (!alive()) return;
      run(true);
      setTimeout(cycle, snake + REST_MS);
    }, snake + HOLD_MS);
  };
  cycle();
}
/** Little four-pointed sparkles that blink here and there around the plate. */
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

/** Builds the plate in `row` and starts it. Returns a function that stops it. */
function startGeode(row) {
  let running = true;
  const alive = () => running;
  const float = document.createElement('div');
  float.className = 'geode__float';
  const shadow = document.createElement('div');
  shadow.className = 'geode__shadow';
  const slab = document.createElement('div');
  slab.className = 'geode__slab';
  slab.style.setProperty('--cell', `${CELL}px`);
  slab.style.width = `${SIDE * CELL}px`;
  slab.style.height = `${SIDE * CELL}px`;
  buildPlate(slab);
  const random = seeded(7);
  const crystals = spiralOrder(SIDE).map((place) => buildCrystal(slab, place, Math.round((random() - 0.5) * 40)));
  float.append(slab);
  row.replaceChildren(shadow, float);
  row.classList.add('splash__blocks--waiting');

  // The game's textures: at once when they are on disk already, else as soon as they arrive. The
  // plate shows only once all of them are decoded, so no face is ever drawn empty.
  let started = false;
  const begin = async () => {
    if (started || !running || !getMcManifest() || !TEXTURES.every((name) => hasBlock(name))) return;
    started = true;
    const urls = Object.fromEntries(TEXTURES.map((name) => [name, mcUrl(`block/${name}.png`)]));
    await Promise.all(
      Object.values(urls).map((url) => {
        const image = new Image();
        image.src = url;
        return image.decode().catch(() => {});
      }),
    );
    if (!running) return;
    for (const element of slab.querySelectorAll('.geode__face')) element.style.backgroundImage = `url("${urls[element.dataset.texture]}")`;
    row.classList.remove('splash__blocks--waiting');
    sparkleLoop(row, alive);
    snakeLoop(crystals, alive);
  };
  const stopListening = onMcReady(begin);
  begin();
  return () => {
    running = false;
    stopListening();
  };
}

/**
 * Runs the start-up `tasks` ([{ label, run: () => Promise }]) all at once behind the start screen,
 * fills the bar as they finish, and fades the screen out when all are done — never before `minMs` (the
 * first crystals get to grow) and never later than `maxMs`. Resolves when the launcher can be used.
 */
export function runSplash({ tasks, minMs = 1700, maxMs = 15000 }) {
  const splash = document.getElementById('splash');
  if (!splash) return Promise.all(tasks.map((task) => task.run().catch(() => {})));
  const row = splash.querySelector('.splash__blocks');
  const bar = splash.querySelector('.splash__bar');
  const stopGeode = startGeode(row);
  const started = performance.now();
  let done = 0;

  // Under the plate it simply says "Загрузка…" (index.html); only the bar shows how far it got.
  const showProgress = () => {
    bar.style.width = `${Math.round((done / Math.max(1, tasks.length)) * 100)}%`;
  };
  showProgress();

  const all = Promise.all(
    tasks.map((task) =>
      Promise.resolve()
        .then(() => task.run())
        .catch(() => {})
        .finally(() => {
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
