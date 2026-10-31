import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { assetUrl } from '../core/assets.js';
import { errorMessage } from '../core/format.js';
import { setLanguage } from '../core/i18n.js';
import { initMc } from '../core/mc.js';
import { defaultHead, headFromSkin } from '../core/skinHead.js';
import { configureSound, installGlobalSounds, sfx } from '../core/sound.js';
import { installClickSparks } from '../core/effects.js';

/*
 * The Amethyx panel over the game (main/overlay.js opens and hides its window): which instance is
 * played and whether its world is open, "Позвать в мир" with the friends right there, a short chat
 * with any friend and the last screenshot in one click. Esc, a click on the darkened game or the
 * same keys take it away. It reads everything fresh each time it opens.
 */

const KEY_LABELS = { 'Shift+Tab': 'Shift+Tab', 'Alt+X': 'Alt+X', F9: 'F9' };
const panel = document.getElementById('overlay-panel');
const dim = document.getElementById('overlay-dim');
const state = { info: null, friends: [], view: 'home', inviting: false, chatWith: null, messages: [], sent: new Set() };
const heads = new Map();

CSS.paintWorklet?.addModule(new URL('../core/pixelFrame.worklet.js', import.meta.url)).catch(() => {});

const nameOf = (user) => (user.tag ? `${user.name}#${user.tag}` : user.name);
const statusOf = (user) => (user.online ? (user.presence?.status === 'playing' ? 'Играет' : 'В сети') : 'Не в сети');
const dotClass = (user) => `friend__dot${user.online ? (user.presence?.status === 'playing' ? ' friend__dot--playing' : ' friend__dot--online') : ''}`;
const keyLabel = () => KEY_LABELS[state.info?.key] ?? 'Shift+Tab';

function head(user, size = 32) {
  const image = h('img', { class: 'friend__img', width: size, height: size, alt: '' });
  const key = `${user.id}:${user.skin ?? ''}`;
  if (heads.has(key)) image.src = heads.get(key);
  else {
    (user.skinBase64 ? headFromSkin(user.skinBase64, size) : defaultHead())
      .then((url) => {
        if (!url) return;
        heads.set(key, url);
        image.src = url;
      })
      .catch(() => {});
  }
  return image;
}

function close() {
  api.overlay.close().catch(() => {});
}

// --- Header and the world ---------------------------------------------------------------------------
function header() {
  const activity = state.info?.activity;
  return h(
    'header',
    { class: 'ov-head' },
    h('img', { class: 'ov-head__mark', src: assetUrl('branding/amethyx-mark.png'), alt: '' }),
    h(
      'div',
      { class: 'ov-head__text' },
      h('b', null, 'Amethyx'),
      activity ? h('span', { class: 'text-muted', 'data-i18n': 'off' }, `${activity.instanceName} · ${activity.minecraft}`) : h('span', { class: 'text-muted' }, 'Игра запускается…'),
    ),
    h('span', { class: 'ov-key', title: 'Открыть и закрыть панель' }, keyLabel()),
    h('button', { class: 'icon-button', type: 'button', title: 'Закрыть (Esc)', onclick: close }, icon('close')),
  );
}

function worldCard() {
  const world = state.info?.world;
  const server = state.info?.ownServer;
  const parts = [];
  if (world?.kind === 'ready') {
    parts.push(
      h('div', { class: 'ov-world__title' }, h('span', { class: 'ov-live' }), 'Мир открыт для друзей'),
      h('p', { class: 'text-muted' }, 'Друг зайдёт к вам напрямую: лаунчер сам откроет порт на роутере (нужны UPnP и «белый» адрес).'),
      h('button', {
        class: `btn ${state.inviting ? 'btn--secondary' : 'btn--primary'} ov-world__invite`,
        type: 'button',
        onclick: () => {
          state.inviting = !state.inviting;
          render();
        },
      }, state.inviting ? null : icon('user'), state.inviting ? 'Готово' : 'Позвать в мир'),
    );
  } else if (world?.kind === 'closed') {
    parts.push(
      h('div', { class: 'ov-world__title' }, 'Мир пока закрыт'),
      h('p', { class: 'text-muted' }, `Откройте его в игре: Esc → «Открыть для сети» → «Открыть мир для сети». Потом снова нажмите ${keyLabel()} — здесь появится «Позвать в мир».`),
    );
  } else {
    parts.push(h('div', { class: 'ov-world__title' }, 'Игра ещё загружается'), h('p', { class: 'text-muted' }, 'Когда войдёте в мир, здесь можно будет позвать друзей.'));
  }
  if (server?.running) {
    parts.push(
      h('button', {
        class: 'btn btn--secondary ov-world__server',
        type: 'button',
        onclick: () => {
          state.inviting = 'server';
          render();
        },
      }, 'Позвать на свой сервер'),
    );
  }
  return h('section', { class: 'ov-world' }, ...parts);
}

// --- Friends --------------------------------------------------------------------------------------
async function invite(friend, button) {
  button.disabled = true;
  button.textContent = 'Отправляем…';
  try {
    const social = state.info?.social ?? {};
    const toServer = state.inviting === 'server';
    await api.friends.sendInvite(friend.id, {
      instanceId: state.info.instanceId,
      world: !toServer,
      ownServer: toServer,
      withPack: social.inviteWithPack !== false,
      upload: social.inviteUpload !== 'never',
    });
    state.sent.add(friend.id);
    sfx('success');
    button.textContent = 'Позван';
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Позвать';
    notify(errorMessage(error));
  }
}

function friendRow(friend) {
  const inviting = Boolean(state.inviting);
  const action = inviting
    ? h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: state.sent.has(friend.id), onclick: (event) => invite(friend, event.currentTarget) }, state.sent.has(friend.id) ? 'Позван' : 'Позвать')
    : h('button', { class: 'icon-button', type: 'button', title: 'Написать', onclick: () => openChat(friend) }, icon('pencil'));
  return h(
    'div',
    { class: 'friend ov-friend' },
    h('span', { class: 'friend__head' }, head(friend), h('span', { class: dotClass(friend) })),
    h('button', { class: 'friend__text ov-friend__name', type: 'button', onclick: () => openChat(friend) }, h('b', { 'data-i18n': 'off' }, nameOf(friend)), h('span', { class: 'friend__status' }, statusOf(friend))),
    action,
  );
}

function friendsSection() {
  if (!state.friends.length) {
    return h('section', { class: 'ov-friends' }, h('div', { class: 'ov-section-title' }, 'Друзья'), h('p', { class: 'text-muted' }, 'Друзей пока нет: добавьте их в лаунчере, во вкладке «Друзья».'));
  }
  const order = (user) => (user.online ? (user.presence?.status === 'playing' ? 1 : 0) : 2);
  const friends = [...state.friends].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return h(
    'section',
    { class: 'ov-friends' },
    h('div', { class: 'ov-section-title' }, state.inviting ? (state.inviting === 'server' ? 'Кого позвать на сервер' : 'Кого позвать в мир') : 'Друзья'),
    h('div', { class: 'ov-friends__list' }, ...friends.map(friendRow)),
  );
}

// --- Chat -----------------------------------------------------------------------------------------
async function openChat(friend) {
  state.view = 'chat';
  state.chatWith = friend;
  state.messages = [];
  render();
  try {
    const page = await api.friends.messages(friend.id);
    if (state.chatWith?.id !== friend.id) return;
    state.messages = page.messages.slice(-40);
    renderChatLog();
    api.friends.markRead(friend.id).catch(() => {});
  } catch (error) {
    notify(errorMessage(error));
  }
}

function messageText(message) {
  if (message.kind === 'image') return 'Скриншот';
  if (message.kind === 'invite') return message.body?.kind === 'server' ? 'Приглашение на сервер' : message.body?.world ? 'Приглашение в мир' : `Сборка: ${message.body?.instance ?? ''}`;
  return String(message.body ?? '');
}

const chatLog = h('div', { class: 'ov-chat__log' });
function renderChatLog() {
  const friendId = state.chatWith?.id;
  chatLog.replaceChildren(
    ...(state.messages.length
      ? state.messages.map((message) =>
          h('div', { class: `ov-msg${message.from === friendId ? '' : ' ov-msg--mine'}${message.kind !== 'text' ? ' ov-msg--special' : ''}` }, h('span', { 'data-i18n': message.kind === 'text' ? 'off' : null }, messageText(message))),
        )
      : [h('p', { class: 'text-muted ov-chat__empty' }, 'Сообщений пока нет. Напишите первым!')]),
  );
  chatLog.scrollTop = chatLog.scrollHeight;
}

function chatView() {
  const friend = state.chatWith;
  const input = h('input', { class: 'input', type: 'text', maxlength: '2000', placeholder: 'Сообщение…', 'data-i18n-placeholder': null });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const { message } = await api.friends.sendText(friend.id, text);
      state.messages.push(message);
      renderChatLog();
    } catch (error) {
      notify(errorMessage(error));
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') send();
  });
  const shot = h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => sendScreenshot(friend, shot) }, icon('image'), 'Последний скриншот');
  setTimeout(() => input.focus(), 50);
  renderChatLog();
  return h(
    'section',
    { class: 'ov-chat' },
    h(
      'div',
      { class: 'ov-chat__head' },
      h('button', { class: 'icon-button ov-back', type: 'button', title: 'Назад', onclick: () => { state.view = 'home'; render(); } }, icon('chevron')),
      h('span', { class: 'friend__head' }, head(friend, 28), h('span', { class: dotClass(friend) })),
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, nameOf(friend)), h('span', { class: 'friend__status' }, statusOf(friend))),
    ),
    chatLog,
    h('div', { class: 'ov-chat__tools' }, shot),
    h('div', { class: 'ov-chat__composer' }, input, h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: send }, 'Отправить')),
  );
}

/** The newest screenshot of the instance being played (or of any), to the friend. */
async function sendScreenshot(friend, button) {
  button.disabled = true;
  try {
    const shots = await api.friends.screenshots();
    const shot = shots.find((candidate) => candidate.instanceId === state.info?.instanceId) ?? shots[0];
    if (!shot) {
      notify('Скриншотов пока нет: в игре нажмите F2.');
      return;
    }
    const { message } = await api.friends.sendScreenshot(friend.id, shot.instanceId, shot.name, '');
    state.messages.push(message);
    renderChatLog();
    sfx('success');
  } catch (error) {
    notify(errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

// --- Small notes at the bottom of the panel ----------------------------------------------------------
const note = h('div', { class: 'ov-note', hidden: true });
let noteTimer = 0;
function notify(text) {
  note.textContent = text;
  note.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note.hidden = true;
  }, 5000);
}

function render() {
  if (state.view === 'chat' && state.chatWith) {
    panel.replaceChildren(header(), chatView(), note);
    return;
  }
  panel.replaceChildren(header(), worldCard(), friendsSection(), note);
}

async function refresh() {
  try {
    state.info = await api.overlay.state();
  } catch {
    state.info = null;
  }
  const ui = state.info?.ui ?? {};
  document.documentElement.dataset.accent = ui.accent ?? 'amethyst';
  document.documentElement.dataset.font = ui.font ?? 'pixel';
  document.documentElement.dataset.style = ui.style ?? 'soft';
  document.documentElement.dataset.icons = ui.icons ?? 'color';
  document.documentElement.dataset.animations = ui.animations === false ? 'off' : 'on';
  render();
  try {
    const status = await api.friends.status();
    if (status.enabled && status.available) state.friends = (await api.friends.list()).friends;
  } catch {
    // Offline: the panel still tells about the world.
  }
  render();
}

api.events.onOverlay((event) => {
  if (event.open) {
    state.inviting = false;
    state.sent.clear();
    document.body.classList.add('is-open');
    refresh();
  } else {
    document.body.classList.remove('is-open');
  }
});

// A message from the friend whose chat is open shows at once.
api.events.onFriendEvent((event) => {
  if (event.type === 'message' && state.view === 'chat' && event.message.from === state.chatWith?.id) {
    state.messages.push(event.message);
    renderChatLog();
    api.friends.markRead(state.chatWith.id).catch(() => {});
  }
});

dim.addEventListener('click', close);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
});

(async () => {
  initMc().catch(() => {});
  installGlobalSounds();
  installClickSparks(() => true);
  try {
    const settings = await api.settings.get();
    configureSound(settings.sounds);
    await setLanguage(settings.ui?.language || 'ru');
  } catch {
    // Defaults: Russian, sounds as they are.
  }
  render();
})();
