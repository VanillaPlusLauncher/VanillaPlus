'use strict';

const { createLogger } = require('../core/logger');
const { request } = require('../core/http');
const upnp = require('./upnp');

/*
 * "Join my world" for friends, directly: the host's world (a world opened to LAN in the game, or an
 * own server from the Servers tab) gets its port opened on the home router (UPnP, upnp.js), and the
 * invite carries the router's outside address, "203.0.113.5:54321". The friend's game connects
 * there by itself: no server in between, so it works where Cloudflare is blocked too, for every
 * instance, vanilla included. (Until 1.7.1 the Amethyx server relayed the game through tunnels; the
 * site's hosting cannot hold such connections.)
 *
 * It cannot work when the router has UPnP switched off (then the port is opened by hand in the
 * router's settings and the address still goes in the invite), or when the provider gives a shared
 * ("grey") address: then nobody outside can reach this computer, and the friend opens the world instead.
 */

const log = createLogger('direct');
/** A mapping is renewed well before its lease ends. */
const RENEW_MS = (upnp.LEASE_SECONDS * 1000) / 2;
/** Open ports: 'world' or 'server:<instanceId>' → { port, address, timer }. */
const opened = new Map();

/** The outside address when the router does not tell it: as the Amethyx server sees this computer. */
async function addressFromServer() {
  const { requireServer } = require('./cloudClient');
  const base = await requireServer();
  const answer = await (await request(`${base}/ip`, { timeoutMs: 8000, retries: 1 })).json();
  return typeof answer?.ip === 'string' && /^[0-9a-f.:]+$/i.test(answer.ip) ? answer.ip : null;
}

/** Opens `port` for `key` (or keeps it open). Resolves with { port, address }; throws when friends cannot get in. */
async function openFor(key, port, label) {
  const existing = opened.get(key);
  if (existing?.port === port) return existing;
  await closeFor(key);
  let ip = null;
  try {
    const result = await upnp.openPort(port, `Amethyx: ${label}`);
    if (result.private) {
      throw new Error('У вас «серый» адрес от провайдера: друзья из интернета не смогут к вам подключиться. Пусть мир откроет друг, у которого адрес «белый», или подключите у провайдера белый IP.');
    }
    ip = result.externalIp;
  } catch (error) {
    if (!(error instanceof upnp.UpnpUnavailable)) throw error;
    // Without UPnP the address can still be known; the port then has to be opened by hand.
    ip = await addressFromServer().catch(() => null);
    if (!ip) throw new Error(`${error.message} Включите UPnP в настройках роутера (или откройте порт ${port} вручную) и попробуйте ещё раз.`);
    log.warn(`${error.message} Адрес ${ip}:${port} — порт нужно открыть на роутере вручную`);
    const entry = { port, address: `${ip}:${port}`, manual: true, timer: null };
    opened.set(key, entry);
    return entry;
  }
  if (!ip) throw new Error('Роутер не сообщил свой внешний адрес.');
  const entry = { port, address: `${ip}:${port}`, manual: false, timer: null };
  entry.timer = setInterval(() => {
    upnp.openPort(port, `Amethyx: ${label}`).catch((error) => log.warn(`Порт ${port} не продлён: ${error.message}`));
  }, RENEW_MS);
  opened.set(key, entry);
  return entry;
}

async function closeFor(key) {
  const entry = opened.get(key);
  if (!entry) return;
  opened.delete(key);
  clearInterval(entry.timer);
  if (!entry.manual) await upnp.closePort(entry.port).catch(() => {});
}

// --- Worlds opened to LAN -----------------------------------------------------------------------

function lanPort() {
  return require('../minecraft/gameService').getActivity()?.lanPort ?? null;
}

/** What the invite dialog can offer: { kind: 'ready', port, address? } — the world is open; 'closed'; null — no game. */
function worldStatus() {
  const activity = require('../minecraft/gameService').getActivity();
  if (!activity) return null;
  if (!activity.lanPort) return { kind: 'closed' };
  const entry = opened.get('world');
  return { kind: 'ready', port: activity.lanPort, hosting: Boolean(entry), address: entry?.port === activity.lanPort ? entry.address : null };
}

/** Opens the world opened to LAN to friends. Resolves with { address, manual }. */
async function hostWorld() {
  const port = lanPort();
  if (!port) throw new Error('Мир не открыт: в игре нажмите Esc → «Открыть для сети» → «Открыть мир для сети».');
  const entry = await openFor('world', port, 'мир');
  return { address: entry.address, manual: entry.manual };
}

/** The world was opened to LAN: its port is new each time, so it opens when a friend is invited. */
function onLanOpen() {}

function onGameExit() {
  closeFor('world');
}

// --- Own servers ---------------------------------------------------------------------------------

/** The own server is running with "Доступ из интернета" on: its port opens. Resolves with { address, manual }. */
async function hostServer(instanceId, port, name) {
  const entry = await openFor(`server:${instanceId}`, port, `сервер «${name}»`);
  return { address: entry.address, manual: entry.manual };
}

function stopServer(instanceId) {
  closeFor(`server:${instanceId}`);
}

function isHostingServer(instanceId) {
  return opened.has(`server:${instanceId}`);
}

function serverAddress(instanceId) {
  return opened.get(`server:${instanceId}`)?.address ?? null;
}

// --- Friends' worlds and servers ----------------------------------------------------------------

/**
 * The friend's side of an invite: its address is joined as it is. An invite from before 1.7.1
 * carries a tunnel id instead, and tunnels are no more.
 */
async function joinTunnel(value) {
  const text = String(value ?? '').trim();
  if (/^[0-9a-f]{32}$/.test(text)) throw new Error('Это приглашение через старый туннель Amethyx: попросите друга позвать вас ещё раз.');
  if (!/^[\w.:[\]-]{3,80}$/.test(text)) throw new Error('Неверное приглашение.');
  return { address: text };
}

/** Nothing to restore: friends' addresses are joined directly. */
async function restoreJoined() {}

function stopAll() {
  for (const key of [...opened.keys()]) closeFor(key);
}

module.exports = { worldStatus, hostWorld, onLanOpen, onGameExit, hostServer, stopServer, isHostingServer, serverAddress, joinTunnel, restoreJoined, stopAll };
