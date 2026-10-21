'use strict';

const { fetchJson, request, HttpError } = require('../core/http');

/*
 * CurseForge API v1 (https://docs.curseforge.com). Every request needs an API key: the launcher's
 * own key when the build carries one (installer/build.ps1 writes build-keys.json, which is never
 * in the repository), otherwise one the user enters in Settings, which always wins. Results are
 * converted to the same shapes as Modrinth's (see modrinth.js).
 */
let builtInKey;

/** The key the build carries, or ''. */
function builtInApiKey() {
  if (builtInKey === undefined) {
    try {
      builtInKey = String(require('../../build-keys.json').curseforge ?? '').trim();
    } catch {
      builtInKey = '';
    }
  }
  return builtInKey;
}

/** The key to use: the user's own, else the launcher's. */
function apiKey(settings) {
  return settings?.curseforgeApiKey || builtInApiKey();
}

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const CLASS_IDS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552, datapack: 6945 };
const TYPE_BY_CLASS = Object.fromEntries(Object.entries(CLASS_IDS).map(([type, id]) => [id, type]));
const LOADER_IDS = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const SORT_FIELDS = { relevance: 1, downloads: 6, follows: 2, newest: 11, updated: 3 };
const RELEASE_TYPES = { 1: 'release', 2: 'beta', 3: 'alpha' };
const LOADER_NAMES = new Set(['forge', 'fabric', 'quilt', 'neoforge', 'liteloader']);

class MissingCurseForgeKey extends Error {
  constructor() {
    super('Для CurseForge нужен ключ API. Получите его бесплатно на console.curseforge.com и вставьте в Настройках → Моды.');
    this.name = 'MissingCurseForgeKey';
  }
}

function headers(apiKey) {
  if (!apiKey) {
    throw new MissingCurseForgeKey();
  }
  return { 'x-api-key': apiKey, Accept: 'application/json' };
}

async function call(apiKey, url, options = {}) {
  try {
    if (options.body) {
      const response = await request(url, {
        method: 'POST',
        headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(options.body),
      });
      return await response.json();
    }
    return await fetchJson(url, { headers: headers(apiKey) });
  } catch (error) {
    // New keys of CurseForge for Studios work everywhere except search until CurseForge opens it.
    if (error instanceof HttpError && error.status === 403 && url.includes('/mods/search')) {
      throw new Error('CurseForge пока не открыл поиск для этого ключа. Модпаки и моды CurseForge из файлов ставятся и обновляются как обычно, а искать моды можно на Modrinth.');
    }
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new Error('CurseForge не принял ключ API. Проверьте его в Настройках → Моды.');
    }
    throw error;
  }
}

/** CDN address for files whose author disabled third-party downloads (downloadUrl is null). */
function fallbackDownloadUrl(file) {
  const id = String(file.id);
  return `https://edge.forgecdn.net/files/${id.slice(0, -3) || '0'}/${Number(id.slice(-3))}/${encodeURIComponent(file.fileName)}`;
}

function toHit(mod) {
  return {
    platform: 'curseforge',
    id: String(mod.id),
    slug: mod.slug,
    title: mod.name,
    description: mod.summary,
    author: mod.authors?.[0]?.name ?? '',
    iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || null,
    downloads: mod.downloadCount,
    follows: mod.thumbsUpCount ?? 0,
    categories: (mod.categories ?? []).map((category) => category.name),
    updatedAt: mod.dateModified,
    gameVersions: [...new Set((mod.latestFilesIndexes ?? []).map((index) => index.gameVersion))],
    url: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/${mod.slug}`,
    type: TYPE_BY_CLASS[mod.classId] ?? 'mod',
  };
}

async function search(apiKey, { type = 'mod', query = '', gameVersion, loader, sort = 'relevance', offset = 0, limit = 20 }) {
  const params = new URLSearchParams({
    gameId: String(MINECRAFT_GAME_ID),
    classId: String(CLASS_IDS[type] ?? CLASS_IDS.mod),
    searchFilter: query,
    sortField: String(SORT_FIELDS[sort] ?? 1),
    sortOrder: 'desc',
    index: String(Math.min(offset, 9950)),
    pageSize: String(limit),
  });
  if (gameVersion) {
    params.set('gameVersion', gameVersion);
  }
  if (loader && LOADER_IDS[loader] && (type === 'mod' || type === 'modpack')) {
    params.set('modLoaderType', String(LOADER_IDS[loader]));
  }
  const result = await call(apiKey, `${API}/mods/search?${params}`);
  return { hits: result.data.map(toHit), total: Math.min(result.pagination?.totalCount ?? result.data.length, 10000) };
}

async function getProject(apiKey, id) {
  const [{ data: mod }, description] = await Promise.all([
    call(apiKey, `${API}/mods/${encodeURIComponent(id)}`),
    call(apiKey, `${API}/mods/${encodeURIComponent(id)}/description`).catch(() => ({ data: '' })),
  ]);
  const hit = toHit(mod);
  return {
    ...hit,
    type: TYPE_BY_CLASS[mod.classId] ?? 'mod',
    body: description.data ?? '',
    bodyFormat: 'html',
    gallery: (mod.screenshots ?? []).map((image) => ({ url: image.url, title: image.title ?? '' })),
    links: { site: hit.url, source: mod.links?.sourceUrl ?? null, issues: mod.links?.issuesUrl ?? null, wiki: mod.links?.wikiUrl ?? null, discord: null },
    loaders: [],
    license: null,
  };
}

function toVersion(file) {
  const gameVersions = [];
  const loaders = [];
  for (const value of file.gameVersions ?? []) {
    const lower = value.toLowerCase();
    if (LOADER_NAMES.has(lower)) {
      loaders.push(lower);
    } else if (/^\d/.test(value)) {
      gameVersions.push(value);
    }
  }
  return {
    platform: 'curseforge',
    id: String(file.id),
    projectId: String(file.modId),
    name: file.displayName,
    versionNumber: file.displayName,
    type: RELEASE_TYPES[file.releaseType] ?? 'release',
    date: file.fileDate,
    downloads: file.downloadCount,
    gameVersions,
    loaders,
    files: [
      {
        url: file.downloadUrl || fallbackDownloadUrl(file),
        filename: file.fileName,
        size: file.fileLength,
        sha1: file.hashes?.find((hash) => hash.algo === 1)?.value ?? null,
        primary: true,
      },
    ],
    dependencies: (file.dependencies ?? [])
      .filter((dependency) => dependency.relationType === 3 || dependency.relationType === 2)
      .map((dependency) => ({ projectId: String(dependency.modId), versionId: null, type: dependency.relationType === 3 ? 'required' : 'optional' })),
    // Client / server from the file's own tags (CurseForge has no such field on the project).
    ...sidesOfFile(file),
  };
}

async function getVersions(apiKey, projectId, { gameVersion, loader, type } = {}) {
  const params = new URLSearchParams({ pageSize: '50' });
  if (gameVersion) {
    params.set('gameVersion', gameVersion);
  }
  if (loader && LOADER_IDS[loader] && (!type || type === 'mod' || type === 'modpack')) {
    params.set('modLoaderType', String(LOADER_IDS[loader]));
  }
  const result = await call(apiKey, `${API}/mods/${encodeURIComponent(projectId)}/files?${params}`);
  return result.data.map(toVersion).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

async function getVersion(apiKey, projectId, fileId) {
  const result = await call(apiKey, `${API}/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`);
  return toVersion(result.data);
}

/** Files by id, in batches (modpack manifests list hundreds). */
async function getFiles(apiKey, fileIds) {
  const result = [];
  for (let start = 0; start < fileIds.length; start += 500) {
    const batch = fileIds.slice(start, start + 500).map(Number);
    const answer = await call(apiKey, `${API}/mods/files`, { body: { fileIds: batch } });
    result.push(...answer.data);
  }
  return result;
}

async function getMods(apiKey, modIds) {
  const result = [];
  for (let start = 0; start < modIds.length; start += 500) {
    const batch = modIds.slice(start, start + 500).map(Number);
    const answer = await call(apiKey, `${API}/mods`, { body: { modIds: batch } });
    result.push(...answer.data);
  }
  return result;
}

/** Files CurseForge knows by their fingerprint (curseFingerprint.js): { [fingerprint]: file }. */
async function matchFingerprints(apiKey, fingerprints) {
  const found = {};
  for (let start = 0; start < fingerprints.length; start += 500) {
    const batch = fingerprints.slice(start, start + 500);
    const answer = await call(apiKey, `${API}/fingerprints/${MINECRAFT_GAME_ID}`, { body: { fingerprints: batch } });
    for (const match of answer.data?.exactMatches ?? []) {
      if (match.file) found[match.file.fileFingerprint ?? ''] = match.file;
    }
  }
  return found;
}

/**
 * Where a CurseForge file runs, from its "Client" / "Server" tags (newer files carry them), in
 * Modrinth's words so sideOf() reads both alike: { clientSide, serverSide } or nulls.
 */
function sidesOfFile(file) {
  const tags = new Set((file.gameVersions ?? []).map((value) => String(value).toLowerCase()));
  const client = tags.has('client');
  const server = tags.has('server');
  if (!client && !server) return { clientSide: null, serverSide: null };
  return { clientSide: client ? 'required' : 'unsupported', serverSide: server ? 'required' : 'unsupported' };
}

module.exports = {
  matchFingerprints,
  sidesOfFile,
  search,
  getProject,
  getVersions,
  getVersion,
  getFiles,
  getMods,
  toVersion,
  toHit,
  fallbackDownloadUrl,
  MissingCurseForgeKey,
  TYPE_BY_CLASS,
  apiKey,
  builtInApiKey,
};
