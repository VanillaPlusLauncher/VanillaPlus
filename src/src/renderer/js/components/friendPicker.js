import { api } from '../services/api.js';
import { h } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { defaultHead, headFromSkin } from '../core/skinHead.js';
import { sfx } from '../core/sound.js';
import { go } from '../core/nav.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { loadingState } from './controls.js';

const nameOf = (user) => (user.tag ? `${user.name}#${user.tag}` : user.name);

/**
 * "Пригласить друга": the friends, online ones first, each with one button. `send(friendId)` sends
 * the invite (it resolves when the message is in the chat); the button then says it went. Several
 * friends can be invited from the same window.
 */
export function openFriendPicker({ title = 'Пригласить друга', intro = null, actionLabel = 'Позвать', send }) {
  const list = h('div', { class: 'friend-picker' }, loadingState('Загружаем друзей…'));
  const modal = openModal({
    title,
    content: h('div', { class: 'modal__section' }, intro ? h('p', { class: 'text-soft' }, intro) : null, list),
    footer: [h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => modal.close() }, 'Готово')],
  });

  function head(user) {
    const image = h('img', { class: 'friend__img', width: 32, height: 32, alt: '' });
    (user.skinBase64 ? headFromSkin(user.skinBase64, 32) : defaultHead()).then((url) => url && (image.src = url)).catch(() => {});
    return image;
  }

  function row(user) {
    const button = h('button', {
      class: 'btn btn--primary btn--compact',
      type: 'button',
      onclick: async () => {
        button.disabled = true;
        button.textContent = 'Отправляем…';
        try {
          await send(user.id);
          sfx('success');
          button.textContent = 'Отправлено';
        } catch (error) {
          toast(errorMessage(error), 'error', 8000);
          button.disabled = false;
          button.textContent = actionLabel;
        }
      },
    }, actionLabel);
    const status = user.online ? (user.presence?.status === 'playing' ? 'Играет' : 'В сети') : 'Не в сети';
    return h(
      'div',
      { class: 'friend friend-picker__row' },
      h('span', { class: 'friend__head' }, head(user), h('span', { class: `friend__dot${user.online ? (user.presence?.status === 'playing' ? ' friend__dot--playing' : ' friend__dot--online') : ''}` })),
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, nameOf(user)), h('span', { class: 'friend__status' }, status)),
      button,
    );
  }

  (async () => {
    try {
      const status = await api.friends.status();
      if (!status.enabled || !status.available) {
        list.replaceChildren(h('p', { class: 'text-muted' }, 'Друзья выключены в настройках или сервер Amethyx недоступен.'));
        return;
      }
      const data = await api.friends.list();
      const order = (user) => (user.online ? (user.presence?.status === 'playing' ? 1 : 0) : 2);
      const friends = [...data.friends].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      list.replaceChildren(
        ...(friends.length
          ? friends.map(row)
          : [h('p', { class: 'text-muted' }, 'Пока нет друзей.'), h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => { modal.close(); go('friends'); } }, 'Добавить друга')]),
      );
    } catch (error) {
      list.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  })();
  return modal;
}
