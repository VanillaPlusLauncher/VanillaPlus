'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { runWithConcurrency } = require('../core/taskPool');
const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');
const { probeJavaExecutable } = require('./javaDetector');
const { VENDORS, mojangComponent } = require('./javaVendors');

const DEFAULT_VENDOR = 'temurin';
const MOJANG_CONCURRENCY = 8;
const log = createLogger('java-installer');

/** Adoptium (Eclipse Temurin) redirects to the latest GA JDK archive for the given major version. */
function adoptiumDownloadUrl(majorVersion) {
  return `https://api.adoptium.net/v3/binary/latest/${majorVersion}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`;
}

/**
 * Absolute path to the bsdtar that ships with Windows 10+. A bare "tar.exe" could
 * resolve to GNU tar from Git for Windows, which cannot read zip archives.
 */
function windowsTarPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

/**
 * Unpacks a zip with the bsdtar that ships with Windows 10+.
 * Runs inside the archive's folder with relative names: bsdtar reads "C:" in a
 * path as a remote host, so absolute Windows paths must not be passed to it.
 */
function runTarExtract(archivePath, targetDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      windowsTarPath(),
      ['-xf', path.basename(archivePath), '-C', path.basename(targetDirectory)],
      { cwd: path.dirname(archivePath), windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Не удалось распаковать Java: ${stderr.trim()}`))));
  });
}

/** Finds the JDK root inside an extracted archive (the folder that contains bin\java.exe). */
async function findJdkRoot(extractedDirectory) {
  const entries = await fsp.readdir(extractedDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(extractedDirectory, entry.name);
    if (entry.isDirectory()) {
      try {
        await fsp.access(path.join(candidate, 'bin', 'java.exe'));
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  throw new Error('В архиве Java не найден bin\\java.exe.');
}

/** Folder of a managed runtime. Temurin keeps the historical name "java-<major>". */
function runtimeDirectory(vendor, majorVersion) {
  const { runtimesDirectory } = getAppPaths();
  return path.join(runtimesDirectory, vendor === DEFAULT_VENDOR ? `java-${majorVersion}` : `${vendor}-${majorVersion}`);
}

/** Installs in progress: a second request for the same vendor and version joins the first. */
const pendingInstalls = new Map();

/**
 * Downloads and unpacks a JDK into the managed runtimes folder.
 * options: { vendor = 'temurin', onProgress(fraction) }.
 * Returns the probed runtime {path, version, majorVersion, is64Bit, vendor}.
 */
function installJava(majorVersion, options = {}) {
  const vendor = VENDORS[options.vendor] ? options.vendor : DEFAULT_VENDOR;
  if (!VENDORS[vendor].majors.includes(majorVersion)) {
    return Promise.reject(new Error(`${VENDORS[vendor].label} не выпускает Java ${majorVersion} для Windows.`));
  }
  const key = `${vendor}:${majorVersion}`;
  const pending = pendingInstalls.get(key);
  if (pending) {
    return pending;
  }
  const work = (vendor === 'mojang' ? installMojang(majorVersion, options) : downloadAndUnpack(vendor, majorVersion, options)).finally(() =>
    pendingInstalls.delete(key),
  );
  pendingInstalls.set(key, work);
  return work;
}

async function probeInstalled(targetDirectory, label) {
  const runtime = await probeJavaExecutable(path.join(targetDirectory, 'bin', 'java.exe'));
  if (!runtime) {
    throw new Error(`Установленная ${label} не запускается.`);
  }
  log.info(`${label} ${runtime.version} установлена в ${targetDirectory}`);
  return runtime;
}

async function downloadAndUnpack(vendor, majorVersion, { onProgress } = {}) {
  const { runtimesDirectory, tempDirectory } = getAppPaths();
  const archivePath = path.join(tempDirectory, `${vendor}-${majorVersion}.zip`);
  const extractDirectory = path.join(tempDirectory, `${vendor}-${majorVersion}-extract`);
  const targetDirectory = runtimeDirectory(vendor, majorVersion);
  const label = `${VENDORS[vendor].label} ${majorVersion}`;

  log.info(`Загрузка ${label}`);
  await fsp.mkdir(tempDirectory, { recursive: true });
  const url = await VENDORS[vendor].zipUrl(majorVersion);
  await downloadFile(url, archivePath, {
    deepVerify: false,
    retries: 2,
    onProgress: (received, total) => {
      if (total) {
        onProgress?.(received / total);
      }
    },
  });

  await fsp.rm(extractDirectory, { recursive: true, force: true });
  await fsp.mkdir(extractDirectory, { recursive: true });
  await runTarExtract(archivePath, extractDirectory);
  const jdkRoot = await findJdkRoot(extractDirectory);

  await fsp.rm(targetDirectory, { recursive: true, force: true });
  await fsp.mkdir(runtimesDirectory, { recursive: true });
  await fsp.rename(jdkRoot, targetDirectory);
  await fsp.rm(extractDirectory, { recursive: true, force: true });
  await fsp.rm(archivePath, { force: true });
  return probeInstalled(targetDirectory, label);
}

/**
 * Mojang's runtimes come as a manifest of files (each with its own URL and SHA-1), the same way
 * the official launcher installs them.
 */
async function installMojang(majorVersion, { onProgress } = {}) {
  const component = await mojangComponent(majorVersion);
  const manifest = await fetchJson(component.manifestUrl);
  const targetDirectory = runtimeDirectory('mojang', majorVersion);
  const staging = `${targetDirectory}.part`;
  await fsp.rm(staging, { recursive: true, force: true });
  log.info(`Загрузка Java ${component.version} от Mojang (${component.name})`);

  const entries = Object.entries(manifest.files ?? {});
  for (const [relative, entry] of entries) {
    if (entry.type === 'directory') {
      await fsp.mkdir(path.join(staging, ...relative.split('/')), { recursive: true });
    }
  }
  const files = entries.filter(([, entry]) => entry.type === 'file' && entry.downloads?.raw);
  let done = 0;
  await runWithConcurrency(files, MOJANG_CONCURRENCY, async ([relative, entry]) => {
    const raw = entry.downloads.raw;
    await downloadFile(raw.url, path.join(staging, ...relative.split('/')), { sha1: raw.sha1, size: raw.size });
    done += 1;
    onProgress?.(done / files.length);
  });

  await fsp.rm(targetDirectory, { recursive: true, force: true });
  await fsp.rename(staging, targetDirectory);
  return probeInstalled(targetDirectory, `Java ${majorVersion} (Mojang)`);
}

/** Deletes a runtime the launcher installed. Refuses anything outside the managed runtimes folder. */
async function removeManagedJava(javaPath) {
  const { runtimesDirectory } = getAppPaths();
  const root = path.resolve(runtimesDirectory);
  const runtimeRoot = path.resolve(path.dirname(path.dirname(javaPath)));
  if (path.dirname(runtimeRoot) !== root) {
    throw new Error('Удалить можно только Java, которую установил лаунчер.');
  }
  await fsp.rm(runtimeRoot, { recursive: true, force: true });
  log.info(`Java удалена: ${runtimeRoot}`);
}

/** True for a java.exe inside the launcher's runtimes folder. */
function isManagedJava(javaPath) {
  const root = path.resolve(getAppPaths().runtimesDirectory);
  return path.dirname(path.resolve(path.dirname(path.dirname(javaPath)))) === root;
}

module.exports = { installJava, removeManagedJava, isManagedJava, adoptiumDownloadUrl, DEFAULT_VENDOR };
