/*
 * The start screen (its markup is in index.html, so it is there from the very first frame): the
 * launcher's X, its name, a queue of blocks in the theme colour — they step along one place at a
 * time with a little hop while the last one leaps over the others to the front, round and round —
 * and what is loading with a bar. Meanwhile everything the launcher needs is fetched (the game's textures, instances,
 * accounts, fonts, news); when all of it is in, the screen fades and the launcher is ready.
 * Shown once per start of the launcher.
 */

/** How many blocks walk in the queue. */
const BLOCK_COUNT = 4;

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

/** A small 3D block in the theme colour: top, left and right faces of a cube seen from above. */
function blockElement(shades, index) {
  const top = texture(shades, { seed: index * 31 + 7 });
  const side = texture(shades, { seed: index * 13 + 5 });
  const cube = document.createElement('span');
  cube.className = 'splash__cube';
  for (const [name, image] of [['top', top], ['left', side], ['right', side]]) {
    const face = document.createElement('span');
    face.className = `splash__face splash__face--${name}`;
    face.style.backgroundImage = `url(${image})`;
    cube.append(face);
  }
  const holder = document.createElement('span');
  holder.className = 'splash__block';
  holder.style.setProperty('--i', String(index));
  holder.append(cube);
  return holder;
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
  const shades = accentShades();
  row.replaceChildren(...Array.from({ length: BLOCK_COUNT }, (_, index) => blockElement(shades, index)));
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
            splash.remove();
            resolve();
          }, 520);
        }),
    );
}
