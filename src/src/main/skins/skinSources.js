'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fetchJson, request, HttpError } = require('../core/http');
const { readJsonFile, writeJsonFileAtomic, writeFileAtomic } = require('../core/jsonFile');
const { SerialQueue } = require('../core/serialQueue');
const { getAppPaths } = require('../core/paths');
const { assertSkinPng } = require('./pngValidation');
const { loadSkin, MODELS } = require('./skinStore');

/*
 * Where skins come from besides the editor: any player's skin by nickname (Mojang or Ely.by),
 * the current skin of a signed-in account, uploading to a Microsoft profile, and a local
 * library of saved skins.
 */

const MOJANG_LOOKUP = 'https://api.minecraftservices.com/minecraft/profile/lookup/name/';
const MOJANG_SESSION = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const ELY_TEXTURES = 'https://skinsystem.ely.by/textures/';
const MINECRAFT_SKINS = 'https://api.minecraftservices.com/minecraft/profile/skins';
const NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const MAX_SKIN_BYTES = 256 * 1024;
const libraryQueue = new SerialQueue();

async function fetchPng(url) {
  const response = await request(url.replace(/^http:\/\//, 'https://'), { retries: 1 });
  const png = Buffer.from(await response.arrayBuffer());
  if (png.length > MAX_SKIN_BYTES) {
    throw new Error('Файл скина слишком большой.');
  }
  return png;
}

/** Textures of a Mojang profile by its UUID: { skinUrl, model, capeUrl }. */
async function mojangTextures(uuid) {
  const profile = await fetchJson(`${MOJANG_SESSION}${String(uuid).replace(/-/g, '')}`);
  const property = profile.properties?.find((candidate) => candidate.name === 'textures');
  if (!property) {
    return null;
  }
  const textures = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8')).textures ?? {};
  return {
    skinUrl: textures.SKIN?.url ?? null,
    model: textures.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic',
    capeUrl: textures.CAPE?.url ?? null,
  };
}

async function elyTextures(username) {
  try {
    const textures = await fetchJson(`${ELY_TEXTURES}${encodeURIComponent(username)}`);
    return {
      skinUrl: textures.SKIN?.url ?? null,
      model: textures.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic',
      capeUrl: textures.CAPE?.url ?? null,
    };
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 204)) {
      return null;
    }
    throw error;
  }
}

async function packTextures(textures, notFoundMessage) {
  if (!textures?.skinUrl) {
    throw new Error(notFoundMessage);
  }
  const [skin, cape] = await Promise.all([fetchPng(textures.skinUrl), textures.capeUrl ? fetchPng(textures.capeUrl).catch(() => null) : null]);
  return { pngBase64: skin.toString('base64'), model: textures.model, capeBase64: cape?.toString('base64') ?? null };
}

/** Skin of any player by nickname. source: 'mojang' (licensed players) or 'ely'. */
async function skinByName(name, source = 'mojang') {
  const username = String(name ?? '').trim();
  if (!NAME_PATTERN.test(username)) {
    throw new Error('Введите ник: латинские буквы, цифры и _, до 16 символов.');
  }
  if (source === 'ely') {
    return packTextures(await elyTextures(username), `На Ely.by нет скина игрока ${username}.`);
  }
  let profile;
  try {
    profile = await fetchJson(`${MOJANG_LOOKUP}${encodeURIComponent(username)}`);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 204)) {
      throw new Error(`Лицензионный игрок ${username} не найден.`);
    }
    throw error;
  }
  return packTextures(await mojangTextures(profile.id), `У игрока ${username} стандартный скин.`);
}

/** Current skin of an account as the game will show it. */
async function accountSkin(account) {
  if (account.type === 'offline') {
    const stored = await loadSkin(account.uuid);
    return stored ? { pngBase64: stored.png.toString('base64'), model: stored.model, capeBase64: null } : null;
  }
  if (account.type === 'ely') {
    const textures = await elyTextures(account.username);
    return textures?.skinUrl ? packTextures(textures, '') : null;
  }
  const textures = await mojangTextures(account.uuid);
  return textures?.skinUrl ? packTextures(textures, '') : null;
}

/** Uploads a skin to a Microsoft (licensed) profile with the account's Minecraft token. */
async function uploadMicrosoftSkin(accessToken, png, model) {
  assertSkinPng(png);
  if (!MODELS.includes(model)) {
    throw new Error('Неизвестная модель скина.');
  }
  const form = new FormData();
  form.append('variant', model);
  form.append('file', new Blob([png], { type: 'image/png' }), 'skin.png');
  try {
    await request(MINECRAFT_SKINS, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form, retries: 0 });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      throw new Error('Сессия Microsoft устарела. Запустите игру один раз или войдите заново.');
    }
    throw error;
  }
}

// --- Library ------------------------------------------------------------------------

function libraryDirectory() {
  return path.join(getAppPaths().root, 'skin-library');
}

function libraryIndexPath() {
  return path.join(libraryDirectory(), 'index.json');
}

async function readLibraryIndex() {
  const index = await readJsonFile(libraryIndexPath(), null);
  return Array.isArray(index) ? index : [];
}

async function listLibrary() {
  const index = await readLibraryIndex();
  const result = [];
  for (const item of index) {
    try {
      const png = await fsp.readFile(path.join(libraryDirectory(), `${item.id}.png`));
      result.push({ ...item, pngBase64: png.toString('base64') });
    } catch {
      // The file was removed by hand: skip it.
    }
  }
  return result;
}

const hashOf = (png) => crypto.createHash('sha1').update(png).digest('hex');

/**
 * Adds a skin to the library. The same picture is kept once: saving it again (a second click on a
 * site's download button, the same file twice) returns the skin already there, with `duplicate`.
 */
function saveToLibrary(name, png, model) {
  assertSkinPng(png);
  return libraryQueue.run(async () => {
    const index = await readLibraryIndex();
    const hash = hashOf(png);
    for (const existing of index) {
      // Skins saved before hashes were kept: their file is read once to compare.
      const existingHash = existing.hash ?? (await fsp.readFile(path.join(libraryDirectory(), `${existing.id}.png`)).then(hashOf).catch(() => null));
      if (existingHash === hash) return { ...existing, duplicate: true };
    }
    const item = {
      id: crypto.randomUUID(),
      name: String(name ?? '').trim().slice(0, 40) || `Скин ${index.length + 1}`,
      model: MODELS.includes(model) ? model : 'classic',
      hash,
      createdAt: new Date().toISOString(),
    };
    await writeFileAtomic(path.join(libraryDirectory(), `${item.id}.png`), png);
    await writeJsonFileAtomic(libraryIndexPath(), [item, ...index]);
    return item;
  });
}

function removeFromLibrary(id) {
  return libraryQueue.run(async () => {
    const index = await readLibraryIndex();
    const item = index.find((candidate) => candidate.id === id);
    if (!item) {
      return;
    }
    await fsp.rm(path.join(libraryDirectory(), `${item.id}.png`), { force: true });
    await writeJsonFileAtomic(libraryIndexPath(), index.filter((candidate) => candidate.id !== id));
  });
}

module.exports = { skinByName, accountSkin, uploadMicrosoftSkin, listLibrary, saveToLibrary, removeFromLibrary };
