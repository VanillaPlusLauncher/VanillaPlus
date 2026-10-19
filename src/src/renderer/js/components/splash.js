/*
 * The start screen (its markup is in index.html, so it is there from the very first frame): the
 * launcher's X, its name, a sliding-block puzzle of 3D cubes in the theme colour — eight cubes on a
 * 3 × 3 board, one place free, and every moment a cube next to the gap slides into it — and what
 * is loading with a bar. Meanwhile everything the launcher needs is fetched (the game's textures,
 * instances, accounts, fonts, news); when all of it is in, the screen fades and the launcher is
 * ready. Shown once per start of the launcher.
 */

/** The board is SIDE × SIDE places; all but one hold a cube. */
const SIDE = 3;
/** One place on the board, in px (a cube is a little smaller, see features.css). */
const CELL = 30;
/** How often a cube slides, in ms (the slide itself is set in CSS). */
const MOVE_MS = 520;

/** Shades of the theme colour (the accent) for the blocks' mottled faces. */
function accentShades() {
  const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').split(',').map((part) => Number(part.trim()));
  const [r, g, b] = rgb.length === 3 && rgb.every(Number.isFinite) ? rgb : [190, 160, 255];
  const shade = (factor) => `rgb(${[r, g, b].map((value) => Math.round(Math.min(255, value * factor))).join(', ')})`;
  return [shade(0.46), shade(0.56), shade(0.66), shade(0.78), shade(0.92)];
}

function texture(colors, { topColors = null, ore = null, seed = 1 } = {}) {
  let value = seed;
  const random = () => {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    return value / 0x7fffffff;
  };
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d');
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const list = topColors && y < 3 + ((x * 7) % 3) ? topColors : colors;
      context.fillStyle = list[Math.floor(random() * list.length)];
      context.fillRect(x, y, 1, 1);
    }
  }
  if (ore) {
    for (const [ox, oy] of [[3, 4], [10, 2], [7, 9], [12, 11], [2, 12]]) {
      context.fillStyle = ore[Math.floor(random() * ore.length)];
      context.fillRect(ox, oy, 2, 2);
    }
  }
  return canvas.toDataURL();
}

/** A small 3D cube in the theme colour: its top and the two sides that face the viewer. */
function blockElement(shades, index) {
  const top = texture(shades, { seed: index * 31 + 7 });
  const side = texture(shades, { seed: index * 13 + 5 });
  const cube = document.createElement('span');
  cube.className = 'splash__block';
  for (const [name, image] of [['top', top], ['south', side], ['east', side]]) {
    const face = document.createElement('span');
    face.className = `splash__face splash__face--${name}`;
    face.style.backgroundImage = `url(${image})`;
    cube.append(face);
  }
  return cube;
}

/**
 * Builds the board in `row` and starts the puzzle: a cube next to the free place slides into it,
 * never straight back to where it just came from. Returns a function that stops it.
 */
function startPuzzle(row, shades) {
  const board = document.createElement('div');
  board.className = 'splash__board';
  board.style.setProperty('--cell', `${CELL}px`);
  const places = SIDE * SIDE;
  for (let place = 0; place < places; place += 1) {
    const slot = document.createElement('span');
    slot.className = 'splash__slot';
    slot.style.translate = `${(place % SIDE) * CELL}px ${Math.floor(place / SIDE) * CELL}px`;
    board.append(slot);
  }
  const cells = [];
  const put = (cube, place) => {
    cube.style.translate = `${(place % SIDE) * CELL}px ${Math.floor(place / SIDE) * CELL}px`;
  };
  for (let place = 0; place < places - 1; place += 1) {
    const cube = blockElement(shades, place);
    cells[place] = cube;
    put(cube, place);
    board.append(cube);
  }
  cells[places - 1] = null;
  row.replaceChildren(board);

  let empty = places - 1;
  let previous = -1;
  const timer = setInterval(() => {
    const x = empty % SIDE;
    const y = Math.floor(empty / SIDE);
    const near = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]
      .filter(([a, b]) => a >= 0 && a < SIDE && b >= 0 && b < SIDE)
      .map(([a, b]) => b * SIDE + a)
      .filter((place) => place !== previous);
    const from = near[Math.floor(Math.random() * near.length)];
    const cube = cells[from];
    cells[empty] = cube;
    cells[from] = null;
    put(cube, empty);
    previous = empty;
    empty = from;
  }, MOVE_MS);
  return () => clearInterval(timer);
}

/**
 * Runs the start-up `tasks` ([{ label, run: () => Promise }]) all at once behind the start screen,
 * shows what is loading, and fades the screen out when all are done — never before `minMs` (the
 * blocks get to land) and never later than `maxMs`. Resolves when the launcher can be used.
 */
export function runSplash({ tasks, minMs = 1700, maxMs = 15000 }) {
  const splash = document.getElementById('splash');
  if (!splash) return Promise.all(tasks.map((task) => task.run().catch(() => {})));
  const row = splash.querySelector('.splash__blocks');
  const status = splash.querySelector('.splash__status');
  const bar = splash.querySelector('.splash__bar');
  const stopPuzzle = startPuzzle(row, accentShades());
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
            stopPuzzle();
            splash.remove();
            resolve();
          }, 520);
        }),
    );
}
