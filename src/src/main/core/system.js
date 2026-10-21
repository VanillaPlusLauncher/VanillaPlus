'use strict';

const os = require('node:os');

/*
 * What kind of computer the launcher runs on, for choices made before anything is set:
 *   legacy build  — the build for Windows 7 and 8, on Electron 22 (the last one that runs there);
 *   legacy Windows — Windows 7, 8 or 8.1 (NT 6.1–6.3);
 *   light system  — legacy Windows or 4 GB of memory and less: animations, blur and music start
 *                   off there, and Chromium runs in its low-memory mode.
 */

const MEGABYTE = 1024 * 1024;

function isLegacyWindows() {
  if (process.platform !== 'win32') return false;
  const [major] = os.release().split('.').map(Number);
  return major === 6;
}

function isLegacyBuild() {
  return Number(String(process.versions.electron ?? '99').split('.')[0]) < 23;
}

/** AMETHYX_LIGHT=1 / 0 forces it either way (to try the light start on any computer). */
function isLightSystem() {
  if (process.env.AMETHYX_LIGHT === '1') return true;
  if (process.env.AMETHYX_LIGHT === '0') return false;
  return isLegacyWindows() || os.totalmem() / MEGABYTE <= 4096 + 256;
}

module.exports = { isLegacyWindows, isLegacyBuild, isLightSystem };
