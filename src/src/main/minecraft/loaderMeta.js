'use strict';

const { fetchJson } = require('../core/http');

/**
 * Mod loader versions available for a Minecraft version, newest first:
 * [{ version, stable, label }]. `version` is what loaderInstaller expects.
 */

const LOADER_TYPES = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const LOADER_LABELS = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value;
  }
  const value = await load();
  cache.set(key, { value, at: Date.now() });
  return value;
}

async function fabricLike(base, minecraft) {
  const list = await fetchJson(`${base}/versions/loader/${encodeURIComponent(minecraft)}`);
  return list.map((entry) => ({
    version: entry.loader.version,
    // Quilt has no "stable" flag: its betas carry "beta" in the version.
    stable: entry.loader.stable ?? !/beta|alpha|pre|rc/i.test(entry.loader.version),
  }));
}

async function forgeVersions(minecraft) {
  const [metadata, promotions] = await Promise.all([
    cached('forge-meta', () => fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json')),
    cached('forge-promos', () => fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json').catch(() => ({ promos: {} }))),
  ]);
  const recommended = promotions.promos?.[`${minecraft}-recommended`];
  const list = [...(metadata[minecraft] ?? [])].reverse();
  return list.map((full) => {
    // "1.20.1-47.2.0" (some old ones have a trailing "-1.7.10"): the loader part is the second field.
    const loader = full.split('-')[1] ?? full;
    return { version: full, label: loader, stable: loader === recommended };
  });
}

/**
 * NeoForge numbers its versions after Minecraft: 21.1.x is for 1.21.1, 20.4.x for 1.20.4.
 * From Minecraft 26.1 (year-based numbers) the first three fields are the Minecraft version itself:
 * 26.3.0.92 is for 26.3, 26.1.1.5 for 26.1.1. For 1.20.1 NeoForge still published "forge"-named builds.
 */
function neoforgeMinecraftVersion(version) {
  const [major, minor, patch] = version.split('-')[0].split('.');
  const a = Number(major);
  if (a >= 26) {
    return patch && patch !== '0' ? `${a}.${minor}.${patch}` : `${a}.${minor}`;
  }
  return minor === '0' ? `1.${a}` : `1.${a}.${minor}`;
}

async function neoforgeVersions(minecraft) {
  if (minecraft === '1.20.1') {
    const legacy = await cached('neoforge-legacy', () =>
      fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge'),
    );
    return (legacy.versions ?? [])
      .filter((version) => version.startsWith('1.20.1-'))
      .reverse()
      .map((version) => ({ version, label: version.slice('1.20.1-'.length), stable: true, legacyArtifact: true }));
  }
  const data = await cached('neoforge', () => fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'));
  return (data.versions ?? [])
    .filter((version) => neoforgeMinecraftVersion(version) === minecraft)
    .reverse()
    .map((version) => ({ version, label: version, stable: !/beta|alpha/i.test(version) }));
}

async function listLoaderVersions(type, minecraft) {
  if (!minecraft) {
    return [];
  }
  return cached(`${type}:${minecraft}`, async () => {
    switch (type) {
      case 'fabric':
        return fabricLike('https://meta.fabricmc.net/v2', minecraft);
      case 'quilt':
        return fabricLike('https://meta.quiltmc.org/v3', minecraft);
      case 'forge':
        return forgeVersions(minecraft);
      case 'neoforge':
        return neoforgeVersions(minecraft);
      default:
        return [];
    }
  }).then((list) => list.map((entry) => ({ label: entry.version, ...entry })));
}

/** The loader version to use when the user did not pick one: the newest stable, else the newest. */
async function pickLoaderVersion(type, minecraft) {
  const list = await listLoaderVersions(type, minecraft);
  if (list.length === 0) {
    throw new Error(`${LOADER_LABELS[type]} пока не поддерживает Minecraft ${minecraft}.`);
  }
  return (list.find((entry) => entry.stable) ?? list[0]).version;
}

module.exports = { listLoaderVersions, pickLoaderVersion, neoforgeMinecraftVersion, LOADER_TYPES, LOADER_LABELS };
