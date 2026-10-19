'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('../core/jsonFile');
const { getAppPaths } = require('../core/paths');
const { assertSkinPng, assertCapePng } = require('./pngValidation');

const MODELS = ['classic', 'slim'];

/** Account UUIDs are stored without dashes, lowercase: the same form the game and skin server use. */
function normalizeUuid(uuid) {
  const compact = String(uuid ?? '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error('Некорректный идентификатор профиля.');
  }
  return compact;
}

function skinDirectory() {
  return path.join(getAppPaths().root, 'skins');
}

function skinPaths(uuid) {
  const directory = skinDirectory();
  return { png: path.join(directory, `${uuid}.png`), meta: path.join(directory, `${uuid}.json`), cape: path.join(directory, `${uuid}.cape.png`) };
}

/** Validates and stores the skin PNG for a profile. */
async function saveSkin(rawUuid, pngBuffer, model) {
  const uuid = normalizeUuid(rawUuid);
  assertSkinPng(pngBuffer);
  if (!MODELS.includes(model)) {
    throw new Error('Неизвестная модель скина.');
  }
  const paths = skinPaths(uuid);
  await writeFileAtomic(paths.png, pngBuffer);
  await writeFileAtomic(paths.meta, JSON.stringify({ model, updatedAt: new Date().toISOString() }));
}

/** Returns { png: Buffer, model } or null when the profile has no skin. */
async function loadSkin(rawUuid) {
  const uuid = normalizeUuid(rawUuid);
  const paths = skinPaths(uuid);
  try {
    const [png, meta] = await Promise.all([fsp.readFile(paths.png), fsp.readFile(paths.meta, 'utf8')]);
    const { model } = JSON.parse(meta);
    return { png, model: MODELS.includes(model) ? model : 'classic' };
  } catch {
    return null;
  }
}

async function deleteSkin(rawUuid) {
  const paths = skinPaths(normalizeUuid(rawUuid));
  await Promise.all([fsp.rm(paths.png, { force: true }), fsp.rm(paths.meta, { force: true })]);
}

/*
 * The cape of a profile. For an offline account it is the cape in the game; for Microsoft and
 * Ely.by it is shown only by Vanilla+ (CustomSkinLoader in modded instances), like the
 * Vanilla+ skin stored above for those accounts.
 */
async function saveCape(rawUuid, pngBuffer) {
  const paths = skinPaths(normalizeUuid(rawUuid));
  assertCapePng(pngBuffer);
  await writeFileAtomic(paths.cape, pngBuffer);
}

/** Returns the cape PNG (Buffer) or null. */
async function loadCape(rawUuid) {
  try {
    return await fsp.readFile(skinPaths(normalizeUuid(rawUuid)).cape);
  } catch {
    return null;
  }
}

async function deleteCape(rawUuid) {
  await fsp.rm(skinPaths(normalizeUuid(rawUuid)).cape, { force: true });
}

module.exports = { saveSkin, loadSkin, deleteSkin, saveCape, loadCape, deleteCape, normalizeUuid, MODELS };
