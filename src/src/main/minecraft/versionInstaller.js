'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { runWithConcurrency } = require('../core/taskPool');
const { writeJsonFileAtomic } = require('../core/jsonFile');
const { createLogger } = require('../core/logger');
const { getRemoteVersionEntry } = require('./versionManifest');
const { resolveLibraries } = require('./libraryResolver');
const { installAssets } = require('./assetInstaller');
const { extractNatives } = require('./nativesExtractor');
const { resolveJavaRuntime } = require('../java/javaRuntimeService');

const LIBRARY_CONCURRENCY = 8;
const log = createLogger('installer');

/** Maps a fraction of a stage onto the overall 0..100 progress scale. */
function stageProgress(reporter, label, from, to) {
  return (fraction) => reporter.report(label, from + (to - from) * fraction, label);
}

/**
 * Installs one vanilla Minecraft version: descriptor, Java runtime, client jar,
 * libraries, natives, assets and logging config. Writes a completion marker last,
 * so a partially downloaded version is never reported as installed.
 */
async function installVersion({ versionId, layout, settings, reporter }) {
  const entry = await getRemoteVersionEntry(versionId);
  reporter.report('Метаданные', 1, versionId);
  const descriptor = await fetchJson(entry.url);
  await writeJsonFileAtomic(layout.versionJsonPath(versionId), descriptor);

  const requiredJava = descriptor.javaVersion?.majorVersion ?? 8;
  await resolveJavaRuntime({
    requiredMajor: requiredJava,
    settings,
    onProgress: stageProgress(reporter, `Java ${requiredJava}`, 2, 20),
  });

  reporter.report('Клиент', 21, 'client.jar');
  const client = descriptor.downloads.client;
  await downloadFile(client.url, layout.clientJarPath(versionId), {
    sha1: client.sha1,
    size: client.size,
  });

  const { classpath, natives } = resolveLibraries(descriptor);
  const libraryFiles = [...classpath, ...natives];
  let libraryCount = 0;
  reporter.report('Библиотеки', 22, `${libraryFiles.length} файлов`);
  await runWithConcurrency(libraryFiles, LIBRARY_CONCURRENCY, async (library) => {
    await downloadFile(library.url, layout.libraryPath(library.relativePath), {
      sha1: library.sha1,
      size: library.size,
    });
    libraryCount += 1;
    reporter.report('Библиотеки', 22 + (libraryCount / libraryFiles.length) * 20, `${libraryCount}/${libraryFiles.length}`);
  });

  reporter.report('Нативные библиотеки', 43, 'распаковка');
  await extractNatives(
    natives.map((native) => ({ jarPath: layout.libraryPath(native.relativePath), exclude: native.exclude })),
    layout.nativesDirectory(versionId),
  );

  const logging = descriptor.logging?.client?.file;
  if (logging) {
    await downloadFile(logging.url, layout.logConfigPath(logging.id), { sha1: logging.sha1, size: logging.size });
  }

  reporter.report('Ресурсы', 46, descriptor.assetIndex.id);
  await installAssets({
    assetIndex: descriptor.assetIndex,
    layout,
    onProgress: stageProgress(reporter, 'Ресурсы', 46, 99),
  });

  await writeJsonFileAtomic(layout.completeMarkerPath(versionId), {
    versionId,
    installedAt: new Date().toISOString(),
  });
  log.info(`Версия ${versionId} установлена в ${path.relative(layout.root, layout.versionDirectory(versionId))}`);
}

/** Deletes a version's own folder. Shared libraries and assets are kept for other versions. */
async function removeVersion(layout, versionId) {
  await fsp.rm(layout.versionDirectory(versionId), { recursive: true, force: true });
}

module.exports = { installVersion, removeVersion };
