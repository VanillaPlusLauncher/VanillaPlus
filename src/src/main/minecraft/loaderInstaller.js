'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const AdmZip = require('adm-zip');
const { fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { sha1File } = require('../core/hashing');
const { runWithConcurrency } = require('../core/taskPool');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');
const { resolveLibraries, mavenRelativePath } = require('./libraryResolver');
const { resolveDescriptor } = require('./descriptor');

/*
 * Installs mod loaders on top of an installed vanilla version. Each loader becomes a version of
 * its own (versions/<id>/<id>.json with inheritsFrom), exactly as the official launcher stores it.
 *
 * Fabric and Quilt publish a ready version file. Forge and NeoForge ship an installer jar whose
 * install_profile.json lists libraries and "processors" (small Java programs that patch the game);
 * the launcher runs them itself, the same way the installer's "Install client" button does.
 */

const { parallelDownloads } = require('../core/downloadConfig');
const log = createLogger('loader-installer');

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Downloads every library of a resolved version that is not on disk yet. */
async function downloadLibraries(layout, descriptor, onProgress) {
  const { classpath, natives } = resolveLibraries(descriptor);
  const files = [...classpath, ...natives].filter((library) => library.url);
  let done = 0;
  await runWithConcurrency(files, parallelDownloads(), async (library) => {
    await downloadFile(library.url, layout.libraryPath(library.relativePath), { sha1: library.sha1, size: library.size });
    done += 1;
    onProgress?.(done / files.length);
  });
}

function loadLocal(layout) {
  return async (id) => {
    const raw = await readJsonFile(layout.versionJsonPath(id), null);
    if (!raw) {
      throw new Error(`Не найден файл версии ${id}.`);
    }
    return raw;
  };
}

async function markComplete(layout, versionId) {
  await writeJsonFileAtomic(layout.completeMarkerPath(versionId), { versionId, installedAt: new Date().toISOString() });
}

// --- Fabric / Quilt ---------------------------------------------------------------

const FABRIC_LIKE = {
  fabric: 'https://meta.fabricmc.net/v2',
  quilt: 'https://meta.quiltmc.org/v3',
};

async function installFabricLike({ type, minecraft, loaderVersion, layout, onProgress }) {
  const base = FABRIC_LIKE[type];
  const profile = await fetchJson(`${base}/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  const versionId = profile.id;
  await writeJsonFileAtomic(layout.versionJsonPath(versionId), profile);
  const descriptor = await resolveDescriptor(versionId, loadLocal(layout));
  await downloadLibraries(layout, descriptor, onProgress);
  await markComplete(layout, versionId);
  return versionId;
}

// --- Forge / NeoForge ----------------------------------------------------------------

function installerUrl(type, version) {
  if (type === 'forge') {
    return `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
  }
  // NeoForge for 1.20.1 still used the "forge" artifact name.
  if (version.startsWith('1.20.1-')) {
    return `https://maven.neoforged.net/releases/net/neoforged/forge/${version}/forge-${version}-installer.jar`;
  }
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
}

function readZipJson(zip, name) {
  const entry = zip.getEntry(name);
  return entry ? JSON.parse(zip.readAsText(entry)) : null;
}

/** Writes an installer entry to `target` unless it is already there. Returns false when the entry is missing. */
async function extractEntry(zip, entryName, target) {
  const entry = zip.getEntry(entryName.replace(/^\/+/, ''));
  if (!entry) {
    return false;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, entry.getData());
  return true;
}

/** Libraries of an install profile or version file: downloaded, or taken from the installer's maven/ folder. */
async function fetchInstallerLibraries(zip, layout, libraries, onProgress) {
  let done = 0;
  await runWithConcurrency(libraries, parallelDownloads(), async (library) => {
    const artifact = library.downloads?.artifact;
    const relativePath = artifact?.path ?? mavenRelativePath(library.name);
    const target = layout.libraryPath(relativePath);
    if (artifact?.url) {
      await downloadFile(artifact.url, target, { sha1: artifact.sha1, size: artifact.size });
    } else if (!(await exists(target))) {
      // Not downloadable: either bundled in the installer or produced later by a processor.
      await extractEntry(zip, `maven/${relativePath}`, target);
    }
    done += 1;
    onProgress?.(done / libraries.length);
  });
}

function mainClassOf(jarPath) {
  const zip = new AdmZip(jarPath);
  const manifest = zip.getEntry('META-INF/MANIFEST.MF');
  const match = manifest ? /^Main-Class:\s*(.+)$/m.exec(zip.readAsText(manifest)) : null;
  if (!match) {
    throw new Error(`В ${path.basename(jarPath)} нет Main-Class.`);
  }
  return match[1].trim();
}

function runJava(javaPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    const tail = [];
    const collect = (chunk) => {
      tail.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 30));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        log.error(`Процессор завершился с кодом ${code}:\n${tail.join('\n')}`);
        reject(new Error(`Установщик не смог подготовить файлы игры (код ${code}). ${tail.slice(-3).join(' ')}`));
      }
    });
  });
}

/**
 * Turns install_profile "data" into concrete values for the client side:
 * [maven:coords] -> library path, 'literal' -> literal, /path/in/installer -> extracted temp file.
 */
async function resolveProfileData(zip, profile, layout, tempDirectory, builtins) {
  const data = { ...builtins };
  for (const [key, value] of Object.entries(profile.data ?? {})) {
    const client = value.client;
    if (typeof client !== 'string') {
      continue;
    }
    if (client.startsWith('[') && client.endsWith(']')) {
      data[key] = layout.libraryPath(mavenRelativePath(client.slice(1, -1)));
    } else if (client.startsWith("'") && client.endsWith("'")) {
      data[key] = client.slice(1, -1);
    } else if (client.startsWith('/')) {
      const target = path.join(tempDirectory, ...client.split('/').filter(Boolean));
      await extractEntry(zip, client, target);
      data[key] = target;
    } else {
      data[key] = client;
    }
  }
  return data;
}

function substitute(argument, data, layout) {
  const whole = /^\[(.+)\]$/.exec(argument);
  if (whole) {
    return layout.libraryPath(mavenRelativePath(whole[1]));
  }
  return argument.replace(/\{([^}]+)\}/g, (match, key) => (key in data ? data[key] : match));
}

async function outputsUpToDate(outputs, data, layout) {
  const entries = Object.entries(outputs ?? {});
  if (entries.length === 0) {
    return false;
  }
  for (const [rawFile, rawHash] of entries) {
    const file = substitute(rawFile, data, layout);
    const expected = substitute(rawHash, data, layout).replace(/'/g, '');
    if (!(await exists(file)) || (await sha1File(file)) !== expected) {
      return false;
    }
  }
  return true;
}

/** Old installers (up to 1.12.2): the profile embeds the version file and the universal jar. */
async function installLegacyForge({ zip, profile, minecraft, layout }) {
  const versionInfo = { ...profile.versionInfo };
  const versionId = versionInfo.id;
  if (!versionInfo.inheritsFrom) {
    versionInfo.inheritsFrom = minecraft;
  }
  versionInfo.jar ??= minecraft;
  // Libraries the vanilla version already lists come from it; the rest stay with their maven URL.
  await writeJsonFileAtomic(layout.versionJsonPath(versionId), versionInfo);
  const universal = profile.install?.path;
  if (universal && profile.install?.filePath) {
    await extractEntry(zip, profile.install.filePath, layout.libraryPath(mavenRelativePath(universal)));
  }
  return versionId;
}

async function installForgeLike({ type, minecraft, loaderVersion, layout, java, onProgress }) {
  const { tempDirectory } = getAppPaths();
  const workDirectory = path.join(tempDirectory, `${type}-${crypto.randomBytes(4).toString('hex')}`);
  const installerPath = path.join(workDirectory, 'installer.jar');
  try {
    onProgress?.(0.02, 'Установщик');
    await downloadFile(installerUrl(type, loaderVersion), installerPath);
    const zip = new AdmZip(installerPath);
    const profile = readZipJson(zip, 'install_profile.json');
    if (!profile) {
      throw new Error('В установщике нет install_profile.json.');
    }

    if (profile.versionInfo) {
      const versionId = await installLegacyForge({ zip, profile, minecraft, layout });
      const descriptor = await resolveDescriptor(versionId, loadLocal(layout));
      await downloadLibraries(layout, descriptor, (fraction) => onProgress?.(0.1 + fraction * 0.85, 'Библиотеки'));
      await markComplete(layout, versionId);
      return versionId;
    }

    const versionFile = readZipJson(zip, (profile.json ?? '/version.json').replace(/^\/+/, ''));
    if (!versionFile) {
      throw new Error('В установщике нет описания версии.');
    }
    const versionId = versionFile.id;
    await writeJsonFileAtomic(layout.versionJsonPath(versionId), versionFile);

    const libraries = [...(profile.libraries ?? []), ...(versionFile.libraries ?? [])];
    await fetchInstallerLibraries(zip, layout, libraries, (fraction) => onProgress?.(0.05 + fraction * 0.45, 'Библиотеки'));

    const data = await resolveProfileData(zip, profile, layout, workDirectory, {
      SIDE: 'client',
      MINECRAFT_JAR: layout.clientJarPath(minecraft),
      MINECRAFT_VERSION: minecraft,
      ROOT: layout.root,
      INSTALLER: installerPath,
      LIBRARY_DIR: layout.librariesDirectory,
    });

    const processors = (profile.processors ?? []).filter((processor) => !processor.sides || processor.sides.includes('client'));
    for (const [index, processor] of processors.entries()) {
      onProgress?.(0.5 + (index / Math.max(1, processors.length)) * 0.48, `Обработка ${index + 1}/${processors.length}`);
      if (await outputsUpToDate(processor.outputs, data, layout)) {
        continue;
      }
      const jarPath = layout.libraryPath(mavenRelativePath(processor.jar));
      const classpath = [jarPath, ...(processor.classpath ?? []).map((name) => layout.libraryPath(mavenRelativePath(name)))];
      const args = (processor.args ?? []).map((argument) => substitute(argument, data, layout));
      log.info(`Процессор ${processor.jar}`);
      await runJava(java.path, ['-cp', classpath.join(path.delimiter), mainClassOf(jarPath), ...args], workDirectory);
    }

    // Some loaders list the vanilla jar in an "ignoreList" by the loader version's name: keep a copy under that name.
    const ownJar = layout.clientJarPath(versionId);
    if (!(await exists(ownJar))) {
      await fsp.copyFile(layout.clientJarPath(minecraft), ownJar).catch(() => {});
    }
    await markComplete(layout, versionId);
    return versionId;
  } finally {
    await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Installs a loader for an installed vanilla version and returns the launchable version id.
 * `java` ({ path }) is needed for Forge and NeoForge processors.
 */
async function installLoader({ type, minecraft, loaderVersion, layout, java, onProgress }) {
  if (type === 'fabric' || type === 'quilt') {
    return installFabricLike({ type, minecraft, loaderVersion, layout, onProgress: (fraction) => onProgress?.(fraction, 'Библиотеки') });
  }
  if (type === 'forge' || type === 'neoforge') {
    return installForgeLike({ type, minecraft, loaderVersion, layout, java, onProgress });
  }
  throw new Error(`Неизвестный загрузчик ${type}.`);
}

/** Version id a Fabric or Quilt install will produce, known without downloading anything. */
function predictableVersionId(type, minecraft, loaderVersion) {
  if (type === 'fabric') {
    return `fabric-loader-${loaderVersion}-${minecraft}`;
  }
  if (type === 'quilt') {
    return `quilt-loader-${loaderVersion}-${minecraft}`;
  }
  return null;
}

module.exports = { installLoader, predictableVersionId, installerUrl };
