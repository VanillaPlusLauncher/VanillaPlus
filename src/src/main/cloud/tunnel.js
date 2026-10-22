'use strict';

const { broadcast } = require('../core/broadcast');
const { createLogger } = require('../core/logger');
const { CHANNELS } = require('../../shared/channels');
const { loadAccountStore } = require('../accounts/accountStore');
const { callAs, sessionFor, readStore, updateStore } = require('./cloudClient');
const { startHost, startGuest } = require('./tunnelCore');

/*
 * "Join my world" for friends, with no mod and no router setup: the host's world (a world opened
 * to LAN in the game, or an own server from the Servers tab) gets a tunnel room on the Amethyx
 * server; a friend's launcher opens a local port that leads into it, and the friend's game joins
 * 127.0.0.1:<port>. Works for every instance, vanilla too.
 *
 * Each player keeps few tunnels (the server allows FREE_TUNNELS): one for worlds opened to LAN,
 * reused for every game (cloud.json → tunnels), and one per own server (its amethyx-server.json).
 * So an invite stays good: whenever the host's world or server is open again, the friend gets in.
 * A host connection that drops comes back by itself; a tunnel the server forgot is made anew.
 */

const log = createLogger('tunnel');
const RETRY_MS = [3000, 6000, 15000, 30000, 60000];
/** Host connections: 'world' or 'server:<instanceId>' → { id, port, handle, retry, attempt, stopped }. */
const hosts = new Map();
/** Friends' rooms joined in this run: tunnel id → { port, close, name }. */
const guests = new Map();

async function accountId() {
  const { selectedId } = await loadAccountStore();
  if (!selectedId) throw new Error('Добавьте аккаунт, чтобы звать друзей.');
  return selectedId;
}

/** The room's WebSocket address for each new connection, with a fresh session token. */
function socketUrlFor(account, id) {
  return async (role, conn) => {
    const { base, token } = await sessionFor(account);
    return `${base.replace(/^http/, 'ws')}/v1/tunnels/${id}/ws?token=${encodeURIComponent(token)}&role=${role}${conn ? `&conn=${encodeURIComponent(conn)}` : ''}`;
  };
}

function emit(event) {
  broadcast(CHANNELS.events.friendEvent, event);
}

/** A tunnel of this player that the server still knows, or a new one. */
async function liveTunnel(account, id) {
  if (id) {
    try {
      await callAs(account, 'GET', `/v1/tunnels/${id}`);
      return id;
    } catch (error) {
      if (error.status !== 404 && error.status !== 403) throw error;
    }
  }
  const created = await callAs(account, 'POST', '/v1/tunnels');
  return created.id;
}

/** The player's tunnel for worlds opened to LAN (made once, then reused). */
async function worldTunnelId(account) {
  const store = await readStore();
  const known = store.tunnels?.[account]?.world ?? null;
  const id = await liveTunnel(account, known);
  if (id !== known) {
    await updateStore((next) => {
      next.tunnels = { ...(next.tunnels ?? {}), [account]: { ...(next.tunnels?.[account] ?? {}), world: id } };
    });
  }
  return id;
}

/** Opens the host side of `key` to `port` and keeps it open until stopHost(key). */
async function startHosting(key, id, port, label) {
  const existing = hosts.get(key);
  if (existing && existing.id === id && existing.port === port && existing.handle) return existing;
  stopHost(key);
  const entry = { id, port, label, handle: null, retry: null, attempt: 0, stopped: false };
  hosts.set(key, entry);
  await connectHost(key, entry);
  return entry;
}

async function connectHost(key, entry) {
  const handle = await startHost({
    socketUrl: socketUrlFor(await accountId(), entry.id),
    port: entry.port,
    onEvent: (event) => {
      if (event.type === 'join') {
        log.info(`К ${entry.label} подключается ${event.from}`);
        noticeJoin(event.from, key);
      } else if (event.type === 'closed') {
        entry.handle = null;
        scheduleReconnect(key, entry);
      }
    },
  });
  if (entry.stopped) {
    handle.close();
    return;
  }
  entry.handle = handle;
  entry.attempt = 0;
  log.info(`Туннель открыт: ${entry.label} (порт ${entry.port})`);
}

/**
 * A friend comes in: the window says so, and over the game Amethyx's own card in the corner (it never
 * takes the focus). Each game connection counts, the server list's ping too, so once a minute per friend.
 */
const noticed = new Map();
function noticeJoin(from, key) {
  if (!from || Date.now() - (noticed.get(from) ?? 0) < 60000) return;
  noticed.set(from, Date.now());
  emit({ type: 'tunnel-join', from, key });
  const window = require('../window').getMainWindow();
  if (window?.isFocused()) return;
  require('../notice').showNotice({ title: 'Amethyx', text: `${from} заходит к вам` });
}

function scheduleReconnect(key, entry) {
  if (entry.stopped || hosts.get(key) !== entry) return;
  clearTimeout(entry.retry);
  const pause = RETRY_MS[Math.min(entry.attempt, RETRY_MS.length - 1)];
  entry.attempt += 1;
  entry.retry = setTimeout(() => {
    connectHost(key, entry).catch((error) => {
      log.warn(`Туннель (${entry.label}) не переподключился: ${error.message}`);
      scheduleReconnect(key, entry);
    });
  }, pause);
}

function stopHost(key) {
  const entry = hosts.get(key);
  if (!entry) return;
  entry.stopped = true;
  clearTimeout(entry.retry);
  entry.handle?.close();
  hosts.delete(key);
}

// --- Worlds opened to LAN -----------------------------------------------------------------------

function lanPort() {
  return require('../minecraft/gameService').getActivity()?.lanPort ?? null;
}

/** What the invite dialog can offer: { kind: 'ready', port } — the world is open; 'closed'; null — no game. */
function worldStatus() {
  const activity = require('../minecraft/gameService').getActivity();
  if (!activity) return null;
  return activity.lanPort ? { kind: 'ready', port: activity.lanPort, hosting: hosts.has('world') } : { kind: 'closed' };
}

/** Opens (or reuses) the tunnel into the world opened to LAN. Resolves with { id }. */
async function hostWorld() {
  const port = lanPort();
  if (!port) throw new Error('Мир не открыт: в игре нажмите Esc → «Открыть для сети» → «Открыть мир для сети».');
  const account = await accountId();
  const id = await worldTunnelId(account);
  await startHosting('world', id, port, 'миру');
  return { id };
}

/** The world was opened to LAN: friends with an earlier invite can come in at once. */
async function onLanOpen() {
  try {
    const account = await accountId();
    if (!(await readStore()).tunnels?.[account]?.world) return;
    await hostWorld();
  } catch (error) {
    log.warn(`Туннель к миру не открыт: ${error.message}`);
  }
}

function onGameExit() {
  stopHost('world');
}

// --- Own servers ---------------------------------------------------------------------------------

/** The server's tunnel id (made when missing). */
async function serverTunnelId(known) {
  return liveTunnel(await accountId(), known);
}

/** The own server is running and its tunnel is on: friends come in through it. */
async function hostServer(instanceId, id, port, name) {
  await startHosting(`server:${instanceId}`, id, port, `серверу «${name}»`);
}

function stopServer(instanceId) {
  stopHost(`server:${instanceId}`);
}

function isHostingServer(instanceId) {
  return Boolean(hosts.get(`server:${instanceId}`)?.handle);
}

// --- Friends' worlds and servers ----------------------------------------------------------------

/** A steady local port for a tunnel, so its address in the game's server list does not change. */
function preferredPort(id) {
  return 41000 + (parseInt(id.slice(0, 6), 16) % 9000);
}

/**
 * The friend's side: a local port into the host's world or server, kept while the launcher runs
 * (and opened again on the next start, see restoreJoined). Resolves with { address, port }.
 */
async function joinTunnel(tunnelId, { name = '' } = {}) {
  const id = String(tunnelId);
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('Неверное приглашение.');
  const known = guests.get(id);
  if (known) return { address: `127.0.0.1:${known.port}`, port: known.port };
  const account = await accountId();
  const stored = (await readStore()).joined?.[id];
  let warned = 0;
  const guest = await startGuest({
    socketUrl: socketUrlFor(account, id),
    port: stored?.port ?? preferredPort(id),
    onEvent: (event) => {
      // The game's server list asks every few seconds: one word about it is enough.
      if (event.type !== 'error' || Date.now() - warned < 30000) return;
      warned = Date.now();
      emit({ type: 'tunnel-error', message: `${name || 'Друг'} сейчас не в игре, или его мир закрыт.` });
    },
  });
  guests.set(id, { ...guest, name });
  await updateStore((next) => {
    next.joined = { ...(next.joined ?? {}), [id]: { port: guest.port, name: name || stored?.name || '', at: Date.now() } };
  });
  log.info(`Подключение к другу${name ? ` (${name})` : ''}: 127.0.0.1:${guest.port}`);
  return { address: `127.0.0.1:${guest.port}`, port: guest.port };
}

/** After a start: the friends' servers saved in the game's list answer again (only the last 20). */
async function restoreJoined() {
  const joined = Object.entries((await readStore()).joined ?? {})
    .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    .slice(0, 20);
  for (const [id, entry] of joined) {
    await joinTunnel(id, { name: entry.name }).catch(() => {});
  }
}

function stopAll() {
  for (const key of [...hosts.keys()]) stopHost(key);
  for (const guest of guests.values()) guest.close();
  guests.clear();
}

module.exports = { worldStatus, hostWorld, onLanOpen, onGameExit, serverTunnelId, hostServer, stopServer, isHostingServer, joinTunnel, restoreJoined, stopAll };
