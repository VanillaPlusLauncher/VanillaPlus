'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { downloadFile } = require('../core/fileDownloader');
const { readJsonFile } = require('../core/jsonFile');
const { runWithConcurrency } = require('../core/taskPool');

const ASSET_BASE_URL = 'https://resources.download.minecraft.net';
const { parallelDownloads } = require('../core/downloadConfig');

/**
 * Downloads the asset index and every object it references.
 * Legacy indexes (virtual / map_to_resources) additionally get a readable copy
 * of each object under their historical folder names in assets/virtual/<index>;
 * map_to_resources versions also need them in their instance folder (see prepareLegacyAssets).
 *
 * `onProgress(fraction)` receives a value between 0 and 1.
 * Returns the folder that `${assets_root}`-style placeholders should use.
 */
async function installAssets({ assetIndex, layout, onProgress }) {
  const indexPath = layout.assetIndexPath(assetIndex.id);
  await downloadFile(assetIndex.url, indexPath, { sha1: assetIndex.sha1, size: assetIndex.size });
  const index = await readJsonFile(indexPath, null);
  if (!index?.objects) {
    throw new Error(`Повреждён индекс ресурсов ${assetIndex.id}.`);
  }

  const objects = Object.entries(index.objects).map(([name, info]) => ({ name, hash: info.hash, size: info.size }));
  let completed = 0;

  await runWithConcurrency(objects, parallelDownloads(2), async (object) => {
    const prefix = object.hash.slice(0, 2);
    await downloadFile(`${ASSET_BASE_URL}/${prefix}/${object.hash}`, layout.assetObjectPath(object.hash), {
      sha1: object.hash,
      size: object.size,
      deepVerify: false,
    });
    completed += 1;
    onProgress?.(completed / objects.length);
  });

  if (index.virtual || index.map_to_resources) {
    const targetRoot = layout.virtualAssetsDirectory(assetIndex.id);
    await placeLegacyObjects(objects, layout, targetRoot);
    return targetRoot;
  }
  return layout.assetsDirectory;
}

/**
 * Puts each object under its readable name. Hard links cost no extra disk space;
 * a copy is used when linking is impossible (another drive, FAT32).
 */
async function placeLegacyObjects(objects, layout, targetRoot) {
  for (const object of objects) {
    const destination = path.join(targetRoot, ...object.name.split('/'));
    try {
      await fsp.access(destination);
      continue;
    } catch {
      // Not placed yet.
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const source = layout.assetObjectPath(object.hash);
    try {
      await fsp.link(source, destination);
    } catch {
      await fsp.copyFile(source, destination);
    }
  }
}

/**
 * Before a legacy version starts: makes sure assets/virtual/<index> is complete (installs made
 * by older launcher builds put the files elsewhere) and, for versions before 1.6
 * (map_to_resources), fills <instance>/resources where they read sounds and music.
 * Already present files are skipped, so this is quick after the first start.
 */
async function prepareLegacyAssets(layout, assetIndexId, gameDirectory) {
  const index = await readJsonFile(layout.assetIndexPath(assetIndexId), null);
  if (!index?.objects || !(index.virtual || index.map_to_resources)) {
    return;
  }
  const objects = Object.entries(index.objects).map(([name, info]) => ({ name, hash: info.hash }));
  await placeLegacyObjects(objects, layout, layout.virtualAssetsDirectory(assetIndexId));
  if (index.map_to_resources) {
    await placeLegacyObjects(objects, layout, path.join(gameDirectory, 'resources'));
  }
}

module.exports = { installAssets, prepareLegacyAssets };
