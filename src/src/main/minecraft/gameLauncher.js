'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../core/logger');
const { readJsonFile } = require('../core/jsonFile');
const { createConsoleDecoder } = require('../core/consoleEncoding');
const { getAppPaths } = require('../core/paths');
const { legacyLoggingArgument } = require('./legacyLogging');
const { resolveDescriptor } = require('./descriptor');
const { resolveLibraries } = require('./libraryResolver');
const { buildLaunchArguments, splitUserArguments, DEFAULT_FEATURES } = require('./launchArguments');
const { isComplete } = require('./installedVersions');
const { createGameLogFormatter } = require('./gameLogFormatter');
const { prepareLegacyAssets } = require('./assetInstaller');
const { prepareLegacyHome } = require('./legacyGameHome');

const LAUNCHER_NAME = 'Amethyx';
const LAUNCHER_VERSION = '1.0.0';
const log = createLogger('game');

/** Loads a version descriptor from disk, following inheritsFrom chains. */
async function loadLocalDescriptor(layout, versionId) {
  return resolveDescriptor(versionId, async (id) => {
    const raw = await readJsonFile(layout.versionJsonPath(id), null);
    if (!raw) {
      throw new Error(`Не найден файл версии ${id}. Переустановите её.`);
    }
    return raw;
  });
}

/** Java major version the installed version was built for (8 for legacy versions without the field). */
async function getRequiredJavaMajor(layout, versionId) {
  const descriptor = await loadLocalDescriptor(layout, versionId);
  return descriptor.javaVersion?.majorVersion ?? 8;
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** "host" or "host:port" -> { host, port } (port defaults to 25565). */
function parseServerAddress(address) {
  const text = String(address ?? '').trim();
  if (!text) {
    return null;
  }
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(text);
  return match ? { host: match[1], port: match[2] ?? '25565', text } : null;
}

/**
 * Starts Minecraft for an installed version with an already resolved Java runtime.
 * `gameDirectory` is the instance folder; `options` holds per-launch extras
 * ({ width, height, fullscreen, joinServer, extraGameArgs }).
 * Returns the child process; stdout/stderr lines are passed to `onLog`.
 */
async function startGameProcess({
  versionId,
  layout,
  gameDirectory = layout.instanceDirectory(versionId),
  homeKey = versionId,
  settings,
  session,
  runtime,
  options = {},
  agentArguments = [],
  extraEnv = {},
  onLog,
}) {
  if (!(await isComplete(layout, versionId))) {
    throw new Error(`Версия ${versionId} не установлена.`);
  }
  const descriptor = await loadLocalDescriptor(layout, versionId);

  const { classpath } = resolveLibraries(descriptor);
  // Loaders that keep their own copy of the game jar (Forge, NeoForge) expect that copy on the class path.
  const ownJar = layout.clientJarPath(versionId);
  const clientJar = (await exists(ownJar)) ? ownJar : layout.clientJarPath(descriptor.clientJarId);
  const jarPaths = [...classpath.map((library) => layout.libraryPath(library.relativePath)), clientJar];
  // Natives are extracted once for the vanilla version at the root of the chain.
  const nativesDirectory = layout.nativesDirectory(descriptor.baseId ?? versionId);
  await fsp.mkdir(gameDirectory, { recursive: true });
  await prepareLegacyAssets(layout, descriptor.assetIndex.id, gameDirectory);

  const width = Number(options.width) > 0 ? Math.round(options.width) : null;
  const height = Number(options.height) > 0 ? Math.round(options.height) : null;
  const server = parseServerAddress(options.joinServer);
  const supportsQuickPlay = JSON.stringify(descriptor.arguments?.game ?? []).includes('quickPlayMultiplayer');
  const features = {
    ...DEFAULT_FEATURES,
    has_custom_resolution: Boolean(width && height),
    is_quick_play_multiplayer: Boolean(server && supportsQuickPlay),
  };

  const values = {
    resolution_width: width ?? '',
    resolution_height: height ?? '',
    quickPlayMultiplayer: server?.text ?? '',
    auth_player_name: session.username,
    version_name: versionId,
    game_directory: gameDirectory,
    assets_root: layout.assetsDirectory,
    game_assets: layout.virtualAssetsDirectory(descriptor.assetIndex.id),
    assets_index_name: descriptor.assetIndex.id,
    auth_uuid: session.uuid,
    auth_access_token: session.accessToken,
    auth_xuid: session.xuid ?? '',
    clientid: '',
    user_type: session.userType,
    version_type: descriptor.type ?? 'release',
    user_properties: '{}',
    auth_session: session.accessToken,
    natives_directory: nativesDirectory,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    library_directory: layout.librariesDirectory,
    classpath: jarPaths.join(path.delimiter),
    classpath_separator: path.delimiter,
  };

  const { jvm, game, mainClass } = buildLaunchArguments(descriptor, values, features);
  if (!descriptor.arguments && width && height) {
    game.push('--width', String(width), '--height', String(height));
  }
  if (server && !supportsQuickPlay) {
    game.push('--server', server.host.replace(/^\[|\]$/g, ''), '--port', server.port);
  }
  if (options.fullscreen) {
    game.push('--fullscreen');
  }
  game.push(...splitUserArguments(options.extraGameArgs));
  const legacyHome = await prepareLegacyHome({ layout, homeKey, gameDirectory, mainClass, gameArguments: game });
  const memoryArguments = [`-Xmx${settings.ramMb}M`, `-Xms${Math.min(settings.ramMb, 512)}M`];
  const logArgument = descriptor.logging?.client?.argument;
  // Versions with log4j get Mojang's config; older ones log through java.util.logging and get ours.
  const logConfig = descriptor.logging?.client?.file
    ? [logArgument.replace('${path}', layout.logConfigPath(descriptor.logging.client.file.id))]
    : [await legacyLoggingArgument(getAppPaths().toolsDirectory)];

  const userJvmArgs = splitUserArguments(settings.extraJvmArgs);
  await makeJvmLogFolders(userJvmArgs, gameDirectory);
  // macOS: the game's window must run on the first thread. New versions ask for it in their own
  // arguments; older ones (and some loaders) do not.
  const macArguments = process.platform === 'darwin' && !jvm.includes('-XstartOnFirstThread') ? ['-XstartOnFirstThread'] : [];

  const args = [
    ...memoryArguments,
    ...macArguments,
    ...agentArguments,
    ...legacyHome.jvmArgs,
    ...userJvmArgs,
    ...jvm,
    ...logConfig,
    mainClass,
    ...game,
  ];

  log.info(`Запуск ${versionId} на Java ${runtime.majorVersion} (${runtime.path})`);
  const decode = await createConsoleDecoder();
  const env = mergeEnvironment(process.env, { ...extraEnv, ...legacyHome.env });
  const child = spawn(runtime.path, args, { cwd: gameDirectory, windowsHide: true, env });
  attachLineReader(child.stdout, decode, onLog);
  attachLineReader(child.stderr, decode, onLog);
  return child;
}

/**
 * Java refuses to start when an -Xlog file (for example "-Xlog:gc:file=logs/gc.log", common in packs
 * brought from Prism) lies in a folder that does not exist yet: those folders are made first.
 */
async function makeJvmLogFolders(jvmArgs, gameDirectory) {
  for (const arg of jvmArgs) {
    const match = /^-Xlog:.*?\bfile=(?:"([^"]+)"|([A-Za-z]:[\\/][^:]*|[^:]+))/.exec(arg);
    const file = match?.[1] ?? match?.[2];
    if (!file) continue;
    await fsp.mkdir(path.dirname(path.resolve(gameDirectory, file)), { recursive: true }).catch(() => {});
  }
}

/**
 * Copies the environment with overrides applied. Windows names are case-insensitive, so an
 * override drops the inherited variable whatever its case (AppData vs APPDATA).
 */
function mergeEnvironment(base, overrides) {
  const result = { ...base };
  if (process.platform === 'win32') {
    const overridden = new Set(Object.keys(overrides).map((name) => name.toUpperCase()));
    for (const name of Object.keys(result)) {
      if (overridden.has(name.toUpperCase())) {
        delete result[name];
      }
    }
  }
  return Object.assign(result, overrides);
}

/**
 * Reads a stream line by line. Lines are split on raw bytes and decoded one by one, because
 * a single stream can mix UTF-8 and the Windows code page. Each stream has its own formatter,
 * so stderr never splits an XML event.
 */
function attachLineReader(stream, decode, onLine) {
  const formatter = createGameLogFormatter(onLine);
  let pending = Buffer.alloc(0);
  const emit = (bytes) => {
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
    formatter.push(decode(bytes.subarray(0, end)));
  };
  stream.on('data', (chunk) => {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    let newline = pending.indexOf(0x0a, start);
    while (newline !== -1) {
      emit(pending.subarray(start, newline));
      start = newline + 1;
      newline = pending.indexOf(0x0a, start);
    }
    pending = pending.subarray(start);
  });
  stream.on('end', () => {
    if (pending.length > 0) {
      emit(pending);
    }
    formatter.flush();
  });
}

module.exports = { startGameProcess, loadLocalDescriptor, getRequiredJavaMajor };
