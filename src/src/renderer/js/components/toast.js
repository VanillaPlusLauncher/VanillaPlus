import { h, icon } from '../core/dom.js';
import { formatAgo } from '../core/content.js';
import { getMcManifest, mcUrl } from '../core/mc.js';
import { sfx } from '../core/sound.js';

const LEAVE_ANIMATION_MS = 260;
const TITLES = { success: 'Готово!', error: 'Ошибка', info: 'Внимание' };
/** Item shown in the toast, like an advancement icon. */
const ICONS = { success: 'emerald', error: 'redstone', info: 'book' };
const GAP = 10;
/** More than this and the oldest ones go away at once. */
const MAX_TOASTS = 12;

/*
 * Notifications. Every one goes into the book in the bottom-right corner: a small enchanted book that
 * hops and counts what is new. A click opens the list in sections (mod downloads, instances, errors,
 * the rest); each section is a stack showing its newest note, and opens to show all of them with how
 * long ago each was. Only what needs an answer also shows as a card over the corner: an error, or a
 * notice with a button ("Обновить", "Позже"…).
 */
const GROUPS = [
  { key: 'mods', title: 'Загрузки модов', icon: 'enchanted_book' },
  { key: 'instances', title: 'Сборки', icon: 'diamond_pickaxe' },
  { key: 'errors', title: 'Ошибки', icon: 'redstone' },
  { key: 'other', title: 'Прочее', icon: 'book' },
];
/** Notes kept for the list (this run of the launcher only). */
const KEEP = 200;
const notes = [];
let unseen = 0;
/** The corner holding the book (fixed; the book itself is an ordinary small button). */
let corner = null;
let book = null;
let bookCount = null;
let panel = null;
/** Sections opened in the list (they stay open the next time the list opens). */
const openGroups = new Set();

/** An item picture from the game, when the game's files are there. */
function itemPicture(name, className) {
  return getMcManifest()?.textures.items.includes(name) ? h('img', { class: className, src: mcUrl(`item/${name}.png`), alt: '' }) : null;
}

function ensureBook() {
  if (book) return;
  bookCount = h('span', { class: 'notify-book__count', 'aria-hidden': 'true' });
  book = h(
    'button',
    { class: 'icon-button notify-book', type: 'button', title: 'Уведомления', 'aria-label': 'Уведомления', onclick: () => (panel ? closePanel() : openPanel()) },
    itemPicture('enchanted_book', 'notify-book__img') ?? icon('file'),
  );
  // The number sits on the corner, not in the button: the button cuts off what sticks out of it.
  corner = h('div', { class: 'notify-corner', hidden: true }, book, bookCount);
  document.body.append(corner);
}

/** The book hops and its number grows; it shows from the first note of this run. */
function bump() {
  ensureBook();
  corner.hidden = false;
  if (panel) {
    renderPanel();
    return;
  }
  unseen += 1;
  bookCount.textContent = unseen > 99 ? '99+' : String(unseen);
  book.classList.add('notify-book--new');
  book.classList.remove('notify-book--hop');
  void book.offsetWidth;
  book.classList.add('notify-book--hop');
}

function record(message, type, options) {
  const group = options.group ?? (type === 'error' ? 'errors' : 'other');
  notes.push({ group, type, title: options.title ?? TITLES[type] ?? TITLES.info, text: String(message), icon: options.icon ?? ICONS[type], action: options.action ?? null, at: new Date().toISOString() });
  if (notes.length > KEEP) notes.splice(0, notes.length - KEEP);
  bump();
}

function noteRow(note) {
  return h(
    'div',
    { class: `notify-note notify-note--${note.type}` },
    itemPicture(note.icon, 'notify-note__img'),
    h(
      'div',
      { class: 'notify-note__body' },
      h('span', { class: 'notify-note__title' }, note.title),
      h('span', { class: 'notify-note__text' }, note.text),
      // The card's button ("Обновить"…) stays here once the card is gone.
      note.action ? h('button', { class: 'btn btn--secondary btn--compact notify-note__action', type: 'button', onclick: (event) => { event.stopPropagation(); closePanel(); note.action.onClick(); } }, note.action.label) : null,
    ),
    h('span', { class: 'notify-note__time' }, formatAgo(note.at)),
  );
}

function renderPanel() {
  const sections = GROUPS.map((group) => {
    const own = notes.filter((note) => note.group === group.key).reverse();
    if (own.length === 0) return null;
    const open = openGroups.has(group.key);
    const head = h(
      'button',
      {
        class: 'notify-group__head',
        type: 'button',
        'aria-expanded': String(open),
        onclick: () => {
          if (open) openGroups.delete(group.key);
          else openGroups.add(group.key);
          renderPanel();
        },
      },
      itemPicture(group.icon, 'notify-group__img'),
      h('span', { class: 'notify-group__title' }, group.title),
      h('span', { class: 'notify-group__count' }, String(own.length)),
      h('span', { class: 'notify-group__time' }, formatAgo(own[0].at)),
      h('span', { class: 'notify-group__chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
    );
    // Closed, a section is a stack: its newest note on top, the others as edges under it.
    const body = open
      ? h('div', { class: 'notify-group__list' }, own.map(noteRow))
      : h('div', { class: `notify-group__stack${own.length > 1 ? ' notify-group__stack--more' : ''}`, onclick: () => { openGroups.add(group.key); renderPanel(); } }, noteRow(own[0]));
    return h('section', { class: `notify-group notify-group--${group.key}` }, head, body);
  }).filter(Boolean);
  panel.replaceChildren(
    h(
      'div',
      { class: 'notify-panel__head' },
      h('span', { class: 'notify-panel__title' }, 'Уведомления'),
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => { notes.length = 0; closePanel(); corner.hidden = true; } }, 'Очистить'),
    ),
    sections.length ? h('div', { class: 'notify-panel__groups' }, sections) : h('p', { class: 'notify-panel__empty' }, 'Пока ничего'),
  );
}

let ticker = 0;
function onOutside(event) {
  if (panel && !panel.contains(event.target) && !book.contains(event.target)) closePanel();
}
function onKey(event) {
  if (event.key === 'Escape') closePanel();
}

function openPanel() {
  panel = h('div', { class: 'context-menu notify-panel', role: 'dialog', 'aria-label': 'Уведомления' });
  renderPanel();
  document.body.append(panel);
  // The cards say nothing the list does not: they go.
  for (const entry of toasts) leave(entry);
  unseen = 0;
  bookCount.textContent = '';
  book.classList.remove('notify-book--new');
  book.setAttribute('aria-expanded', 'true');
  // "минуту назад" stays true while the list is open.
  ticker = setInterval(renderPanel, 30000);
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true));
  document.addEventListener('keydown', onKey);
}

function closePanel() {
  clearInterval(ticker);
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey);
  panel?.remove();
  panel = null;
  book?.setAttribute('aria-expanded', 'false');
}

/*
 * Cards (an error, a notice with a button) never cover each other: only the newest one shows, and when
 * there are several a number in its corner says how many. With the pointer on them they spread into a
 * list and none leaves while you read.
 */
const toasts = [];
let stack = null;
/** The number in the newest toast's corner; it moves to whichever toast is the newest. */
let badge = null;
let hovered = false;

function ensureStack() {
  if (stack) return;
  stack = document.getElementById('toast-root');
  stack.classList.add('toast-pile');
  badge = h('span', { class: 'toast__count', 'aria-hidden': 'true' });
  stack.addEventListener('pointerenter', () => {
    hovered = true;
    for (const entry of toasts) entry.pause();
    layout();
  });
  stack.addEventListener('pointerleave', () => {
    hovered = false;
    for (const entry of toasts) entry.resume();
    layout();
  });
}

/**
 * Places every toast: a pile (newest in front) or, under the pointer, a list going up. The `translate`
 * and `scale` properties are used, not `transform`: the toasts' own in/out animations keep that one.
 */
function layout() {
  const live = toasts.filter((entry) => !entry.leaving);
  const newestFirst = [...live].reverse();
  let offset = 0;
  newestFirst.forEach((entry, depth) => {
    const { element } = entry;
    const height = element.offsetHeight;
    if (hovered || live.length < 2) {
      element.style.translate = `0 ${-offset}px`;
      element.style.scale = '1';
      element.style.opacity = '1';
      offset += height + GAP;
    } else {
      // Only the newest is seen; the others wait behind it (the number in its corner says how many).
      element.style.translate = '0 0';
      element.style.scale = depth === 0 ? '1' : '0.96';
      element.style.opacity = depth === 0 ? '1' : '0';
      if (depth === 0) offset = height + GAP;
    }
    element.style.zIndex = String(100 - depth);
    element.style.pointerEvents = hovered || depth === 0 || live.length < 2 ? 'auto' : 'none';
  });
  // The count sits in the newest toast's corner while the others wait behind it.
  const newest = newestFirst[0];
  if (newest && live.length >= 2 && !hovered) {
    if (badge.parentElement !== newest.element || badge.textContent !== `×${live.length}`) {
      badge.textContent = `×${live.length}`;
      newest.element.append(badge);
      badge.classList.remove('toast__count--pop');
      void badge.offsetWidth;
      badge.classList.add('toast__count--pop');
    }
  } else {
    badge.remove();
  }
  // The pile's own height: the pointer can reach every toast of the spread list.
  stack.style.height = `${offset}px`;
}

function leave(entry) {
  if (entry.leaving) return;
  entry.leaving = true;
  entry.clear();
  entry.element.classList.add('toast--leaving');
  layout();
  setTimeout(() => {
    entry.element.remove();
    const index = toasts.indexOf(entry);
    if (index >= 0) toasts.splice(index, 1);
    layout();
  }, LEAVE_ANIMATION_MS);
}

/**
 * A notification. type: 'info' | 'success' | 'error'. `options.title` replaces the default heading,
 * `options.icon` is an item texture name, `options.group` its section in the book ('mods',
 * 'instances'; errors go to their own, the rest to "Прочее"), options.action = { label, onClick } adds
 * a button. It goes into the book; an error or one with a button also shows as a card (the
 * advancement look) in the bottom-right corner.
 */
export function toast(message, type = 'info', duration = 4200, options = {}) {
  record(message, type, options);
  if (!options.silent) {
    sfx(type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
  }
  if (type !== 'error' && !options.action) return;
  ensureStack();
  const iconName = options.icon ?? ICONS[type];
  const hasIcon = getMcManifest()?.textures.items.includes(iconName);
  const entry = { element: null, leaving: false };
  const element = h(
    'div',
    { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    hasIcon ? h('img', { class: 'toast__icon', src: mcUrl(`item/${iconName}.png`), alt: '' }) : null,
    h('div', { class: 'toast__body' }, h('span', { class: 'toast__title' }, options.title ?? TITLES[type] ?? TITLES.info), h('span', { class: 'toast__text' }, message)),
    options.action
      ? h('button', { class: 'btn btn--primary btn--compact toast__action', type: 'button', onclick: () => { options.action.onClick(); leave(entry); } }, options.action.label)
      : null,
  );
  entry.element = element;
  // Its own timer, stopped while the pointer is on the pile.
  let remaining = duration;
  let startedAt = 0;
  let timer = 0;
  entry.resume = () => {
    if (entry.leaving || timer) return;
    startedAt = Date.now();
    timer = setTimeout(() => leave(entry), Math.max(800, remaining));
  };
  entry.pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    remaining -= Date.now() - startedAt;
  };
  entry.clear = () => {
    clearTimeout(timer);
    timer = 0;
  };
  toasts.push(entry);
  stack.append(element);
  // Too many at once: the oldest go.
  toasts.filter((candidate) => !candidate.leaving).slice(0, -MAX_TOASTS).forEach((old) => leave(old));
  layout();
  if (!hovered) entry.resume();
}
