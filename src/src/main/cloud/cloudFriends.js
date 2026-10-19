'use strict';

const { createLogger } = require('../core/logger');
const { request } = require('../core/http');
const { skinByName } = require('../skins/skinSources');
const { getSettings } = require('../settings/settingsService');
const { loadAccountStore } = require('../accounts/accountStore');
const { callAs, serverUrl, NAMESPACE } = require('./cloudClient');

/*
 * Friends of the account selected for playing, and its "online / playing" status. The launcher
 * reports the status every few minutes while it is open; friends see what you play only when
 * "Показывать друзьям, во что я играю" is on.
 */

const PRESENCE_MS = 5 * 60 * 1000;
const SKIN_CACHE_MS = 30 * 60 * 1000;
const NAMESPACES = Object.values(NAMESPACE);
const log = createLogger('friends');
const skinCache = new Map();
let timer = null;
let lastAccountId = null;

async function selectedAccountId() {
  const { selectedId } = await loadAccountStore();
  if (!selectedId) throw new Error('Добавьте аккаунт, чтобы дружить в Amethyx.');
  return selectedId;
}

/**
 * The skin a player shows (for the head in the list): the Amethyx skin when there is one, else
 * the Mojang or Ely.by skin. Cached for a while: the list is refreshed often.
 */
async function skinOf(base, user) {
  const key = user.skin ? `vp:${user.skin}` : `${user.ns}:${user.name.toLowerCase()}`;
  const cached = skinCache.get(key);
  if (cached && Date.now() - cached.at < SKIN_CACHE_MS) return cached.png;
  let png = null;
  try {
    if (user.skin) {
      const response = await request(`${base}/textures/${user.skin}`, { retries: 1 });
      png = Buffer.from(await response.arrayBuffer()).toString('base64');
    } else if (user.ns !== 'offline') {
      png = (await skinByName(user.name, user.ns === 'ely' ? 'ely' : 'mojang')).pngBase64;
    }
  } catch {
    // No skin found: the default head.
  }
  skinCache.set(key, { at: Date.now(), png });
  return png;
}

async function listFriends() {
  const result = await callAs(await selectedAccountId(), 'GET', '/v1/friends');
  const base = serverUrl(await getSettings());
  const withSkin = (users) => Promise.all(users.map(async (user) => ({ ...user, skinBase64: await skinOf(base, user) })));
  const [friendsList, incoming, outgoing] = await Promise.all([withSkin(result.friends), withSkin(result.incoming), withSkin(result.outgoing)]);
  return { me: result.me, friends: friendsList, incoming, outgoing };
}

async function requestFriend(ns, name) {
  if (!NAMESPACES.includes(ns)) throw new Error('Неизвестный тип аккаунта.');
  return callAs(await selectedAccountId(), 'POST', '/v1/friends/request', { ns, name: String(name ?? '').trim() });
}

async function answerFriend(id, accept) {
  return callAs(await selectedAccountId(), 'POST', accept ? '/v1/friends/accept' : '/v1/friends/decline', { id: String(id) });
}

async function removeFriend(id) {
  return callAs(await selectedAccountId(), 'DELETE', `/v1/friends/${encodeURIComponent(String(id))}`);
}

/** What friends see now: online, or playing (with the instance and server when shared). */
async function presenceBody(settings) {
  // Lazy: gameService loads the whole launch machinery.
  const activity = require('../minecraft/gameService').getActivity();
  if (!activity) return { status: 'online' };
  if (settings.social?.shareActivity === false) return { status: 'playing' };
  return { status: 'playing', instance: activity.instanceName, minecraft: activity.minecraft, loader: activity.loader, server: activity.server };
}

/** Sends the status now. Silent: no server, no network or no account is not an error here. */
async function reportPresence() {
  try {
    const settings = await getSettings();
    if (!serverUrl(settings)) return;
    const { selectedId } = await loadAccountStore();
    if (!selectedId) return;
    // Switching accounts: the previous one goes offline at once.
    if (lastAccountId && lastAccountId !== selectedId) {
      await callAs(lastAccountId, 'POST', '/v1/me/presence', { status: 'offline' }).catch(() => {});
    }
    lastAccountId = selectedId;
    await callAs(selectedId, 'POST', '/v1/me/presence', await presenceBody(settings));
  } catch (error) {
    log.warn(`Статус для друзей не отправлен: ${error.message}`);
  }
}

function startPresence() {
  if (timer) return;
  reportPresence();
  timer = setInterval(reportPresence, PRESENCE_MS);
  timer.unref?.();
}

/** On quit: friends see "offline" right away instead of after a few minutes. */
async function stopPresence() {
  clearInterval(timer);
  timer = null;
  if (!lastAccountId) return;
  await Promise.race([callAs(lastAccountId, 'POST', '/v1/me/presence', { status: 'offline' }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

module.exports = { listFriends, requestFriend, answerFriend, removeFriend, reportPresence, startPresence, stopPresence };
