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

/** Starts the HTTP proxy that serves the skin to versions before 1.7. */
async function startLegacyServices({ session, skin, onLog }) {
  const proxy = await startLegacySkinProxy({
    skins: new Map([[session.username.toLowerCase(), toLegacySkin(skin.png)]]),
    onLog: (message) => {
      log.info(message);
      onLog(message);
    },
  });
  log.info(`Прокси скинов для старой версии запущен на порту ${proxy.port}`);
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

/** Ely.by serves every player's skin (and Mojang's for names it does not know) by nickname. */
const ELY_SKIN_URL = 'https://skinsystem.ely.by/skins/';

/**
 * Ely.by accounts: authlib-injector points the game's authlib at Ely.by, so the session is
 * accepted by Ely.by servers and every player's Ely.by skin shows. Versions before 1.7 have no
 * authlib: their skin comes over plain HTTP, which the legacy proxy answers with the Ely.by skin.
 */
async function prepareElyAgent({ session, layout, versionId, onLog }) {
  let mode = 'injector';
  try {
    mode = await detectSkinMode(layout, versionId);
  } catch (error) {
    log.warn(`Не удалось определить версию authlib: ${error.message}`);
  }
  if (mode === 'legacy') {
    try {
      const response = await fetch(`${ELY_SKIN_URL}${encodeURIComponent(session.username)}.png`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        return null;
      }
      const png = Buffer.from(await response.arrayBuffer());
      return startLegacyServices({ session, skin: { png }, onLog });
    } catch (error) {
      onLog(`Скин Ely.by не загружен: ${error.message}`);
      return null;
    }
  }
  const jarPath = await ensureAuthlibInjector(getAppPaths().toolsDirectory);
  onLog('Вход через Ely.by: подключён authlib-injector');
  return { args: [`-javaagent:${jarPath}=${ELY_INJECTOR_TARGET}`], env: {}, stop: async () => {} };
}

/**
 * Prepares what an offline account needs besides the game itself:
 * - its own skin (local profile server, see skinServer.js);
 * - quiet answers instead of Mojang's 401 for player attributes (newer versions) and for Realms.
 * Returns { args, env, stop } or null for Microsoft accounts. Nothing here ever blocks the launch:
 * a failed part is skipped and the log says why. `onLog` receives lines for the game log.
 */
async function prepareSkinAgent({ session, layout, versionId, onLog = () => {} }) {
  if (session.provider === 'ely') {
    return prepareElyAgent({ session, layout, versionId, onLog });
  }
  if (session.userType !== 'legacy') {
    return null; // Microsoft accounts use Mojang's services as they are.
  }
  let uuid = null;
  try {
    uuid = normalizeUuid(session.uuid);
  } catch {
    // Without a valid UUID there is no skin; Realms can still be silenced.
  }
  const [stored, cape] = uuid ? await Promise.all([loadSkin(uuid), loadCape(uuid)]) : [null, null];
  // Versions before 1.7 (the plain HTTP proxy) take only the skin.
  const skin = stored || cape ? { png: stored?.png ?? null, model: stored?.model ?? 'classic', cape } : null;

  const args = [];
  const env = {};
  const stops = [];

  let mode = 'injector';
  try {
    mode = await detectSkinMode(layout, versionId);
  } catch (error) {
    log.warn(`Не удалось определить версию authlib: ${error.message}`);
  }

  // Older versions need authlib-injector (a download) or the proxy for this, so they get it only with a skin.
  if (uuid && ((mode === 'legacy' ? skin?.png : skin) || mode === 'discovery')) {
    try {
      const profileServices =
        mode === 'legacy' ? await startLegacyServices({ session, skin, onLog }) : await startProfileServices({ session, uuid, skin, mode, onLog });
      args.push(...profileServices.args);
      stops.push(profileServices.stop);
      if (skin?.png) {
        onLog(`Скин: подключён свой скин (${skin.model === 'slim' ? 'тонкая модель' : 'классическая модель'})`);
      }
      if (skin?.cape && mode !== 'legacy') {
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

  if (stops.length === 0) {
    return null;
  }
  return {
    args,
    env,
    stop: () => Promise.all(stops.map((stop) => stop())).then(() => {}),
  };
}

module.exports = { prepareSkinAgent };
