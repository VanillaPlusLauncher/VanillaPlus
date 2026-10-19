'use strict';

const { getMainWindow } = require('../window');
const { showNotice } = require('../notice');
const { showWindow } = require('../tray');
const { broadcast } = require('../core/broadcast');
const { createLogger } = require('../core/logger');
const { CHANNELS } = require('../../shared/channels');
const { getSettings } = require('../settings/settingsService');
const { loadAccountStore } = require('../accounts/accountStore');
const { serverUrl, sessionFor } = require('./cloudClient');

/*
 * The live connection to the Vanilla+ server (a WebSocket per open launcher): new messages,
 * friend requests and read marks arrive at once. Events go to the window; when the window is not
 * in focus Vanilla+'s own notice card (notice.js) shows the message. Reconnects by itself with a growing pause.
 */

const PING_MS = 45 * 1000;
const MAX_PAUSE_MS = 2 * 60 * 1000;
const log = createLogger('live');
let socket = null;
let accountId = null;
let pingTimer = null;
let retryTimer = null;
let pause = 5000;
let stopped = true;

function mainWindow() {
  return getMainWindow();
}

function preview(message) {
  if (message.kind === 'image') return message.body?.caption ? `Скриншот: ${message.body.caption}` : 'Скриншот';
  if (message.kind === 'invite') {
    if (message.body?.world) return 'Зовёт в свой мир';
    return message.body?.server ? `Зовёт играть на ${message.body.server}` : `Зовёт играть: ${message.body?.instance ?? 'сборка'}`;
  }
  return String(message.body ?? '').slice(0, 140);
}

function onEvent(event) {
  broadcast(CHANNELS.events.friendEvent, event);
  if (event.type !== 'message') return;
  const window = mainWindow();
  if (window?.isFocused()) return;
  // Vanilla+'s own card in the corner of the screen (main/notice.js), not a Windows toast.
  showNotice({
    title: event.from?.name ?? 'Vanilla+',
    text: preview(event.message),
    onClick: () => {
      if (!window || window.isDestroyed()) return;
      showWindow(window);
      broadcast(CHANNELS.events.friendEvent, { type: 'open-chat', with: event.message.from });
    },
  });
}

function clearTimers() {
  clearInterval(pingTimer);
  clearTimeout(retryTimer);
  pingTimer = null;
  retryTimer = null;
}

function scheduleRetry() {
  if (stopped) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, pause);
  pause = Math.min(pause * 2, MAX_PAUSE_MS);
}

async function connect() {
  clearTimers();
  try {
    const settings = await getSettings();
    const { selectedId } = await loadAccountStore();
    if (stopped || !serverUrl(settings) || !selectedId) return;
    accountId = selectedId;
    const { base, token } = await sessionFor(selectedId);
    const url = `${base.replace(/^http/, 'ws')}/v1/live?token=${encodeURIComponent(token)}`;
    const current = new WebSocket(url);
    socket = current;
    current.addEventListener('open', () => {
      pause = 5000;
      log.info('Живое соединение с сервером Vanilla+ открыто');
      pingTimer = setInterval(() => current.readyState === WebSocket.OPEN && current.send('ping'), PING_MS);
    });
    current.addEventListener('message', (message) => {
      if (message.data === 'pong') return;
      try {
        onEvent(JSON.parse(String(message.data)));
      } catch {
        // Not an event.
      }
    });
    current.addEventListener('close', () => {
      if (socket !== current) return;
      socket = null;
      clearInterval(pingTimer);
      scheduleRetry();
    });
    current.addEventListener('error', () => {
      // "close" follows and schedules the next try.
    });
  } catch (error) {
    log.warn(`Живое соединение не открыто: ${error.message}`);
    scheduleRetry();
  }
}

function stopSocket() {
  clearTimers();
  const current = socket;
  socket = null;
  try {
    current?.close();
  } catch {
    // Already closed.
  }
}

/** Starts (or, after an account switch or a settings change, restarts) the live connection. */
function startLive() {
  stopped = false;
  pause = 5000;
  stopSocket();
  connect();
}

function stopLive() {
  stopped = true;
  stopSocket();
}

/** After switching accounts: the connection follows the selected account. */
async function followAccount() {
  const { selectedId } = await loadAccountStore().catch(() => ({ selectedId: null }));
  if (stopped || (selectedId === accountId && socket)) return;
  startLive();
}

module.exports = { startLive, stopLive, followAccount };
