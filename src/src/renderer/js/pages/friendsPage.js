import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { LOADER_LABELS } from '../core/content.js';
import { iconImage } from '../core/mc.js';
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
// Instances built from a friend's code, by the code: the second click plays instead of building again.
const BUILT_KEY = 'friends.builtCodes';
const UPLOAD_LABEL = 'Моды не с Modrinth и CurseForge загрузить на сервер Amethyx, чтобы они передались вместе с кодом';

function codeKey(code) {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) hash = Math.imul(hash ^ code.charCodeAt(index), 16777619);
  return `${(hash >>> 0).toString(36)}.${code.length.toString(36)}`;
}

function readBuilt() {
  try {
    return JSON.parse(localStorage.getItem(BUILT_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** The instance once built from this code, while it still exists. */
function builtInstance(code) {
  const id = code ? readBuilt()[codeKey(code)] : null;
  return id ? store.get().instances.find((instance) => instance.id === id) ?? null : null;
}

function rememberBuilt(code, instanceId) {
  const built = readBuilt();
  built[codeKey(code)] = instanceId;
  try {
    localStorage.setItem(BUILT_KEY, JSON.stringify(built));
  } catch {
    // Not remembered: the next click builds again.
  }
}

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
  const nameInput = h('input', { class: 'input', type: 'text', maxlength: '25', placeholder: 'Ник друга', spellcheck: 'false' });
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
    h('button', { class: 'icon-button chat__tool', type: 'button', title: 'Поделиться сборкой', onclick: () => sharePackDialog() }, icon('cube')),
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
  /** The name friends use: an offline player whose name was taken has a code after it ("Steve#3fa1"). */
  function nameOf(user) {
    return user.tag ? `${user.name}#${user.tag}` : user.name;
  }

  function friendRow(user) {
    const unread = state.data?.unread?.[user.id] ?? 0;
    return h(
      'button',
      { class: `friend friend--button${state.chatWith === user.id ? ' friend--active' : ''}`, type: 'button', onclick: () => openChat(user.id) },
      h('span', { class: 'friend__head' }, headImage(user, 36), h('span', { class: dotClass(user) })),
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, nameOf(user)), h('span', { class: 'friend__status' }, statusText(user))),
      unread ? h('span', { class: 'friend__badge' }, String(unread)) : null,
    );
  }

  function requestRow(user, actions) {
    return h(
      'div',
      { class: 'friend friend--request' },
      h('span', { class: 'friend__head' }, headImage(user, 32)),
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, nameOf(user)), h('span', { class: 'friend__status' }, KIND_LABELS[user.ns])),
      h('span', { class: 'friend__actions' }, ...actions),
    );
  }

  function renderSide() {
    const data = state.data;
    meHost.replaceChildren(
      h('p', { class: 'text-soft' }, h('span', null, 'Вы:'), ' ', h('b', { 'data-i18n': 'off' }, nameOf(data.me)), ' · ', h('span', null, KIND_LABELS[data.me.ns])),
      // A popular offline name (Steve, Alex…) was taken before: friends need the code too.
      ...(data.me.tag ? [h('p', { class: 'text-muted friends-tag-note' }, `Ник ${data.me.name} уже был занят, поэтому у вас есть код. Друзья добавляют вас так: ${nameOf(data.me)}`)] : []),
    );
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
      h('span', { class: 'friend__text' }, h('b', { 'data-i18n': 'off' }, nameOf(friend)), h('span', { class: 'friend__status' }, statusText(friend))),
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
      content = [inviteCard(message.body ?? {}, mine)];
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

  /** What an invite is: 'world', 'server' (the friend's own), 'play' (an address) or 'pack' (only the instance). */
  function inviteKind(invite) {
    if (invite.kind) return invite.kind;
    if (invite.world || invite.tunnel) return 'world';
    if (invite.server) return 'play';
    return invite.code ? 'pack' : 'play';
  }

  const INVITE_TITLES = {
    world: ['Вы позвали в свой мир', 'Зовёт в свой мир'],
    server: ['Вы позвали на свой сервер', 'Зовёт на свой сервер'],
    play: ['Вы позвали играть', 'Зовёт играть'],
    pack: ['Вы поделились сборкой', 'Делится сборкой'],
  };

  /**
   * An invite as a card: the instance's picture, name and version, and what it leads to. The main
   * button builds the instance when needed and joins at once ("Зайти"), the second only builds it;
   * while it builds, "Прервать" stops it. A shared instance is only built; once built it plays.
   */
  function inviteCard(invite, mine) {
    const kind = inviteKind(invite);
    const built = builtInstance(invite.code);
    const version = invite.minecraft ? `Minecraft ${invite.minecraft}${invite.loader && invite.loader !== 'vanilla' ? ` · ${LOADER_LABELS[invite.loader] ?? invite.loader}` : ''}` : null;
    const actions = h('div', { class: 'chat__invite-actions' });
    const progress = h('div', { class: 'invite-card__progress', hidden: true });
    if (!mine) {
      const joins = kind !== 'pack';
      let label = joins ? 'Зайти' : 'Играть';
      if (!built && invite.code) label = joins ? 'Собрать и зайти' : 'Собрать';
      const main = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => acceptInvite(invite, { main, extra, progress, buildOnly: false }) }, joins ? icon('play') : null, label);
      // "Только собрать": the instance without joining (the player starts it later).
      const extra = joins && invite.code && !built ? h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => acceptInvite(invite, { main, extra, progress, buildOnly: true }) }, 'Только собрать') : null;
      actions.append(main, ...(extra ? [extra] : []));
    }
    return h(
      'div',
      { class: `invite-card invite-card--${kind}` },
      h('div', { class: 'invite-card__head' }, h('b', null, INVITE_TITLES[kind]?.[mine ? 0 : 1] ?? INVITE_TITLES.play[mine ? 0 : 1])),
      h(
        'div',
        { class: 'invite-card__body' },
        iconImage(invite.icon || 'block:grass_block', 'invite-card__icon'),
        h(
          'span',
          { class: 'invite-card__text' },
          h('b', { 'data-i18n': 'off' }, invite.instance || 'Сборка'),
          version ? h('span', { class: 'text-muted' }, version) : null,
          kind === 'play' && invite.server ? h('span', { class: 'text-muted' }, `Сервер: ${invite.server}`) : null,
          built ? h('span', { class: 'invite-card__built' }, 'Сборка уже есть') : null,
        ),
      ),
      mine ? null : actions,
      progress,
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
    const instanceSelect = () => h('select', { class: 'select' }, ...instances.map((instance) => h('option', { value: instance.id, selected: instance.id === settings?.selectedInstanceId }, `${instance.name} · ${instance.minecraft}`)));
    const select = instanceSelect();
    const ownSelect = instanceSelect();
    const serverInput = h('input', { class: 'input', type: 'text', placeholder: 'mc.example.org', spellcheck: 'false' });
    // The instance goes with the invite (its code) unless turned off in Settings: the friend builds it and joins in one click.
    const social = settings?.social ?? {};
    const upload = h('input', { type: 'checkbox', checked: social.inviteUpload !== 'never' });
    const sendInvite = h('button', { class: 'btn btn--primary btn--compact', type: 'button' }, 'Пригласить');
    // "В мой мир": the world opened to LAN, through the Amethyx tunnel (any instance, vanilla too).
    const worldStatus = h('p', { class: 'text-soft' }, 'Проверяем мир…');
    const worldPanel = h(
      'div',
      { class: 'modal__section' },
      worldStatus,
      h('p', { class: 'skin-note' }, 'Друг заходит так же, как вы: если вы играете с лицензией Microsoft, другу тоже нужен Microsoft; с Ely.by — Ely.by. В офлайн-мир может зайти любой.'),
    );
    // "На мой сервер": the own server of an instance, through its tunnel.
    const ownPanel = h(
      'div',
      { class: 'modal__section', hidden: true },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Сервер какой сборки'), ownSelect),
      h('p', { class: 'skin-note' }, 'Сервер создаётся на вкладке сборки «Серверы» → «Свой сервер». Друг зайдёт, когда сервер запущен.'),
    );
    const serverPanel = h(
      'div',
      { class: 'modal__section', hidden: true },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Сборка'), select),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Адрес сервера'), serverInput),
    );
    let mode = 'world';
    let worldReady = false;
    const refreshButton = () => {
      sendInvite.disabled = (mode === 'world' && !worldReady) || (mode === 'server' && !serverInput.value.trim());
    };
    serverInput.addEventListener('input', refreshButton);
    const modeControl = createSegmented({
      options: [{ value: 'world', label: 'В мой мир' }, { value: 'own', label: 'На мой сервер' }, { value: 'server', label: 'По адресу' }],
      value: mode,
      onChange: (value) => {
        mode = value;
        worldPanel.hidden = value !== 'world';
        ownPanel.hidden = value !== 'own';
        serverPanel.hidden = value !== 'server';
        refreshButton();
      },
    });
    api.friends
      .hostStatus()
      .then((status) => {
        worldReady = status?.kind === 'ready';
        if (!status) worldStatus.textContent = 'Сначала запустите игру и откройте мир: Esc → «Открыть для сети» → «Открыть мир для сети».';
        else if (status.kind === 'ready') worldStatus.textContent = `Мир открыт. Друг зайдёт через туннель Amethyx — без белого IP и настройки роутера.${status.address ? ` Адрес для друзей с другим лаунчером: ${status.address}` : ''}`;
        else worldStatus.textContent = 'Откройте мир: в игре нажмите Esc → «Открыть для сети» → «Открыть мир для сети».';
        refreshButton();
      })
      .catch(() => {
        worldStatus.textContent = 'Не удалось проверить мир.';
      });
    sendInvite.addEventListener('click', async () => {
      sendInvite.disabled = true;
      try {
        const { message, uploadError } = await api.friends.sendInvite(friendId, {
          instanceId: mode === 'own' ? ownSelect.value : select.value,
          server: mode === 'server' ? serverInput.value.trim() : '',
          withPack: social.inviteWithPack !== false,
          upload: upload.checked,
          world: mode === 'world',
          ownServer: mode === 'own',
        });
        modal.close();
        if (state.chatWith === friendId) pushMessage(message);
        toast('Приглашение отправлено', 'success');
        if (uploadError) toast(`Моды не загрузились, сборка ушла без них: ${uploadError}`, 'info', 8000);
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
        ownPanel,
        serverPanel,
        // Asked here only when Settings say "Спрашивать"; otherwise the setting decides.
        social.inviteUpload === 'ask' && social.inviteWithPack !== false ? h('label', { class: 'share-upload' }, upload, h('span', null, UPLOAD_LABEL)) : null,
      ),
      footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), sendInvite],
    });
    sendInvite.disabled = true;
  }

  /** "Поделиться сборкой": any instance goes into the chat with its code; the friend builds it in one click. */
  function sharePackDialog() {
    const friendId = state.chatWith;
    const { instances } = store.get();
    if (!friendId) return;
    if (!instances.length) {
      toast('Сначала создайте сборку на вкладке «Сборки».', 'error');
      return;
    }
    const social = store.get().settings?.social ?? {};
    const upload = h('input', { type: 'checkbox', checked: social.inviteUpload !== 'never' });
    async function send(instance) {
      modal.close();
      toast('Отправляем сборку…', 'info', 2500);
      try {
        const { message, uploadError } = await api.friends.sendInvite(friendId, { instanceId: instance.id, withPack: true, upload: upload.checked });
        if (state.chatWith === friendId) pushMessage(message);
        if (uploadError) toast(`Моды не загрузились, сборка ушла без них: ${uploadError}`, 'info', 8000);
      } catch (error) {
        toast(errorMessage(error), 'error', 8000);
      }
    }
    const list = h(
      'div',
      { class: 'pack-picker' },
      ...instances.map((instance) =>
        h(
          'button',
          { class: 'pack-picker__item', type: 'button', onclick: () => send(instance) },
          iconImage(instance.icon, 'pack-picker__icon'),
          h(
            'span',
            { class: 'pack-picker__text' },
            h('b', { 'data-i18n': 'off' }, instance.name),
            h('span', { class: 'text-muted' }, `Minecraft ${instance.minecraft}${instance.loader?.type && instance.loader.type !== 'vanilla' ? ` · ${LOADER_LABELS[instance.loader.type] ?? instance.loader.type}` : ''}`),
          ),
        ),
      ),
    );
    const modal = openModal({
      title: 'Поделиться сборкой',
      wide: true,
      content: h('div', { class: 'modal__section' }, list, social.inviteUpload === 'ask' ? h('label', { class: 'share-upload' }, upload, h('span', null, UPLOAD_LABEL)) : null),
    });
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

  /** With the game already running, the friend's world address for "Direct connection". */
  function showWorldAddress(address) {
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
  }

  /**
   * Builds the friend's instance from the code, right in the chat: the card shows how it goes and
   * "Прервать" stops it (the half-built instance is removed). Null when it failed or was stopped.
   */
  async function buildFromCode(invite, controls = {}) {
    const { main, extra, progress } = controls;
    const jobId = `invite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const labels = { main: main?.textContent, extra: extra?.textContent };
    if (main) {
      main.disabled = true;
      main.textContent = 'Собираем…';
    }
    if (extra) {
      extra.textContent = 'Прервать';
      extra.onclick = () => {
        extra.disabled = true;
        extra.textContent = 'Останавливаем…';
        api.share.cancelImport(jobId).catch(() => {});
      };
    }
    if (progress) {
      progress.hidden = false;
      progress.textContent = 'Скачиваем моды и игру — прогресс вверху окна.';
    }
    try {
      const { instance, failed, filesError } = await api.share.importCode(invite.code, { icon: invite.icon ?? null, jobId });
      rememberBuilt(invite.code, instance.id);
      await refreshInstances();
      if (failed.length) toast(`Не удалось поставить: ${failed.length}`, 'info', 6000);
      if (filesError) toast(`Моды автора не скачались: ${filesError}`, 'info', 8000);
      return instance;
    } catch (error) {
      const stopped = /остановлена/i.test(errorMessage(error));
      toast(stopped ? 'Сборка остановлена' : errorMessage(error), stopped ? 'info' : 'error');
      renderMessages({ keepScroll: true });
      return null;
    } finally {
      if (progress) progress.hidden = true;
      if (main) {
        main.disabled = false;
        main.textContent = labels.main;
      }
      if (extra) {
        extra.disabled = false;
        extra.textContent = labels.extra;
      }
    }
  }

  /** Where to join for an invite: through the friend's tunnel, or its address. Null when nowhere. */
  async function inviteAddress(invite) {
    if (invite.tunnel) {
      const friend = findFriend(state.chatWith);
      return (await api.friends.joinTunnel(invite.tunnel, friend ? nameOf(friend) : '')).address;
    }
    return invite.server || null;
  }

  /**
   * One click on an invite or a shared instance: the friend's instance (built from its code the
   * first time, the same one later) starts and joins the world or server at once. `buildOnly` (or
   * Settings → "Приглашения друзей" → only build) stops after building. A shared instance is only
   * built; its button then says "Играть". Without a code, an instance of the same version plays.
   */
  async function acceptInvite(invite, controls = {}) {
    const kind = inviteKind(invite);
    const joins = kind !== 'pack';
    const buildOnly = controls.buildOnly || (joins && store.get().settings?.social?.acceptInvite === 'build' && !builtInstance(invite.code));
    if (joins && !invite.tunnel && !invite.server && kind === 'world') {
      toast('Это приглашение устарело: попросите друга позвать вас ещё раз.', 'info', 6000);
      return;
    }
    let instance = builtInstance(invite.code);
    if (!instance && invite.code) {
      instance = await buildFromCode(invite, controls);
      if (!instance) return;
      if (!joins || buildOnly) {
        toast(`Сборка «${instance.name}» готова`, 'success');
        renderMessages({ keepScroll: true });
        return;
      }
    }
    let address = null;
    if (joins) {
      try {
        address = await inviteAddress(invite);
      } catch (error) {
        toast(errorMessage(error), 'error', 8000);
        return;
      }
    }
    // The game already runs: the address for "Прямое подключение".
    if (address && store.get().game?.state === 'running') {
      showWorldAddress(address);
      return;
    }
    if (!instance) {
      if (!address) {
        toast('В приглашении нет сервера: договоритесь, куда заходить.', 'info');
        return;
      }
      instance = instanceFor(invite);
      if (!instance || instance.minecraft !== invite.minecraft) {
        joinServer({ ...invite, server: address }, 'другу');
        return;
      }
    }
    playInstance(instance.id, address ? { server: address } : {});
    renderMessages({ keepScroll: true });
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
      // "Name#code" is always an offline player, whatever kind is picked above.
      const result = await api.friends.request(name.includes('#') ? 'offline' : state.kind, name);
      nameInput.value = '';
      toast(result.state === 'friends' ? `${nameOf(result.user)} теперь в друзьях` : `Заявка отправлена: ${nameOf(result.user)}`, 'success');
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
