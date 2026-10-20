'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createLogger } = require('../core/logger');
const { IS_WINDOWS, IS_MAC, JAVA_BINARY, javaIn } = require('./javaPlatform');

const PROBE_TIMEOUT_MS = 8000;
const PROGRAM_FILES_VENDOR_FOLDERS = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'Temurin'];
/** Where JDK installers put Java on macOS (each JDK is a bundle with Contents/Home inside). */
const MAC_JVM_FOLDERS = ['/Library/Java/JavaVirtualMachines', path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines')];
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

/** Lists java executables from JAVA_HOME, PATH, common vendor folders and managed runtimes. */
async function collectJavaCandidates(managedRuntimesDirectory) {
  const candidates = new Set();

  if (process.env.JAVA_HOME) {
    candidates.add(javaIn(process.env.JAVA_HOME));
  }

  const onPath = await runWhere(JAVA_BINARY);
  // macOS's /usr/bin/java is only a stub: with no Java installed it pops up "install Java?".
  onPath.filter((entry) => !(IS_MAC && entry === '/usr/bin/java')).forEach((entry) => candidates.add(entry));

  if (IS_WINDOWS) {
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    for (const root of programFiles) {
      for (const vendor of PROGRAM_FILES_VENDOR_FOLDERS) {
        await addRuntimesFromFolder(path.join(root, vendor), candidates);
      }
    }
  }
  if (IS_MAC) {
    for (const folder of MAC_JVM_FOLDERS) await addRuntimesFromFolder(folder, candidates);
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
    // A plain JDK folder (bin/java) or a macOS JDK bundle (Contents/Home/bin/java).
    for (const home of [path.join(folder, entry.name), path.join(folder, entry.name, 'Contents', 'Home')]) {
      const executable = javaIn(home);
      if (await pathExists(executable)) {
        candidates.add(executable);
        break;
      }
    }
  }
}

/** Every `name` on PATH: where.exe on Windows, `which -a` elsewhere. */
function runWhere(name) {
  return new Promise((resolve) => {
    const child = IS_WINDOWS ? spawn('where.exe', [name], { windowsHide: true }) : spawn('/usr/bin/which', ['-a', name]);
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
