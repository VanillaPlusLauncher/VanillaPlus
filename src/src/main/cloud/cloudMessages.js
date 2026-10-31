'use strict';

const { nativeImage } = require('electron');
const { loadAccountStore } = require('../accounts/accountStore');
const { getSettings } = require('../settings/settingsService');
const { callAs, fetchAs } = require('./cloudClient');

/*
 * Messages with friends, as the account selected for playing: text, screenshots from the
 * instances (shrunk to a JPEG that fits the server's limit) and invites to play — the server to
 * join and, when wanted, the share code of the instance, so a friend gets the same mods in a click.
 */

const MAX_IMAGE_BASE64 = 880 * 1024;
const IMAGE_CACHE = 40;
const imageCache = new Map();

async function me() {
  const { selectedId } = await loadAccountStore();
  if (!selectedId) throw new Error('Добавьте аккаунт, чтобы писать друзьям.');
  return selectedId;
}

async function listMessages(friendId, before = null) {
  const query = new URLSearchParams({ with: String(friendId) });
  if (before) query.set('before', String(before));
  return callAs(await me(), 'GET', `/v1/messages?${query}`);
}

async function sendText(friendId, text) {
  return callAs(await me(), 'POST', '/v1/messages', { to: String(friendId), text: String(text ?? '').slice(0, 2000) });
}

/** A screenshot as a JPEG small enough for the server: smaller and softer until it fits. */
function compress(filePath) {
  const source = nativeImage.createFromPath(filePath);
  if (source.isEmpty()) throw new Error('Не удалось открыть картинку.');
  for (const [width, quality] of [[1920, 85], [1600, 80], [1280, 75], [960, 70]]) {
    const { width: sourceWidth } = source.getSize();
    const image = sourceWidth > width ? source.resize({ width, quality: 'best' }) : source;
    const data = image.toJPEG(quality).toString('base64');
    if (data.length <= MAX_IMAGE_BASE64) return { data, ...image.getSize() };
  }
  throw new Error('Картинка слишком большая даже после сжатия.');
}

async function sendScreenshot(friendId, instanceId, name, caption = '') {
  // Lazy: the instance modules are only needed here.
  const instanceService = require('../minecraft/instanceService');
  const { screenshotPath } = require('../minecraft/instanceFiles');
  const instance = await instanceService.getInstance(await getSettings(), String(instanceId));
  const filePath = screenshotPath(instance.directory, String(name));
  if (!filePath) throw new Error('Скриншот не найден.');
  const { data, width, height } = compress(filePath);
  return callAs(await me(), 'POST', '/v1/messages', { to: String(friendId), kind: 'image', image: data, caption: String(caption).slice(0, 200), width, height });
}

/** The instance's picture for the invite card: a block or item of the game, or a modpack's icon. */
function inviteIcon(icon) {
  const value = String(icon ?? '');
  if (/^[a-z0-9_]{1,48}$/.test(value)) return `block:${value}`;
  return /^(block:[a-z0-9_]{1,48}|item:[a-z0-9_]{1,48}|https:\/\/[^\s"'<>]{1,280})$/.test(value) ? value : null;
}

/**
 * An invite: the instance (name, version, loader, picture), where to join, and the share code
 * when `withPack` is on, so the friend can build the same instance. Where to join:
 *  world     — the world opened to LAN now: e4mc's public address when that mod is in the instance,
 *              else this computer's outside address with the port opened on the router (tunnel.js);
 *  ownServer — the own server of the instance, the same way ("Доступ из интернета" switched on);
 *  server    — an address typed by the player.
 * With `upload` the mods that are on neither Modrinth nor CurseForge go to the server and into the
 * code; when that fails the invite still goes, without them, and `uploadError` says why. A ready
 * `code` (the export dialog's, perhaps with the author's files) is sent as it is.
 */
async function sendInvite(friendId, { instanceId, server = '', withPack = true, upload = false, world = false, ownServer = false, code: readyCode = null } = {}) {
  const settings = await getSettings();
  const instanceService = require('../minecraft/instanceService');
  const tunnel = require('./tunnel');
  let address = String(server ?? '').trim() || null;
  let id = String(instanceId);
  if (world) {
    const status = tunnel.worldStatus();
    if (status?.kind !== 'ready') {
      throw new Error('Мир ещё не открыт для друзей: в игре нажмите Esc → «Открыть для сети» → «Открыть мир для сети».');
    }
    // e4mc's public address when that mod is there; otherwise the port opened on the router.
    const e4mc = require('../minecraft/worldShare').hostStatus();
    address = e4mc?.kind === 'ready' ? e4mc.address : (await tunnel.hostWorld()).address;
    const running = require('../minecraft/gameService').getStatus();
    if (running.state === 'running' && running.instanceId) id = running.instanceId;
  } else if (ownServer) {
    address = (await require('../minecraft/serverService').serverInvite(settings, id)).address;
  }
  const instance = await instanceService.getInstance(settings, id);
  let code = null;
  let uploadError = null;
  if (withPack && typeof readyCode === 'string' && readyCode.startsWith('VP1-')) {
    code = readyCode;
  } else if (withPack) {
    const { makeShareCode } = require('../content/shareService');
    try {
      code = (await makeShareCode(settings, instance.id, { upload })).code;
    } catch (error) {
      if (!upload) throw error;
      uploadError = error.message;
      code = (await makeShareCode(settings, instance.id)).code;
    }
  }
  const kind = world ? 'world' : ownServer ? 'server' : address ? 'play' : 'pack';
  const invite = {
    instance: instance.name,
    minecraft: instance.minecraft,
    loader: instance.loader?.type ?? 'vanilla',
    server: address,
    world: world || ownServer ? instance.name : null,
    code,
    // Friends join the address directly (cloud/tunnel.js); invites before 1.7.1 carried a tunnel id here.
    tunnel: null,
    icon: inviteIcon(instance.icon),
    kind,
  };
  return { ...(await callAs(await me(), 'POST', '/v1/messages', { to: String(friendId), kind: 'invite', invite })), uploadError };
}

async function markRead(friendId) {
  return callAs(await me(), 'POST', '/v1/messages/read', { with: String(friendId) });
}

/** A picture from a message as a data URL (cached: the chat shows the same ones again and again). */
async function imageData(imageId) {
  const id = String(imageId);
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('Неверная картинка.');
  if (imageCache.has(id)) return imageCache.get(id);
  const bytes = await fetchAs(await me(), `/v1/images/${id}`);
  const type = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const url = `data:${type};base64,${bytes.toString('base64')}`;
  imageCache.set(id, url);
  if (imageCache.size > IMAGE_CACHE) imageCache.delete(imageCache.keys().next().value);
  return url;
}

/** Screenshots of every instance, newest first (for "send a screenshot"). */
async function recentScreenshots(limit = 60) {
  const settings = await getSettings();
  const instanceService = require('../minecraft/instanceService');
  const { listScreenshots } = require('../minecraft/instanceFiles');
  const instances = await instanceService.listInstances(settings);
  const all = [];
  for (const instance of instances) {
    for (const shot of await listScreenshots(instance.directory).catch(() => [])) {
      all.push({ instanceId: instance.id, instanceName: instance.name, name: shot.name, modifiedAt: shot.modifiedAt });
    }
  }
  return all.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

module.exports = { listMessages, sendText, sendScreenshot, sendInvite, markRead, imageData, recentScreenshots };
