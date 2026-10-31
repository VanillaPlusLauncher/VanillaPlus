'use strict';

const { request, HttpError } = require('../core/http');

/*
 * Maps from Minecraft Inside (minecraft-inside.ru), a Russian site without an API: read from its list
 * and map pages, which its robots.txt lets programs read. Its search and its download links
 * (/search/, /download/) are closed to programs: there is no search on the site itself (a title is
 * looked for among the newest maps), and a map is downloaded by the player on the site's own page
 * (insideSite.js), from where the launcher takes the file.
 */
const BASE = 'https://minecraft-inside.ru';
const PER_PAGE = 10;
/** A title is looked for among this many list pages (the newest maps). */
const SEARCH_PAGES = 5;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

const decode = (text) => String(text ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const plain = (html) => decode(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const absolute = (url) => (url ? new URL(decode(url), BASE).href : null);

/** A page of the site, kept for a while: the catalog asks again for the same pages while scrolling. */
async function fetchPage(pathname) {
  const hit = cache.get(pathname);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.text;
  const text = await (await request(`${BASE}${pathname}`, { headers: { Accept: 'text/html' } })).text();
  cache.set(pathname, { at: Date.now(), text });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return text;
}

/** "A Shroomy Night [26.3]" (or "… [1.21.11] [1.21.1]") → the name and its Minecraft versions. */
function splitTitle(raw) {
  const name = decode(raw).trim();
  let title = name;
  const versions = [];
  for (let group = title.match(/\s*\[([^\]]+)\]\s*$/); group && /\d+\.\d+/.test(group[1]); group = title.match(/\s*\[([^\]]+)\]\s*$/)) {
    versions.unshift(...group[1].split(/\s*[,;]\s*|\s+-\s+/).filter((value) => /^\d+(\.\d+)+/.test(value)));
    title = title.slice(0, group.index);
  }
  return { title: title || name, versions: [...new Set(versions)] };
}

function toHit({ id, title, versions, cover, author, description, russian }) {
  return {
    platform: 'mcinside',
    id,
    slug: id.replace(/^\d+-/, ''),
    title,
    description,
    author: author ?? '',
    iconUrl: cover,
    downloads: null,
    follows: 0,
    categories: russian ? ['На русском'] : [],
    updatedAt: null,
    gameVersions: versions,
    url: `${BASE}/maps/${id}.html`,
    type: 'world',
  };
}

/** The maps of one list page and how many pages the list has. */
function parseList(html) {
  const hits = [];
  for (const block of html.split('<div class="box box_grass post').slice(1)) {
    const heading = block.match(/<h2 class="box__title"><a href="\/maps\/(\d+-[a-z0-9-]+)\.html">([^<]+)<\/a>/i);
    if (!heading) continue;
    const { title, versions } = splitTitle(heading[2]);
    hits.push(toHit({
      id: heading[1],
      title,
      versions,
      cover: absolute(block.match(/class="post__cover"><img[^>]*src="([^"]+)"/)?.[1]),
      author: decode(block.match(/post__creator">\s*Автор:\s*<a[^>]*>([^<]+)<\/a>/)?.[1] ?? '').trim(),
      description: plain(block.match(/class="post__cover">[\s\S]*?<\/a>\s*(?:<br\s*\/?>)?([\s\S]*?)<\/div>/)?.[1]).slice(0, 400),
      russian: /icon_ru/.test(block),
    }));
  }
  const pages = Number(html.match(/class="last"><a href="\/maps\/(?:[^"]*\/)?page\/(\d+)\//)?.[1] ?? 1);
  return { hits, pages };
}

/** The list for a Minecraft version (its own list on the site) or all maps; page 1 is the list itself. */
function listPath(gameVersion, page) {
  const version = /^\d+\.\d+(\.\d+)?$/.test(String(gameVersion ?? '')) ? `${gameVersion}/` : '';
  return `/maps/${version}${page > 1 ? `page/${page}/` : ''}`;
}

async function readList(gameVersion, page) {
  try {
    return parseList(await fetchPage(listPath(gameVersion, page)));
  } catch (error) {
    // A version the site has no list for: all maps instead.
    if (error instanceof HttpError && error.status === 404 && listPath(gameVersion, 1) !== '/maps/') return parseList(await fetchPage(listPath(null, page)));
    throw error;
  }
}

/** Newest first, PER_PAGE maps a page; a title among the newest SEARCH_PAGES pages. */
async function search({ query = '', gameVersion, offset = 0, limit = 20 }) {
  const wanted = String(query).trim().toLowerCase();
  if (wanted) {
    if (offset > 0) return { hits: [], total: offset };
    const found = [];
    for (let page = 1; page <= SEARCH_PAGES; page += 1) {
      const list = await readList(gameVersion, page);
      found.push(...list.hits.filter((hit) => `${hit.title} ${hit.description}`.toLowerCase().includes(wanted)));
      if (page >= list.pages) break;
    }
    return { hits: found, total: found.length };
  }
  const start = await seek(gameVersion, offset);
  const hits = start.list.hits.slice(start.skip);
  let { page, list } = start;
  while (hits.length < limit && page < list.pages) {
    page += 1;
    list = await readList(gameVersion, page);
    hits.push(...list.hits);
  }
  // The real count once the last page is read; until then as many as the pages would hold.
  return { hits, total: page >= list.pages ? offset + hits.length : list.pages * PER_PAGE };
}

/**
 * Where `offset` falls in a list: its page, how many of that page's maps were shown already, and the
 * page itself. Pages hold up to PER_PAGE maps, sometimes fewer, so they are counted (they are cached).
 */
async function seek(gameVersion, offset) {
  let before = 0;
  for (let page = 1; ; page += 1) {
    const list = await readList(gameVersion, page);
    if (before + list.hits.length > offset || page >= list.pages) return { page, skip: Math.max(0, offset - before), list };
    before += list.hits.length;
  }
}

function assertId(id) {
  const value = String(id ?? '');
  if (!/^\d+-[a-z0-9-]+$/i.test(value)) throw new Error('Неизвестная карта.');
  return value;
}

/** The download rows of a map page: "Для 26.3", the size and date, the site's download link. */
function parseFiles(html, id) {
  const table = html.match(/<table class="dl">([\s\S]*?)<\/table>/)?.[1] ?? '';
  return [...table.matchAll(/<tr class="dl__row">([\s\S]*?)<\/tr>/g)].map(([, row]) => {
    const link = row.match(/href="(https?:\/\/minecraft-inside\.ru\/download\/(\d+)\/)"/);
    if (!link) return null;
    const name = plain(row.match(/class="dl__name">([\s\S]*?)<\/span>/)?.[1]) || 'Карта';
    const sizeText = plain(row.match(/class="dl__size">([\s\S]*?)<\/td>/)?.[1]);
    const size = Number(sizeText.replace(/\s/g, '').replace(',', '.').match(/[\d.]+/)?.[0] ?? 0) * (/ГБ/i.test(sizeText) ? 1024 ** 3 : /МБ/i.test(sizeText) ? 1024 ** 2 : /КБ/i.test(sizeText) ? 1024 : 1);
    return {
      platform: 'mcinside',
      id: link[2],
      projectId: id,
      name,
      versionNumber: name,
      type: 'release',
      date: null,
      downloads: Number(row.match(/Скачиваний:\s*(\d+)/)?.[1] ?? 0),
      gameVersions: [...name.matchAll(/\d+\.\d+(?:\.\d+)?/g)].map((match) => match[0]),
      loaders: [],
      // Downloaded by the player on the site's page (insideSite.js), never by the launcher itself.
      files: [{ url: link[1], filename: null, size: Math.round(size) || null, sha1: null, primary: true }],
      dependencies: [],
    };
  }).filter(Boolean);
}

async function getProject(id) {
  const html = await fetchPage(`/maps/${assertId(id)}.html`);
  const { title, versions } = splitTitle(html.match(/<h1 class="box__title">([^<]+)<\/h1>/)?.[1] ?? id);
  const body = html.match(/<h1 class="box__title">[\s\S]*?<div class="box__body">([\s\S]*?)<h2>(?:Скриншоты|Как установить|Скачать)/)?.[1] ?? '';
  // Pictures and links of the description point at the site, not at the launcher.
  const description = body.replace(/^\s*<img[^>]*>/, '').replace(/<h2>Описание<\/h2>/, '').replace(/(src|href)="(\/[^"]*)"/g, (_all, attribute, url) => `${attribute}="${BASE}${url}"`).trim();
  const cover = absolute(body.match(/^\s*<img[^>]*src="([^"]+)"/)?.[1]);
  const gallery = [...html.matchAll(/data-big="([^"]+)"/g)].map((match) => ({ url: absolute(match[1]), title: '' }));
  const hit = toHit({ id, title, versions, cover, author: decode(html.match(/post__creator">\s*Автор:\s*<a[^>]*>([^<]+)<\/a>/)?.[1] ?? '').trim(), description: plain(description).slice(0, 400), russian: /icon_ru/.test(html) });
  return {
    ...hit,
    body: description,
    bodyFormat: 'html',
    gallery,
    links: { site: hit.url, source: null, issues: null, wiki: null, discord: null },
    loaders: [],
    license: null,
    files: parseFiles(html, id),
  };
}

/** The map's files, those for `gameVersion` first. */
async function getVersions(id, { gameVersion } = {}) {
  const { files } = await getProject(id);
  if (!gameVersion) return files;
  return [...files].sort((a, b) => Number(b.gameVersions.includes(gameVersion)) - Number(a.gameVersions.includes(gameVersion)));
}

async function getVersion(id, fileId) {
  return (await getProject(id)).files.find((file) => file.id === String(fileId)) ?? null;
}

module.exports = { search, getProject, getVersions, getVersion, parseList, parseFiles, BASE };
