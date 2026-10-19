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

/** Copies the instance's mods (without client-only ones) and configs to the server. */
async function syncContent(settings, instance, directory) {
  const contentService = require('../content/contentService');
  const mods = await contentService.listContent(settings, instance.id, 'mod');
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
    if (mod.side === 'client') {
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
    const meta = { instanceId, minecraft: instance.minecraft, loader: instance.loader.type, java: java.path, ramMb, port, start, createdAt: new Date().toISOString(), copiedMods: copied };
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
  const args = [`-Xmx${meta.ramMb}M`, ...(meta.start.argsFile ? [`@${meta.start.argsFile}`] : ['-jar', meta.start.jar]), 'nogui'];
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
    broadcast(CHANNELS.events.serverState, { instanceId, running: false });
  });
  pushLine(instanceId, `--- Запуск сервера на порту ${meta.port} ---`);
  broadcast(CHANNELS.events.serverState, { instanceId, running: true });
  return getServer(settings, instanceId);
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

/** Stops every server when the launcher quits. */
function stopAll() {
  return Promise.all([...running.keys()].map((id) => stopServer(id)));
}

module.exports = { getServer, createServer, startServer, stopServer, sendCommand, syncServerContent, deleteServer, stopAll };
