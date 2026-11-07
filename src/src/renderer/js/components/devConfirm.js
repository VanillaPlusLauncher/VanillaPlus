import { api } from '../services/api.js';
import { h } from '../core/dom.js';
import { openModal } from './modal.js';

/*
 * "Разрешить ИИ?": an AI tool (developer mode, main/dev/devGuard.js) wants to delete or change one of
 * the player's own instances. Nothing happens unless the player presses the button; closing the
 * window, "Отмена" or two minutes without an answer are a "no".
 */

function describe(request) {
  const name = h('b', { 'data-i18n': 'off' }, request.name);
  const detail = request.detail ? h('span', { class: 'mono', 'data-i18n': 'off' }, request.detail) : null;
  switch (request.action) {
    case 'delete':
      return { text: [h('span', null, 'ИИ хочет удалить вашу сборку'), ' ', name, '. ', h('span', null, 'Её миры, моды и настройки удалятся насовсем.')], button: 'Удалить', danger: true };
    case 'addMods':
      return { text: [h('span', null, 'ИИ хочет добавить моды в вашу сборку'), ' ', name, ': ', detail], button: 'Разрешить' };
    case 'removeMod':
      return { text: [h('span', null, 'ИИ хочет убрать мод из вашей сборки'), ' ', name, ': ', detail], button: 'Разрешить' };
    case 'writeFile':
      return { text: [h('span', null, 'ИИ хочет изменить файл в вашей сборке'), ' ', name, ': ', detail], button: 'Разрешить' };
    case 'stopGame':
      return { text: [h('span', null, 'ИИ хочет закрыть игру в вашей сборке'), ' ', name, '. ', h('span', null, 'Несохранённое в мире может пропасть.')], button: 'Закрыть игру', danger: true };
    default:
      return { text: [h('span', null, 'ИИ хочет изменить вашу сборку'), ' ', name, '.'], button: 'Разрешить' };
  }
}

/** Listens for the AI's requests for the whole life of the window (called once from app.js). */
export function setupDevConfirm() {
  const open = new Map();
  api.events.onDevConfirm((request) => {
    if (request.cancel) {
      // No answer in time: the launcher already said "no" for the player.
      open.get(request.id)?.close();
      return;
    }
    const { text, button, danger } = describe(request);
    let answered = false;
    const reply = (yes) => {
      if (answered) return;
      answered = true;
      open.delete(request.id);
      api.dev.answer(request.id, yes).catch(() => {});
    };
    const modal = openModal({
      title: 'Разрешить ИИ?',
      content: h('div', { style: { display: 'grid', gap: '10px' } },
        h('p', { class: 'text-soft' }, text),
        h('p', { class: 'settings-card__desc' }, 'Это просит программа, подключённая через режим разработчика. Если вы её не запускали, нажмите «Отмена».')),
      footer: [
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { reply(false); modal.close(); } }, 'Отмена'),
        h('button', { class: `btn btn--compact ${danger ? 'btn--secondary btn--danger' : 'btn--primary'}`, type: 'button', onclick: () => { reply(true); modal.close(); } }, button),
      ],
      onClose: () => reply(false),
    });
    open.set(request.id, modal);
  });
}
