import { api } from '../services/api.js';
import { getMcManifest, mcUrl, onMcReady } from './mc.js';

/*
 * Interface sounds, all taken from Minecraft: button clicks, note blocks, toasts, level-up,
 * and the title-screen music. Played through Web Audio, so note blocks get the game's pitch
 * (playback rate 2^((note - 12) / 12), notes 0..24) and many sounds can overlap.
 */

const MUSIC_GAP_MS = [15000, 45000];
let context = null;
let master = null;
let musicGain = null;
const buffers = new Map();
let settings = { enabled: true, volume: 60, clicks: true, hover: false, events: true, navSound: 'click', actions: {}, music: false, musicVolume: 35 };
let musicState = { playing: false, source: null, timer: null, lastTrack: null };

function audio() {
  if (!context) {
    context = new AudioContext();
    master = context.createGain();
    master.connect(context.destination);
    musicGain = context.createGain();
    musicGain.connect(context.destination);
    applyVolumes();
  }
  if (context.state === 'suspended' && !away) {
    context.resume().catch(() => {});
  }
  return context;
}

/**
 * Away from the window (the game, a browser, another program): all sound pauses — the music
 * stops right where it is and goes on from there when the window is back in focus.
 */
let away = !document.hasFocus();
window.addEventListener('blur', () => {
  away = true;
  context?.suspend().catch(() => {});
});
window.addEventListener('focus', () => {
  away = false;
  if (context?.state === 'suspended') context.resume().catch(() => {});
});

function applyVolumes() {
  if (!master) {
    return;
  }
  master.gain.value = settings.enabled ? settings.volume / 100 : 0;
  musicGain.gain.value = settings.enabled && settings.music ? (settings.musicVolume / 100) * 0.6 : 0;
}

async function loadBuffer(relativePath) {
  if (!buffers.has(relativePath)) {
    buffers.set(
      relativePath,
      fetch(mcUrl(relativePath))
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
        .then((data) => audio().decodeAudioData(data))
        .catch(() => null),
    );
  }
  return buffers.get(relativePath);
}

/** Plays a sound by key (see SOUNDS in mcResources.js). options: { volume, rate, note }. */
export async function playSound(key, { volume = 1, rate = 1, note = null } = {}) {
  if (!settings.enabled) {
    return;
  }
  const path = getMcManifest()?.sounds?.[key];
  if (!path) {
    return;
  }
  const buffer = await loadBuffer(path);
  if (!buffer) {
    return;
  }
  const ctx = audio();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = note === null ? rate : 2 ** ((note - 12) / 12);
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(master);
  source.start();
}

/** A sequence of note block notes: [[instrument, note, delayMs], ...]. */
export function playMelody(notes, volume = 0.5) {
  for (const [instrument, note, delay] of notes) {
    setTimeout(() => playSound(`note_${instrument}`, { note, volume }), delay);
  }
}

const jitter = (spread) => 1 + (Math.random() - 0.5) * spread;
const NOTE_STEPS = [6, 8, 10, 13, 15, 18, 20];

/**
 * Every sound an action can have (Settings → Sounds lets each action pick one). `index` is the
 * position of a sidebar item, so note-block sounds climb a scale along the sidebar.
 */
export const SOUND_PRESETS = {
  none: { label: 'Без звука', play: () => {} },
  click: { label: 'Кнопка', play: () => playSound('click', { volume: 0.45, rate: jitter(0.06) }) },
  click_soft: { label: 'Тихая кнопка', play: () => playSound('click', { volume: 0.3, rate: 1.15 }) },
  wood: { label: 'Деревянная кнопка', play: () => playSound('wood_click', { volume: 0.5, rate: jitter(0.1) }) },
  lever: { label: 'Рычаг', play: () => playSound('lever', { volume: 0.4, rate: jitter(0.08) }) },
  pressure_plate: { label: 'Нажимная плита', play: () => playSound('pressure_plate', { volume: 0.45 }) },
  xp: { label: 'Опыт', play: () => playSound('orb', { volume: 0.35, rate: 0.75 + Math.random() * 0.6 }) },
  levelup: { label: 'Новый уровень', play: () => playSound('levelup', { volume: 0.4 }) },
  pop: { label: 'Подбор предмета', play: () => playSound('pop', { volume: 0.4, rate: 0.8 + Math.random() * 0.6 }) },
  note_harp: { label: 'Нотный блок: арфа', play: (index = 0) => playSound('note_harp', { note: NOTE_STEPS[index % 7], volume: 0.35 }) },
  note_bell: { label: 'Нотный блок: колокольчик', play: (index = 0) => playSound('note_bell', { note: NOTE_STEPS[index % 7], volume: 0.3 }) },
  note_pling: { label: 'Нотный блок: плинг', play: (index = 0) => playSound('note_pling', { note: NOTE_STEPS[index % 7], volume: 0.3 }) },
  note_chime: { label: 'Нотный блок: перезвон', play: (index = 0) => playSound('note_chime', { note: NOTE_STEPS[index % 7], volume: 0.3 }) },
  note_bit: { label: 'Нотный блок: 8-бит', play: (index = 0) => playSound('note_bit', { note: NOTE_STEPS[index % 7], volume: 0.3 }) },
  note_hat: { label: 'Нотный блок: хэт', play: () => playSound('note_hat', { note: 18, volume: 0.12 }) },
  melody: { label: 'Мелодия нотных блоков', play: () => playMelody([['pling', 6, 0], ['pling', 10, 90], ['pling', 13, 180], ['pling', 18, 270], ['bell', 18, 380]], 0.4) },
  bell: { label: 'Колокол', play: () => playSound('bell', { volume: 0.35 }) },
  chest_open: { label: 'Сундук открывается', play: () => playSound('chest_open', { volume: 0.35, rate: 1.1 }) },
  chest_close: { label: 'Сундук закрывается', play: () => playSound('chest_close', { volume: 0.3, rate: 1.1 }) },
  barrel_open: { label: 'Бочка открывается', play: () => playSound('barrel_open', { volume: 0.4 }) },
  barrel_close: { label: 'Бочка закрывается', play: () => playSound('barrel_close', { volume: 0.4 }) },
  shulker_open: { label: 'Шалкер открывается', play: () => playSound('shulker_open', { volume: 0.4 }) },
  shulker_close: { label: 'Шалкер закрывается', play: () => playSound('shulker_close', { volume: 0.4 }) },
  door_open: { label: 'Дверь открывается', play: () => playSound('door_open', { volume: 0.35 }) },
  door_close: { label: 'Дверь закрывается', play: () => playSound('door_close', { volume: 0.35 }) },
  page: { label: 'Страница книги', play: () => playSound('page', { volume: 0.5 }) },
  book_close: { label: 'Книга закрывается', play: () => playSound('book_close', { volume: 0.5 }) },
  toast: { label: 'Уведомление', play: () => playSound('toast_in', { volume: 0.5 }) },
  challenge: { label: 'Испытание выполнено', play: () => playSound('challenge', { volume: 0.35 }) },
  amethyst: { label: 'Аметист', play: () => playSound('amethyst', { volume: 0.6, rate: jitter(0.2) }) },
  enchant: { label: 'Зачарование', play: () => playSound('enchant', { volume: 0.4 }) },
  anvil: { label: 'Наковальня', play: () => playSound('anvil', { volume: 0.3 }) },
  smithing: { label: 'Стол кузнеца', play: () => playSound('smithing', { volume: 0.4 }) },
  stonecutter: { label: 'Камнерез', play: () => playSound('stonecutter', { volume: 0.35 }) },
  loom: { label: 'Ткацкий станок', play: () => playSound('loom', { volume: 0.45 }) },
  cartography: { label: 'Стол картографа', play: () => playSound('cartography', { volume: 0.45 }) },
  item_frame: { label: 'Рамка', play: () => playSound('item_frame', { volume: 0.45 }) },
  lodestone: { label: 'Магнетит', play: () => playSound('lodestone', { volume: 0.45 }) },
  glass: { label: 'Стекло', play: () => playSound('glass', { volume: 0.3 }) },
  beacon: { label: 'Маяк включается', play: () => playSound('beacon', { volume: 0.35 }) },
  beacon_off: { label: 'Маяк выключается', play: () => playSound('beacon_off', { volume: 0.35 }) },
  portal: { label: 'Портал', play: () => playSound('portal', { volume: 0.2 }) },
  teleport: { label: 'Телепорт эндермена', play: () => playSound('teleport', { volume: 0.3 }) },
  totem: { label: 'Тотем бессмертия', play: () => playSound('totem', { volume: 0.25 }) },
  firework_launch: { label: 'Фейерверк: запуск', play: () => playSound('firework_launch', { volume: 0.35 }) },
  firework_blast: { label: 'Фейерверк: взрыв', play: () => playSound('firework_blast', { volume: 0.3 }) },
  firework_twinkle: { label: 'Фейерверк: искры', play: () => playSound('firework_twinkle', { volume: 0.3 }) },
  bow: { label: 'Лук', play: () => playSound('bow', { volume: 0.35, rate: jitter(0.2) }) },
  eat: { label: 'Еда', play: () => playSound('eat', { volume: 0.35 }) },
  burp: { label: 'Отрыжка', play: () => playSound('burp', { volume: 0.35 }) },
  bubble: { label: 'Пузыри', play: () => playSound('bubble', { volume: 0.4 }) },
  villager_yes: { label: 'Житель: да', play: () => playSound('villager_yes', { volume: 0.45 }) },
  villager_no: { label: 'Житель: нет', play: () => playSound('villager_no', { volume: 0.45 }) },
  villager_idle: { label: 'Житель: хм', play: () => playSound('villager_idle', { volume: 0.45 }) },
  meow: { label: 'Кошка', play: () => playSound('meow', { volume: 0.35 }) },
  purr: { label: 'Кошка мурлычет', play: () => playSound('purr', { volume: 0.45 }) },
  chicken: { label: 'Курица', play: () => playSound('chicken', { volume: 0.35 }) },
  allay: { label: 'Тихоня', play: () => playSound('allay', { volume: 0.4 }) },
  axolotl: { label: 'Аксолотль', play: () => playSound('axolotl', { volume: 0.4 }) },
  frog: { label: 'Лягушка', play: () => playSound('frog', { volume: 0.4 }) },
  bee: { label: 'Пчела', play: () => playSound('bee', { volume: 0.4 }) },
  sniffer: { label: 'Нюхач', play: () => playSound('sniffer', { volume: 0.4 }) },
};

/** Actions that have a sound, with the default one. `group` follows the old on/off switches. */
export const SOUND_ACTIONS = [
  { key: 'click', label: 'Нажатие кнопки', group: 'clicks', preset: 'click' },
  { key: 'navigate', label: 'Переход по разделам', group: 'clicks', preset: 'click' },
  { key: 'tab', label: 'Вкладки и переключатели режимов', group: 'clicks', preset: 'click_soft' },
  { key: 'toggleOn', label: 'Включение', group: 'clicks', preset: 'wood' },
  { key: 'toggleOff', label: 'Выключение', group: 'clicks', preset: 'wood' },
  { key: 'hover', label: 'Наведение на карточки', group: 'hover', preset: 'note_hat' },
  { key: 'modalOpen', label: 'Окно открывается', group: 'events', preset: 'chest_open' },
  { key: 'modalClose', label: 'Окно закрывается', group: 'events', preset: 'chest_close' },
  { key: 'success', label: 'Успех', group: 'events', preset: 'xp' },
  { key: 'error', label: 'Ошибка', group: 'events', preset: 'villager_no' },
  { key: 'info', label: 'Уведомление', group: 'events', preset: 'toast' },
  { key: 'installed', label: 'Установка завершена', group: 'events', preset: 'challenge' },
  { key: 'launch', label: 'Нажали «Играть»', group: 'events', preset: 'none' },
  { key: 'gameStarted', label: 'Игра запустилась', group: 'events', preset: 'levelup' },
  { key: 'skinSaved', label: 'Скин сохранён', group: 'events', preset: 'amethyst' },
  { key: 'page', label: 'Страница книги (описания)', group: 'events', preset: 'page' },
  { key: 'delete', label: 'Удаление', group: 'events', preset: 'stonecutter' },
];
const ACTIONS_BY_KEY = Object.fromEntries(SOUND_ACTIONS.map((action) => [action.key, action]));

/** The sound chosen for an action (the old "navigation sound" setting still counts). */
export function presetFor(action) {
  const chosen = settings.actions?.[action];
  if (chosen && SOUND_PRESETS[chosen]) return chosen;
  if (action === 'navigate' && settings.navSound && settings.navSound !== 'click') return settings.navSound === 'note' ? 'note_harp' : settings.navSound;
  return ACTIONS_BY_KEY[action]?.preset ?? 'none';
}

/** Plays one preset (the ▶ buttons in Settings). */
export function previewSound(preset) {
  SOUND_PRESETS[preset]?.play(Math.floor(Math.random() * 7));
}

export function sfx(name, ...args) {
  try {
    const action = ACTIONS_BY_KEY[name];
    if (!action) {
      // Drawing on a skin: a soft tick that follows the clicks switch.
      if (name === 'paint' && settings.clicks) playSound('note_hat', { note: 12 + Math.floor(Math.random() * 8), volume: 0.08 });
      return;
    }
    if (!settings[action.group]) return;
    SOUND_PRESETS[presetFor(name)]?.play(...args);
  } catch {
    // Sounds never break the UI.
  }
}

// --- Music --------------------------------------------------------------------------

function scheduleNextTrack(delay) {
  clearTimeout(musicState.timer);
  musicState.timer = setTimeout(playNextTrack, delay);
}

/** While Minecraft runs, the launcher's music is silent (the game has its own). */
let gameRunning = false;

async function playNextTrack() {
  if (!settings.enabled || !settings.music || gameRunning) {
    return;
  }
  const tracks = getMcManifest()?.music ?? [];
  if (tracks.length === 0) {
    return;
  }
  const choices = tracks.length > 1 ? tracks.filter((track) => track !== musicState.lastTrack) : tracks;
  const track = choices[Math.floor(Math.random() * choices.length)];
  musicState.lastTrack = track;
  const buffer = await loadBuffer(track);
  if (!buffer || !settings.music || gameRunning) {
    return;
  }
  const ctx = audio();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(musicGain);
  source.onended = () => {
    if (musicState.source === source) {
      musicState.source = null;
      const [min, max] = MUSIC_GAP_MS;
      scheduleNextTrack(min + Math.random() * (max - min));
    }
  };
  musicState.source?.stop();
  musicState.source = source;
  source.start();
}

async function startMusic() {
  if (musicState.playing || gameRunning) {
    return;
  }
  musicState.playing = true;
  try {
    if ((getMcManifest()?.music ?? []).length === 0) {
      await api.minecraft.music();
    }
  } catch {
    musicState.playing = false;
    return;
  }
  scheduleNextTrack(1500);
}

function stopMusic() {
  musicState.playing = false;
  clearTimeout(musicState.timer);
  musicState.source?.stop();
  musicState.source = null;
}

/** The game started (or is being started) / ended: music stops, then comes back afterwards. */
export function setGameRunning(running) {
  if (running === gameRunning) return;
  gameRunning = running;
  if (running) {
    stopMusic();
  } else if (settings.enabled && settings.music) {
    onMcReady(() => startMusic());
  }
}

/** Applies Settings → Sounds. */
export function configureSound(next) {
  settings = { ...settings, ...(next ?? {}) };
  applyVolumes();
  if (settings.enabled && settings.music) {
    onMcReady(() => startMusic());
  } else {
    stopMusic();
  }
}

/** Plays UI click sounds for every button, chip and tab without each page wiring them. */
export function installGlobalSounds() {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('button, [role="button"], .toggle input') : null;
      if (!target || target.disabled || target.dataset.sound === 'none') {
        return;
      }
      if (target.matches('.toggle input')) {
        sfx(target.checked ? 'toggleOn' : 'toggleOff');
      } else if (target.matches('.tabs__button, .segmented button')) {
        sfx('tab');
      } else if (!target.matches('.nav-button')) {
        sfx('click');
      }
    },
    true,
  );
  document.addEventListener(
    'pointerover',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('.nav-button, .instance-card, .project-card') : null;
      if (target && !target.contains(event.relatedTarget)) {
        sfx('hover');
      }
    },
    true,
  );
}
