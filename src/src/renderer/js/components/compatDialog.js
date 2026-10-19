import { api } from '../services/api.js';
import { h } from '../core/dom.js';
import { store } from '../state/appStore.js';
import { saveSettings } from '../state/actions.js';
import { openModal } from './modal.js';

/**
 * Asks before installing a mod that may not get along with the instance. Resolves with true when
 * the install should go on: no warnings, the check failed (it never blocks), or the user agreed.
 * Warnings can be silenced for good: one by one, or the whole check (Settings → Mods turns it back).
 */
export async function confirmCompatibility(request) {
  let warnings = [];
  try {
    warnings = await api.content.checkCompatibility(request);
  } catch {
    return true;
  }
  if (warnings.length === 0) {
    return true;
  }
  return new Promise((resolve) => {
    let answered = false;
    const remember = h('input', { type: 'checkbox' });
    const answer = async (install) => {
      if (answered) return;
      answered = true;
      if (install && remember.checked) {
        const compat = store.get().settings?.compat ?? {};
        await saveSettings({ compat: { ...compat, ignored: [...new Set([...(compat.ignored ?? []), ...warnings.map((warning) => warning.key)])] } }).catch(() => {});
      }
      modal.close();
      resolve(install);
    };
    const turnOff = async () => {
      const compat = store.get().settings?.compat ?? {};
      await saveSettings({ compat: { ...compat, warn: false } }).catch(() => {});
      answer(true);
    };
    const modal = openModal({
      title: warnings.length === 1 ? 'Возможен конфликт' : `Возможны конфликты (${warnings.length})`,
      wide: true,
      content: h(
        'div',
        { class: 'compat-dialog' },
        h('p', { class: 'text-soft' }, 'Лаунчер нашёл, что может помешать. Иногда это ложная тревога: если игра всё-таки запустится — просто играйте. Если вылетит, журнал покажет настоящую причину.'),
        h(
          'div',
          { class: 'problem-list' },
          warnings.map((warning) =>
            h('div', { class: 'problem-card' }, h('div', { class: 'problem-card__icon', 'aria-hidden': 'true' }, '!'), h('div', { class: 'problem-card__body' }, h('div', { class: 'problem-card__title' }, warning.title), h('div', { class: 'problem-card__detail' }, warning.detail))),
          ),
        ),
        h('label', { class: 'compat-dialog__remember' }, remember, h('span', null, 'Больше не предупреждать об этом')),
        h('button', { class: 'link-button compat-dialog__off', type: 'button', onclick: turnOff }, 'Не проверять совместимость вообще'),
      ),
      footer: [
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => answer(false) }, 'Отмена'),
        h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => answer(true) }, 'Установить всё равно'),
      ],
      onClose: () => answer(false),
    });
  });
}
