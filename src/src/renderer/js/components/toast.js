import { h } from '../core/dom.js';
import { getMcManifest, mcUrl } from '../core/mc.js';
import { sfx } from '../core/sound.js';

const LEAVE_ANIMATION_MS = 260;
const TITLES = { success: 'Готово!', error: 'Ошибка', info: 'Внимание' };
/** Item shown in the toast, like an advancement icon. */
const ICONS = { success: 'emerald', error: 'redstone', info: 'book' };
const GAP = 10;
/** More than this and the oldest ones go away at once. */
const MAX_TOASTS = 12;

/**
 * Toasts never cover each other: only the newest one shows, and when there are several a number in
 * its corner says how many. With the pointer on it they spread into a list and no toast leaves
 * while you read.
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
    if (badge.parentElement !== newest.element || badge.textContent !== String(live.length)) {
      badge.textContent = String(live.length);
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
 * Shows a short notification in the bottom-right corner, styled as a Minecraft advancement.
 * type: 'info' | 'success' | 'error'. `options.title` replaces the default heading, `options.icon`
 * is an item texture name, options.action = { label, onClick } adds a button.
 */
export function toast(message, type = 'info', duration = 4200, options = {}) {
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
  if (!options.silent) {
    sfx(type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
  }
}
