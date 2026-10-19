'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');

/**
 * Extracts native libraries (DLLs) into a clean natives folder.
 * `nativeEntries` items: { jarPath, exclude: string[] }.
 * Entries are flattened into the folder, as the game expects.
 */
async function extractNatives(nativeEntries, nativesDirectory) {
  await fsp.rm(nativesDirectory, { recursive: true, force: true });
  await fsp.mkdir(nativesDirectory, { recursive: true });

  for (const entry of nativeEntries) {
    const archive = new AdmZip(entry.jarPath);
    for (const zipEntry of archive.getEntries()) {
      if (zipEntry.isDirectory || isExcluded(zipEntry.entryName, entry.exclude)) {
        continue;
      }
      const target = path.join(nativesDirectory, path.basename(zipEntry.entryName));
      await fsp.writeFile(target, zipEntry.getData());
    }
  }
}

function isExcluded(entryName, excludePatterns = []) {
  return excludePatterns.some((pattern) => entryName === pattern || entryName.startsWith(pattern));
}

module.exports = { extractNatives };
