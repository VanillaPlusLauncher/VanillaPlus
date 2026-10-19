'use strict';

const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');
const { findJavaRuntimes, probeJavaExecutable } = require('./javaDetector');
const { installJava } = require('./javaInstaller');
const { VENDORS } = require('./javaVendors');

const log = createLogger('java-runtime');

/**
 * Picks the Java runtime for a Minecraft version. The major version must match
 * exactly: old versions (LaunchWrapper, Java 8) crash on newer JVMs, so a
 * "close enough" runtime is never used silently.
 *
 * - custom mode: uses settings.javaPath and checks that it is compatible;
 * - auto mode: uses an installed JDK of the required major version, or downloads it.
 */
async function resolveJavaRuntime({ requiredMajor, settings, onProgress }) {
  if (settings.javaMode === 'custom') {
    if (!settings.javaPath) {
      throw new Error('Укажите путь к Java в настройках или переключитесь на автоматический режим.');
    }
    const runtime = await probeJavaExecutable(settings.javaPath);
    if (!runtime) {
      throw new Error(`По пути ${settings.javaPath} не найдена рабочая Java.`);
    }
    if (!runtime.is64Bit) {
      throw new Error(
        `Java по пути ${settings.javaPath} 32-битная: игра на ней не запустится. ` +
          'Выберите 64-битную Java на вкладке Java или включите автоматический режим.',
      );
    }
    if (!isCompatible(runtime.majorVersion, requiredMajor)) {
      throw new Error(
        `Для этой версии нужна Java ${requiredMajor}, а указана Java ${runtime.majorVersion}. ` +
          'Выберите Java нужной версии на вкладке Java или включите автоматический режим.',
      );
    }
    return runtime;
  }

  const { runtimesDirectory } = getAppPaths();
  const runtimes = await findJavaRuntimes(runtimesDirectory);
  // The launcher downloads 64-bit natives: a 32-bit JVM cannot load them (and gets little memory).
  const exact = runtimes.find((runtime) => runtime.majorVersion === requiredMajor && runtime.is64Bit);
  if (exact) {
    return exact;
  }

  // The vendor chosen on the Java page; one that has no build of this version falls back to Temurin.
  const preferred = VENDORS[settings.javaVendor]?.majors.includes(requiredMajor) ? settings.javaVendor : 'temurin';
  log.info(`Java ${requiredMajor} не найдена, загружаем ${VENDORS[preferred].label} ${requiredMajor}`);
  return installJava(requiredMajor, { onProgress, vendor: preferred });
}

/**
 * Modern Minecraft (Java 16+ requirement) runs on newer JVMs; legacy versions need the exact major.
 */
function isCompatible(actualMajor, requiredMajor) {
  if (actualMajor === requiredMajor) {
    return true;
  }
  return requiredMajor >= 16 && actualMajor > requiredMajor;
}

module.exports = { resolveJavaRuntime, isCompatible };
