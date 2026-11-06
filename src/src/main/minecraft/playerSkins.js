'use strict';

const { request } = require('../core/http');
const { createLogger } = require('../core/logger');
const { namespaceOf } = require('./customSkins');

/*
 * Skins of any player by name, for game versions that still ask for skins by name (before 1.7.6,
 * see legacySkinProxy.js). No mod is needed for that: the launcher answers the game's own requests.
 * Order, like the CustomSkinLoader list in modded instances (customSkins.js):
 *  1. the player's own skin and cape from the launcher (works without internet);
 *  2. the Amethyx server: skins and capes of Amethyx players;
 *  3. the usual source of the account type: Ely.by for Ely.by accounts, else Mojang.
 */

const TIMEOUT_MS = 8000;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const MOJANG_NAME_URL = 'https://api.mojang.com/users/profiles/minecraft/';
const MOJANG_PROFILE_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const ELY_SKIN_URL = 'https://skinsystem.ely.by/skins/';
const ELY_CAPE_URL = 'https://skinsystem.ely.by/cloaks/';
const log = createLogger('player-skins');

async function download(url) {
  try {
    const response = await request(url, { timeoutMs: TIMEOUT_MS, retries: 0 });
    const png = Buffer.from(await response.arrayBuffer());
    // Only PNG files (the signature), nothing else is handed to the game.
    return png.length > 8 && png.readUInt32BE(0) === 0x89504e47 ? png : null;
  } catch {
    return null;
  }
}

async function getJson(url) {
  try {
    const response = await request(url, { timeoutMs: TIMEOUT_MS, retries: 0, headers: { Accept: 'application/json' } });
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function fromAmethyx(serverUrl, namespace, name) {
  if (!serverUrl) return null;
  const profile = await getJson(`${serverUrl}/csl/${namespace}/${name}.json`);
  if (!profile || typeof profile !== 'object') return null;
  const [model, hash] = Object.entries(profile.skins ?? {})[0] ?? [];
  const hex = (value) => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null);
  const [png, cape] = await Promise.all([
    hex(hash) ? download(`${serverUrl}/textures/${hash}`) : null,
    hex(profile.cape) ? download(`${serverUrl}/textures/${profile.cape}`) : null,
  ]);
  return png || cape ? { png, cape, model: model === 'slim' ? 'slim' : 'classic', source: 'Amethyx' } : null;
}

async function fromMojang(name) {
  const id = (await getJson(`${MOJANG_NAME_URL}${name}`))?.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) return null;
  const property = (await getJson(`${MOJANG_PROFILE_URL}${id}`))?.properties?.find((entry) => entry.name === 'textures');
  let textures;
  try {
    textures = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8')).textures ?? {};
  } catch {
    return null;
  }
  // Only Mojang's own texture host.
  const allowed = (url) => (typeof url === 'string' && /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]+$/i.test(url) ? url.replace(/^http:/, 'https:') : null);
  const skinUrl = allowed(textures.SKIN?.url);
  const capeUrl = allowed(textures.CAPE?.url);
  const [png, cape] = await Promise.all([skinUrl ? download(skinUrl) : null, capeUrl ? download(capeUrl) : null]);
  return png || cape ? { png, cape, model: textures.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic', source: 'Mojang' } : null;
}

async function fromEly(name) {
  const [png, cape] = await Promise.all([download(`${ELY_SKIN_URL}${name}.png`), download(`${ELY_CAPE_URL}${name}.png`)]);
  return png || cape ? { png, cape, model: 'classic', source: 'Ely.by' } : null;
}

/**
 * Returns lookup(name) → Promise<{ png, cape, model, source } | null>. Answers are kept for the
 * whole game session, so every player is asked for once (old versions ask again for every entity).
 * own: { username, png, cape, model } of the player, or null.
 */
function createSkinLookup({ serverUrl = null, provider = 'offline', own = null }) {
  const namespace = namespaceOf(provider);
  const cache = new Map();

  async function find(name) {
    const found = (await fromAmethyx(serverUrl, namespace, name)) ?? (provider === 'ely' ? await fromEly(name) : await fromMojang(name));
    log.info(`Скин игрока ${name}: ${found ? found.source : 'нет'}`);
    return found;
  }

  return function lookup(name) {
    const clean = String(name ?? '').trim();
    // The player's own skin and cape: also for a name the servers would not take (offline names may be anything).
    if (own && (own.png || own.cape) && own.username.toLowerCase() === clean.toLowerCase()) {
      return Promise.resolve({ png: own.png ?? null, cape: own.cape ?? null, model: own.model ?? 'classic', source: 'свой' });
    }
    if (!NAME.test(clean)) return Promise.resolve(null);
    const key = clean.toLowerCase();
    if (!cache.has(key)) {
      cache.set(key, find(clean).catch(() => null));
    }
    return cache.get(key);
  };
}

module.exports = { createSkinLookup };
