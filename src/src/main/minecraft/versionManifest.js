'use strict';

const { fetchJson } = require('../core/http');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MEMORY_TTL_MS = 10 * 60 * 1000;
const log = createLogger('manifest');

let memoryCache = null;

/**
 * Returns Mojang's version manifest. Uses a short in-memory cache and falls back
 * to the last successful copy on disk when the network is unavailable.
 */
async function getVersionManifest({ force = false } = {}) {
  if (!force && memoryCache && Date.now() - memoryCache.loadedAt < MEMORY_TTL_MS) {
    return memoryCache.data;
  }
  const { manifestCacheFile } = getAppPaths();
  try {
    const data = await fetchJson(MANIFEST_URL);
    memoryCache = { data, loadedAt: Date.now() };
    await writeJsonFileAtomic(manifestCacheFile, data);
    return data;
  } catch (error) {
    log.warn(`Не удалось обновить список версий: ${error.message}`);
    if (memoryCache) {
      return memoryCache.data;
    }
    const cached = await readJsonFile(manifestCacheFile, null);
    if (cached) {
      memoryCache = { data: cached, loadedAt: 0 };
      return cached;
    }
    throw new Error('Не удалось загрузить список версий Minecraft. Проверьте подключение к интернету.');
  }
}

/** Lists versions as {id, type, releaseTime, url}, newest first as Mojang orders them. */
async function listRemoteVersions(options) {
  const manifest = await getVersionManifest(options);
  return manifest.versions.map(({ id, type, releaseTime, url }) => ({ id, type, releaseTime, url }));
}

async function getRemoteVersionEntry(versionId) {
  const versions = await listRemoteVersions();
  const entry = versions.find((version) => version.id === versionId);
  if (!entry) {
    throw new Error(`Версия ${versionId} не найдена в списке Mojang.`);
  }
  return entry;
}

module.exports = { getVersionManifest, listRemoteVersions, getRemoteVersionEntry, MANIFEST_URL };
