'use strict';

const { getMainWindow } = require('../window');
const { showNotice } = require('../notice');
const { showWindow } = require('../tray');
const { broadcast } = require('../core/broadcast');
const { createLogger } = require('../core/logger');
const { CHANNELS } = require('../../shared/channels');
const { getSettings } = require('../settings/settingsService');
const { loadAccountStore } = require('../accounts/accountStore');
const { serverUrl, callAs } = require('./cloudClient');

/*
 * News from the Amethyx server for the selected account: new messages and read marks. The server
 * lives on ordinary hosting that cannot hold a connection open, so the launcher asks it every few
 * seconds (GET /v1/updates?since=…) and a little less often while it does not answer. Events go to
 * the window; when the window is not in focus Amethyx's own notice card (notice.js) shows the message.
 */

const EVERY_MS = 6000;
const MAX_PAUSE_MS = 2 * 60 * 1000;
const log = createLogger('live');
let accountId = null;
let timer = null;
let pause = EVERY_MS;
let stopped = true;
/** Server time of the last answer: the next one brings only what came after it. */
let since = 0;
let failing = false;

function mainWindow() {
  return getMainWindow();
}

function preview(message) {
  if (message.kind === 'image') return message.body?.caption ? `Скриншот: ${message.body.caption}` : 'Скриншот';
  if (message.kind === 'invite') {
    if (message.body?.kind === 'server') return 'Зовёт на свой сервер';
    if (message.body?.world) return 'Зовёт в свой мир';
    if (message.body?.kind === 'pack') return `Делится сборкой: ${message.body?.instance ?? 'сборка'}`;
    return message.body?.server ? `Зовёт играть на ${message.body.server}` : `Зовёт играть: ${message.body?.instance ?? 'сборка'}`;
  }
  return String(message.body ?? '').slice(0, 140);
}

function onEvent(event) {
  broadcast(CHANNELS.events.friendEvent, event);
  if (event.type !== 'message') return;
  const window = mainWindow();
  if (window?.isFocused()) return;
  // During a game the panel over it answers (main/overlay.js): the card says which keys open it.
  const overlay = require('../overlay');
  if (overlay.isOpen()) return;
  const key = overlay.overlayKey();
  // Amethyx's own card in the corner of the screen (main/notice.js), not a Windows toast.
  showNotice({
    title: key ? `${event.from?.name ?? 'Amethyx'} · ${key} — ответить` : event.from?.name ?? 'Amethyx',
    text: preview(event.message),
    onClick: () => {
      if (key) {
        overlay.show();
        return;
      }
      if (!window || window.isDestroyed()) return;
      showWindow(window);
      broadcast(CHANNELS.events.friendEvent, { type: 'open-chat', with: event.message.from });
    },
  });
}

function schedule(delay) {
  if (stopped) return;
  clearTimeout(timer);
  timer = setTimeout(poll, delay);
}

/** No server or no account right now: asked again this much later (one may be added meanwhile). */
const IDLE_MS = 30 * 1000;

async function poll() {
  timer = null;
  let next = pause;
  try {
    const settings = await getSettings();
    const { selectedId } = await loadAccountStore();
    if (!serverUrl(settings) || !selectedId) {
      next = IDLE_MS;
    } else {
      if (selectedId !== accountId) {
        accountId = selectedId;
        since = 0;
      }
      const answer = await callAs(selectedId, 'GET', `/v1/updates?since=${since}`);
      if (!stopped && selectedId === accountId) {
        // The first answer only sets the clock: what came before was seen in the chat lists already.
        if (since) (answer?.events ?? []).forEach(onEvent);
        since = Number(answer?.now) || since;
      }
      pause = EVERY_MS;
      next = pause;
      if (failing) log.info('Сервер Amethyx снова отвечает');
      failing = false;
    }
  } catch (error) {
    if (!failing) log.warn(`Новости с сервера Amethyx не пришли: ${error.message}`);
    failing = true;
    pause = Math.min(pause * 2, MAX_PAUSE_MS);
    next = pause;
  }
  schedule(next);
}

/** Starts (or, after an account switch or a settings change, restarts) asking for news. */
function startLive() {
  stopped = false;
  pause = EVERY_MS;
  accountId = null;
  since = 0;
  schedule(0);
}

function stopLive() {
  stopped = true;
  clearTimeout(timer);
  timer = null;
}

/** After switching accounts: the news follow the selected account. */
async function followAccount() {
  const { selectedId } = await loadAccountStore().catch(() => ({ selectedId: null }));
  if (stopped || selectedId === accountId) return;
  startLive();
}

module.exports = { startLive, stopLive, followAccount };
