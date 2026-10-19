import { h } from '../core/dom.js';
import { hasItem, mcUrl, onMcReady } from '../core/mc.js';
import { sfx } from '../core/sound.js';
import { toast } from '../components/toast.js';
import { createParticles } from '../skins/particles.js';
import { creeperTextures, grassTextures } from '../pet/creeperArt.js';

/*
 * "Питомец": a little creeper to look after, like a tamagotchi. It lives on a grass block, walks
 * about, looks at the mouse, eats, plays with a slime ball, sleeps, likes being stroked — and when
 * poked too often it hisses, swells and goes "puff" (only smoke, it is back a moment later).
 * Its needs (food, mood, energy) go down with real time, also while the launcher is closed, and
 * are kept in this computer's launcher data (localStorage).
 *
 * The creeper is real 3D made of CSS boxes (head 8×8×8, body 8×12×4, four legs 4×6×4, like the
 * game's model). Motion is physical, for it to look alive: walking accelerates and brakes, the legs
 * swing with the distance walked (no sliding feet), the body bobs with the steps, the head follows
 * the mouse with a soft spring, jumps fall with gravity and land with a squash.
 */

const STORE_KEY = 'amethyx.pet';
/** Screen pixels per model pixel. */
const UNIT = 9;
/** The grass block, in model pixels. */
const FLOOR = { width: 48, height: 8, depth: 18 };
const WALK_LIMIT = FLOOR.width / 2 - 7;
/** How the needs go down per hour (and energy comes back while asleep). */
const DECAY_PER_HOUR = { hunger: 5, fun: 4, energy: 3 };
const SLEEP_GAIN_PER_HOUR = 25;
/** The view on the scene: a little from above, turned a little to the side (degrees). */
const VIEW_PITCH = -14;
const VIEW_YAW = -24;
const FOODS = [
  { item: 'cookie', label: 'печенье', hunger: 14, fun: 3 },
  { item: 'apple', label: 'яблоко', hunger: 24, fun: 2 },
  { item: 'golden_apple', label: 'золотое яблоко', hunger: 40, fun: 15 },
];

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const approach = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));

function freshPet() {
  const now = Date.now();
  return { name: 'Криппи', hunger: 80, fun: 75, energy: 90, xp: 0, bornAt: now, updatedAt: now, sleeping: false };
}

function loadPet() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { ...freshPet(), ...saved };
  } catch {
    // Storage off or damaged: a new creeper.
  }
  return freshPet();
}

function savePet(pet) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pet));
  } catch {
    // Not kept this time; nothing else depends on it.
  }
}

/** The needs as they are now: real time has passed since the last look. */
function catchUp(pet, now = Date.now()) {
  const hours = Math.max(0, (now - pet.updatedAt) / 3600000);
  pet.hunger = clamp(pet.hunger - DECAY_PER_HOUR.hunger * hours);
  pet.fun = clamp(pet.fun - DECAY_PER_HOUR.fun * hours);
  pet.energy = clamp(pet.energy + (pet.sleeping ? SLEEP_GAIN_PER_HOUR : -DECAY_PER_HOUR.energy) * hours);
  if (pet.sleeping && pet.energy >= 100) pet.sleeping = false;
  pet.updatedAt = now;
}

const levelOf = (xp) => Math.floor(Math.sqrt(xp / 15)) + 1;
const xpForLevel = (level) => (level - 1) ** 2 * 15;

function moodOf(pet) {
  if (pet.sleeping) return { text: 'Спит', kind: 'sleep' };
  if (pet.hunger < 25) return { text: 'Голоден', kind: 'sad' };
  if (pet.energy < 20) return { text: 'Устал', kind: 'sad' };
  if (pet.fun < 25) return { text: 'Скучает', kind: 'sad' };
  if (pet.hunger > 70 && pet.fun > 70) return { text: 'Счастлив', kind: 'happy' };
  return { text: 'Доволен', kind: 'ok' };
}

// --- CSS 3D building blocks --------------------------------------------------------------------

function face(texture, width, height, transform, extra = '') {
  return h('div', {
    class: `pet3d__face${extra}`,
    style: { width: `${width * UNIT}px`, height: `${height * UNIT}px`, left: `${(-width * UNIT) / 2}px`, top: `${(-height * UNIT) / 2}px`, backgroundImage: `url(${texture})`, transform },
  });
}

/** A box of w×h×d model pixels centred on its element, one texture per side. */
function cuboid(w, hgt, d, tex, className = '') {
  const half = (value) => (value * UNIT) / 2;
  return h(
    'div',
    { class: `pet3d__box ${className}` },
    face(tex.front, w, hgt, `translateZ(${half(d)}px)`, ' pet3d__face--front'),
    face(tex.back, w, hgt, `rotateY(180deg) translateZ(${half(d)}px)`),
    face(tex.right, d, hgt, `rotateY(90deg) translateZ(${half(w)}px)`, ' pet3d__face--side'),
    face(tex.left, d, hgt, `rotateY(-90deg) translateZ(${half(w)}px)`, ' pet3d__face--side'),
    face(tex.top, w, d, `rotateX(90deg) translateZ(${half(hgt)}px)`, ' pet3d__face--top'),
    face(tex.bottom, w, d, `rotateX(-90deg) translateZ(${half(hgt)}px)`, ' pet3d__face--bottom'),
  );
}

/** A joint: a point that turns its children (a hip, the neck). */
const joint = (className, ...children) => h('div', { class: `pet3d__joint ${className}` }, ...children);
const px = (units) => `${units * UNIT}px`;

function buildCreeper() {
  const tex = creeperTextures();
  const head = cuboid(8, 8, 8, tex.head, 'pet3d__head');
  head.style.transform = `translate3d(0, ${px(-4)}, 0)`;
  const neck = joint('pet3d__neck', head);
  const body = cuboid(8, 12, 4, tex.body, 'pet3d__body');
  body.style.transform = `translate3d(0, ${px(-6)}, 0)`;
  const torso = joint('pet3d__torso', body, neck);
  // Hips at the bottom of the body; front legs before it, back legs behind (the game's layout).
  const legs = [
    [-2, 4],
    [2, 4],
    [-2, -4],
    [2, -4],
  ].map(([x, z]) => {
    const leg = cuboid(4, 6, 4, tex.leg, 'pet3d__leg');
    leg.style.transform = `translate3d(0, ${px(3)}, 0)`;
    const hip = joint('pet3d__hip', leg);
    hip.dataset.x = String(x);
    hip.dataset.z = String(z);
    return hip;
  });
  const root = joint('pet3d__creeper', torso, ...legs);
  return { root, torso, neck, legs, head };
}

function buildFloor() {
  const grass = grassTextures();
  const tile = { front: grass.side, back: grass.side, left: grass.side, right: grass.side, top: grass.top, bottom: grass.bottom };
  const floor = cuboid(FLOOR.width, FLOOR.height, FLOOR.depth, tile, 'pet3d__floor');
  floor.style.transform = `translate3d(0, ${px(FLOOR.height / 2)}, 0)`;
  // Each side shows 16-texel blocks, like a row of grass blocks.
  for (const side of floor.children) side.style.backgroundSize = `${16 * UNIT}px ${16 * UNIT}px`;
  return floor;
}

// --- The page ---------------------------------------------------------------------------------

export function createPetPage() {
  const pet = loadPet();
  catchUp(pet);
  savePet(pet);

  const element = h('section', { class: 'page page--pet', 'aria-label': 'Питомец' });
  const scene = h('div', { class: 'pet-scene' });
  const world = h('div', { class: 'pet3d__world' });
  const creeper = buildCreeper();
  const shadow = h('div', { class: 'pet3d__shadow' });
  world.append(buildFloor(), shadow, creeper.root);
  scene.append(world);
  const effects = createParticles(scene);

  // --- Header, needs and actions ---------------------------------------------------------------
  const nameLabel = h('button', { class: 'pet-name', type: 'button', title: 'Переименовать', 'data-i18n': 'off' }, pet.name);
  const levelLabel = h('span', { class: 'pet-level' });
  const moodLabel = h('span', { class: 'pet-mood' });
  const ageLabel = h('span', { class: 'text-muted pet-age' });
  const xpBar = h('span', { class: 'pet-xp__fill' });
  const meter = (label, key, kind) => {
    const fill = h('span', { class: `pet-meter__fill pet-meter__fill--${kind}` });
    const value = h('span', { class: 'pet-meter__value' });
    return { key, element: h('div', { class: 'pet-meter' }, h('span', { class: 'pet-meter__label' }, label), h('span', { class: 'pet-meter__track' }, fill), value), fill, value };
  };
  const meters = [meter('Сытость', 'hunger', 'food'), meter('Настроение', 'fun', 'fun'), meter('Энергия', 'energy', 'energy')];
  const action = (label, item, onclick) => {
    const picture = h('img', { class: 'pet-action__icon', alt: '' });
    onMcReady(() => {
      if (hasItem(item)) picture.src = mcUrl(`item/${item}.png`);
    });
    return h('button', { class: 'btn btn--secondary pet-action', type: 'button', onclick }, picture, h('span', null, label));
  };
  const feedButton = action('Покормить', 'cookie', () => feed());
  const playButton = action('Поиграть', 'slime_ball', () => play());
  const sleepButton = action('Уложить спать', 'clock_00', () => toggleSleep());
  const hint = h('p', { class: 'text-muted pet-hint' });

  element.append(
    h('header', { class: 'page-header' }, h('div', null, h('h1', { class: 'page-title' }, 'Питомец'), h('p', { class: 'page-subtitle' }, 'Маленький крипер: кормите, играйте и не забывайте укладывать спать. Он скучает, даже когда лаунчер закрыт.'))),
    h(
      'div',
      { class: 'pet-layout' },
      h('div', { class: 'surface pet-stage' }, scene, h('div', { class: 'pet-stage__caption' }, nameLabel, levelLabel, moodLabel)),
      h(
        'div',
        { class: 'surface pet-panel' },
        h('div', { class: 'pet-panel__head' }, h('b', null, 'Как он'), ageLabel),
        ...meters.map((entry) => entry.element),
        h('div', { class: 'pet-xp' }, h('span', { class: 'pet-meter__label' }, 'Опыт'), h('span', { class: 'pet-xp__track' }, xpBar)),
        h('div', { class: 'pet-actions' }, feedButton, playButton, sleepButton),
        hint,
      ),
    ),
  );

  // --- Motion state -------------------------------------------------------------------------------
  const motion = {
    x: 0, z: 0, vx: 0, targetX: 0,
    yaw: -VIEW_YAW, yawVel: 0,
    headYaw: 0, headPitch: 0, lookYaw: 0, lookPitch: 0,
    phase: 0, y: 0, vy: 0, squash: 0, squashVel: 0,
    idleUntil: performance.now() + 2500, task: null, swell: 0, gone: false,
  };
  let frame = 0;
  let lastTime = 0;
  let active = false;
  let pokes = [];
  const items = [];

  function render() {
    catchUp(pet);
    const level = levelOf(pet.xp);
    levelLabel.textContent = `Ур. ${level}`;
    const mood = moodOf(pet);
    moodLabel.textContent = mood.text;
    moodLabel.className = `pet-mood pet-mood--${mood.kind}`;
    const days = Math.floor((Date.now() - pet.bornAt) / 86400000);
    ageLabel.textContent = days < 1 ? 'Появился сегодня' : `С вами дней: ${days}`;
    for (const entry of meters) {
      const value = Math.round(pet[entry.key]);
      entry.fill.style.width = `${value}%`;
      entry.value.textContent = `${value}`;
      entry.element.classList.toggle('pet-meter--low', value < 25);
    }
    xpBar.style.width = `${clamp(((pet.xp - xpForLevel(level)) / (xpForLevel(level + 1) - xpForLevel(level))) * 100)}%`;
    sleepButton.lastChild.textContent = pet.sleeping ? 'Разбудить' : 'Уложить спать';
    feedButton.disabled = pet.sleeping;
    playButton.disabled = pet.sleeping || pet.energy < 12;
    scene.classList.toggle('pet-scene--night', pet.sleeping);
    hint.textContent = pet.sleeping
      ? 'Тсс… Энергия восстанавливается, пока он спит. Проснётся сам, когда выспится.'
      : pet.hunger < 25
        ? 'Он проголодался — покормите его.'
        : pet.energy < 20
          ? 'Совсем устал: уложите его спать.'
          : pet.fun < 25
            ? 'Ему скучно: поиграйте или погладьте его (клик по криперу).'
            : 'Погладьте его кликом. Только не тыкайте слишком часто — он этого не любит…';
  }

  const gainXp = (amount) => {
    const before = levelOf(pet.xp);
    pet.xp += amount;
    if (levelOf(pet.xp) > before) {
      toast(`${pet.name} теперь ${levelOf(pet.xp)} уровня!`, 'success', 4000, { icon: 'experience_bottle' });
      effects.emit('stars', { count: 12, x: 50, y: 30 });
    }
  };

  function changed() {
    pet.updatedAt = Date.now();
    savePet(pet);
    render();
  }

  /** Where the creeper's head is on the scene, for particles (% of the scene). */
  const headSpot = () => ({ x: 50 + (motion.x / FLOOR.width) * 70, y: 26 });

  // --- Actions ------------------------------------------------------------------------------------

  function hop(strength = 14) {
    if (motion.y > 0.01 || motion.gone) return;
    motion.vy = strength;
    motion.squash = -0.12; // a little crouch before leaving the ground
  }

  function feed() {
    if (pet.sleeping) return;
    if (pet.hunger >= 97) {
      toast(`${pet.name} не хочет есть`, 'info', 2500);
      motion.task = { kind: 'refuse', until: performance.now() + 1100 };
      return;
    }
    const level = levelOf(pet.xp);
    const food = level >= 3 && Math.random() < 0.2 ? FOODS[2] : FOODS[Math.random() < 0.5 ? 0 : 1];
    // The food falls onto the grass a little away from the creeper; it walks over and eats.
    const x = clamp(motion.x + (motion.x > 0 ? -9 : 9), -WALK_LIMIT, WALK_LIMIT);
    const item = dropItem(food.item, x);
    motion.task = { kind: 'eat', item, food, stage: 'go' };
    sfx('click');
  }

  function play() {
    if (pet.sleeping || pet.energy < 12) return;
    const ball = dropItem('slime_ball', clamp(-motion.x * 0.6, -WALK_LIMIT, WALK_LIMIT), { bouncy: true, vx: (Math.random() < 0.5 ? -1 : 1) * 14 });
    motion.task = { kind: 'play', item: ball, until: performance.now() + 5200 };
    pet.fun = clamp(pet.fun + 22);
    pet.energy = clamp(pet.energy - 10);
    pet.hunger = clamp(pet.hunger - 4);
    gainXp(6);
    changed();
    sfx('info');
  }

  function toggleSleep() {
    pet.sleeping = !pet.sleeping;
    motion.task = null;
    changed();
    if (!pet.sleeping) hop(10);
  }

  function stroke() {
    if (motion.gone) return;
    const now = performance.now();
    pokes = pokes.filter((time) => now - time < 2500);
    pokes.push(now);
    if (pet.sleeping) {
      pet.sleeping = false;
      changed();
      effects.emit('notes', { count: 4, ...headSpot() });
      hop(9);
      return;
    }
    if (pokes.length >= 7) {
      pokes = [];
      hiss();
      return;
    }
    pet.fun = clamp(pet.fun + 3);
    gainXp(1);
    changed();
    effects.emit('hearts', { count: 5, ...headSpot() });
    hop(11);
  }

  /** Poked too often: it hisses and swells, then "puff" (smoke only), and drops back in. */
  function hiss() {
    motion.task = { kind: 'hiss', start: performance.now() };
    pet.fun = clamp(pet.fun - 8);
    changed();
  }

  creeper.root.addEventListener('click', stroke);

  // --- Items: food and the ball ---------------------------------------------------------------------

  function dropItem(name, x, { bouncy = false, vx = 0 } = {}) {
    const sprite = h('img', { class: 'pet3d__item', alt: '' });
    if (hasItem(name)) sprite.src = mcUrl(`item/${name}.png`);
    const item = { name, sprite, x, y: 26, vx, vy: 0, z: 3, bouncy, scale: 1, gone: false };
    world.append(sprite);
    items.push(item);
    return item;
  }

  function removeItem(item) {
    item.gone = true;
    item.sprite.remove();
    items.splice(items.indexOf(item), 1);
  }

  // --- The motion loop ------------------------------------------------------------------------------

  function walkTo(target, dt, speedScale = 1) {
    const tired = 0.55 + 0.45 * (Math.min(pet.energy, pet.hunger) / 100);
    const maxSpeed = 7 * tired * speedScale;
    const accel = 22;
    const distance = target - motion.x;
    // Brakes in time to stop at the target: v² = 2·a·d.
    const desired = Math.sign(distance) * Math.min(maxSpeed, Math.sqrt(2 * accel * Math.abs(distance)));
    const dv = clamp(desired - motion.vx, -accel * dt, accel * dt);
    motion.vx += dv;
    if (Math.abs(distance) < 0.15 && Math.abs(motion.vx) < 0.4) {
      motion.vx = 0;
      return true;
    }
    return false;
  }

  function step(time) {
    frame = active ? requestAnimationFrame(step) : 0;
    const dt = Math.min(0.05, (time - (lastTime || time)) / 1000);
    lastTime = time;
    const off = document.documentElement.dataset.animations === 'off';
    const now = performance.now();
    let walking = false;
    let headDown = 0;
    let nod = 0;
    let shake = 0;

    // What it is doing.
    const task = motion.task;
    if (motion.gone) {
      // Waiting off stage after a "puff".
    } else if (task?.kind === 'hiss') {
      const t = (now - task.start) / 1000;
      motion.vx = approach(motion.vx, 0, 10, dt);
      motion.swell = Math.min(1, t / 1.5);
      if (t > 1.5) {
        motion.gone = true;
        motion.swell = 0;
        creeper.root.classList.add('pet3d__creeper--gone');
        shadow.classList.add('pet3d__shadow--gone');
        effects.emit('smoke', { count: 16, ...headSpot(), y: 40 });
        motion.task = { kind: 'return', at: now + 1300 };
      }
    } else if (task?.kind === 'return') {
      // (handled below, while gone)
    } else if (task?.kind === 'eat') {
      if (task.item.gone) motion.task = null;
      else if (task.stage === 'go') {
        if (task.item.y <= 0.01 && walkTo(task.item.x + (task.item.x > motion.x ? -6 : 6), dt)) {
          task.stage = 'eat';
          task.start = now;
        }
        walking = true;
      } else {
        const t = (now - task.start) / 1000;
        nod = Math.max(0, Math.sin(t * 9)) * (t < 1.6 ? 1 : 0);
        task.item.scale = clamp(1 - t / 1.6, 0, 1);
        if (t > 1.6) {
          removeItem(task.item);
          pet.hunger = clamp(pet.hunger + task.food.hunger);
          pet.fun = clamp(pet.fun + task.food.fun);
          gainXp(3);
          changed();
          effects.emit('hearts', { count: 7, ...headSpot() });
          motion.task = null;
          hop(10);
        }
      }
    } else if (task?.kind === 'play') {
      // Chases the ball, hops now and then; the game ends when time is up.
      walkTo(task.item.x, dt, 1.25);
      walking = true;
      if (Math.abs(task.item.x - motion.x) < 6 && task.item.y < 1 && Math.random() < dt * 3) {
        task.item.vy = 18;
        task.item.vx = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 8);
        hop(12);
      }
      if (now > task.until) {
        removeItem(task.item);
        effects.emit('sparkles', { count: 8, ...headSpot() });
        motion.task = null;
      }
    } else if (task?.kind === 'refuse') {
      shake = Math.sin(now / 70) * 0.5 * (task.until - now > 0 ? 1 : 0);
      if (now > task.until) motion.task = null;
    } else if (pet.sleeping) {
      motion.vx = approach(motion.vx, 0, 8, dt);
      headDown = 0.32;
      if (Math.random() < dt * 0.6) effects.emit('zzz', { count: 1, ...headSpot() });
    } else {
      // Wandering: rests a while, then walks somewhere (less often when tired or hungry).
      if (now > motion.idleUntil) {
        if (motion.targetX === null || walkTo(motion.targetX, dt)) {
          motion.targetX = null;
          const lazy = 1 + (100 - Math.min(pet.energy, pet.hunger)) / 50;
          motion.idleUntil = now + (1800 + Math.random() * 3500) * lazy;
          motion.targetX = (Math.random() * 2 - 1) * WALK_LIMIT;
        } else walking = true;
      } else {
        motion.vx = approach(motion.vx, 0, 10, dt);
      }
    }
    if (motion.gone && motion.task?.kind === 'return' && now > motion.task.at) {
      // Drops back in from above and lands with a squash.
      motion.gone = false;
      motion.x = 0;
      motion.vx = 0;
      motion.y = 22;
      motion.vy = 0;
      creeper.root.classList.remove('pet3d__creeper--gone');
      shadow.classList.remove('pet3d__shadow--gone');
      motion.task = null;
    }

    if (!off) {
      // Position and the walk cycle: the legs turn with the distance walked (a stride ≈ 4.5 px).
      motion.x = clamp(motion.x + motion.vx * dt, -WALK_LIMIT, WALK_LIMIT);
      const speed = Math.abs(motion.vx);
      motion.phase += (speed * dt * Math.PI * 2) / 4.5;
      const gait = Math.min(1, speed / 4);

      // Gravity, landing, squash and stretch (a damped spring back to 1).
      motion.vy -= 70 * dt;
      motion.y += motion.vy * dt;
      if (motion.y <= 0) {
        if (motion.vy < -6) motion.squash = Math.min(0.28, -motion.vy / 70);
        motion.y = 0;
        motion.vy = 0;
      }
      const stretch = motion.y > 0 ? clamp(motion.vy / 80, -0.08, 0.12) : 0;
      motion.squashVel += (-180 * motion.squash - 14 * motion.squashVel) * dt;
      motion.squash += motion.squashVel * dt;

      // Facing: towards where it walks, else a little towards you; turned with a spring.
      const facing = speed > 0.6 ? (motion.vx > 0 ? 90 : -90) : -VIEW_YAW;
      motion.yawVel += ((facing - motion.yaw) * 55 - 11 * motion.yawVel) * dt;
      motion.yaw += motion.yawVel * dt;

      // The head follows the mouse (when it faces you), lags a little, nods while eating.
      const towardsYou = speed < 0.6 && !pet.sleeping;
      motion.headYaw = approach(motion.headYaw, towardsYou ? motion.lookYaw : 0, 6, dt);
      motion.headPitch = approach(motion.headPitch, (towardsYou ? motion.lookPitch : 0) + headDown + nod * 0.45, 7, dt);

      const swing = Math.sin(motion.phase) * 0.62 * gait;
      const bob = Math.abs(Math.sin(motion.phase)) * 0.45 * gait;
      const breathe = pet.sleeping ? Math.sin(now / 900) * 0.02 : Math.sin(now / 1400) * 0.008;
      const swellPulse = motion.swell > 0 ? motion.swell * (0.08 + Math.sin(now / 55) * 0.03) : 0;
      const sy = 1 - motion.squash + stretch + breathe + swellPulse;
      const sxz = 1 + motion.squash * 0.6 - stretch * 0.4 + swellPulse;
      creeper.root.style.transform = `translate3d(${px(motion.x)}, ${px(-motion.y)}, ${px(motion.z)}) rotateY(${motion.yaw + shake * 18}deg) scale3d(${sxz}, ${sy}, ${sxz})`;
      // The white flashes of a hissing creeper, on every face (a filter on the whole model would flatten it).
      creeper.root.style.setProperty('--flash', motion.swell > 0 ? String(Math.max(0, Math.sin(now / 90)) * motion.swell * 1.4) : '0');
      creeper.torso.style.transform = `translate3d(0, ${px(-6 + bob * -1 + (pet.sleeping ? 0.6 : 0))}, 0) rotateZ(${Math.sin(motion.phase) * 2 * gait}deg)`;
      creeper.neck.style.transform = `translate3d(0, ${px(-12)}, 0) rotateY(${motion.headYaw}deg) rotateX(${-motion.headPitch * 57}deg)`;
      creeper.legs.forEach((hip, index) => {
        // Diagonal pairs swing together, as a four-legged walk.
        const sign = index === 0 || index === 3 ? 1 : -1;
        hip.style.transform = `translate3d(${px(Number(hip.dataset.x))}, ${px(-6)}, ${px(Number(hip.dataset.z))}) rotateX(${sign * swing * 57}deg)`;
      });
      const lift = clamp(1 - motion.y / 30, 0.4, 1);
      shadow.style.transform = `translate3d(${px(motion.x)}, -4px, ${px(motion.z)}) rotateX(90deg) scale(${lift})`;
      shadow.style.opacity = String(0.55 * lift);

      // Food and the ball: fall, bounce, roll, and are eaten (shrink).
      for (const item of [...items]) {
        item.vy -= 70 * dt;
        item.y += item.vy * dt;
        item.x += item.vx * dt;
        if (item.y <= 0) {
          item.y = 0;
          item.vy = item.bouncy ? Math.abs(item.vy) * 0.62 : 0;
          if (item.vy < 3) item.vy = 0;
          item.vx *= item.bouncy ? 0.9 : 0.4;
        }
        if (Math.abs(item.x) > WALK_LIMIT + 3) {
          item.x = Math.sign(item.x) * (WALK_LIMIT + 3);
          item.vx = -item.vx * 0.7;
        }
        // Always facing you (counter to the view's turn).
        item.sprite.style.transform = `translate3d(${px(item.x)}, ${px(-item.y - 2)}, ${px(item.z)}) rotateY(${-VIEW_YAW}deg) rotateX(${-VIEW_PITCH}deg) scale(${item.scale})`;
      }
    }
  }

  // The head looks towards the mouse anywhere over the scene.
  scene.addEventListener('pointermove', (event) => {
    const rect = scene.getBoundingClientRect();
    motion.lookYaw = clamp(((event.clientX - rect.left) / rect.width - 0.5) * 70, -40, 40);
    motion.lookPitch = clamp(((event.clientY - rect.top) / rect.height - 0.45) * 0.9, -0.35, 0.4);
  });
  scene.addEventListener('pointerleave', () => {
    motion.lookYaw = 0;
    motion.lookPitch = 0;
  });

  // Renaming: a click on the name.
  nameLabel.addEventListener('click', () => {
    const input = h('input', { class: 'input pet-name__input', type: 'text', maxlength: '16', value: pet.name, spellcheck: 'false' });
    const done = () => {
      pet.name = input.value.trim().slice(0, 16) || pet.name;
      nameLabel.textContent = pet.name;
      input.replaceWith(nameLabel);
      changed();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        input.value = pet.name;
        input.blur();
      }
    });
    input.addEventListener('blur', done, { once: true });
    nameLabel.replaceWith(input);
    input.focus();
    input.select();
  });

  world.style.transform = `rotateX(${VIEW_PITCH}deg) rotateY(${VIEW_YAW}deg)`;
  render();
  step(performance.now());
  let ticker = 0;

  return {
    element,
    onShow: () => {
      active = true;
      lastTime = 0;
      render();
      if (!frame) frame = requestAnimationFrame(step);
      ticker = setInterval(() => {
        render();
        savePet(pet);
      }, 30000);
      if (!pet.sleeping) hop(10);
    },
    onHide: () => {
      active = false;
      clearInterval(ticker);
      savePet(pet);
    },
  };
}
