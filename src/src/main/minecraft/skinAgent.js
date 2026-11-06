'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { nativeImage } = require('electron');
const AdmZip = require('adm-zip');
const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');
const { loadSkin, loadCape, normalizeUuid } = require('../skins/skinStore');
const { startSkinServer } = require('./skinServer');
const { startRealmsStub } = require('./realmsStub');
const { startLegacySkinProxy } = require('./legacySkinProxy');
const { createSkinLookup } = require('./playerSkins');
const { ensureAuthlibInjector } = require('./authlibInjector');
const { fetchMojangServices } = require('./servicesDiscovery');
const { loadLocalDescriptor } = require('./gameLauncher');
const { resolveLibraries } = require('./libraryResolver');
const { ELY_INJECTOR_TARGET } = require('../accounts/elyAuth');

const SIGNING_KEY_FILE = 'skin-signing-key.pem';
/** authlib 10+ (Minecraft 26.x) reads every service URL from a discovery document. */
const DISCOVERY_CLASS = 'com/mojang/authlib/services/MinecraftServicesDiscoveryService.class';
const log = createLogger('skin-agent');

/**
 * RSA key that signs the local profiles. Kept on disk: generating a 4096-bit key takes a few
 * seconds, and the size matches Mojang's keys that authlib expects.
 */
async function loadSigningKey(toolsDirectory) {
  const keyPath = path.join(toolsDirectory, SIGNING_KEY_FILE);
  try {
    const privateKey = crypto.createPrivateKey(await fsp.readFile(keyPath, 'utf8'));
    return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
  } catch {
    // Missing or damaged: make a new one.
  }
  // promisify resolves with named { publicKey, privateKey }; the raw callback passes the public key first.
  const { privateKey, publicKey } = await promisify(crypto.generateKeyPair)('rsa', { modulusLength: 4096 });
  await fsp.mkdir(toolsDirectory, { recursive: true });
  await fsp.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { privateKey, publicKey };
}

/**
 * How the game can be pointed at the local server:
 * 'discovery' — authlib with services discovery (newer versions), a system property is enough;
 * 'injector'  — older authlib with hard-coded Mojang URLs: authlib-injector rewrites them;
 * 'legacy'    — no authlib at all (before 1.7): skins come over plain HTTP, a local HTTP proxy answers.
 */
async function detectSkinMode(layout, versionId) {
  const descriptor = await loadLocalDescriptor(layout, versionId);
  const authlib = resolveLibraries(descriptor).classpath.find((library) => library.relativePath.startsWith('com/mojang/authlib/'));
  if (!authlib) {
    return 'legacy';
  }
  try {
    const zip = new AdmZip(layout.libraryPath(authlib.relativePath));
    return zip.getEntry(DISCOVERY_CLASS) ? 'discovery' : 'injector';
  } catch (error) {
    log.warn(`Не удалось прочитать authlib (${error.message}), используем authlib-injector`);
    return 'injector';
  }
}

/** Old clients read a 64x32 skin: the top half of the modern layout (head, body, right arm and leg, hat). */
function toLegacySkin(png) {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  if (width !== 64 || height <= 32) {
    return png;
  }
  return image.crop({ x: 0, y: 0, width: 64, height: 32 }).toPNG();
}

/**
 * Versions that ask for every player's skin by name over plain HTTP: all before authlib (up to 1.6)
 * and 1.7.2–1.7.5, which have authlib for logging in but still load skins the old way.
 */
function asksSkinsByName(mode, minecraft) {
  return mode === 'legacy' || /^1\.7\.[2-5]$/.test(String(minecraft ?? ''));
}

/**
 * Starts the HTTP proxy that answers such versions: the player's own skin and cape, Amethyx skins
 * of everyone else, then Mojang's or Ely.by's (playerSkins.js). No mod is needed for that.
 * own: { username, png, cape, model } or null (then the own skin is looked up like anyone's).
 */
async function startLegacyServices({ session, serverUrl, own, onLog }) {
  const proxy = await startLegacySkinProxy({
    lookup: createSkinLookup({ serverUrl, provider: session.provider, own }),
    toLegacy: toLegacySkin,
    onLog: (message) => {
      log.info(message);
      onLog(message);
    },
  });
  log.info(`Прокси скинов для старой версии запущен на порту ${proxy.port}`);
  onLog(`Скины игроков: лаунчер отвечает игре сам, без мода${serverUrl ? ' (скины Amethyx всех игроков)' : ''}`);
  return { args: ['-Dhttp.proxyHost=127.0.0.1', `-Dhttp.proxyPort=${proxy.port}`], stop: () => proxy.close() };
}

/** Starts the local profile/skin server and returns the JVM arguments that point the game at it. */
async function startProfileServices({ session, uuid, skin, mode, onLog }) {
  const { toolsDirectory } = getAppPaths();
  const [signingKey, services, jarPath] = await Promise.all([
    loadSigningKey(toolsDirectory),
    mode === 'discovery' ? fetchMojangServices() : null,
    mode === 'injector' ? ensureAuthlibInjector(toolsDirectory) : null,
  ]);
  const profiles = new Map(skin?.png || skin?.cape ? [[uuid, { username: session.username, model: skin.model, png: skin.png, cape: skin.cape }]] : []);
  const server = await startSkinServer({
    profiles,
    signingKey,
    services,
    onLog: (message) => {
      log.info(message);
      onLog(message);
    },
  });
  log.info(`Локальный сервер профилей запущен: ${server.url} (режим ${mode})`);
  const args =
    mode === 'discovery' ? [`-Dminecraft.api.discovery.host=${server.discoveryUrl}`] : [`-javaagent:${jarPath}=${server.url}`];
  return { args, stop: () => server.close() };
}

/** The game's arguments and a stop() for the services started; null when nothing was started. */
function agentOf(args, stops, env = {}) {
  if (stops.length === 0 && args.length === 0) {
    return null;
  }
  return { args, env, stop: () => Promise.all(stops.map((stop) => stop())).then(() => {}) };
}

/** Old versions: the skin proxy; a failure is written to the log and the game starts without it. */
async function addLegacyServices({ args, stops, session, serverUrl, own, onLog }) {
  try {
    const services = await startLegacyServices({ session, serverUrl, own, onLog });
    args.push(...services.args);
    stops.push(services.stop);
  } catch (error) {
    log.error(`Прокси скинов не запущен: ${error.message}`);
    onLog(`Скины игроков не подключены: ${error.message}`);
  }
}

/**
 * Ely.by accounts: authlib-injector points the game's authlib at Ely.by, so the session is
 * accepted by Ely.by servers and every player's Ely.by skin shows. Versions that load skins by name
 * get them from the launcher's proxy instead: Amethyx skins first, then Ely.by's.
 */
async function prepareElyAgent({ session, mode, byName, serverUrl, onLog }) {
  const args = [];
  const stops = [];
  if (mode !== 'legacy') {
    const jarPath = await ensureAuthlibInjector(getAppPaths().toolsDirectory);
    args.push(`-javaagent:${jarPath}=${ELY_INJECTOR_TARGET}`);
    // 1.7.2–1.7.5: authlib-injector would answer the skin requests by name itself (Ely.by only).
    if (byName) args.push('-Dauthlibinjector.legacySkinPolyfill=disabled');
    onLog('Вход через Ely.by: подключён authlib-injector');
  }
  if (byName) {
    await addLegacyServices({ args, stops, session, serverUrl, own: null, onLog });
  }
  return agentOf(args, stops);
}

/**
 * Prepares what an account needs besides the game itself:
 * - old versions (skins by name): every player's skin from the launcher, Amethyx skins included;
 * - offline accounts: their own skin (local profile server, see skinServer.js), quiet answers
 *   instead of Mojang's 401 for player attributes (newer versions) and for Realms.
 * Returns { args, env, stop } or null (Microsoft accounts on newer versions use Mojang's services as
 * they are). Nothing here ever blocks the launch: a failed part is skipped and the log says why.
 * `minecraft`: the game version (1.7.2–1.7.5 load skins by name); `serverUrl`: the Amethyx server or null.
 */
async function prepareSkinAgent({ session, layout, versionId, minecraft = null, serverUrl = null, onLog = () => {} }) {
  let mode = 'injector';
  try {
    mode = await detectSkinMode(layout, versionId);
  } catch (error) {
    log.warn(`Не удалось определить версию authlib: ${error.message}`);
  }
  const byName = asksSkinsByName(mode, minecraft);
  if (session.provider === 'ely') {
    return prepareElyAgent({ session, mode, byName, serverUrl, onLog });
  }
  if (session.userType !== 'legacy') {
    if (!byName) {
      return null; // Microsoft accounts use Mojang's services as they are.
    }
    const args = [];
    const stops = [];
    await addLegacyServices({ args, stops, session, serverUrl, own: null, onLog });
    return agentOf(args, stops);
  }
  let uuid = null;
  try {
    uuid = normalizeUuid(session.uuid);
  } catch {
    // Without a valid UUID there is no skin; Realms can still be silenced.
  }
  const [stored, cape] = uuid ? await Promise.all([loadSkin(uuid), loadCape(uuid)]) : [null, null];
  const skin = stored || cape ? { png: stored?.png ?? null, model: stored?.model ?? 'classic', cape } : null;

  const args = [];
  const env = {};
  const stops = [];

  if (byName) {
    // Old versions: the proxy serves the own skin and cape and every other player's (works offline for the own one).
    await addLegacyServices({ args, stops, session, serverUrl, own: { username: session.username, png: skin?.png ?? null, cape: skin?.cape ?? null, model: skin?.model }, onLog });
    if (skin?.png) {
      onLog(`Скин: подключён свой скин (${skin.model === 'slim' ? 'тонкая модель' : 'классическая модель'})`);
    }
  } else if (uuid && (skin || mode === 'discovery')) {
    // Older authlib needs authlib-injector (a download) for this, so it gets it only with a skin.
    try {
      const profileServices = await startProfileServices({ session, uuid, skin, mode, onLog });
      args.push(...profileServices.args);
      stops.push(profileServices.stop);
      if (skin?.png) {
        onLog(`Скин: подключён свой скин (${skin.model === 'slim' ? 'тонкая модель' : 'классическая модель'})`);
      }
      if (skin?.cape) {
        onLog('Скин: подключён свой плащ');
      }
    } catch (error) {
      log.error(`Офлайн-сервисы не запущены: ${error.message}`);
      onLog(`Скин не применён: ${error.message}`);
    }
  }

  // Versions before 1.7 have no Realms at all.
  const realms = mode === 'legacy' ? null : await startRealmsStub();
  if (realms) {
    // Newer versions read the system property, older ones the environment variable.
    args.push('-Drealms.environment=local');
    env['realms.environment'] = 'local';
    stops.push(realms.close);
  } else if (mode !== 'legacy') {
    log.warn('Порт 8080 занят: Realms останется как в обычном офлайн-режиме');
  }

  return agentOf(args, stops, env);
}

module.exports = { prepareSkinAgent, asksSkinsByName };
