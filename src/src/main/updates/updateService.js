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
const { isLegacyBuild } = require('../core/system');

/*
 * Launcher updates.
 *
 * Every release publishes, next to its installer, a small "latest.json":
 *   { "version": "1.3.1", "date": "2026-10-20", "notes": "что нового…",
 *     "installer": { "url": "https://…/Amethyx-Setup-1.3.1.exe", "sha256": "…", "size": 178000000 } }
 * (installer/publish-site.ps1 writes it). The launcher reads that file on start and every few
 * hours, downloads a newer installer in the background and checks its SHA-256. Then it updates by
 * itself, with no installer pages and no buttons: as soon as nothing is running (no game, server
 * or download) it says so for a few seconds, closes, the installer puts the new files in place in
 * a small window of its own and opens the launcher again. "Later" leaves it for the next start,
 * which installs it before the window opens. Worlds, instances and settings live elsewhere and
 * are not touched.
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
/**
 * The build for Windows 7 and 8 (Electron 22) has feeds of its own: the usual installer would not
 * start there. GitHub's latest.json is never asked by it for the same reason.
 */
const SITE_LEGACY_FEED_URL = 'https://launcher.x-world.plus/updates/latest-win7.json';
const SITE_LEGACY_BETA_FEED_URL = 'https://launcher.x-world.plus/updates/beta-win7.json';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8000;
/** How long "the launcher restarts to update" is shown before it does, and how often a busy launcher is asked again. */
const RESTART_NOTICE_MS = 6000;
const BUSY_RETRY_MS = 20 * 1000;
const log = createLogger('updates');
/** Plain http is accepted only for a local test server named in AMETHYX_UPDATE_FEED. */
const LOCAL_TEST_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i;

function isAllowedUrl(url) {
  return /^https:\/\//i.test(url) || (Boolean(process.env.AMETHYX_UPDATE_FEED) && LOCAL_TEST_URL.test(url));
}

/**
 * state: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'restarting' | 'error' | 'disabled'
 * ('restarting': the launcher closes to update at restartAt unless the player says "later").
 */
let status = { state: 'idle', currentVersion: null, latest: null, progress: 0, checkedAt: null, error: null, installerPath: null, restartAt: null };
let timer = null;
let downloading = null;
let autoTimer = null;
/** "Later" was pressed: this run does not restart by itself any more. */
let postponed = false;
/** Whether something is going on that an update must not cut off (set by startUpdateChecks). */
let isBusy = () => false;

function setStatus(patch) {
  status = { ...status, ...patch };
  broadcast(CHANNELS.events.updateStatus, publicStatus());
}

/** autoRestart: the launcher is about to update by itself (so there is nothing to press); postponed: "later" was pressed. */
function publicStatus() {
  return {
    ...status,
    currentVersion: app.getVersion(),
    installerPath: undefined,
    canInstall: status.state === 'ready' || status.state === 'restarting',
    autoRestart: status.state === 'restarting' || (status.state === 'ready' && autoTimer !== null),
    postponed,
  };
}

/**
 * 1.10 > 1.9.3; "1.7" is the same as "1.7.0"; a pre-release tail ("1.7-beta.28") is older than the
 * plain version, and beta.29 is newer than beta.28.
 */
function compareVersions(a, b) {
  const parse = (value) => {
    const text = String(value).trim().replace(/^v/i, '').split('+')[0];
    const dash = text.indexOf('-');
    const numbers = (dash < 0 ? text : text.slice(0, dash)).split('.').map((part) => Number.parseInt(part, 10) || 0);
    while (numbers.length < 3) numbers.push(0);
    return { numbers, tail: dash < 0 ? [] : text.slice(dash + 1).split('.') };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const x = left.numbers[index] ?? 0;
    const y = right.numbers[index] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (left.tail.length === 0 || right.tail.length === 0) return Math.sign(right.tail.length - left.tail.length);
  for (let index = 0; index < Math.max(left.tail.length, right.tail.length); index += 1) {
    const x = left.tail[index];
    const y = right.tail[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric && Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    if (!numeric && x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Where to look: one address set by hand (settings or AMETHYX_UPDATE_FEED), else the site and GitHub. */
function feedUrls(settings) {
  const custom = settings.updates?.feedUrl || process.env.AMETHYX_UPDATE_FEED;
  if (custom) return [custom];
  const beta = /-beta\b/i.test(app.getVersion());
  if (isLegacyBuild()) return [SITE_LEGACY_FEED_URL, ...(beta ? [SITE_LEGACY_BETA_FEED_URL] : [])];
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

function installerPathFor(version) {
  return path.join(updatesDirectory(), `Amethyx-Setup-${String(version).replace(/[^\w.-]/g, '')}.exe`);
}

/**
 * Next to the installer: pending.json, the feed entry of the downloaded version (the next start
 * installs it from there), and attempt.json, the version whose installer was last started. A
 * version already tried is not started by itself again: if its install failed, the old launcher
 * would otherwise close and reopen for ever. The button in Settings still installs it.
 */
const PENDING_FILE = 'pending.json';
const ATTEMPT_FILE = 'attempt.json';

async function readUpdateFile(name) {
  try {
    return JSON.parse(await fsp.readFile(path.join(updatesDirectory(), name), 'utf8'));
  } catch {
    return null;
  }
}

async function writeUpdateFile(name, value) {
  await fsp.mkdir(updatesDirectory(), { recursive: true });
  await fsp.writeFile(path.join(updatesDirectory(), name), JSON.stringify(value), 'utf8');
}

async function alreadyTried(version) {
  return (await readUpdateFile(ATTEMPT_FILE))?.version === version;
}

/** Whether this run may update itself: a packaged Windows launcher, not a test or screenshot run. */
function selfUpdating() {
  return process.platform === 'win32' && (app.isPackaged || Boolean(process.env.AMETHYX_UPDATE_FEED)) && !process.env.AMETHYX_SCREENSHOT && !process.env.AMETHYX_MAIN_SCRIPT;
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
  if (['checking', 'downloading', 'restarting'].includes(status.state)) {
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
    const target = installerPathFor(latest.version);
    // Installers of older updates are not needed any more.
    for (const name of await fsp.readdir(directory).catch(() => [])) {
      if (path.join(directory, name) !== target && name !== PENDING_FILE && name !== ATTEMPT_FILE) {
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
    await writeUpdateFile(PENDING_FILE, latest).catch(() => {});
    if (!postponed) scheduleAutoInstall(1000);
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
 * Runs the downloaded installer and quits. With /relaunch=1 the installer shows no pages and no
 * buttons, only a small "updating" window: it waits for the launcher to close, replaces its files
 * and starts it again (see installer/Amethyx.iss).
 */
async function installUpdate({ isGameRunning = () => false } = {}) {
  if (!['ready', 'restarting'].includes(status.state) || !status.installerPath) {
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
  clearTimeout(autoTimer);
  autoTimer = null;
  await writeUpdateFile(ATTEMPT_FILE, { version: status.latest.version, at: new Date().toISOString() }).catch(() => {});
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

/**
 * Updates by itself once the installer is ready: when nothing is running, "restarting" is shown
 * for a few seconds and the launcher closes to update; while a game, a server or a download is
 * on, it asks again a little later.
 */
function scheduleAutoInstall(delay = BUSY_RETRY_MS) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    autoTimer = null;
    const settings = await getSettings().catch(() => null);
    const auto = status.state === 'ready' && !postponed && settings?.updates?.autoInstall !== false && selfUpdating();
    if (!auto || (await alreadyTried(status.latest.version))) {
      // Not by itself after all: the window offers the button instead.
      setStatus({});
      return;
    }
    if (isBusy()) {
      scheduleAutoInstall();
      return;
    }
    log.info(`Лаунчер перезапустится для обновления до ${status.latest.version}`);
    setStatus({ state: 'restarting', restartAt: Date.now() + RESTART_NOTICE_MS });
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (status.state !== 'restarting') return;
      if (isBusy()) {
        scheduleAutoInstall();
        setStatus({ state: 'ready', restartAt: null });
        return;
      }
      installUpdate({ isGameRunning: isBusy }).catch((error) => {
        log.warn(`Обновление не запущено: ${error.message}`);
        if (status.state === 'restarting') setStatus({ state: 'ready', restartAt: null });
      });
    }, RESTART_NOTICE_MS);
  }, delay);
}

/** "Later": no restart in this run; the next start installs the update. */
function postponeUpdate() {
  clearTimeout(autoTimer);
  autoTimer = null;
  postponed = true;
  if (status.state === 'restarting') setStatus({ state: 'ready', restartAt: null });
  log.info('Обновление отложено до следующего запуска');
  return publicStatus();
}

/**
 * On start, before the window opens: an update downloaded in an earlier run is installed at
 * once (the launcher closes, the installer's small window shows, the new version opens).
 * Returns true when the launcher is closing for it. A leftover of an installed update is removed.
 */
async function installPendingAtStart() {
  if (!selfUpdating()) return false;
  const pending = await readUpdateFile(PENDING_FILE);
  if (!pending?.version || !pending.installer?.sha256) return false;
  const installerPath = installerPathFor(pending.version);
  if (compareVersions(pending.version, app.getVersion()) <= 0) {
    await fsp.rm(installerPath, { force: true }).catch(() => {});
    await fsp.rm(path.join(updatesDirectory(), PENDING_FILE), { force: true }).catch(() => {});
    return false;
  }
  const settings = await getSettings().catch(() => null);
  if (settings?.updates?.autoInstall === false || (await alreadyTried(pending.version))) return false;
  if (!(await fsp.stat(installerPath).catch(() => null))) return false;
  // installUpdate checks the file's SHA-256 before it runs it.
  status = { ...status, state: 'ready', latest: pending, installerPath, progress: 100 };
  log.info(`При запуске ставится скачанное ранее обновление ${pending.version}`);
  await installUpdate();
  return true;
}

/**
 * Starts the automatic checks (on start and every few hours). `busy` says whether a game, a
 * server or a download is running: the launcher does not close for an update then.
 */
function startUpdateChecks({ busy } = {}) {
  if (typeof busy === 'function') isBusy = busy;
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

module.exports = {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  postponeUpdate,
  installPendingAtStart,
  startUpdateChecks,
  getUpdateStatus,
  compareVersions,
  DEFAULT_FEED_URL,
};
