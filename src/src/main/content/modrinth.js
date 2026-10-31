'use strict';

const { fetchJson, request } = require('../core/http');

/*
 * Modrinth API v2 (https://docs.modrinth.com). No key needed. Results are converted to the
 * launcher's own shapes (see contentTypes.js) so the UI does not care which site they came from.
 */
const API = 'https://api.modrinth.com/v2';
const PROJECT_TYPES = { mod: 'mod', modpack: 'modpack', resourcepack: 'resourcepack', shader: 'shader', datapack: 'datapack' };
const SORTS = { relevance: 'relevance', downloads: 'downloads', follows: 'follows', newest: 'newest', updated: 'updated' };
/** Shaders on Modrinth are tagged with the shader loader, not with the mod loader. */
const LOADER_FILTERED_TYPES = new Set(['mod', 'modpack']);

function projectUrl(hit) {
  return `https://modrinth.com/${hit.project_type ?? 'mod'}/${hit.slug ?? hit.project_id ?? hit.id}`;
}

function toHit(hit) {
  return {
    platform: 'modrinth',
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    author: hit.author,
    iconUrl: hit.icon_url || null,
    downloads: hit.downloads,
    follows: hit.follows,
    categories: hit.display_categories ?? hit.categories ?? [],
    updatedAt: hit.date_modified,
    gameVersions: hit.versions ?? [],
    url: projectUrl(hit),
    clientSide: hit.client_side,
  };
}

async function search({ type = 'mod', query = '', gameVersion, loader, category = null, sort = 'relevance', offset = 0, limit = 20 }) {
  const facets = [[`project_type:${PROJECT_TYPES[type] ?? 'mod'}`]];
  if (gameVersion) {
    facets.push([`versions:${gameVersion}`]);
  }
  if (loader && loader !== 'vanilla' && LOADER_FILTERED_TYPES.has(type)) {
    facets.push([`categories:${loader}`]);
  }
  if (category) {
    facets.push([`categories:${category}`]);
  }
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    index: SORTS[sort] ?? 'relevance',
    offset: String(offset),
    limit: String(limit),
  });
  const result = await fetchJson(`${API}/search?${params}`);
  return { hits: result.hits.map(toHit), total: result.total_hits };
}

async function getProject(id) {
  const project = await fetchJson(`${API}/project/${encodeURIComponent(id)}`);
  return {
    platform: 'modrinth',
    id: project.id,
    slug: project.slug,
    type: project.project_type,
    title: project.title,
    description: project.description,
    body: project.body ?? '',
    bodyFormat: 'markdown',
    iconUrl: project.icon_url || null,
    downloads: project.downloads,
    follows: project.followers,
    categories: project.categories ?? [],
    gallery: (project.gallery ?? []).map((image) => ({ url: image.url, title: image.title ?? '' })),
    links: {
      site: `https://modrinth.com/${project.project_type}/${project.slug}`,
      source: project.source_url ?? null,
      issues: project.issues_url ?? null,
      wiki: project.wiki_url ?? null,
      discord: project.discord_url ?? null,
    },
    gameVersions: project.game_versions ?? [],
    loaders: project.loaders ?? [],
    updatedAt: project.updated,
    license: project.license?.name ?? project.license?.id ?? null,
    clientSide: project.client_side ?? null,
    serverSide: project.server_side ?? null,
  };
}

function toVersion(version) {
  return {
    platform: 'modrinth',
    id: version.id,
    projectId: version.project_id,
    name: version.name,
    versionNumber: version.version_number,
    type: version.version_type,
    date: version.date_published,
    downloads: version.downloads,
    gameVersions: version.game_versions ?? [],
    loaders: version.loaders ?? [],
    files: (version.files ?? []).map((file) => ({
      url: file.url,
      filename: file.filename,
      size: file.size,
      sha1: file.hashes?.sha1 ?? null,
      sha512: file.hashes?.sha512 ?? null,
      primary: Boolean(file.primary),
    })),
    dependencies: (version.dependencies ?? []).map((dependency) => ({
      projectId: dependency.project_id ?? null,
      versionId: dependency.version_id ?? null,
      type: dependency.dependency_type,
    })),
  };
}

async function getVersions(projectId, { gameVersion, loader, type } = {}) {
  const params = new URLSearchParams();
  if (gameVersion) {
    params.set('game_versions', JSON.stringify([gameVersion]));
  }
  if (type === 'datapack') {
    // Data packs: only the datapack build, not the mod build many of them also publish.
    params.set('loaders', JSON.stringify(['datapack']));
  } else if (loader && loader !== 'vanilla' && (!type || LOADER_FILTERED_TYPES.has(type))) {
    params.set('loaders', JSON.stringify([loader]));
  }
  const query = params.toString();
  const versions = await fetchJson(`${API}/project/${encodeURIComponent(projectId)}/version${query ? `?${query}` : ''}`);
  return versions.map(toVersion);
}

async function getVersion(versionId) {
  return toVersion(await fetchJson(`${API}/version/${encodeURIComponent(versionId)}`));
}

async function getProjectsBrief(ids) {
  if (ids.length === 0) {
    return [];
  }
  // Long lists go in parts (the ids travel in the URL), all parts at once.
  const projects = (await Promise.all(chunks(ids, 100).map((part) => fetchJson(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(part))}`)))).flat();
  return projects.map((project) => ({
    id: project.id,
    title: project.title,
    iconUrl: project.icon_url || null,
    type: project.project_type,
    slug: project.slug,
    // Where the mod is needed: 'required' | 'optional' | 'unsupported' | 'unknown'.
    clientSide: project.client_side ?? null,
    serverSide: project.server_side ?? null,
  }));
}

/**
 * Newest compatible version for files identified by SHA-1:
 * { [sha1]: version } — only for files Modrinth knows.
 */
async function latestForHashes(hashes, { gameVersion, loader }) {
  if (hashes.length === 0) {
    return {};
  }
  const body = { hashes, algorithm: 'sha1', game_versions: gameVersion ? [gameVersion] : [] };
  if (loader && loader !== 'vanilla') {
    body.loaders = [loader];
  }
  const response = await request(`${API}/version_files/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  return Object.fromEntries(Object.entries(result).map(([hash, version]) => [hash, toVersion(version)]));
}

/** Versions for files identified by SHA-1 (to recognise mods added by hand). */
async function versionsForHashes(hashes) {
  if (hashes.length === 0) {
    return {};
  }
  const response = await request(`${API}/version_files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ hashes, algorithm: 'sha1' }),
  });
  const result = await response.json();
  return Object.fromEntries(Object.entries(result).map(([hash, version]) => [hash, toVersion(version)]));
}

async function listGameVersions() {
  const tags = await fetchJson(`${API}/tag/game_version`);
  return tags.filter((tag) => tag.version_type === 'release').map((tag) => tag.version);
}

/** Several versions at once (installed mods' versions for the compatibility check). */
async function getVersionsByIds(ids) {
  const versions = (await Promise.all(chunks(ids, 100).map((part) => fetchJson(`${API}/versions?ids=${encodeURIComponent(JSON.stringify(part))}`)))).flat();
  return versions.map(toVersion);
}

function chunks(list, size) {
  const parts = [];
  for (let start = 0; start < list.length; start += size) parts.push(list.slice(start, start + size));
  return parts;
}

module.exports = { search, getProject, getVersions, getVersion, getVersionsByIds, getProjectsBrief, latestForHashes, versionsForHashes, listGameVersions };
