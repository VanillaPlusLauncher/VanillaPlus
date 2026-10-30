/** Small visual effects: pixel bursts on Play, sparks from pressed buttons, floating sparks behind the home screen. */

const BURST_COLORS = ['var(--color-accent)', 'var(--color-accent-strong)', '#ffffff', '#ffc4e6'];

function animationsEnabled() {
  return document.documentElement.dataset.animations !== 'off';
}

/** Throws square "pixels" out of an element, like breaking a block. */
export function pixelBurst(element, { count = 22, colors = BURST_COLORS, spread = 160 } = {}) {
  if (!animationsEnabled() || !element) {
    return;
  }
  const rect = element.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  for (let index = 0; index < count; index += 1) {
    const particle = document.createElement('span');
    particle.className = 'pixel-burst';
    const angle = Math.random() * Math.PI * 2;
    const distance = spread * (0.35 + Math.random() * 0.65);
    const size = 4 + Math.round(Math.random() * 3) * 2;
    Object.assign(particle.style, {
      left: `${originX + (Math.random() - 0.5) * rect.width * 0.6}px`,
      top: `${originY + (Math.random() - 0.5) * rect.height * 0.4}px`,
      width: `${size}px`,
      height: `${size}px`,
      background: colors[index % colors.length],
    });
    particle.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--dy', `${Math.sin(angle) * distance - 40}px`);
    particle.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 360)}deg`);
    particle.style.setProperty('--life', `${700 + Math.random() * 600}ms`);
    document.body.append(particle);
    particle.addEventListener('animationend', () => particle.remove(), { once: true });
  }
}

/** Fills a container with slowly rising glowing pixels. */
export function createSparks(count = 18) {
  const container = document.createElement('div');
  container.className = 'sparks';
  container.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < count; index += 1) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    const size = 3 + Math.round(Math.random() * 3);
    Object.assign(spark.style, { left: `${Math.random() * 100}%`, width: `${size}px`, height: `${size}px` });
    spark.style.setProperty('--duration', `${10 + Math.random() * 14}s`);
    spark.style.setProperty('--delay', `${-Math.random() * 20}s`);
    spark.style.setProperty('--drift', `${(Math.random() - 0.5) * 120}px`);
    container.append(spark);
  }
  return container;
}

/*
 * Sparks from a pressed button: one canvas over the window, drawn only while sparks are in the air
 * (60 frames a second, smooth, each spark a square on whole pixels so it stays pixel-art). No DOM
 * element per spark, so a burst never makes the window stutter.
 */
const CLICK_TARGETS = '.btn:not(:disabled), .icon-button:not(.icon-button--window):not(:disabled)';
const GRAVITY = 520;
let sparkCanvas = null;
let sparkContext = null;
let sparkList = [];
let sparkFrame = 0;
let sparkLast = 0;

function sparkColors() {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--color-accent').trim() || '#b48cff';
  const strong = style.getPropertyValue('--color-accent-strong').trim() || '#8a5cf0';
  return [accent, strong, '#ffffff', '#f1e4ff', accent];
}

function fitSparkCanvas() {
  const ratio = window.devicePixelRatio || 1;
  sparkCanvas.width = Math.round(window.innerWidth * ratio);
  sparkCanvas.height = Math.round(window.innerHeight * ratio);
  sparkContext.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawSparks(now) {
  const seconds = Math.min(0.05, (now - sparkLast) / 1000);
  sparkLast = now;
  sparkContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
  sparkList = sparkList.filter((spark) => (spark.age += seconds) < spark.life);
  for (const spark of sparkList) {
    spark.vy += GRAVITY * seconds;
    spark.x += spark.vx * seconds;
    spark.y += spark.vy * seconds;
    const left = 1 - spark.age / spark.life;
    const size = Math.max(1, Math.round(spark.size * (0.5 + left * 0.5)));
    sparkContext.globalAlpha = Math.min(1, left * 1.6);
    sparkContext.fillStyle = spark.color;
    sparkContext.fillRect(Math.round(spark.x - size / 2), Math.round(spark.y - size / 2), size, size);
  }
  sparkContext.globalAlpha = 1;
  sparkFrame = sparkList.length ? requestAnimationFrame(drawSparks) : 0;
  if (!sparkFrame) sparkContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

/** Throws sparks out of a point (a click, or the middle of an element pressed with the keyboard). */
export function clickSparks(x, y, { count = 10 } = {}) {
  if (!animationsEnabled() || !sparkCanvas) return;
  const colors = sparkColors();
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const speed = 90 + Math.random() * 170;
    sparkList.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 2 + Math.round(Math.random() * 2),
      color: colors[index % colors.length],
      age: 0,
      life: 0.42 + Math.random() * 0.32,
    });
  }
  if (!sparkFrame) {
    sparkLast = performance.now();
    sparkFrame = requestAnimationFrame(drawSparks);
  }
}

/** Sparks for every pressed button, while Settings → "Оформление" → "Искры при нажатии" is on. */
export function installClickSparks(isOn) {
  sparkCanvas = document.createElement('canvas');
  sparkCanvas.className = 'click-sparks';
  sparkCanvas.setAttribute('aria-hidden', 'true');
  sparkContext = sparkCanvas.getContext('2d');
  document.body.append(sparkCanvas);
  fitSparkCanvas();
  window.addEventListener('resize', fitSparkCanvas);
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.(CLICK_TARGETS);
    if (!button || !isOn()) return;
    let { clientX: x, clientY: y } = event;
    // Enter or Space: the click has no point, so the sparks come from the button's middle.
    if (!x && !y) {
      const box = button.getBoundingClientRect();
      x = box.left + box.width / 2;
      y = box.top + box.height / 2;
    }
    clickSparks(x, y, { count: button.classList.contains('btn--primary') ? 14 : 8 });
  });
}

/**
 * Runs `change` (which replaces an element's content) and lets the element's height glide from the old
 * one to the new one instead of jumping. With animations off the content simply changes.
 */
export function resizeSmoothly(element, change, duration = 340) {
  const from = element.offsetHeight;
  change();
  if (document.documentElement.dataset.animations === 'off') {
    return;
  }
  const to = element.offsetHeight;
  if (Math.abs(to - from) < 2) {
    return;
  }
  element.animate(
    [
      { height: `${from}px`, overflow: 'hidden' },
      { height: `${to}px`, overflow: 'hidden' },
    ],
    { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

/*
 * A change shown as a passage instead of a jump (the browser's View Transitions): `change` runs between
 * a picture of the page before and after it (it may return a promise: a setting saved first).
 *  - `cards`: a function giving the cards of a list; each card (found again by `key`, its data-id by
 *    default) glides from where it was to where it lands and takes its new shape — grid ↔ list, a new
 *    order, a filter. Only cards on screen take part (a long list stays light).
 *  - `panel`: an element (a dialog, a tab's box) that grows or shrinks to its new size while its old
 *    content fades into the new.
 * Everything else crossfades. With animations off, or while the page is hidden, it simply changes.
 * css/features/alive.css sets the timing.
 */
let passage = null;

export function morph(change, { cards = null, panel = null, key = (card) => card.dataset.id } = {}) {
  // A page that is not the current one is only see-through (layout.css), not gone: its cards still have
  // a place. A passage there froze the whole window over the page just opened (opening an instance from
  // "Сборки" saves it as selected, and the list redrew behind it).
  const shown = (element) => {
    if (element.closest('.page:not(.page--active)')) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.bottom > 0 && box.top < window.innerHeight;
  };
  if (!animationsEnabled() || !document.startViewTransition || document.hidden || (panel && !shown(panel)) || (!panel && cards && ![...cards()].some(shown))) {
    return Promise.resolve(change());
  }
  passage?.skipTransition();
  const names = new Map();
  const named = new Set();
  const name = (element, value, kind) => {
    element.style.viewTransitionName = value;
    element.style.viewTransitionClass = kind;
    named.add(element);
  };
  // A card keeps its name from before to after, so the browser knows it is the same card; one that
  // comes into view gets a new name and fades in, one that leaves fades out.
  const nameAll = () => {
    if (panel?.isConnected) name(panel, 'morph-panel', 'morph-panel');
    for (const card of cards ? [...cards()] : []) {
      const id = key(card);
      if (!id || !shown(card)) continue;
      if (!names.has(id)) names.set(id, `morph-card-${names.size}`);
      name(card, names.get(id), 'morph-card');
    }
  };
  nameAll();
  const current = document.startViewTransition(async () => {
    await change();
    nameAll();
  });
  passage = current;
  current.finished.finally(() => {
    for (const element of named) {
      element.style.viewTransitionName = '';
      element.style.viewTransitionClass = '';
    }
    if (passage === current) passage = null;
  });
  return current.updateCallbackDone.catch(() => {});
}

/** Counts a number up with an ease-out, for statistics. */
export function countUp(element, target, { duration = 900, format = (value) => String(value) } = {}) {
  if (!animationsEnabled()) {
    element.textContent = format(target);
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(Math.round(target * eased));
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}
