'use strict';

const fsp = require('node:fs/promises');
const { readJsonFile } = require('../core/jsonFile');

/** Scans the versions folder and returns fully installed versions (those with a completion marker). */
async function listInstalledVersions(layout) {
  let entries;
  try {
    entries = await fsp.readdir(layout.versionsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !(await isComplete(layout, entry.name))) {
      continue;
    }
    const descriptor = await readJsonFile(layout.versionJsonPath(entry.name), null);
    if (!descriptor) {
      continue;
    }
    installed.push({
      id: entry.name,
      type: descriptor.type ?? 'release',
      releaseTime: descriptor.releaseTime ?? null,
      javaMajorVersion: descriptor.javaVersion?.majorVersion ?? 8,
    });
  }
  return installed;
}

async function isComplete(layout, versionId) {
  try {
    await fsp.access(layout.completeMarkerPath(versionId));
    return true;
  } catch {
    return false;
  }
}

module.exports = { listInstalledVersions, isComplete };
