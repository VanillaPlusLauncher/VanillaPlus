import { h } from '../core/dom.js';
import { getMcManifest, mcUrl } from '../core/mc.js';
import { sfx } from '../core/sound.js';

const LEAVE_ANIMATION_MS = 260;
const TITLES = { success: 'Готово!', error: 'Ошибка', info: 'Внимание' };
/** Item shown in the toast, like an advancement icon. */
const ICONS = { success: 'emerald', error: 'redstone', info: 'book' };

/**
 * Shows a short notification in the bottom-right corner, styled as a Minecraft advancement.
 * type: 'info' | 'success' | 'error'. `options.title` replaces the default heading, `options.icon`
 * is an item texture name, options.action = { label, onClick } adds a button.
 */
export function toast(message, type = 'info', duration = 4200, options = {}) {
  const stack = document.getElementById('toast-root');
  const iconName = options.icon ?? ICONS[type];
  const hasIcon = getMcManifest()?.textures.items.includes(iconName);
  const element = h(
    'div',
    { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    hasIcon ? h('img', { class: 'toast__icon', src: mcUrl(`item/${iconName}.png`), alt: '' }) : null,
    h('div', { class: 'toast__body' }, h('span', { class: 'toast__title' }, options.title ?? TITLES[type] ?? TITLES.info), h('span', { class: 'toast__text' }, message)),
    options.action
      ? h('button', { class: 'btn btn--primary btn--compact toast__action', type: 'button', onclick: () => { options.action.onClick(); element.remove(); } }, options.action.label)
      : null,
  );
  stack.append(element);
  if (!options.silent) {
    sfx(type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
  }
  setTimeout(() => {
    element.classList.add('toast--leaving');
    setTimeout(() => element.remove(), LEAVE_ANIMATION_MS);
  }, duration);
}
