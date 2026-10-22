import { api } from '../services/api.js';
import { h } from '../core/dom.js';
import { assetUrl } from '../core/assets.js';
import { errorMessage } from '../core/format.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { createSegmented } from './controls.js';

/**
 * Mods on neither Modrinth nor CurseForge (the player's own, a friend's): the launcher cannot tell
 * whether a server needs them, so it asks once, before a server gets its mods. A client-only mod on
 * a server can stop it from starting, so "Только у игроков" is the default unless the mod's own
 * file says it is for servers. The answers are kept in the instance (serverService.setModSides).
 * Resolves true when the server may go on (answered, or nothing to ask), false when cancelled.
 */
export async function askUnknownMods(instance) {
  let mods;
  try {
    mods = await api.server.unknownMods(instance.id);
  } catch {
    // Not known now (no network): unknown mods simply stay off the server.
    return true;
  }
  if (!mods.length) return true;
  return new Promise((resolve) => {
    const answers = new Map();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const switches = [];
    const rows = mods.map((mod) => {
      answers.set(mod.file, mod.guess === 'server' ? 'server' : 'client');
      const control = createSegmented({
        options: [
          { value: 'server', label: 'На сервер' },
          { value: 'client', label: 'Только у игроков' },
        ],
        value: answers.get(mod.file),
        onChange: (value) => answers.set(mod.file, value),
      });
      switches.push({ file: mod.file, control });
      return h(
        'div',
        { class: 'unknown-mods__row' },
        mod.icon ? h('img', { class: 'unknown-mods__icon', src: mod.icon, alt: '' }) : h('img', { class: 'unknown-mods__icon unknown-mods__icon--mark', src: assetUrl('branding/amethyx-mark.png'), alt: '' }),
        h('span', { class: 'unknown-mods__text' }, h('b', { 'data-i18n': 'off' }, mod.title), h('span', { class: 'text-muted mono', 'data-i18n': 'off' }, mod.file)),
        control.element,
      );
    });
    const all = (value) => {
      for (const { file, control } of switches) {
        answers.set(file, value);
        control.setValue(value);
      }
    };
    const doneButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => save() }, 'Готово');
    const modal = openModal({
      title: 'Эти моды нам не знакомы',
      wide: true,
      content: h(
        'div',
        { class: 'unknown-mods' },
        h('p', { class: 'text-soft' }, 'Их нет на Modrinth и CurseForge — возможно, вы сделали их сами или получили от друга. Скажите, нужны ли они серверу: моды с новыми блоками, предметами и мобами — нужны, а меню, миникарты и шейдеры — нет (серверу они только мешают запуститься). Лаунчер запомнит ответ.'),
        h('div', { class: 'unknown-mods__all' },
          h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => all('server') }, 'Все на сервер'),
          h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => all('client') }, 'Все только у игроков'),
        ),
        h('div', { class: 'unknown-mods__list' }, ...rows),
      ),
      footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), doneButton],
      onClose: () => finish(false),
    });

    async function save() {
      doneButton.disabled = true;
      try {
        await api.server.setModSides(instance.id, Object.fromEntries(answers));
        finish(true);
        modal.close();
      } catch (error) {
        toast(errorMessage(error), 'error');
        doneButton.disabled = false;
      }
    }
  });
}
