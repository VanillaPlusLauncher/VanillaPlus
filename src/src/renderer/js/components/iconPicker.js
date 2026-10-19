import { h } from '../core/dom.js';
import { ICON_BLOCKS, blockAvailable, getMcManifest, hasItem, iconImage } from '../core/mc.js';
import { openModal } from './modal.js';
import { api } from '../services/api.js';
import { errorMessage } from '../core/format.js';
import { refreshInstances, updateInstance } from '../state/actions.js';
import { toast } from './toast.js';

const ICON_ITEMS = [
  'diamond', 'emerald', 'netherite_ingot', 'diamond_pickaxe', 'diamond_sword', 'netherite_sword', 'golden_apple', 'ender_pearl', 'ender_eye',
  'nether_star', 'totem_of_undying', 'enchanted_book', 'map', 'bow', 'trident', 'elytra', 'spyglass', 'heart_of_the_sea', 'experience_bottle',
  'firework_rocket', 'cake', 'cookie', 'music_disc_cat', 'music_disc_pigstep', 'amethyst_shard', 'echo_shard', 'redstone', 'blaze_powder',
  'slime_ball', 'lava_bucket', 'water_bucket', 'sweet_berries', 'golden_carrot', 'honey_bottle',
];

/**
 * Lets the user choose an instance icon from the game's blocks and items. Resolves with the icon
 * value, 'upload' when the user wants their own picture (only offered with { allowUpload }), or null.
 */
export function pickIcon(current, { allowUpload = false } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    const grid = (title, entries) =>
      h(
        'div',
        { class: 'icon-picker__group' },
        h('span', { class: 'section-title' }, title),
        h(
          'div',
          { class: 'icon-picker__grid' },
          entries.map((value) => {
            const button = h(
              'button',
              {
                class: `icon-picker__item${value === current ? ' icon-picker__item--current' : ''}`,
                type: 'button',
                title: value.split(':')[1].replace(/_/g, ' '),
                onclick: () => {
                  chosen = value;
                  modal.close();
                },
              },
              iconImage(value, 'icon-picker__img'),
            );
            return button;
          }),
        ),
      );
    const manifest = getMcManifest();
    const blocks = ICON_BLOCKS.filter((id) => blockAvailable(id));
    const items = ICON_ITEMS.filter((id) => hasItem(id));
    const upload = allowUpload
      ? h(
          'div',
          { class: 'icon-picker__upload' },
          h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => { chosen = 'upload'; modal.close(); } }, 'Своя картинка…'),
          h('span', { class: 'text-muted', style: { fontSize: '12px' } }, 'PNG, JPG или WebP: обрежется до квадрата'),
        )
      : null;
    const content = manifest
      ? h('div', { class: 'icon-picker' }, upload, grid('Блоки', blocks.map((id) => `block:${id}`)), items.length > 0 ? grid('Предметы', items.map((id) => `item:${id}`)) : null)
      : h('div', { class: 'icon-picker' }, upload, h('p', { class: 'text-muted' }, 'Текстуры Minecraft ещё загружаются. Попробуйте через минуту.'));
    const modal = openModal({ title: 'Иконка сборки', content, wide: true, onClose: () => resolve(chosen) });
  });
}

/**
 * "Сменить картинку" of an instance (right click on it, as in Prism Launcher): a block or item, or a
 * picture file. Resolves with true when it changed.
 */
export async function changeInstanceIcon(instance) {
  const chosen = await pickIcon(instance.icon, { allowUpload: true });
  try {
    if (chosen === 'upload') {
      const [file] = await api.app.pickFiles({ title: 'Картинка для сборки', multiple: false, filters: [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      if (!file) return false;
      await api.instances.setIcon(instance.id, file);
      await refreshInstances();
      return true;
    }
    if (chosen) {
      await updateInstance(instance.id, { icon: chosen });
      return true;
    }
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
  return false;
}