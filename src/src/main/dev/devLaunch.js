'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const nbt = require('../minecraft/nbt');
const { getAppPaths } = require('../core/paths');
const { createLogger } = require('../core/logger');

/*
 * What developer mode changes in a launch (Settings → «Разработчик»): debug lines in the game's log,
 * the Java debugger, Mixin's exported classes, and commands (cheats) in every world of the instance
 * while the game runs. Nothing here does anything while developer mode is off.
 */

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);
const log = createLogger('dev');
const DEBUG_PORT = 5005;
/** Worlds opened for commands by this launcher, to be put back after the game: { worlds: [folder] }. */
const COMMANDS_FILE = path.join('.amethyx', 'dev-commands.json');

/** The developer options in force: none while developer mode is off. */
function devOptions(settings) {
  const dev = settings?.dev;
  return dev?.enabled ? dev : {};
}

/**
 * Whether a Java has the debugger agent. Slim runtimes (jlink'd JREs, some bundled with packs) leave it
 * out, and Java then refuses to start at all with -agentlib:jdwp. Unknown path: assumed present.
 */
function hasDebugger(javaPath) {
  if (!javaPath) return true;
  const home = path.dirname(path.dirname(javaPath));
  const names = process.platform === 'win32' ? [path.join('bin', 'jdwp.dll')] : [path.join('lib', 'libjdwp.so'), path.join('lib', 'libjdwp.dylib')];
  return names.some((name) => fs.existsSync(path.join(home, name)));
}

/** Extra JVM arguments of developer mode for a launch with the Java at `javaPath`. */
function jvmArguments(settings, javaPath = null) {
  const dev = devOptions(settings);
  const args = [];
  if (dev.verboseLogs) {
    // The loaders' own log levels (the game's own comes from logConfigPath below).
    args.push('-Dfabric.log.level=debug', '-Dforge.logging.console.level=debug');
  }
  if (dev.javaDebug && hasDebugger(javaPath)) {
    // suspend=n: the game does not wait for the debugger; only this computer can attach.
    args.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${DEBUG_PORT}`);
  }
  if (dev.mixinExport) {
    args.push('-Dmixin.debug.export=true');
  }
  return args;
}

/** Lines for the game's journal about what developer mode added to this launch. */
function describeLaunch(settings, javaPath = null) {
  const dev = devOptions(settings);
  const lines = [];
  if (dev.verboseLogs) lines.push('Режим разработчика: подробный журнал игры');
  if (dev.javaDebug) {
    lines.push(hasDebugger(javaPath)
      ? `Режим разработчика: отладчик Java ждёт на 127.0.0.1:${DEBUG_PORT}`
      : 'Режим разработчика: в этой Java нет отладчика, он не включён (выберите полную JDK в настройках Java)');
  }
  if (dev.mixinExport) lines.push('Режим разработчика: Mixin сохраняет изменённые классы в .mixin.out');
  return lines;
}

/**
 * The game's log4j config: Mojang's own, or with "verbose logs" a copy of it that lets debug lines
 * through (<Root level="debug">). Falls back to Mojang's file if the copy cannot be made.
 */
async function logConfigPath(settings, mojangPath) {
  if (!devOptions(settings).verboseLogs) {
    return mojangPath;
  }
  try {
    const text = await fsp.readFile(mojangPath, 'utf8');
    const debug = text.replace(/(<Root\b[^>]*\blevel\s*=\s*")[a-z]+(")/i, '$1debug$2');
    const target = path.join(getAppPaths().toolsDirectory, `debug-${path.basename(mojangPath)}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, debug);
    return target;
  } catch (error) {
    log.warn(`Подробный журнал игры не включён: ${error.message}`);
    return mojangPath;
  }
}

async function readLevel(file) {
  return nbt.read(await gunzip(await fsp.readFile(file)));
}

async function writeLevel(file, root) {
  const data = await gzip(nbt.write(root));
  const temporary = `${file}.amethyx-tmp`;
  await fsp.writeFile(temporary, data);
  await fsp.rename(temporary, file);
}

/** Sets a world's "allow commands" (level.dat → Data.allowCommands). Returns the value it had. */
async function setAllowCommands(worldDirectory, value) {
  const file = path.join(worldDirectory, 'level.dat');
  const root = await readLevel(file);
  const data = root.value.Data?.value;
  if (!data || typeof data !== 'object') {
    throw new Error('level.dat without Data');
  }
  const before = Number(data.allowCommands?.value ?? 0);
  if (before !== value) {
    data.allowCommands = { type: nbt.TAG.byte, value };
    await writeLevel(file, root);
  }
  return before;
}

const plainFolder = (name) => typeof name === 'string' && name && !/[\\/]/.test(name) && name !== '.' && name !== '..';

/** Puts back the worlds a run opened for commands (also those of a run the launcher did not see end). */
async function restoreCommands(gameDirectory) {
  const file = path.join(gameDirectory, COMMANDS_FILE);
  let saved;
  try {
    saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return 0;
  }
  let restored = 0;
  for (const world of Array.isArray(saved?.worlds) ? saved.worlds.filter(plainFolder) : []) {
    try {
      await setAllowCommands(path.join(gameDirectory, 'saves', world), 0);
      restored += 1;
    } catch (error) {
      log.warn(`Команды в мире «${world}» не выключены обратно: ${error.message}`);
    }
  }
  await fsp.rm(file, { force: true });
  return restored;
}

/**
 * Before a launch: worlds left open by an earlier run are put back, then with "commands in any world"
 * every world of the instance gets commands. Returns what puts them back once the game has closed.
 */
async function openCommands(settings, gameDirectory, onLog = () => {}) {
  await restoreCommands(gameDirectory).catch(() => 0);
  if (!devOptions(settings).cheats) {
    return async () => {};
  }
  const saves = path.join(gameDirectory, 'saves');
  const entries = await fsp.readdir(saves, { withFileTypes: true }).catch(() => []);
  const opened = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if ((await setAllowCommands(path.join(saves, entry.name), 1)) !== 1) opened.push(entry.name);
    } catch {
      // Not a world, or its level.dat cannot be read: left as it is.
    }
  }
  if (opened.length > 0) {
    const file = path.join(gameDirectory, COMMANDS_FILE);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ worlds: opened }));
    onLog(`Режим разработчика: команды включены в мирах (${opened.length}), после игры вернутся как были`);
  }
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await restoreCommands(gameDirectory).catch((error) => log.warn(`Миры не возвращены как были: ${error.message}`));
  };
}

module.exports = { jvmArguments, describeLaunch, hasDebugger, logConfigPath, openCommands, restoreCommands, setAllowCommands, DEBUG_PORT };
