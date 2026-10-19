'use strict';

const { SerialQueue } = require('../core/serialQueue');
const { createTaskReporter } = require('../core/progressReporter');
const { getAppPaths } = require('../core/paths');
const { findJavaRuntimes } = require('./javaDetector');
const { installJava, removeManagedJava, isManagedJava, DEFAULT_VENDOR } = require('./javaInstaller');
const { VENDORS, listVendors } = require('./javaVendors');
const { resolveJavaRuntime } = require('./javaRuntimeService');

const installQueue = new SerialQueue();

/** Lists Java installations found on this PC and the ones managed by the launcher. */
async function listJavaRuntimes() {
  const runtimes = await findJavaRuntimes(getAppPaths().runtimesDirectory);
  return runtimes.map((runtime) => ({ ...runtime, managed: isManagedJava(runtime.path) }));
}

function removeJava(javaPath) {
  return installQueue.run(() => removeManagedJava(String(javaPath)));
}

/** Downloads a JDK of the given vendor and major version (serialized with other installs). */
function installManagedJava(majorVersion, vendor = DEFAULT_VENDOR) {
  if (!Number.isInteger(majorVersion) || majorVersion < 8 || majorVersion > 30) {
    throw new Error(`Java ${majorVersion} не поддерживается автоматической установкой.`);
  }
  const label = VENDORS[vendor]?.label ?? vendor;
  return installQueue.run(async () => {
    const reporter = createTaskReporter({ taskId: `java:${vendor}:${majorVersion}`, kind: 'java', label: `Java ${majorVersion} (${label})` });
    try {
      reporter.report('Загрузка', 0, label);
      const runtime = await installJava(majorVersion, {
        vendor,
        onProgress: (fraction) => reporter.report('Загрузка', fraction * 95, label),
      });
      reporter.finish('done', runtime.version);
      return runtime;
    } catch (error) {
      reporter.finish('error', error.message);
      throw error;
    }
  });
}

/**
 * Java for a game launch. When the runtime has to be downloaded, the download is
 * reported as a task so the Home screen can show its progress.
 */
async function resolveJavaForLaunch(requiredMajor, settings) {
  let reporter = null;
  try {
    const runtime = await resolveJavaRuntime({
      requiredMajor,
      settings,
      onProgress: (fraction) => {
        reporter ??= createTaskReporter({ taskId: `java:${requiredMajor}`, kind: 'java', label: `Java ${requiredMajor}` });
        reporter.report('Загрузка', fraction * 95, 'Temurin');
      },
    });
    reporter?.finish('done', runtime.version);
    return runtime;
  } catch (error) {
    reporter?.finish('error', error.message);
    throw error;
  }
}

module.exports = { listJavaRuntimes, installManagedJava, resolveJavaForLaunch, removeJava, listVendors };
