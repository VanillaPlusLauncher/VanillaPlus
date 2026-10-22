'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { broadcast } = require('../core/broadcast');
const { createTaskReporter } = require('../core/progressReporter');
const { createLogger } = require('../core/logger');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { CHANNELS } = require('../../shared/channels');
const { resolveJavaForLaunch } = require('../java/javaService');
const { getRequiredJavaMajor } = require('./gameLauncher');
const { installerUrl } = require('./loaderInstaller');
const instanceService = require('./instanceService');
const serverList = require('./serverList');

/*
 * "Server in one click": a Minecraft server made from an instance, for playing with friends.
 * The server core matching the instance (vanilla, Fabric, Quilt, Forge, NeoForge) goes into
 * <game folder>/servers/<instance>, with the instance's mods minus client-only ones and its configs.
 * The launcher starts and stops it, shows its console and adds it to the instance's server list.
 * The Minecraft EULA is accepted only by the user, with a tick in the window.
 */

const META_FILE = 'amethyx-server.json';
/** Written by Vanilla+ Launcher; read when the new file is not there yet. */
const OLD_META_FILE = 'vanillaplus-server.json';
const LOG_LIMIT = 3000;
const STOP_TIMEOUT_MS = 30000;
const EXTRA_FOLDERS = ['config', 'defaultconfigs', 'kubejs'];
const log = createLogger('server');

/** Running servers: instanceId -> { child, port } */
const running = new Map();
/** Console lines of each server, kept after it stops (the window shows how it ended). */
const consoles = new Map();

function serverDirectory(settings, instanceId) {
  return path.join(settings.gameDirectory, 'servers', instanceId);
}

async function readMeta(directory) {
  return (await readJsonFile(path.join(directory, META_FILE), null)) ?? readJsonFile(path.join(directory, OLD_META_FILE), null);
}

function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        return address.address;
      }
    }
  }
  return null;
}

/** State of an instance's server: { exists, running, port, directory, lan, … }. */
async function getServer(settings, instanceId) {
  const directory = serverDirectory(settings, instanceId);
  const meta = await readMeta(directory);
  const live = running.get(instanceId);
  return {
    exists: Boolean(meta),
    running: Boolean(live),
    directory,
    port: meta?.port ?? 25565,
    lan: lanAddress(),
    loader: meta?.loader ?? null,
    minecraft: meta?.minecraft ?? null,
    createdAt: meta?.createdAt ?? null,
    // "Доступ из интернета": friends with Amethyx come in through the tunnel (cloud/tunnel.js).
    tunnel: { enabled: Boolean(meta?.tunnel?.enabled), hosting: require('../cloud/tunnel').isHostingServer(instanceId) },
    lines: [...(consoles.get(instanceId) ?? [])],
  };
}

function runJava(javaPath, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    const forward = (chunk) => chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((line) => onLine?.(line));
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Установщик сервера завершился с кодом ${code}`))));
  });
}

/** Downloads the server core and returns how to start it: { jar } or { argsFile } (relative to the server folder). */
async function installCore({ instance, directory, java, report }) {
  const { type, version } = instance.loader;
  const mc = instance.minecraft;
  if (type === 'vanilla') {
    const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const entry = manifest.versions.find((candidate) => candidate.id === mc);
    if (!entry) throw new Error(`Версия ${mc} не найдена у Mojang.`);
    const descriptor = await fetchJson(entry.url);
    const server = descriptor.downloads?.server;
    if (!server) throw new Error(`Для ${mc} Mojang не выпускает сервер.`);
    report('Сервер Minecraft', 30, mc);
    await downloadFile(server.url, path.join(directory, 'server.jar'), { sha1: server.sha1, size: server.size });
    return { jar: 'server.jar' };
  }
  if (type === 'fabric') {
    const installers = await fetchJson('https://meta.fabricmc.net/v2/versions/installer');
    const installer = (installers.find((candidate) => candidate.stable) ?? installers[0]).version;
    report('Fabric для сервера', 30, version);
    await downloadFile(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${version}/${installer}/server/jar`, path.join(directory, 'fabric-server-launch.jar'), { deepVerify: false });
    return { jar: 'fabric-server-launch.jar' };
  }
  if (type === 'quilt') {
    const installers = await fetchJson('https://meta.quiltmc.org/v3/versions/installer');
    const installer = installers[0].version;
    const installerJar = path.join(directory, 'quilt-installer.jar');
    report('Quilt для сервера', 30, version);
    await downloadFile(`https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installer}/quilt-installer-${installer}.jar`, installerJar, { deepVerify: false });
    await runJava(java.path, ['-jar', 'quilt-installer.jar', 'install', 'server', mc, version, '--install-dir=.', '--download-server'], directory, (line) => report('Quilt для сервера', 45, line.slice(0, 80)));
    await fsp.rm(installerJar, { force: true });
    return { jar: 'quilt-server-launch.jar' };
  }
  if (type === 'forge' || type === 'neoforge') {
    const installerJar = path.join(directory, 'installer.jar');
    report(`${type === 'forge' ? 'Forge' : 'NeoForge'} для сервера`, 25, version);
    await downloadFile(installerUrl(type, version), installerJar, { deepVerify: false });
    await runJava(java.path, ['-jar', 'installer.jar', '--installServer'], directory, (line) => report(`${type === 'forge' ? 'Forge' : 'NeoForge'} для сервера`, 50, line.slice(0, 80)));
    await fsp.rm(installerJar, { force: true });
    await fsp.rm(path.join(directory, 'installer.jar.log'), { force: true });
    // New installers write an argument file (libraries/…/win_args.txt), old ones a "universal" jar.
    const group = type === 'forge' ? 'net/minecraftforge/forge' : version.startsWith('1.20.1-') ? 'net/neoforged/forge' : 'net/neoforged/neoforge';
    const argsFile = path.join('libraries', ...group.split('/'), version, 'win_args.txt');
    if (await fsp.stat(path.join(directory, argsFile)).catch(() => null)) {
      return { argsFile };
    }
    const jar = (await fsp.readdir(directory)).find((name) => /^(forge|neoforge)-.*\.jar$/i.test(name) && !/installer/i.test(name));
    if (!jar) throw new Error('Установщик не создал файлы для запуска сервера.');
    return { jar };
  }
  throw new Error(`Сервер для загрузчика ${type} не поддерживается.`);
}

// --- Mods the launcher does not know --------------------------------------------------------

/**
 * Where a mod goes, with the player's answer for mods on neither Modrinth nor CurseForge (their own
 * or a friend's): 'server' puts it on the server, 'client' keeps it in the game only. An unknown mod
 * nobody answered for stays off the server: a client-only mod there would stop it from starting.
 */
function serverSide(mod, choices) {
  const choice = choices?.[mod.file] ?? choices?.[String(mod.file).replace(/\.disabled$/i, '')];
  if (choice === 'server') return 'both';
  if (choice === 'client') return 'client';
  if (!mod.platform && mod.side !== 'client' && mod.side !== 'server') return 'unknown';
  return mod.side;
}

/** Mods the launcher cannot place by itself, to ask about: [{ file, title, version, icon, side }]. */
async function unknownMods(settings, instanceId) {
  const mods = await modsForServer(settings, instanceId);
  return mods.filter((mod) => mod.enabled && mod.side === 'unknown').map(({ file, title, version, icon, guess }) => ({ file, title, version, icon, guess }));
}

/** Saves the answers: { file: 'server' | 'client' }. */
async function setModSides(settings, instanceId, answers) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const choices = { ...(instance.overrides?.serverMods ?? {}) };
  for (const [file, side] of Object.entries(answers ?? {})) {
    if (typeof file === 'string' && file.length <= 255 && ['server', 'client'].includes(side)) choices[file] = side;
  }
  await instanceService.updateInstance(settings, instanceId, { overrides: { serverMods: choices } });
  return choices;
}

/** Copies the instance's mods (without client-only ones) and configs to the server. */
async function syncContent(settings, instance, directory) {
  const contentService = require('../content/contentService');
  const choices = instance.overrides?.serverMods ?? {};
  const mods = (await contentService.listContent(settings, instance.id, 'mod')).map((mod) => ({ ...mod, side: serverSide(mod, choices) }));
  const target = path.join(directory, 'mods');
  // Mods the launcher put there before are replaced; files the user added to the server stay.
  const meta = (await readMeta(directory)) ?? {};
  for (const old of meta.copiedMods ?? []) {
    await fsp.rm(path.join(target, old), { force: true });
  }
  await fsp.mkdir(target, { recursive: true });
  const copied = [];
  const skipped = [];
  for (const mod of mods) {
    if (!mod.enabled || mod.folder) continue;
    if (mod.side === 'client' || mod.side === 'unknown') {
      skipped.push(mod.title);
      continue;
    }
    await fsp.copyFile(path.join(instance.directory, 'mods', mod.file), path.join(target, mod.file));
    copied.push(mod.file);
  }
  for (const folder of EXTRA_FOLDERS) {
    const from = path.join(instance.directory, folder);
    if (await fsp.stat(from).catch(() => null)) {
      await fsp.cp(from, path.join(directory, folder), { recursive: true, force: true });
    }
  }
  return { copied, skipped };
}

/**
 * Creates (or recreates) the server of an instance.
 * options: { port, onlineMode, motd, ramMb, acceptEula }.
 */
async function createServer(settings, instanceId, options = {}) {
  if (!options.acceptEula) {
    throw new Error('Чтобы запустить сервер, нужно принять EULA Minecraft.');
  }
  if (running.has(instanceId)) {
    throw new Error('Сначала остановите сервер.');
  }
  const instance = await instanceService.ensureInstanceReady(settings, instanceId).then((ready) => ({ ...ready, directory: instanceService.layoutFor(settings).instanceDirectory(instanceId) }));
  const directory = serverDirectory(settings, instanceId);
  const port = Math.min(65535, Math.max(1024, Number(options.port) || 25565));
  const reporter = createTaskReporter({ taskId: `server:${instanceId}`, kind: 'server', label: `Сервер «${instance.name}»` });
  try {
    await fsp.mkdir(directory, { recursive: true });
    const layout = instanceService.layoutFor(settings);
    const java = await resolveJavaForLaunch(await getRequiredJavaMajor(layout, instance.minecraft), settings);
    reporter.report('Ядро сервера', 10, instance.loader.type);
    const start = await installCore({ instance, directory, java, report: (stage, percent, detail) => reporter.report(stage, percent, detail) });
    reporter.report('Моды и настройки', 75, '');
    const { copied, skipped } = await syncContent(settings, instance, directory);
    await fsp.writeFile(path.join(directory, 'eula.txt'), `# Принято в Amethyx Launcher ${new Date().toISOString()} (https://aka.ms/MinecraftEULA)\neula=true\n`);
    const propertiesFile = path.join(directory, 'server.properties');
    const existing = await fsp.readFile(propertiesFile, 'utf8').catch(() => '');
    const properties = new Map(existing.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    properties.set('server-port', String(port));
    properties.set('online-mode', options.onlineMode ? 'true' : 'false');
    properties.set('motd', String(options.motd || `Сервер ${instance.name}`).replace(/[\r\n]/g, ' ').slice(0, 59));
    await fsp.writeFile(propertiesFile, `#Minecraft server properties\n${[...properties].map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
    const ramMb = Math.max(1024, Number(options.ramMb) || 4096);
    // Made again: its tunnel (invites already sent) and Java arguments stay.
    const previous = (await readMeta(directory)) ?? {};
    const meta = { instanceId, minecraft: instance.minecraft, loader: instance.loader.type, java: java.path, ramMb, port, start, createdAt: new Date().toISOString(), copiedMods: copied, tunnel: previous.tunnel, javaArgs: previous.javaArgs };
    await writeJsonFileAtomic(path.join(directory, META_FILE), meta);
    // A start script, for running the server without the launcher.
    const command = start.argsFile ? `@${start.argsFile}` : `-jar ${start.jar}`;
    await fsp.writeFile(path.join(directory, 'start.bat'), `@echo off\r\ncd /d "%~dp0"\r\n"${java.path}" -Xmx${ramMb}M ${command} nogui\r\npause\r\n`);
    // The instance can join its own server from the Servers tab.
    const servers = await serverList.listServers(instance.directory).catch(() => []);
    const address = port === 25565 ? 'localhost' : `localhost:${port}`;
    if (!servers.some((server) => server.address === address)) {
      await serverList.saveServers(instance.directory, [...servers.map((server) => ({ key: server.key, name: server.name, address: server.address })), { name: `Мой сервер (${instance.name})`, address }]).catch(() => {});
    }
    reporter.finish('done', 'Сервер готов');
    log.info(`Сервер «${instance.name}» создан в ${directory}: ${copied.length} модов, без клиентских: ${skipped.length}`);
    return { ...(await getServer(settings, instanceId)), copied: copied.length, skipped };
  } catch (error) {
    reporter.finish('error', error.message);
    throw error;
  }
}

function pushLine(instanceId, line) {
  const lines = consoles.get(instanceId) ?? [];
  consoles.set(instanceId, lines);
  lines.push(line);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  broadcast(CHANNELS.events.serverLog, { instanceId, line });
}

async function startServer(settings, instanceId) {
  if (running.has(instanceId)) {
    return getServer(settings, instanceId);
  }
  const directory = serverDirectory(settings, instanceId);
  const meta = await readMeta(directory);
  if (!meta) throw new Error('Сервер ещё не создан.');
  const args = [`-Xmx${meta.ramMb}M`, ...splitArgs(meta.javaArgs), ...(meta.start.argsFile ? [`@${meta.start.argsFile}`] : ['-jar', meta.start.jar]), 'nogui'];
  const child = spawn(meta.java, args, { cwd: directory, windowsHide: true });
  running.set(instanceId, { child, port: meta.port });
  consoles.set(instanceId, []);
  const forward = (chunk) => chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((line) => pushLine(instanceId, line));
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  child.on('error', (error) => pushLine(instanceId, `Не удалось запустить Java: ${error.message}`));
  child.on('exit', (code) => {
    pushLine(instanceId, `--- Сервер остановлен (код ${code ?? '—'}) ---`);
    running.delete(instanceId);
    require('../cloud/tunnel').stopServer(instanceId);
    broadcast(CHANNELS.events.serverState, { instanceId, running: false });
  });
  pushLine(instanceId, `--- Запуск сервера на порту ${meta.port} ---`);
  if (meta.tunnel?.enabled && meta.tunnel.id) {
    const name = (await instanceService.getInstance(settings, instanceId).catch(() => null))?.name ?? instanceId;
    require('../cloud/tunnel')
      .hostServer(instanceId, meta.tunnel.id, meta.port, name)
      .then(() => {
        pushLine(instanceId, '--- Туннель открыт: друзья с Amethyx заходят по приглашению ---');
        broadcast(CHANNELS.events.serverState, { instanceId, running: running.has(instanceId) });
      })
      .catch((error) => pushLine(instanceId, `--- Туннель не открылся: ${error.message} ---`));
  }
  broadcast(CHANNELS.events.serverState, { instanceId, running: true });
  return getServer(settings, instanceId);
}

/** Extra Java arguments as typed ("-XX:+UseG1GC -Dfoo=bar"), quotes kept together. */
function splitArgs(text) {
  return String(text ?? '').match(/"[^"]*"|\S+/g)?.map((part) => part.replace(/^"|"$/g, '')) ?? [];
}

// --- Server settings ----------------------------------------------------------------------------

const PROPERTIES_FILE = 'server.properties';
const PLAYER_FILES = { whitelist: 'whitelist.json', ops: 'ops.json', banned: 'banned-players.json' };
const NAME = /^[A-Za-z0-9_]{1,16}$/;

async function readProperties(directory) {
  const text = await fsp.readFile(path.join(directory, PROPERTIES_FILE), 'utf8').catch(() => '');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    // server.properties escapes ":" and "=" in values with a backslash.
    map.set(line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).replace(/\\([:=\\])/g, '$1'));
  }
  return map;
}

async function writeProperties(directory, map) {
  const lines = [...map].map(([key, value]) => `${key}=${String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/=/g, '\\=')}`);
  await fsp.writeFile(path.join(directory, PROPERTIES_FILE), `#Minecraft server properties\n#${new Date().toUTCString()}\n${lines.join('\n')}\n`);
}

async function requireMeta(settings, instanceId) {
  const directory = serverDirectory(settings, instanceId);
  const meta = await readMeta(directory);
  if (!meta) throw new Error('Сервер ещё не создан.');
  return { directory, meta };
}

async function writeMeta(directory, meta) {
  await writeJsonFileAtomic(path.join(directory, META_FILE), meta);
}

/** Folders that hold a world (a level.dat inside). */
async function worldFolders(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const worlds = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await fsp.stat(path.join(directory, entry.name, 'level.dat')).catch(() => null))) worlds.push(entry.name);
  }
  return worlds.sort((a, b) => a.localeCompare(b, 'ru'));
}

async function readPlayers(directory) {
  const players = {};
  for (const [list, file] of Object.entries(PLAYER_FILES)) {
    const entries = await readJsonFile(path.join(directory, file), []);
    players[list] = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.name).map((entry) => ({ name: String(entry.name), uuid: entry.uuid ?? null, level: entry.level ?? null }));
  }
  return players;
}

/** Everything the server's settings window shows. */
async function getServerSettings(settings, instanceId) {
  const { directory, meta } = await requireMeta(settings, instanceId);
  const instance = await instanceService.getInstance(settings, instanceId);
  return {
    running: running.has(instanceId),
    minecraft: meta.minecraft,
    loader: meta.loader,
    properties: Object.fromEntries(await readProperties(directory)),
    ramMb: meta.ramMb,
    javaArgs: meta.javaArgs ?? '',
    worlds: await worldFolders(directory),
    saves: await worldFolders(path.join(instance.directory, 'saves')),
    players: await readPlayers(directory),
    icon: Boolean(await fsp.stat(path.join(directory, 'server-icon.png')).catch(() => null)),
  };
}

/**
 * Saves the settings window: { properties: { key: value }, ramMb, javaArgs }. Keys the window does
 * not know stay as they are. A running server takes them on its next start.
 */
async function saveServerSettings(settings, instanceId, changes = {}) {
  const { directory, meta } = await requireMeta(settings, instanceId);
  const properties = await readProperties(directory);
  for (const [key, value] of Object.entries(changes.properties ?? {})) {
    if (!/^[a-z0-9.\-]{1,64}$/.test(key)) continue;
    properties.set(key, String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 500));
  }
  const port = Number(properties.get('server-port'));
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) meta.port = port;
  else properties.set('server-port', String(meta.port));
  if (changes.ramMb !== undefined) meta.ramMb = Math.min(65536, Math.max(1024, Math.round(Number(changes.ramMb) || meta.ramMb)));
  if (changes.javaArgs !== undefined) meta.javaArgs = String(changes.javaArgs ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 2000);
  await writeProperties(directory, properties);
  await writeMeta(directory, meta);
  const command = meta.start.argsFile ? `@${meta.start.argsFile}` : `-jar ${meta.start.jar}`;
  await fsp.writeFile(path.join(directory, 'start.bat'), `@echo off\r\ncd /d "%~dp0"\r\n"${meta.java}" -Xmx${meta.ramMb}M ${meta.javaArgs ? `${meta.javaArgs} ` : ''}${command} nogui\r\npause\r\n`);
  return getServerSettings(settings, instanceId);
}

/** The offline UUID the server gives a name when online-mode is off (as the game computes it). */
function offlineUuid(name) {
  const hash = require('node:crypto').createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function playerUuid(name, online) {
  if (!online) return offlineUuid(name);
  const profile = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`).catch(() => null);
  if (!profile?.id) throw new Error(`Игрока «${name}» нет среди аккаунтов Microsoft. Для офлайн-ников выключите «Только лицензия».`);
  return profile.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

const PLAYER_COMMANDS = {
  whitelist: { add: 'whitelist add', remove: 'whitelist remove' },
  ops: { add: 'op', remove: 'deop' },
  banned: { add: 'ban', remove: 'pardon' },
};

/**
 * Adds or removes a player in the white list, the operators or the banned ones. A running server
 * is told by command; a stopped one gets its file written (with the UUID it would use itself).
 */
async function changePlayer(settings, instanceId, list, action, rawName) {
  const name = String(rawName ?? '').trim();
  if (!PLAYER_FILES[list] || !['add', 'remove'].includes(action)) throw new Error('Неверный запрос.');
  if (!NAME.test(name)) throw new Error('Ник: латинские буквы, цифры и «_», до 16 символов.');
  const { directory } = await requireMeta(settings, instanceId);
  if (running.has(instanceId)) {
    sendCommand(instanceId, `${PLAYER_COMMANDS[list][action]} ${name}`);
    // The server writes its file a moment later.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return readPlayers(directory);
  }
  const file = path.join(directory, PLAYER_FILES[list]);
  const entries = (await readJsonFile(file, [])).filter((entry) => String(entry?.name).toLowerCase() !== name.toLowerCase());
  if (action === 'add') {
    const online = (await readProperties(directory)).get('online-mode') === 'true';
    const uuid = await playerUuid(name, online);
    if (list === 'ops') entries.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
    else if (list === 'banned') entries.push({ uuid, name, created: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000'), source: 'Amethyx', expires: 'forever', reason: 'Banned by an operator.' });
    else entries.push({ uuid, name });
  }
  await writeJsonFileAtomic(file, entries);
  return readPlayers(directory);
}

function assertStopped(instanceId) {
  if (running.has(instanceId)) throw new Error('Сначала остановите сервер.');
}

/** A free folder name for a world on the server. */
async function freeWorldName(directory, wanted) {
  const base = String(wanted ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 40) || 'world';
  let name = base;
  for (let index = 2; await fsp.stat(path.join(directory, name)).catch(() => null); index += 1) name = `${base} ${index}`;
  return name;
}

/** Copies a world of the instance onto the server and makes it the server's world. Resolves with its name. */
async function importWorld(settings, instanceId, saveName) {
  assertStopped(instanceId);
  const { directory } = await requireMeta(settings, instanceId);
  const instance = await instanceService.getInstance(settings, instanceId);
  const source = path.join(instance.directory, 'saves', path.basename(String(saveName)));
  if (!(await fsp.stat(path.join(source, 'level.dat')).catch(() => null))) throw new Error('Мир не найден.');
  const name = await freeWorldName(directory, path.basename(source));
  await fsp.cp(source, path.join(directory, name), { recursive: true });
  await fsp.rm(path.join(directory, name, 'session.lock'), { force: true });
  const properties = await readProperties(directory);
  properties.set('level-name', name);
  await writeProperties(directory, properties);
  return name;
}

/** A new world on the next start: { name, seed, type }. Resolves with its name. */
async function newWorld(settings, instanceId, { name, seed = '', type = '' } = {}) {
  assertStopped(instanceId);
  const { directory } = await requireMeta(settings, instanceId);
  const folder = await freeWorldName(directory, name || 'world');
  const properties = await readProperties(directory);
  properties.set('level-name', folder);
  properties.set('level-seed', String(seed ?? '').replace(/[\r\n]/g, '').slice(0, 64));
  if (type) properties.set('level-type', String(type).slice(0, 64));
  await writeProperties(directory, properties);
  return folder;
}

/** A world of the server to the recycle bin. */
async function deleteWorld(settings, instanceId, name) {
  assertStopped(instanceId);
  const { directory } = await requireMeta(settings, instanceId);
  const target = path.join(directory, path.basename(String(name)));
  if (!(await fsp.stat(path.join(target, 'level.dat')).catch(() => null))) throw new Error('Мир не найден.');
  const { shell } = require('electron');
  await shell.trashItem(target);
}

/** The picture in the friends' server list: a 64×64 PNG (a data URL from the window). */
async function setServerIcon(settings, instanceId, dataUrl) {
  const { directory } = await requireMeta(settings, instanceId);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!match) throw new Error('Нужна картинка PNG.');
  const { nativeImage } = require('electron');
  const image = nativeImage.createFromBuffer(Buffer.from(match[1], 'base64'));
  if (image.isEmpty()) throw new Error('Картинка повреждена.');
  await fsp.writeFile(path.join(directory, 'server-icon.png'), image.resize({ width: 64, height: 64, quality: 'best' }).toPNG());
}

/** "Доступ из интернета" on or off. On: the server keeps one tunnel; it opens whenever the server runs. */
async function setServerTunnel(settings, instanceId, enabled) {
  const { directory, meta } = await requireMeta(settings, instanceId);
  const tunnel = require('../cloud/tunnel');
  if (enabled) {
    const id = await tunnel.serverTunnelId(meta.tunnel?.id ?? null);
    meta.tunnel = { id, enabled: true };
    await writeMeta(directory, meta);
    if (running.has(instanceId)) {
      const instance = await instanceService.getInstance(settings, instanceId);
      await tunnel.hostServer(instanceId, id, meta.port, instance.name);
    }
  } else {
    meta.tunnel = { ...(meta.tunnel ?? {}), enabled: false };
    await writeMeta(directory, meta);
    tunnel.stopServer(instanceId);
  }
  return getServer(settings, instanceId);
}

/** The server's tunnel for an invite (switched on when it was off). Resolves with { id, name, running }. */
async function serverInvite(settings, instanceId) {
  if (!(await readMeta(serverDirectory(settings, instanceId)))) {
    throw new Error('У этой сборки ещё нет своего сервера: создайте его на вкладке «Серверы» → «Свой сервер».');
  }
  let { meta } = await requireMeta(settings, instanceId);
  if (!meta.tunnel?.enabled || !meta.tunnel.id) {
    await setServerTunnel(settings, instanceId, true);
    ({ meta } = await requireMeta(settings, instanceId));
  }
  return { id: meta.tunnel.id, running: running.has(instanceId) };
}

/** Sends a console command ("stop", "op Steve", "say привет"). */
function sendCommand(instanceId, command) {
  const live = running.get(instanceId);
  if (!live) throw new Error('Сервер не запущен.');
  const text = String(command ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 1000);
  if (text) {
    pushLine(instanceId, `> ${text}`);
    live.child.stdin.write(`${text}\n`);
  }
}

/** Saves and stops the server ("stop"); kills it when it does not stop in time. */
function stopServer(instanceId) {
  const live = running.get(instanceId);
  if (!live) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => live.child.kill(), STOP_TIMEOUT_MS);
    live.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    sendCommand(instanceId, 'stop');
  });
}

async function syncServerContent(settings, instanceId) {
  if (running.has(instanceId)) throw new Error('Сначала остановите сервер.');
  const directory = serverDirectory(settings, instanceId);
  const meta = await readMeta(directory);
  if (!meta) throw new Error('Сервер ещё не создан.');
  const instance = await instanceService.getInstance(settings, instanceId);
  const result = await syncContent(settings, instance, directory);
  await writeJsonFileAtomic(path.join(directory, META_FILE), { ...meta, copiedMods: result.copied });
  return result;
}

async function deleteServer(settings, instanceId) {
  if (running.has(instanceId)) throw new Error('Сначала остановите сервер.');
  const { shell } = require('electron');
  const directory = serverDirectory(settings, instanceId);
  if (await fsp.stat(directory).catch(() => null)) {
    // To the recycle bin: the server's world can still be brought back.
    await shell.trashItem(directory);
  }
}

function anyServerRunning() {
  return running.size > 0;
}

/** Stops every server when the launcher quits. */
function stopAll() {
  return Promise.all([...running.keys()].map((id) => stopServer(id)));
}

// --- "Для хостинга": the instance as a server pack ----------------------------------------------

/** Folders of mods that load data packs for every world (Paxi, Open Loader, Global Packs…). */
const GLOBAL_DATAPACK_FOLDERS = ['datapacks', 'global_packs', 'openloader', 'paxi'];
const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const SIDE_NAMES = { client: 'только клиент', server: 'только сервер', both: 'клиент и сервер', unknown: 'неизвестный мод' };

/**
 * The instance's mods with where each is needed, for choosing what goes on a server. Mods not
 * installed through the launcher are looked up on Modrinth by their file first (works offline too,
 * then from the mods' own files only). [{ file, title, version, icon, side, enabled, size }]
 */
async function modsForServer(settings, instanceId) {
  const contentService = require('../content/contentService');
  await contentService.identifyContent(settings, instanceId, 'mod').catch((error) => log.warn(`Моды не распознаны на Modrinth: ${error.message}`));
  await contentService.resolveSides(settings, instanceId).catch((error) => log.warn(`Стороны модов не получены: ${error.message}`));
  const instance = await instanceService.getInstance(settings, instanceId);
  const choices = instance.overrides?.serverMods ?? {};
  const mods = await contentService.listContent(settings, instanceId, 'mod');
  return mods
    .filter((mod) => !mod.folder)
    .map((mod) => ({
      file: mod.file,
      title: mod.title,
      version: mod.version,
      icon: mod.icon,
      side: serverSide(mod, choices),
      // What the mod's own file says, as a hint for the question about it.
      guess: mod.side,
      known: Boolean(mod.platform),
      enabled: mod.enabled,
      size: mod.size,
    }));
}

/** The mods that go on the server: the chosen files, or by default every enabled one not client-only. */
function pickServerMods(mods, files) {
  if (Array.isArray(files)) {
    const chosen = new Set(files);
    return { included: mods.filter((mod) => chosen.has(mod.file)), left: mods.filter((mod) => !chosen.has(mod.file)) };
  }
  const included = mods.filter((mod) => mod.enabled && mod.side !== 'client' && mod.side !== 'unknown');
  return { included, left: mods.filter((mod) => !included.includes(mod)) };
}

function modListText(instance, included, left) {
  const loader = LOADER_NAMES[instance.loader.type] ?? instance.loader.type;
  const line = (mod) => `  ${mod.title}${mod.version ? ` ${mod.version}` : ''} — ${mod.file}${mod.side ? ` (${SIDE_NAMES[mod.side] ?? mod.side})` : ''}`;
  return [
    `Моды сервера «${instance.name}» — Amethyx Launcher`,
    `Minecraft ${instance.minecraft}${instance.loader.type === 'vanilla' ? '' : `, ${loader} ${String(instance.loader.version ?? '').replace(`${instance.minecraft}-`, '')}`}`,
    '',
    `На сервер (${included.length}):`,
    ...included.map(line),
    '',
    left.length ? `Не на сервер (${left.length}) — клиентские, выключенные или снятые вручную:` : null,
    ...left.map(line),
  ].filter((value) => value !== null).join('\r\n');
}

/** Saves the server's mod list (what goes on the server and what stays on the client) as a text file. */
async function exportServerModList(settings, instanceId, target, files = null) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const mods = await modsForServer(settings, instanceId);
  const { included, left } = pickServerMods(mods, files);
  await fsp.writeFile(target, `${modListText(instance, included, left)}\r\n`);
  return { path: target, mods: included.length };
}

/**
 * The instance prepared for any hosting, as a zip or a plain folder, made of what was ticked:
 *  mods      — the chosen mod files (by default every enabled mod except client-only ones);
 *  configs   — config, defaultconfigs, kubejs;  resourcepacks — the resourcepacks folder;
 *  datapacks — folders of global data packs (datapacks, global_packs, openloader, paxi);
 *  world     — a world of the instance, as "world" (its own data packs come with it);
 *  core      — a whole server: its core (vanilla, Fabric, Quilt, Forge or NeoForge, installed here),
 *              server.properties (port, onlineMode), start.bat / start.sh (ramMb), eula.txt only
 *              when the user accepted the EULA.
 * Always: mods.txt (the server's mod list) and ПРОЧТИ.txt (how to use it). Resolves with
 * { path, mods, skipped, format }.
 */
async function exportServerPack(settings, instanceId, target, options = {}) {
  const format = options.format === 'folder' ? 'folder' : 'zip';
  const plain = await instanceService.getInstance(settings, instanceId);
  const instance = options.core ? { ...(await instanceService.ensureInstanceReady(settings, instanceId)), directory: plain.directory } : plain;
  const reporter = createTaskReporter({ taskId: `serverpack:${instanceId}`, kind: 'server', label: 'Сервер для хостинга', instance: instance.name });
  if (format === 'folder' && (await fsp.readdir(target).catch(() => [])).length > 0) {
    throw new Error(`Папка «${path.basename(target)}» уже есть и не пустая. Выберите другое место.`);
  }
  const work = format === 'folder' ? target : path.join(os.tmpdir(), `amethyx-serverpack-${Date.now()}`);
  try {
    await fsp.mkdir(work, { recursive: true });
    const layout = instanceService.layoutFor(settings);
    const javaMajor = await getRequiredJavaMajor(layout, instance.minecraft).catch(() => null);
    let start = null;
    if (options.core) {
      reporter.report('Ядро сервера', 5, instance.loader.type);
      const java = await resolveJavaForLaunch(javaMajor, settings);
      start = await installCore({ instance, directory: work, java, report: (stage, percent, detail) => reporter.report(stage, 5 + percent * 0.5, detail) });
    }
    reporter.report('Моды', 60, '');
    const mods = await modsForServer(settings, instanceId);
    const { included, left } = pickServerMods(mods, options.mods);
    if (included.length) {
      await fsp.mkdir(path.join(work, 'mods'), { recursive: true });
      for (const mod of included) {
        await fsp.copyFile(path.join(instance.directory, 'mods', mod.file), path.join(work, 'mods', mod.file.replace(/\.disabled$/i, '')));
      }
    }
    const copyFolder = async (folder, to = folder) => {
      const from = path.join(instance.directory, folder);
      if (!(await fsp.stat(from).catch(() => null))) return false;
      await fsp.cp(from, path.join(work, to), { recursive: true, force: true });
      return true;
    };
    reporter.report('Настройки и паки', 70, '');
    const extras = [];
    if (options.configs !== false) for (const folder of EXTRA_FOLDERS) if (await copyFolder(folder)) extras.push(folder);
    if (options.resourcepacks && (await copyFolder('resourcepacks'))) extras.push('resourcepacks');
    if (options.datapacks) for (const folder of GLOBAL_DATAPACK_FOLDERS) if (await copyFolder(folder)) extras.push(folder);
    if (options.world) {
      const world = path.join(instance.directory, 'saves', path.basename(String(options.world)));
      if (await fsp.stat(world).catch(() => null)) {
        reporter.report('Мир', 78, path.basename(world));
        await fsp.cp(world, path.join(work, 'world'), { recursive: true });
        // Kept by the game for single player; a server keeps its own lock.
        await fsp.rm(path.join(work, 'world', 'session.lock'), { force: true });
        extras.push('world');
      }
    }
    const loaderName = LOADER_NAMES[instance.loader.type] ?? instance.loader.type;
    const loaderLine = instance.loader.type === 'vanilla' ? `Minecraft ${instance.minecraft} без модов` : `Minecraft ${instance.minecraft}, ${loaderName} ${String(instance.loader.version ?? '').replace(`${instance.minecraft}-`, '')}`;
    await fsp.writeFile(path.join(work, 'mods.txt'), `${modListText(instance, included, left)}\r\n`);
    const notes = [`Сервер из сборки «${instance.name}» — Amethyx Launcher`, '', `Версия: ${loaderLine}`, javaMajor ? `Java: ${javaMajor} или новее` : null, `Модов: ${included.length} (список — mods.txt)`, extras.length ? `Ещё: ${extras.join(', ')}` : null, ''];
    if (options.core && start) {
      const port = Math.min(65535, Math.max(1024, Number(options.port) || 25565));
      const ramMb = Math.max(1024, Number(options.ramMb) || 4096);
      const properties = ['#Minecraft server properties', `server-port=${port}`, `online-mode=${options.onlineMode ? 'true' : 'false'}`, `motd=${`Сервер ${instance.name}`.replace(/[\r\n]/g, ' ').slice(0, 59)}`, 'level-name=world'];
      await fsp.writeFile(path.join(work, 'server.properties'), `${properties.join('\n')}\n`);
      if (options.acceptEula) {
        await fsp.writeFile(path.join(work, 'eula.txt'), `# Принято в Amethyx Launcher ${new Date().toISOString()} (https://aka.ms/MinecraftEULA)\neula=true\n`);
      }
      const winCommand = start.argsFile ? `@${start.argsFile}` : `-jar ${start.jar}`;
      const unixCommand = start.argsFile ? `@${start.argsFile.replace(/win_args\.txt$/, 'unix_args.txt').replace(/\\/g, '/')}` : `-jar ${start.jar}`;
      await fsp.writeFile(path.join(work, 'start.bat'), `@echo off\r\ncd /d "%~dp0"\r\njava -Xmx${ramMb}M ${winCommand} nogui\r\npause\r\n`);
      await fsp.writeFile(path.join(work, 'start.sh'), `#!/bin/sh\ncd "$(dirname "$0")"\nexec java -Xmx${ramMb}M ${unixCommand} nogui\n`);
      notes.push(
        'Как запустить:',
        '  Windows — start.bat; Linux / хостинг — start.sh (или команда из него).',
        `  Порт ${port}, ${options.onlineMode ? 'только лицензионные игроки' : 'можно заходить без лицензии (online-mode=false)'}.`,
        options.acceptEula ? '  EULA Minecraft принята (eula.txt).' : '  Перед первым запуском откройте eula.txt и поставьте eula=true — так вы принимаете EULA Minecraft (https://aka.ms/MinecraftEULA).',
      );
    } else {
      notes.push('Как использовать:', `  1. На хостинге выберите ${loaderLine}.`, '  2. Загрузите эти папки в папку сервера (mods, config и остальные).', options.world ? '  3. Папка world — это мир: её туда же.' : null);
    }
    await fsp.writeFile(path.join(work, 'ПРОЧТИ.txt'), `${notes.filter((line) => line !== null).join('\r\n')}\r\n`);
    if (format === 'zip') {
      reporter.report('Архив', 88, path.basename(target));
      const { writeZip } = require('../core/zipWriter');
      await writeZip(target, (zip) => zip.addFolder('', work));
    }
    reporter.finish('done', path.basename(target));
    log.info(`Сборка «${instance.name}» подготовлена для хостинга (${format}, ядро: ${Boolean(options.core)}): ${target}`);
    return { path: target, mods: included.length, skipped: left.filter((mod) => mod.side === 'client').map((mod) => mod.title), format };
  } catch (error) {
    reporter.finish('error', error.message);
    if (format === 'folder') await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (format === 'zip') await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  getServer,
  createServer,
  startServer,
  stopServer,
  sendCommand,
  syncServerContent,
  deleteServer,
  stopAll,
  anyServerRunning,
  modsForServer,
  unknownMods,
  setModSides,
  exportServerPack,
  exportServerModList,
  getServerSettings,
  saveServerSettings,
  changePlayer,
  importWorld,
  newWorld,
  deleteWorld,
  setServerIcon,
  setServerTunnel,
  serverInvite,
};
