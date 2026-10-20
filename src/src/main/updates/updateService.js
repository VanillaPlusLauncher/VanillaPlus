'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { broadcast } = require('../core/broadcast');
const { createLogger } = require('../core/logger');
const { CHANNELS } = require('../../shared/channels');
const { getSettings } = require('../settings/settingsService');

/*
 * Launcher updates.
 *
 * Every release publishes, next to its installer, a small "latest.json":
 *   { "version": "1.3.1", "date": "2026-10-20", "notes": "что нового…",
 *     "installer": { "url": "https://…/Amethyx-Setup-1.3.1.exe", "sha256": "…", "size": 178000000 } }
 * (installer/publish-update.ps1 writes it). The launcher reads that file on start and every few
 * hours, downloads a newer installer in the background, checks its SHA-256 and, when the user
 * agrees (or on the next exit), runs it silently: the installer replaces the files and starts
 * the launcher again. Worlds, instances and settings live elsewhere and are not touched.
 */

/** The built-in address of latest.json: the asset of the newest release on GitHub. */
const DEFAULT_FEED_URL = 'https://github.com/VanillaPlusLauncher/VanillaPlus/releases/latest/download/latest.json';
/**
 * The site's own feeds (its admin panel publishes them, same format): the released version, and
 * the newest test build for those who already run a beta. Both sources are asked, the newest
 * version wins, and one being down does not stop updates from the other.
 */
const SITE_FEED_URL = 'https://launcher.x-world.plus/updates/latest.json';
const SITE_BETA_FEED_URL = 'https://launcher.x-world.plus/updates/beta.json';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8000;
const log = createLogger('updates');
/** Plain http is accepted only for a local test server named in AMETHYX_UPDATE_FEED. */
const LOCAL_TEST_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i;

function isAllowedUrl(url) {
  return /^https:\/\//i.test(url) || (Boolean(process.env.AMETHYX_UPDATE_FEED) && LOCAL_TEST_URL.test(url));
}

/**
 * state: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled'
 */
let status = { state: 'idle', currentVersion: null, latest: null, progress: 0, checkedAt: null, error: null, installerPath: null };
let timer = null;
let downloading = null;

function setStatus(patch) {
  status = { ...status, ...patch };
  broadcast(CHANNELS.events.updateStatus, publicStatus());
}

function publicStatus() {
  return { ...status, currentVersion: app.getVersion(), installerPath: undefined, canInstall: status.state === 'ready' };
}

/** 1.10.0 > 1.9.3; pre-release tails ("-beta") count as older than the plain version. */
function compareVersions(a, b) {
  const parse = (value) => String(value).replace(/^v/i, '').split(/[.+-]/);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return /^\d+$/.test(y) ? -1 : 1;
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** Where to look: one address set by hand (settings or AMETHYX_UPDATE_FEED), else the site and GitHub. */
function feedUrls(settings) {
  const custom = settings.updates?.feedUrl || process.env.AMETHYX_UPDATE_FEED;
  if (custom) return [custom];
  const beta = /-beta\b/i.test(app.getVersion());
  return [SITE_FEED_URL, ...(beta ? [SITE_BETA_FEED_URL] : []), DEFAULT_FEED_URL];
}

/** The newest version any feed offers; fails only when every feed failed. */
async function readNewestFeed(urls) {
  const results = await Promise.allSettled(urls.map((url) => readFeed(url).then((feed) => ({ ...feed, source: url }))));
  const found = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  for (const result of results) {
    if (result.status === 'rejected') log.info(`Источник обновлений не ответил: ${result.reason?.message ?? result.reason}`);
  }
  if (found.length === 0) throw results.find((result) => result.status === 'rejected')?.reason ?? new Error('Нет источников обновлений.');
  return found.reduce((best, feed) => (compareVersions(feed.version, best.version) > 0 ? feed : best));
}

function updatesDirectory() {
  return path.join(app.getPath('userData'), 'updates');
}

/** Reads latest.json and checks what it describes. */
async function readFeed(url) {
  const feed = await fetchJson(url, { headers: { 'Cache-Control': 'no-cache' } });
  const version = String(feed?.version ?? '').trim();
  const installer = feed?.installer ?? {};
  if (!/^\d+\.\d+(\.\d+)?([.+-][\w.]+)?$/.test(version)) {
    throw new Error('В файле обновлений нет версии.');
  }
  if (!isAllowedUrl(String(installer.url ?? ''))) {
    throw new Error('В файле обновлений нет ссылки на установщик.');
  }
  if (!/^[0-9a-f]{64}$/i.test(String(installer.sha256 ?? ''))) {
    throw new Error('В файле обновлений нет контрольной суммы установщика.');
  }
  return {
    version,
    date: feed.date ?? null,
    notes: typeof feed.notes === 'string' ? feed.notes.slice(0, 4000) : '',
    installer: { url: installer.url, sha256: installer.sha256.toLowerCase(), size: Number(installer.size) || null },
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Looks for a newer version. `manual` checks are reported even when nothing is found; automatic
 * ones download the installer at once when settings allow it.
 */
async function checkForUpdates({ manual = false } = {}) {
  const settings = await getSettings();
  const urls = feedUrls(settings);
  // Updates come as a Windows installer: other systems update by hand for now.
  if (urls.length === 0 || process.platform !== 'win32') {
    setStatus({ state: 'disabled', error: null });
    return publicStatus();
  }
  if (['checking', 'downloading'].includes(status.state)) {
    return publicStatus();
  }
  setStatus({ state: 'checking', error: null });
  try {
    const latest = await readNewestFeed(urls);
    const checkedAt = new Date().toISOString();
    if (compareVersions(latest.version, app.getVersion()) <= 0) {
      setStatus({ state: 'latest', latest, checkedAt });
      log.info(`Обновлений нет (${app.getVersion()} — последняя)`);
      return publicStatus();
    }
    log.info(`Доступна версия ${latest.version}`);
    setStatus({ state: 'available', latest, checkedAt });
    if (settings.updates?.autoDownload || manual) {
      downloadUpdate().catch(() => {});
    }
  } catch (error) {
    log.warn(`Проверка обновлений не удалась: ${error.message}`);
    setStatus({ state: 'error', error: error.message, checkedAt: new Date().toISOString() });
  }
  return publicStatus();
}

/** Downloads the installer of the found version and checks it. */
function downloadUpdate() {
  if (downloading) {
    return downloading;
  }
  const latest = status.latest;
  if (!latest) {
    return Promise.reject(new Error('Сначала проверьте обновления.'));
  }
  downloading = (async () => {
    const directory = updatesDirectory();
    await fsp.mkdir(directory, { recursive: true });
    const target = path.join(directory, `Amethyx-Setup-${latest.version.replace(/[^\w.-]/g, '')}.exe`);
    // Installers of older updates are not needed any more.
    for (const name of await fsp.readdir(directory).catch(() => [])) {
      if (path.join(directory, name) !== target) {
        await fsp.rm(path.join(directory, name), { force: true, recursive: true }).catch(() => {});
      }
    }
    const ready = await fsp
      .stat(target)
      .then(async () => (await sha256File(target)) === latest.installer.sha256)
      .catch(() => false);
    if (!ready) {
      setStatus({ state: 'downloading', progress: 0 });
      await downloadFile(latest.installer.url, target, {
        size: latest.installer.size ?? undefined,
        deepVerify: false,
        retries: 2,
        onProgress: (received, total) => {
          const progress = Math.round((received / (total || latest.installer.size || received)) * 100);
          if (progress !== status.progress) {
            setStatus({ progress });
          }
        },
      });
      const actual = await sha256File(target);
      if (actual !== latest.installer.sha256) {
        await fsp.rm(target, { force: true });
        throw new Error('Скачанный установщик повреждён (не совпала контрольная сумма). Попробуйте ещё раз.');
      }
    }
    log.info(`Установщик ${latest.version} готов: ${target}`);
    setStatus({ state: 'ready', progress: 100, installerPath: target });
    return publicStatus();
  })()
    .catch((error) => {
      log.warn(`Обновление не скачано: ${error.message}`);
      setStatus({ state: 'error', error: error.message });
      throw error;
    })
    .finally(() => {
      downloading = null;
    });
  return downloading;
}

/**
 * Runs the downloaded installer silently and quits. The installer waits for the launcher to close,
 * replaces its files and starts it again (/relaunch=1, see installer/Amethyx.iss).
 */
async function installUpdate({ isGameRunning = () => false } = {}) {
  if (status.state !== 'ready' || !status.installerPath) {
    throw new Error('Обновление ещё не скачано.');
  }
  if (isGameRunning()) {
    throw new Error('Закройте игру, а потом обновите лаунчер.');
  }
  // The file is checked again right before it runs.
  if ((await sha256File(status.installerPath)) !== status.latest.installer.sha256) {
    setStatus({ state: 'error', error: 'Установщик изменился после загрузки. Скачайте обновление заново.' });
    throw new Error('Установщик изменился после загрузки.');
  }
  log.info(`Запуск установщика ${status.latest.version}`);
  const child = spawn(status.installerPath, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/relaunch=1'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  setTimeout(() => app.quit(), 300);
  return { installing: true };
}

/** Starts the automatic checks (on start and every few hours). */
function startUpdateChecks() {
  if (!app.isPackaged && !process.env.AMETHYX_UPDATE_FEED) {
    // A development run never updates itself.
    setStatus({ state: 'disabled' });
    return;
  }
  const run = async () => {
    const settings = await getSettings().catch(() => null);
    if (settings?.updates?.autoCheck !== false) {
      await checkForUpdates();
    }
  };
  setTimeout(run, FIRST_CHECK_DELAY_MS);
  clearInterval(timer);
  timer = setInterval(run, CHECK_INTERVAL_MS);
}

function getUpdateStatus() {
  return publicStatus();
}

module.exports = { checkForUpdates, downloadUpdate, installUpdate, startUpdateChecks, getUpdateStatus, compareVersions, DEFAULT_FEED_URL };
