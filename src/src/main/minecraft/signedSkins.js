'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { request } = require('../core/http');
const { createLogger } = require('../core/logger');

/*
 * Amethyx skins of other players in games without mods (1.7.6 and newer). A game shows another
 * player's skin only when its textures come signed by a key the game trusts. The Amethyx server
 * signs its players' skins with its own key (website/cloud/lib/signed.php), and an offline
 * player's game is told to trust that key (skinServer.js). Then:
 *  - a player who opened a world to LAN: their game asks the launcher whether a friend has joined,
 *    and the launcher answers with the friend's profile, signed skin included — everyone in the
 *    world gets it from there;
 *  - a player on an offline server (or in a friend's world): 1.13–1.20.1 ask the launcher for
 *    players the server sent without a skin, and the Amethyx server finds them by the id an
 *    offline server gives a name.
 */

const KEY_FILE = 'amethyx-skin-key.json';
const KEY_TIMEOUT_MS = 5000;
const PROFILE_TIMEOUT_MS = 5000;
// A player without a skin is asked again after this; one with a skin keeps it for the session.
const MISS_TTL_MS = 2 * 60 * 1000;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const UUID = /^[0-9a-f]{32}$/;
const log = createLogger('signed-skins');

/** The id an offline server gives a name (Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name)), without dashes. */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

/** Offline ids are version 3; Microsoft's and Ely.by's (version 4) come with their own skins. */
function isOfflineUuid(uuid) {
  return UUID.test(uuid) && uuid[12] === '3';
}

async function getJson(url, timeoutMs) {
  const response = await request(url, { timeoutMs, retries: 0, headers: { Accept: 'application/json' } });
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function keyFromDer(base64) {
  return crypto.createPublicKey({ key: Buffer.from(String(base64), 'base64'), format: 'der', type: 'spki' });
}

/**
 * The public key the Amethyx server signs skins with: fresh from the server, else the copy kept
 * from an earlier launch (the game also starts without internet). null when there is neither.
 */
async function loadServerKey(serverUrl, toolsDirectory) {
  const file = path.join(toolsDirectory, KEY_FILE);
  try {
    const answer = await getJson(`${serverUrl}/skin-key`, KEY_TIMEOUT_MS);
    const key = keyFromDer(answer?.publicKey);
    try {
      await fsp.mkdir(toolsDirectory, { recursive: true });
      await fsp.writeFile(file, JSON.stringify({ serverUrl, publicKey: answer.publicKey }));
    } catch (error) {
      log.warn(`Ключ подписи скинов не сохранён: ${error.message}`);
    }
    return key;
  } catch (error) {
    try {
      const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (saved.serverUrl === serverUrl) return keyFromDer(saved.publicKey);
    } catch {
      // Never fetched before.
    }
    log.warn(`Ключ подписи скинов Amethyx не получен: ${error.message}`);
    return null;
  }
}

/** The textures property of a profile answer, reduced to what the game reads; null when there is none. */
function texturesProperty(answer) {
  const property = Array.isArray(answer?.properties) ? answer.properties.find((entry) => entry?.name === 'textures') : null;
  if (!property || typeof property.value !== 'string' || typeof property.signature !== 'string') return null;
  return { name: 'textures', value: property.value, signature: property.signature };
}

/** What a signed property shows: { skin, cape } texture hashes and the model; null when unreadable. */
function texturesOf(property) {
  try {
    const textures = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8')).textures ?? {};
    const hash = (url) => (typeof url === 'string' ? (/\/textures\/([0-9a-f]{64})$/.exec(url)?.[1] ?? null) : null);
    return { skin: hash(textures.SKIN?.url), cape: hash(textures.CAPE?.url), model: textures.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic' };
  } catch {
    return null;
  }
}

/**
 * Signed skins from the Amethyx server for one game session:
 *  byName(name, uuid, { fresh }) → the textures property for that name and id, or null;
 *  byUuid(uuid) → { name, property } for an offline id, or null.
 * Answers are kept for the session (a miss for a couple of minutes); fresh skips the kept one.
 */
function createSignedSkins(serverUrl) {
  const kept = new Map();

  function remembered(key, load, fresh) {
    const hit = kept.get(key);
    if (!fresh && hit && (hit.found || Date.now() - hit.at < MISS_TTL_MS)) return hit.promise;
    const entry = { at: Date.now(), found: false, promise: null };
    entry.promise = load()
      .catch(() => null)
      .then((value) => {
        entry.found = Boolean(value);
        return value;
      });
    kept.set(key, entry);
    return entry.promise;
  }

  return {
    byName(name, uuid, { fresh = false } = {}) {
      if (!NAME.test(String(name)) || !UUID.test(String(uuid))) return Promise.resolve(null);
      return remembered(`name:${name}:${uuid}`, async () => texturesProperty(await getJson(`${serverUrl}/signed/offline/${name}.json?uuid=${uuid}`, PROFILE_TIMEOUT_MS)), fresh);
    },
    byUuid(uuid) {
      if (!isOfflineUuid(String(uuid))) return Promise.resolve(null);
      return remembered(`uuid:${uuid}`, async () => {
        const answer = await getJson(`${serverUrl}/signed/uuid/${uuid}.json`, PROFILE_TIMEOUT_MS);
        const property = texturesProperty(answer);
        return property && typeof answer.name === 'string' && answer.name ? { name: answer.name, property } : null;
      });
    },
  };
}

module.exports = { offlineUuid, isOfflineUuid, loadServerKey, createSignedSkins, texturesOf };
