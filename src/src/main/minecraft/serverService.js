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
const SIDE_NAMES = { client: 'только клиент', server: 'только сервер', both: 'клиент и сервер' };

/**
 * The instance's mods with where each is needed, for choosing what goes on a server. Mods not
 * installed through the launcher are looked up on Modrinth by their file first (works offline too,
 * then from the mods' own files only). [{ file, title, version, icon, side, enabled, size }]
 */
async function modsForServer(settings, instanceId) {
  const contentService = require('../content/contentService');
  await contentService.identifyContent(settings, instanceId, 'mod').catch((error) => log.warn(`Моды не распознаны на Modrinth: ${error.message}`));
  await contentService.resolveSides(settings, instanceId).catch((error) => log.warn(`Стороны модов не получены: ${error.message}`));
  const mods = await contentService.listContent(settings, instanceId, 'mod');
  return mods.filter((mod) => !mod.folder).map((mod) => ({ file: mod.file, title: mod.title, version: mod.version, icon: mod.icon, side: mod.side, enabled: mod.enabled, size: mod.size }));
}

/** The mods that go on the server: the chosen files, or by default every enabled one not client-only. */
function pickServerMods(mods, files) {
  if (Array.isArray(files)) {
    const chosen = new Set(files);
    return { included: mods.filter((mod) => chosen.has(mod.file)), left: mods.filter((mod) => !chosen.has(mod.file)) };
  }
  const included = mods.filter((mod) => mod.enabled && mod.side !== 'client');
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

module.exports = { getServer, createServer, startServer, stopServer, sendCommand, syncServerContent, deleteServer, stopAll, anyServerRunning, modsForServer, exportServerPack, exportServerModList };
