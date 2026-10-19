import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { LOADER_LABELS } from '../core/content.js';
import { defaultHead, headFromSkin } from '../core/skinHead.js';
import { sfx } from '../core/sound.js';
import { store } from '../state/appStore.js';
import { playInstance, refreshInstances } from '../state/actions.js';
import { go } from '../core/nav.js';
import { confirmDialog, openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { createSegmented, loadingState } from '../components/controls.js';

const REFRESH_MS = 30 * 1000;
const KINDS = [
  { value: 'ms', label: 'Microsoft' },
  { value: 'ely', label: 'Ely.by' },
  { value: 'offline', label: 'Офлайн' },
];
const KIND_LABELS = Object.fromEntries(KINDS.map((kind) => [kind.value, kind.label]));
const ACCOUNT_KIND = { microsoft: 'ms', ely: 'ely', offline: 'offline' };

/**
 * Friends on the Amethyx server, like Essential: the list with who is online and what they play
 * on the left, the conversation on the right — messages, screenshots from the instances and
 * invites to play (with the instance's share code, so a friend gets the same mods in a click).
 */
export function createFriendsPage() {
  const state = { kind: 'ms', timer: 0, loading: false, data: null, chatWith: null, messages: [], more: false };
  const element = h('section', { class: 'page page--friends', 'aria-label': 'Друзья' });
  const body = h('div');
  const heads = new Map();

  // --- Left: add, requests, friends -------------------------------------------------------
  const nameInput = h('input', { class: 'input', type: 'text', maxlength: '16', placeholder: 'Ник друга', spellcheck: 'false' });
  const addButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => addFriend() }, 'Добавить');
  const kindControl = createSegmented({ options: KINDS, value: state.kind, onChange: (value) => { state.kind = value; } });
  nameInput.addEventListener('keydown', (event) => event.key === 'Enter' && addFriend());
  const meHost = h('div', { class: 'friends-me' });
  const incomingHost = h('div', { class: 'friends-list' });
  const outgoingHost = h('div', { class: 'friends-list' });
  const friendsHost = h('div', { class: 'friends-list' });
  const incomingBlock = h('div', { class: 'friends-block', hidden: true }, h('div', { class: 'friends-block__title' }, 'Заявки в друзья'), incomingHost);
  const outgoingBlock = h('div', { class: 'friends-block', hidden: true }, h('div', { class: 'friends-block__title' }, 'Ждут ответа'), outgoingHost);
  const sidebar = h(
    'aside',
    { class: 'surface friends-side' },
    meHost,
    h('div', { class: 'friends-add' }, kindControl.element, h('div', { class: 'friends-add__row' }, nameInput, addButton)),
    incomingBlock,
    h('div', { class: 'friends-block' }, h('div', { class: 'friends-block__title' }, 'Друзья'), friendsHost),
    outgoingBlock,
  );

  // --- Right: the conversation --------------------------------------------------------------
  const chatHead = h('div', { class: 'chat__head' });
  const chatLog = h('div', { class: 'chat__log' });
  const chatInput = h('textarea', { class: 'input chat__input', rows: '1', maxlength: '2000', placeholder: 'Сообщение…' });
  const sendButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => sendText() }, 'Отправить');
  const chatComposer = h(
    'div',
    { class: 'chat__composer' },
    h('button', { class: 'icon-button chat__tool', type: 'button', title: 'Отправить скриншот', onclick: () => pickScreenshot() }, icon('image')),
    h('button', { class: 'icon-button chat__tool', type: 'button', title: 'Пригласить играть', onclick: () => inviteDialog() }, icon('play')),
    chatInput,
    sendButton,
  );
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Enter is not a click: the send sound is played here (the button plays its own).
      if (chatInput.value.trim()) sfx('click');
      sendText();
    }
  });
  // Grows with the text up to five lines; the borders are outside scrollHeight.
  function fitInput() {
    chatInput.style.height = '';
    const height = Math.min(chatInput.scrollHeight + 4, 120);
    chatInput.style.height = `${Math.max(42, height)}px`;
    chatInput.style.overflowY = chatInput.scrollHeight + 4 > 120 ? 'auto' : 'hidden';
  }
  chatInput.addEventListener('input', fitInput);
  const chat = h('section', { class: 'surface chat' }, chatHead, chatLog, chatComposer);
  const layout = h('div', { class: 'friends-layout' }, sidebar, chat);

  element.append(
    h('header', { class: 'page-header' }, h('div', null, h('h1', { class: 'page-title' }, 'Друзья'), h('p', { class: 'page-subtitle' }, 'Пишите друзьям, делитесь скриншотами и зовите играть — всё в лаунчере.'))),
    body,
  );

  // --- Helpers ----------------------------------------------------------------------------------
  function headImage(user, size) {
    const image = h('img', { class: 'friend__img', width: size, height: size, alt: '' });
    const key = `${user.id}:${user.skin ?? ''}`;
    const cached = heads.get(key);
    if (cached) {
      image.src = cached;
    } else {
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

  function statusText(user) {
    if (!user.online) return 'Не в сети';
    const presence = user.presence;
    if (presence?.status !== 'playing') return 'В сети';
    const parts = [presence.instance, presence.minecraft ? `Minecraft ${presence.minecraft}${presence.loader && presence.loader !== 'vanilla' ? ` (${LOADER_LABELS[presence.loader] ?? presence.loader})` : ''}` : null, presence.server ? `на ${presence.server}` : null].filter(Boolean);
    return parts.length ? `Играет: ${parts.join(' · ')}` : 'Играет';
  }

  const dotClass = (user) => `friend__dot${user.online ? (user.presence?.status === 'playing' ? ' friend__dot--playing' : ' friend__dot--online') : ''}`;

  function findFriend(id) {
    return state.data?.friends.find((friend) => friend.id === id) ?? null;
  }

  /** The instance to play a friend's server or invite with: same version and loader first. */
  function instanceFor({ minecraft, loader }) {
    const { instances, settings } = store.get();
    return (
      instances.find((instance) => instance.minecraft === minecraft && instance.loader?.type === loader) ??
      instances.find((instance) => instance.minecraft === minecraft) ??
      instances.find((instance) => instance.id === settings?.selectedInstanceId) ??
      null
    );
  }

  async function act(work, success) {
    try {
      await work();
      if (success) toast(success, 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
    refresh();
  }

  // --- Left list ------------------------------------------------------------------------------
  function friendRow(user) {
    const unread = state.data?.unread?.[user.id] ?? 0;
    return h(
      'button',
      { class: `friend friend--button${state.chatWith === user.id ? ' friend--active' : ''}`, type: 'button', onclick: () => openChat(user.id) },
      h('span', { class: 'friend__head' }, headImage(user, 36), h('span', { class: dotClass(user) })),
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, user.name), h('span', { class: 'friend__status' }, statusText(user))),
      unread ? h('span', { class: 'friend__badge' }, String(unread)) : null,
    );
  }

  function requestRow(user, actions) {
    return h(
      'div',
      { class: 'friend friend--request' },
      h('span', { class: 'friend__head' }, headImage(user, 32)),
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, user.name), h('span', { class: 'friend__status' }, KIND_LABELS[user.ns])),
      h('span', { class: 'friend__actions' }, ...actions),
    );
  }

  function renderSide() {
    const data = state.data;
    meHost.replaceChildren(h('p', { class: 'text-soft' }, h('span', null, 'Вы:'), ' ', h('b', { 'data-i18n': 'off' }, data.me.name), ' · ', h('span', null, KIND_LABELS[data.me.ns])));
    const order = (user) => (user.online ? (user.presence?.status === 'playing' ? 0 : 1) : 2);
    const friends = [...data.friends].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    friendsHost.replaceChildren(...(friends.length ? friends.map(friendRow) : [h('p', { class: 'friends-empty' }, 'Пока никого. Добавьте друга по нику выше.')]));
    incomingBlock.hidden = data.incoming.length === 0;
    incomingHost.replaceChildren(
      ...data.incoming.map((user) =>
        requestRow(user, [
          h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => act(() => api.friends.answer(user.id, true), `${user.name} теперь в друзьях`) }, 'Принять'),
          h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => act(() => api.friends.answer(user.id, false)) }, 'Отклонить'),
        ]),
      ),
    );
    outgoingBlock.hidden = data.outgoing.length === 0;
    outgoingHost.replaceChildren(...data.outgoing.map((user) => requestRow(user, [h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => act(() => api.friends.answer(user.id, false)) }, 'Отменить')])));
  }

  // --- Conversation -------------------------------------------------------------------------
  function renderChatHead() {
    const friend = findFriend(state.chatWith);
    if (!friend) {
      chat.classList.add('chat--empty');
      chatHead.replaceChildren();
      chatLog.replaceChildren(h('div', { class: 'chat__placeholder' }, h('p', null, 'Выберите друга слева, чтобы написать ему.'), h('p', { class: 'text-muted' }, 'Можно отправить скриншот из игры или позвать играть на свой сервер.')));
      return;
    }
    chat.classList.remove('chat--empty');
    chatHead.replaceChildren(
      h('span', { class: 'friend__head' }, headImage(friend, 40), h('span', { class: dotClass(friend) })),
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, friend.name), h('span', { class: 'friend__status' }, statusText(friend))),
      h(
        'span',
        { class: 'friend__actions' },
        friend.online && friend.presence?.server ? h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => joinServer(friend.presence, friend.name) }, 'Зайти') : null,
        h('button', {
          class: 'icon-button',
          type: 'button',
          title: 'Удалить из друзей',
          onclick: async () => {
            if (await confirmDialog({ title: `Удалить ${friend.name} из друзей?`, message: 'Заявку можно будет отправить снова.', confirmLabel: 'Удалить', danger: true })) {
              state.chatWith = null;
              act(() => api.friends.remove(friend.id));
            }
          },
        }, icon('close')),
      ),
    );
  }

  /** Text with its http(s) links clickable (they open in the browser). */
  function linkify(text) {
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g)) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      const url = match[0];
      parts.push(h('a', { class: 'chat__link', href: '#', title: url, onclick: (event) => { event.preventDefault(); api.app.openExternal(url).catch(() => {}); } }, url));
      last = match.index + url.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  function timeLabel(stamp) {
    return new Date(stamp).toLocaleTimeString(document.documentElement.lang || 'ru', { hour: '2-digit', minute: '2-digit' });
  }

  function messageView(message) {
    const mine = message.from !== state.chatWith;
    let content;
    if (message.kind === 'image') {
      const image = h('img', { class: 'chat__image', alt: message.body?.caption ?? '' });
      if (message.body?.width && message.body?.height) image.style.aspectRatio = `${message.body.width} / ${message.body.height}`;
      api.friends.image(message.body?.imageId).then((url) => { image.src = url; }).catch(() => image.replaceWith(h('span', { class: 'text-muted' }, 'Картинка устарела (хранится 30 дней).')));
      image.addEventListener('click', () => image.src && openModal({ title: message.body?.caption || 'Скриншот', wide: true, content: h('img', { class: 'chat__image-full', src: image.src, alt: '' }) }));
      content = [image, message.body?.caption ? h('span', null, message.body.caption) : null];
    } else if (message.kind === 'invite') {
      const invite = message.body ?? {};
      const what = [invite.instance, invite.minecraft ? `Minecraft ${invite.minecraft}${invite.loader && invite.loader !== 'vanilla' ? ` (${LOADER_LABELS[invite.loader] ?? invite.loader})` : ''}` : null].filter(Boolean).join(' · ');
      // Old invites of the removed Amethyx tunnel carry `tunnel` instead of an address.
      const intoWorld = Boolean(invite.world || invite.tunnel);
      content = [
        h('b', null, intoWorld ? (mine ? 'Вы позвали в свой мир' : 'Зовёт в свой мир') : mine ? 'Вы позвали играть' : 'Зовёт играть'),
        what ? h('span', { 'data-i18n': 'off' }, what) : null,
        invite.server && !intoWorld ? h('span', { class: 'text-muted' }, `Сервер: ${invite.server}`) : null,
        mine ? null : h('div', { class: 'chat__invite-actions' }, h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => acceptInvite(invite) }, intoWorld ? 'Зайти в мир' : invite.code ? 'Собрать и играть' : 'Играть')),
      ];
    } else {
      content = [h('span', { class: 'chat__text', 'data-i18n': 'off' }, ...linkify(String(message.body ?? '')))];
    }
    return h(
      'div',
      { class: `chat__message${mine ? ' chat__message--mine' : ''}${message.kind !== 'text' ? ` chat__message--${message.kind}` : ''}` },
      h('div', { class: 'chat__bubble' }, ...content.filter(Boolean)),
      h('span', { class: 'chat__time' }, timeLabel(message.createdAt), mine && message.readAt ? ' ✓✓' : ''),
    );
  }

  function renderMessages({ keepScroll = false } = {}) {
    if (!findFriend(state.chatWith)) return;
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    const nodes = state.messages.map(messageView);
    if (state.more) nodes.unshift(h('button', { class: 'btn btn--ghost btn--compact chat__more', type: 'button', onclick: () => loadOlder() }, 'Раньше'));
    if (!nodes.length) nodes.push(h('div', { class: 'chat__placeholder' }, h('p', { class: 'text-muted' }, 'Сообщений пока нет. Напишите первым!')));
    chatLog.replaceChildren(...nodes);
    if (!keepScroll || atBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function openChat(friendId) {
    state.chatWith = friendId;
    state.messages = [];
    state.more = false;
    renderSide();
    renderChatHead();
    chatLog.replaceChildren(h('div', { class: 'chat__placeholder' }, h('p', { class: 'text-muted' }, 'Загрузка…')));
    try {
      const page = await api.friends.messages(friendId);
      if (state.chatWith !== friendId) return;
      state.messages = page.messages;
      state.more = page.more;
      renderMessages();
      if (state.data?.unread?.[friendId]) {
        delete state.data.unread[friendId];
        renderSide();
        api.friends.markRead(friendId).catch(() => {});
      }
      chatInput.focus();
    } catch (error) {
      chatLog.replaceChildren(h('div', { class: 'chat__placeholder' }, h('p', { class: 'text-danger' }, errorMessage(error))));
    }
  }

  async function loadOlder() {
    const first = state.messages[0];
    if (!first) return;
    const height = chatLog.scrollHeight;
    const page = await api.friends.messages(state.chatWith, first.id).catch(() => null);
    if (!page) return;
    state.messages = [...page.messages, ...state.messages];
    state.more = page.more;
    renderMessages({ keepScroll: true });
    chatLog.scrollTop = chatLog.scrollHeight - height;
  }

  function pushMessage(message) {
    if (state.messages.some((existing) => existing.id === message.id)) return;
    state.messages.push(message);
    renderMessages({ keepScroll: true });
  }

  async function sendText() {
    const text = chatInput.value.trim();
    if (!text || !state.chatWith) return;
    sendButton.disabled = true;
    try {
      const { message } = await api.friends.sendText(state.chatWith, text);
      chatInput.value = '';
      fitInput();
      pushMessage(message);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      sendButton.disabled = false;
      chatInput.focus();
    }
  }

  async function pickScreenshot() {
    if (!state.chatWith) return;
    const grid = h('div', { class: 'shot-picker' }, h('p', { class: 'text-muted' }, 'Загрузка…'));
    const modal = openModal({ title: 'Отправить скриншот', wide: true, content: grid });
    try {
      const shots = await api.friends.screenshots();
      if (!shots.length) {
        grid.replaceChildren(h('p', { class: 'text-muted' }, 'Скриншотов пока нет. В игре нажмите F2 — снимок появится здесь.'));
        return;
      }
      grid.replaceChildren(
        ...shots.map((shot) =>
          h(
            'button',
            {
              class: 'shot-picker__item',
              type: 'button',
              title: shot.instanceName,
              onclick: async () => {
                modal.close();
                const friendId = state.chatWith;
                toast('Отправляем скриншот…', 'info', 2000);
                try {
                  const { message } = await api.friends.sendScreenshot(friendId, shot.instanceId, shot.name, '');
                  if (state.chatWith === friendId) pushMessage(message);
                } catch (error) {
                  toast(errorMessage(error), 'error');
                }
              },
            },
            h('img', { src: `app://instance/${encodeURIComponent(shot.instanceId)}/screenshots/${encodeURIComponent(shot.name)}`, alt: '', loading: 'lazy' }),
            h('span', { 'data-i18n': 'off' }, shot.instanceName),
          ),
        ),
      );
    } catch (error) {
      grid.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  function inviteDialog() {
    const friendId = state.chatWith;
    const { instances, settings } = store.get();
    if (!friendId) return;
    if (!instances.length) {
      toast('Сначала создайте сборку на вкладке «Сборки».', 'error');
      return;
    }
    const select = h('select', { class: 'select' }, ...instances.map((instance) => h('option', { value: instance.id, selected: instance.id === settings?.selectedInstanceId }, `${instance.name} · ${instance.minecraft}`)));
    const serverInput = h('input', { class: 'input', type: 'text', placeholder: 'mc.example.org (необязательно)', spellcheck: 'false' });
    const withPack = h('input', { type: 'checkbox', checked: true });
    const sendInvite = h('button', { class: 'btn btn--primary btn--compact', type: 'button' }, 'Пригласить');
    // "Into my world": the world opened to LAN gets a public address from the e4mc mod.
    const worldStatus = h('p', { class: 'text-soft' }, 'Проверяем мир…');
    const worldPanel = h(
      'div',
      { class: 'modal__section' },
      worldStatus,
      h('p', { class: 'skin-note' }, 'Друг заходит так же, как вы: если вы играете с лицензией Microsoft, другу тоже нужен Microsoft; с Ely.by — Ely.by. В офлайн-мир может зайти любой.'),
    );
    const serverPanel = h(
      'div',
      { class: 'modal__section', hidden: true },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Сборка'), select),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Сервер'), serverInput),
    );
    let mode = 'world';
    let worldReady = false;
    const modeControl = createSegmented({
      options: [{ value: 'world', label: 'В мой мир' }, { value: 'server', label: 'На сервер' }],
      value: mode,
      onChange: (value) => {
        mode = value;
        worldPanel.hidden = value !== 'world';
        serverPanel.hidden = value !== 'server';
        sendInvite.disabled = value === 'world' && !worldReady;
      },
    });
    api.friends
      .hostStatus()
      .then((status) => {
        worldReady = status?.kind === 'ready';
        if (!status) worldStatus.textContent = 'Сначала запустите игру и откройте мир: Esc → «Открыть для сети» → «Открыть мир для сети».';
        else if (status.kind === 'ready') worldStatus.textContent = `Мир открыт для друзей: ${status.address}`;
        else if (status.kind === 'vanilla') worldStatus.textContent = 'В сборке без модов позвать друга через интернет нельзя. Играйте в сборке с Fabric, Forge, NeoForge или Quilt — лаунчер сам поставит мод e4mc.';
        else worldStatus.textContent = 'Откройте мир: в игре нажмите Esc → «Открыть для сети» → «Открыть мир для сети». Через пару секунд мир получит адрес для друзей.';
        sendInvite.disabled = mode === 'world' && !worldReady;
      })
      .catch(() => {
        worldStatus.textContent = 'Не удалось проверить мир.';
      });
    sendInvite.addEventListener('click', async () => {
      sendInvite.disabled = true;
      try {
        const { message } = await api.friends.sendInvite(friendId, { instanceId: select.value, server: serverInput.value.trim(), withPack: withPack.checked, world: mode === 'world' });
        modal.close();
        if (state.chatWith === friendId) pushMessage(message);
        toast('Приглашение отправлено', 'success');
      } catch (error) {
        toast(errorMessage(error), 'error');
        sendInvite.disabled = false;
      }
    });
    const modal = openModal({
      title: 'Позвать играть',
      content: h(
        'div',
        { class: 'modal__section' },
        modeControl.element,
        worldPanel,
        serverPanel,
        h('label', { class: 'compat-dialog__remember' }, withPack, h('span', null, 'Приложить сборку: друг соберёт такую же одной кнопкой')),
      ),
      footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), sendInvite],
    });
    sendInvite.disabled = true;
  }

  async function joinServer(presence, name) {
    const instance = instanceFor(presence);
    if (!instance) {
      toast('Сначала создайте сборку на вкладке «Сборки».', 'error');
      return;
    }
    const message =
      instance.minecraft === presence.minecraft
        ? `Сервер ${presence.server}, сборка «${instance.name}» (Minecraft ${instance.minecraft}).`
        : `Сервер ${presence.server}, сборка «${instance.name}» (Minecraft ${instance.minecraft}). У друга Minecraft ${presence.minecraft}: если сервер не пустит, создайте сборку этой версии.`;
    if (await confirmDialog({ title: `Зайти к ${name}?`, message, confirmLabel: 'Играть' })) {
      playInstance(instance.id, presence.server ? { server: presence.server } : {});
    }
  }

  /**
   * "Into my world": the friend's world has an e4mc address. With the game already running, the
   * address is shown for "Direct connection"; otherwise a matching instance (or the friend's one,
   * built from its code) starts and joins at once.
   */
  async function joinFriendWorld(invite) {
    const address = invite.server;
    if (!address) {
      toast('Это приглашение устарело: попросите друга позвать вас ещё раз.', 'info', 6000);
      return;
    }
    if (store.get().game?.state === 'running') {
      const field = h('input', { class: 'input mono', readonly: true, value: address });
      openModal({
        title: 'Адрес мира друга',
        content: h(
          'div',
          { class: 'modal__section' },
          h('p', { class: 'text-soft' }, 'Игра уже запущена: в ней откройте «Сетевая игра» → «Прямое подключение» и вставьте адрес.'),
          field,
          h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => navigator.clipboard.writeText(address).then(() => toast('Адрес скопирован', 'success')) }, 'Копировать'),
        ),
      });
      return;
    }
    let instance = instanceFor(invite);
    const exact = instance && instance.minecraft === invite.minecraft && (instance.loader?.type ?? 'vanilla') === (invite.loader ?? 'vanilla');
    if (!exact && invite.code) {
      const build = await confirmDialog({ title: `Собрать «${invite.instance ?? 'сборку'}»?`, message: 'У вас нет такой сборки. Лаунчер соберёт сборку друга с теми же модами и сразу зайдёт в мир.', confirmLabel: 'Собрать' });
      if (!build) return;
      try {
        toast('Собираем сборку друга…', 'info', 3000);
        ({ instance } = await api.share.importCode(invite.code, {}));
        await refreshInstances();
      } catch (error) {
        toast(errorMessage(error), 'error');
        return;
      }
    }
    if (!instance) {
      toast('Сначала создайте сборку на вкладке «Сборки».', 'error');
      return;
    }
    playInstance(instance.id, { server: address });
  }

  /** An invite: build the friend's instance from its code (or use a matching one), then play. */
  async function acceptInvite(invite) {
    if (invite.world || invite.tunnel) {
      joinFriendWorld(invite);
      return;
    }
    if (!invite.code) {
      if (invite.server) joinServer(invite, 'другу');
      else toast('В приглашении нет сервера: договоритесь, куда заходить.', 'info');
      return;
    }
    const confirmed = await confirmDialog({
      title: `Собрать «${invite.instance ?? 'сборку'}»?`,
      message: `Лаунчер создаст такую же сборку (Minecraft ${invite.minecraft ?? '?'}) с теми же модами${invite.server ? ` и зайдёт на ${invite.server}` : ''}.`,
      confirmLabel: 'Собрать',
    });
    if (!confirmed) return;
    try {
      toast('Собираем сборку друга…', 'info', 3000);
      const { instance, failed } = await api.share.importCode(invite.code, {});
      await refreshInstances();
      if (failed.length) toast(`Не удалось поставить: ${failed.length}`, 'info', 6000);
      playInstance(instance.id, invite.server ? { server: invite.server } : {});
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  // --- Loading -------------------------------------------------------------------------------
  function showMessage(title, text, action = null) {
    body.replaceChildren(h('div', { class: 'surface friends-card friends-empty' }, h('h2', { class: 'section-title' }, title), h('p', null, text), action));
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    // The first time the server may take a while: say so instead of an empty page.
    if (!state.data && body.firstChild !== layout) body.replaceChildren(loadingState('Загружаем друзей…'));
    try {
      const status = await api.friends.status();
      if (!status.enabled) {
        showMessage('Онлайн-функции выключены', 'Друзья и общие скины работают через сервер Amethyx. Включите их в настройках.', h('button', { class: 'btn btn--primary', type: 'button', onclick: () => go('settings') }, 'Открыть настройки'));
        return;
      }
      if (!status.available) {
        showMessage('Скоро', 'Друзья работают через сервер Amethyx, а он ещё не подключён. Скины и плащи Amethyx уже можно сохранять — друзья увидят их, когда сервер заработает.');
        return;
      }
      if (!store.get().selectedAccountId) {
        showMessage('Нет аккаунта', 'Добавьте аккаунт, чтобы дружить в Amethyx.');
        return;
      }
      const first = !state.data;
      state.data = await api.friends.list();
      if (body.firstChild !== layout) body.replaceChildren(layout);
      if (state.chatWith && !findFriend(state.chatWith)) state.chatWith = null;
      const account = store.get().accounts.find((candidate) => candidate.id === store.get().selectedAccountId);
      if (first && account && !nameInput.value) {
        state.kind = ACCOUNT_KIND[account.type] ?? 'ms';
        kindControl.setValue(state.kind);
      }
      renderSide();
      renderChatHead();
      if (first && !state.chatWith) renderChatHead();
    } catch (error) {
      showMessage('Не удалось загрузить друзей', errorMessage(error), h('button', { class: 'btn btn--primary', type: 'button', onclick: () => refresh() }, 'Ещё раз'));
    } finally {
      state.loading = false;
    }
  }

  async function addFriend() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    addButton.disabled = true;
    try {
      const result = await api.friends.request(state.kind, name);
      nameInput.value = '';
      toast(result.state === 'friends' ? `${result.user.name} теперь в друзьях` : `Заявка отправлена: ${result.user.name}`, 'success');
      refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      addButton.disabled = false;
    }
  }

  // Instant events from the server (cloudLive.js).
  api.events.onFriendEvent((event) => {
    const active = element.classList.contains('page--active');
    if (event.type === 'message') {
      const from = event.message.from;
      if (active && state.chatWith === from && !document.hidden) {
        pushMessage(event.message);
        api.friends.markRead(from).catch(() => {});
      } else if (state.data) {
        state.data.unread = { ...state.data.unread, [from]: (state.data.unread?.[from] ?? 0) + 1 };
        if (active) renderSide();
      }
      sfx('info');
    } else if (event.type === 'read' && state.chatWith === event.by) {
      state.messages = state.messages.map((message) => (message.from !== event.by && !message.readAt ? { ...message, readAt: Date.now() } : message));
      renderMessages({ keepScroll: true });
    } else if (event.type === 'open-chat') {
      go('friends');
      refresh().then(() => openChat(event.with));
    }
  });

  store.subscribe(['selectedAccountId'], () => {
    state.data = null;
    state.chatWith = null;
    api.friends.ping().catch(() => {});
    if (element.classList.contains('page--active')) refresh();
  });

  return {
    element,
    onShow: () => {
      refresh();
      clearInterval(state.timer);
      state.timer = setInterval(() => {
        if (element.classList.contains('page--active') && !document.hidden) refresh();
        else clearInterval(state.timer);
      }, REFRESH_MS);
    },
  };
}
