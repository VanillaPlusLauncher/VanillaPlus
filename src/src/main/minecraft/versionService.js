'use strict';

const { SerialQueue } = require('../core/serialQueue');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { createGameLayout } = require('./gameLayout');
const { listRemoteVersions } = require('./versionManifest');
const { listInstalledVersions, isComplete } = require('./installedVersions');
const { installVersion, removeVersion } = require('./versionInstaller');

/** One install at a time: installs share library and asset folders. */
const installQueue = new SerialQueue();
const pendingInstalls = new Map();
const log = createLogger('versions');

/** Mojang catalog merged with local install state. */
async function getCatalog(settings, { force = false } = {}) {
  const [remote, installed] = await Promise.all([
    listRemoteVersions({ force }),
    listInstalledVersions(createGameLayout(settings.gameDirectory)),
  ]);
  const installedIds = new Set(installed.map((version) => version.id));
  return {
    versions: remote.map((version) => ({
      ...version,
      installed: installedIds.has(version.id),
      installing: pendingInstalls.has(version.id),
    })),
  };
}

function listInstalled(settings) {
  return listInstalledVersions(createGameLayout(settings.gameDirectory));
}

/** Installs a version unless it is already complete. Concurrent calls for one version share the work. */
function ensureVersionInstalled(versionId, settings) {
  const existing = pendingInstalls.get(versionId);
  if (existing) {
    return existing;
  }
  const work = installQueue.run(async () => {
    const layout = createGameLayout(settings.gameDirectory);
    if (await isComplete(layout, versionId)) {
      return;
    }
    const reporter = createTaskReporter({ taskId: `version:${versionId}`, kind: 'version', label: versionId });
    try {
      await installVersion({ versionId, layout, settings, reporter });
      reporter.finish('done', 'Установлено');
    } catch (error) {
      log.error(`Установка ${versionId} не удалась: ${error.stack ?? error.message}`);
      reporter.finish('error', error.message);
      throw error;
    }
  });
  pendingInstalls.set(versionId, work);
  work.finally(() => pendingInstalls.delete(versionId)).catch(() => {});
  return work;
}

function uninstallVersion(versionId, settings) {
  return installQueue.run(async () => {
    await removeVersion(createGameLayout(settings.gameDirectory), versionId);
    log.info(`Версия ${versionId} удалена`);
  });
}

function isInstallPending(versionId) {
  return pendingInstalls.has(versionId);
}

module.exports = {
  getCatalog,
  listInstalled,
  ensureVersionInstalled,
  uninstallVersion,
  isInstallPending,
};
