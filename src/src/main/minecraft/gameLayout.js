'use strict';

const path = require('node:path');

/**
 * Describes where Minecraft keeps its files inside the game directory.
 * Versions, libraries and assets match the official .minecraft folder and are shared;
 * everything the game itself writes lives in a separate instance folder per version.
 */
function createGameLayout(gameDirectory) {
  const versionsDirectory = path.join(gameDirectory, 'versions');
  const librariesDirectory = path.join(gameDirectory, 'libraries');
  const assetsDirectory = path.join(gameDirectory, 'assets');
  const instancesDirectory = path.join(gameDirectory, 'instances');

  return {
    root: gameDirectory,
    versionsDirectory,
    librariesDirectory,
    assetsDirectory,
    instancesDirectory,
    /**
     * The game's own folder for one version: worlds, options, resource packs, screenshots, logs.
     * Versions never share it, so an old version cannot read or break a newer version's worlds.
     */
    instanceDirectory: (versionId) => path.join(instancesDirectory, versionId),
    /** Home folder given to versions before 1.6: its default game folder is a link to the instance. */
    legacyHomeDirectory: (versionId) => path.join(gameDirectory, 'legacy-home', versionId),
    versionDirectory: (versionId) => path.join(versionsDirectory, versionId),
    versionJsonPath: (versionId) => path.join(versionsDirectory, versionId, `${versionId}.json`),
    clientJarPath: (versionId) => path.join(versionsDirectory, versionId, `${versionId}.jar`),
    nativesDirectory: (versionId) => path.join(versionsDirectory, versionId, 'natives'),
    completeMarkerPath: (versionId) => path.join(versionsDirectory, versionId, '.complete'),
    libraryPath: (relativePath) => path.join(librariesDirectory, ...relativePath.split('/')),
    assetIndexPath: (indexId) => path.join(assetsDirectory, 'indexes', `${indexId}.json`),
    assetObjectPath: (hash) => path.join(assetsDirectory, 'objects', hash.slice(0, 2), hash),
    logConfigPath: (fileId) => path.join(assetsDirectory, 'log_configs', fileId),
    virtualAssetsDirectory: (indexId) => path.join(assetsDirectory, 'virtual', indexId),
  };
}

module.exports = { createGameLayout };
