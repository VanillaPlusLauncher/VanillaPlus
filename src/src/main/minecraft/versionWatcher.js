'use strict';

const path = require('node:path');
const { broadcast } = require('../core/broadcast');
const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { CHANNELS } = require('../../shared/channels');
const { getSettings } = require('../settings/settingsService');
const { getVersionManifest } = require('./versionManifest');

/*
 * Notices new Minecraft versions while the launcher runs: Mojang's version list is read again
 * every half hour, the window refreshes its catalog and announces a new release (and a new
 * snapshot, when snapshots are shown). The last versions seen are remembered between starts,
 * so a release that came out while the launcher was closed is announced once on the next start.
 */

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15000;
const log = createLogger('versions-watch');
let timer = null;

function seenFile() {
  return path.join(getAppPaths().root, 'cache', 'latest-minecraft.json');
}

async function checkForNewVersions() {
  let manifest;
  try {
    manifest = await getVersionManifest({ force: true });
  } catch (error) {
    log.warn(`Список версий Minecraft не обновлён: ${error.message}`);
    return [];
  }
  const latest = manifest.latest ?? {};
  const seen = await readJsonFile(seenFile(), null);
  await writeJsonFileAtomic(seenFile(), { release: latest.release ?? null, snapshot: latest.snapshot ?? null });
  // Always refresh the window's list: a new version must be pickable at once.
  broadcast(CHANNELS.events.versionsChanged, { latest });
  if (!seen) {
    // First start: nothing to compare with yet.
    return [];
  }
  const settings = await getSettings().catch(() => null);
  const found = [];
  if (latest.release && latest.release !== seen.release) {
    found.push({ id: latest.release, type: 'release' });
  }
  if (latest.snapshot && latest.snapshot !== seen.snapshot && latest.snapshot !== latest.release && settings?.versionFilters?.snapshot) {
    found.push({ id: latest.snapshot, type: 'snapshot' });
  }
  for (const version of found) {
    log.info(`Вышла новая версия Minecraft: ${version.id} (${version.type})`);
    broadcast(CHANNELS.events.minecraftReleased, version);
  }
  return found;
}

function startVersionWatch() {
  setTimeout(() => checkForNewVersions().catch(() => {}), FIRST_CHECK_DELAY_MS);
  clearInterval(timer);
  timer = setInterval(() => checkForNewVersions().catch(() => {}), CHECK_INTERVAL_MS);
}

module.exports = { startVersionWatch, checkForNewVersions };
