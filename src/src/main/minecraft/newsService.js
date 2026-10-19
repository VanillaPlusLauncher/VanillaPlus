'use strict';

const path = require('node:path');
const { fetchJson } = require('../core/http');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { getAppPaths } = require('../core/paths');
const { createLogger } = require('../core/logger');

/** Minecraft news as the official launcher shows them (titles, text and pictures from Mojang). */
const NEWS_URL = 'https://launchercontent.mojang.com/v2/news.json';
const CONTENT_BASE = 'https://launchercontent.mojang.com';
const MEMORY_TTL_MS = 30 * 60 * 1000;
const log = createLogger('news');
let memory = null;

function cacheFile() {
  return path.join(getAppPaths().root, 'cache', 'news.json');
}

function toArticle(entry) {
  const image = entry.newsPageImage?.url ?? entry.playPageImage?.url;
  return {
    id: entry.id,
    title: String(entry.title ?? '').trim(),
    text: entry.text ?? '',
    tag: entry.tag ?? '',
    category: entry.category ?? '',
    date: entry.date ?? null,
    image: image ? `${CONTENT_BASE}${image}` : null,
    url: entry.readMoreLink ?? null,
    java: entry.category === 'Minecraft: Java Edition' || (entry.newsType ?? []).includes('Java'),
  };
}

/** Java Edition news first, then the rest; newest first inside each group. */
async function getNews({ limit = 12 } = {}) {
  if (memory && Date.now() - memory.at < MEMORY_TTL_MS) {
    return memory.articles.slice(0, limit);
  }
  let entries;
  try {
    const feed = await fetchJson(NEWS_URL);
    entries = feed.entries ?? [];
    await writeJsonFileAtomic(cacheFile(), entries).catch(() => {});
  } catch (error) {
    log.warn(`Новости недоступны: ${error.message}`);
    entries = (await readJsonFile(cacheFile(), null)) ?? [];
  }
  const articles = entries
    .map(toArticle)
    .filter((article) => article.title && article.image)
    .sort((a, b) => Number(b.java) - Number(a.java) || (b.date ?? '').localeCompare(a.date ?? ''));
  memory = { articles, at: Date.now() };
  return articles.slice(0, limit);
}

module.exports = { getNews };
