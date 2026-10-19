'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../core/logger');

const PROBE_TIMEOUT_MS = 8000;
const PROGRAM_FILES_VENDOR_FOLDERS = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'Temurin'];
const log = createLogger('java');

/**
 * Extracts {version, majorVersion, is64Bit} from the output of `java -version`.
 * 64-bit JVMs say so ("64-Bit Server VM", OpenJ9 "amd64-64-Bit"); 32-bit ones do not.
 */
function parseJavaVersionOutput(output) {
  const match = /version "([^"]+)"/.exec(output);
  if (!match) {
    return null;
  }
  const version = match[1];
  // Java 8 and older report "1.8.0_311"; newer releases report "21.0.2".
  const majorVersion = version.startsWith('1.')
    ? Number.parseInt(version.split('.')[1], 10)
    : Number.parseInt(version.split(/[.+_-]/)[0], 10);
  if (!Number.isFinite(majorVersion)) {
    return null;
  }
  return { version, majorVersion, is64Bit: /64-Bit/i.test(output), vendor: detectVendor(output) };
}

/** Distribution name from `java -version` ("OpenJDK Runtime Environment Temurin-21…", "Zulu…"). */
function detectVendor(output) {
  const checks = [
    [/Temurin|AdoptOpenJDK/i, 'Temurin'],
    [/Zulu/i, 'Azul Zulu'],
    [/Corretto/i, 'Amazon Corretto'],
    [/Microsoft/i, 'Microsoft'],
    [/BellSoft|Liberica/i, 'Liberica'],
    [/GraalVM/i, 'GraalVM'],
    [/Semeru|OpenJ9/i, 'IBM Semeru'],
    [/Java\(TM\)/i, 'Oracle'],
  ];
  for (const [pattern, name] of checks) {
    if (pattern.test(output)) {
      return name;
    }
  }
  return 'OpenJDK';
}

/** Runs `java -version` and returns {path, version, majorVersion}, or null when it is not a usable JVM. */
function probeJavaExecutable(javaPath) {
  const executable = javaPath.toLowerCase().endsWith('javaw.exe') ? javaPath.slice(0, -'w.exe'.length) + '.exe' : javaPath;
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(executable, ['-version'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const parsed = parseJavaVersionOutput(output);
      resolve(parsed ? { path: executable, ...parsed } : null);
    });
  });
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Lists `java.exe` candidates from JAVA_HOME, PATH, common vendor folders and managed runtimes. */
async function collectJavaCandidates(managedRuntimesDirectory) {
  const candidates = new Set();

  if (process.env.JAVA_HOME) {
    candidates.add(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  }

  const onPath = await runWhere('java.exe');
  onPath.forEach((entry) => candidates.add(entry));

  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const root of programFiles) {
    for (const vendor of PROGRAM_FILES_VENDOR_FOLDERS) {
      await addRuntimesFromFolder(path.join(root, vendor), candidates);
    }
  }

  await addRuntimesFromFolder(managedRuntimesDirectory, candidates);
  return [...candidates];
}

async function addRuntimesFromFolder(folder, candidates) {
  let entries;
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const javaExe = path.join(folder, entry.name, 'bin', 'java.exe');
    if (await pathExists(javaExe)) {
      candidates.add(javaExe);
    }
  }
}

function runWhere(name) {
  return new Promise((resolve) => {
    const child = spawn('where.exe', [name], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
  });
}

/**
 * Probes every candidate and returns the usable runtimes, deduplicated by real path
 * and sorted from newest to oldest.
 */
async function findJavaRuntimes(managedRuntimesDirectory) {
  const candidates = await collectJavaCandidates(managedRuntimesDirectory);
  const unique = new Map();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  const probes = await Promise.all([...unique.values()].map((candidate) => probeJavaExecutable(candidate)));
  const runtimes = probes.filter(Boolean).map((runtime) => {
    // Mojang's runtimes report themselves as plain OpenJDK: name them by their folder.
    const folder = path.basename(path.dirname(path.dirname(runtime.path)));
    return /^mojang-\d+$/i.test(folder) ? { ...runtime, vendor: 'Mojang' } : runtime;
  });
  log.info(`Найдено Java-окружений: ${runtimes.length}`);
  return runtimes.sort((a, b) => b.majorVersion - a.majorVersion);
}

module.exports = { findJavaRuntimes, probeJavaExecutable, parseJavaVersionOutput };
