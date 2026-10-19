'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { createLogger } = require('../core/logger');

const RELEASES_URL = 'https://api.github.com/repos/yushijinhun/authlib-injector/releases/latest';
const MIRROR_URL = 'https://authlib-injector.yushi.moe/artifact/latest.json';
const JAR_PATTERN = /^authlib-injector-.+\.jar$/;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const log = createLogger('authlib-injector');

/** Latest release as { name, url, size? }: GitHub first, the project's own site when GitHub refuses (rate limit). */
async function findLatestRelease() {
  try {
    const release = await fetchJson(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
    const asset = release.assets?.find((candidate) => JAR_PATTERN.test(candidate.name));
    if (asset) {
      return { name: asset.name, url: asset.browser_download_url, size: asset.size };
    }
    throw new Error('в релизе нет jar-файла');
  } catch (githubError) {
    log.warn(`GitHub недоступен (${githubError.message}), пробуем authlib-injector.yushi.moe`);
    const artifact = await fetchJson(MIRROR_URL);
    if (!artifact?.download_url || !artifact?.version) {
      throw new Error('сайт authlib-injector вернул неполный ответ');
    }
    return { name: `authlib-injector-${artifact.version}.jar`, url: artifact.download_url };
  }
}

/**
 * Makes sure the latest authlib-injector jar is in the tools folder and returns its path.
 * Falls back to an already downloaded jar when the network is unreachable.
 */
async function ensureAuthlibInjector(toolsDirectory) {
  await fsp.mkdir(toolsDirectory, { recursive: true });
  const cached = (await fsp.readdir(toolsDirectory)).filter((name) => JAR_PATTERN.test(name)).sort();
  const newestCached = cached.length > 0 ? path.join(toolsDirectory, cached.at(-1)) : null;
  // GitHub's API allows only a few unauthenticated requests per hour: check for updates once a day at most.
  if (newestCached) {
    const stat = await fsp.stat(newestCached);
    if (Date.now() - stat.mtimeMs < CHECK_INTERVAL_MS) {
      return newestCached;
    }
  }
  try {
    const release = await findLatestRelease();
    const target = path.join(toolsDirectory, release.name);
    await downloadFile(release.url, target, { size: release.size, deepVerify: false });
    // The mtime marks the last update check, also when the jar was already up to date.
    const now = new Date();
    await fsp.utimes(target, now, now);
    await Promise.all(
      cached.filter((name) => name !== release.name).map((name) => fsp.rm(path.join(toolsDirectory, name), { force: true })),
    );
    return target;
  } catch (error) {
    if (newestCached) {
      log.warn(`Не удалось обновить authlib-injector (${error.message}), используем сохранённую версию`);
      return newestCached;
    }
    throw new Error(`Не удалось загрузить authlib-injector для скинов: ${error.message}`);
  }
}

module.exports = { ensureAuthlibInjector };
