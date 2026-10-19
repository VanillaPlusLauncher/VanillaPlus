'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { buildDiscoveryDocument, buildPublicKeys } = require('./servicesDiscovery');

/*
 * Local Yggdrasil-compatible server. The game is pointed at it (by authlib-injector on older
 * versions, by the services discovery property on newer ones), asks it for the profile of the
 * offline account and gets the skin texture URL back. It listens on 127.0.0.1 only.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const PROFILE_PATH = /^\/sessionserver\/session\/minecraft\/profile\/([0-9a-f]{32})$/;
const TEXTURE_PATH = /^\/textures\/([0-9a-f]{64})$/;
const DISCOVERY_PATH = '/discovery/minecraft/client';
const MOJANG_PROFILE_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const PROXY_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * What Mojang would tell an offline player: chat and multiplayer allowed, no Realms,
 * telemetry or friends (they need a real account). Field names follow authlib's UserAttributesResponse.
 */
const OFFLINE_ATTRIBUTES = {
  privileges: {
    onlineChat: { enabled: true },
    multiplayerServer: { enabled: true },
    multiplayerRealms: { enabled: false },
    telemetry: { enabled: false },
    optionalTelemetry: { enabled: false },
  },
  profanityFilterPreferences: { profanityFilterOn: false },
  friendsPreferences: { friends: 'DISABLED', acceptInvites: 'DISABLED' },
  chatPreferences: { textCommunication: 'ENABLED' },
  banStatus: { bannedScopes: {} },
};

function sendJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

/** SHA-256 of the PNG: the game caches skins by the texture URL's file name, so a new skin must get a new name. */
function textureHash(png) {
  return crypto.createHash('sha256').update(png).digest('hex');
}

/** Signs the textures property like Mojang does (SHA1withRSA), so authlib accepts it as secure. */
function signProperty(value, privateKey) {
  return crypto.sign('sha1', Buffer.from(value), privateKey).toString('base64');
}

function buildProfile(uuid, profile, baseUrl, privateKey) {
  const texturesPayload = {
    timestamp: Date.now(),
    profileId: uuid,
    profileName: profile.username,
    textures: {
      ...(profile.hash
        ? {
            SKIN: {
              url: `${baseUrl}/textures/${profile.hash}`,
              // Classic skins carry no metadata in Mojang's API; older game versions expect exactly that.
              ...(profile.model === 'slim' ? { metadata: { model: 'slim' } } : {}),
            },
          }
        : {}),
      ...(profile.capeHash ? { CAPE: { url: `${baseUrl}/textures/${profile.capeHash}` } } : {}),
    },
  };
  const value = Buffer.from(JSON.stringify(texturesPayload)).toString('base64');
  return {
    id: uuid,
    name: profile.username,
    properties: [{ name: 'textures', value, signature: signProperty(value, privateKey) }],
    profileActions: [],
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** POST /api/profiles/minecraft: names -> [{ id, name }]. Old game versions look skins up by name. */
async function handleProfileLookup(request, response, profiles) {
  let names;
  try {
    names = JSON.parse(await readBody(request));
  } catch {
    sendJson(response, 400, { error: 'IllegalArgumentException', errorMessage: 'Invalid request body' });
    return;
  }
  const wanted = new Set((Array.isArray(names) ? names : []).map((name) => String(name).toLowerCase()));
  const found = [];
  for (const [uuid, profile] of profiles) {
    if (wanted.has(profile.username.toLowerCase())) {
      found.push({ id: uuid, name: profile.username });
    }
  }
  sendJson(response, 200, found);
}

/** Profiles of other players (multiplayer) come from Mojang as before. */
async function proxyMojangProfile(uuid, search, response) {
  try {
    const upstream = await fetch(`${MOJANG_PROFILE_URL}${uuid}${search}`, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (upstream.status === 200 && body.length > 0) {
      response.writeHead(200, JSON_HEADERS);
      response.end(body);
      return;
    }
  } catch {
    // Offline or Mojang unreachable: the player simply has the default skin.
  }
  response.writeHead(204).end();
}

function handleAuthServer(pathname, response) {
  if (pathname === '/authserver/authenticate') {
    sendJson(response, 403, { error: 'ForbiddenOperationException', errorMessage: 'Офлайн-режим: сервер авторизации не нужен' });
    return;
  }
  response.writeHead(204).end();
}

/**
 * profiles: Map<uuid without dashes, { username, model, png: Buffer | null, cape: Buffer | null }>.
 * signingKey: { privateKey, publicKey } (node KeyObjects, RSA).
 * services: { discovery, publicKeys } from Mojang, used for the discovery document of newer versions.
 * Resolves with { url, discoveryUrl, close() } once the server listens on a free local port.
 */
function startSkinServer({ profiles, signingKey, services, onLog = () => {} }) {
  const publicKeyPem = signingKey.publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeyDer = signingKey.publicKey.export({ type: 'spki', format: 'der' });

  const known = new Map();
  const textures = new Map();
  for (const [uuid, profile] of profiles) {
    const hash = profile.png ? textureHash(profile.png) : null;
    const capeHash = profile.cape ? textureHash(profile.cape) : null;
    known.set(uuid, { ...profile, hash, capeHash });
    if (hash) textures.set(hash, profile.png);
    if (capeHash) textures.set(capeHash, profile.cape);
  }

  return new Promise((resolve, reject) => {
    let baseUrl = '';
    let discoveryDocument = null;

    const server = http.createServer((request, response) => {
      const { pathname, search } = new URL(request.url, 'http://127.0.0.1');
      const isGet = request.method === 'GET';

      if (pathname === '/' && isGet) {
        sendJson(response, 200, {
          meta: { serverName: 'Amethyx Launcher offline skins', implementationName: 'Amethyx', implementationVersion: '1.0' },
          skinDomains: ['127.0.0.1'],
          signaturePublickey: publicKeyPem,
        });
        return;
      }

      if (pathname === DISCOVERY_PATH && isGet && discoveryDocument) {
        onLog('Офлайн-сервисы: игра подключилась к лаунчеру');
        sendJson(response, 200, discoveryDocument);
        return;
      }

      if (pathname === '/minecraftservices/publickeys' && isGet) {
        sendJson(response, 200, buildPublicKeys(services?.publicKeys ?? {}, publicKeyDer));
        return;
      }

      // authlib-injector maps api.minecraftservices.com to /minecraftservices, the discovery document points here too.
      if (pathname === '/minecraftservices/player/attributes') {
        request.resume();
        sendJson(response, 200, OFFLINE_ATTRIBUTES);
        return;
      }
      if (pathname === '/minecraftservices/privacy/blocklist' && isGet) {
        sendJson(response, 200, { blockedProfiles: [] });
        return;
      }

      const profileMatch = PROFILE_PATH.exec(pathname);
      if (profileMatch && isGet) {
        const profile = known.get(profileMatch[1]);
        if (!profile) {
          proxyMojangProfile(profileMatch[1], search, response);
          return;
        }
        onLog(`Скин: игра запросила профиль ${profile.username}`);
        sendJson(response, 200, buildProfile(profileMatch[1], profile, baseUrl, signingKey.privateKey));
        return;
      }

      const textureMatch = TEXTURE_PATH.exec(pathname);
      if (textureMatch && isGet) {
        const png = textures.get(textureMatch[1]);
        if (!png) {
          response.writeHead(404).end();
          return;
        }
        onLog('Скин: игра загрузила текстуру');
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        response.end(png);
        return;
      }

      if (pathname === '/api/profiles/minecraft' && request.method === 'POST') {
        handleProfileLookup(request, response, known).catch(() => {
          if (!response.headersSent) {
            response.writeHead(400).end();
          }
        });
        return;
      }

      if (pathname.startsWith('/authserver/')) {
        handleAuthServer(pathname, response);
        return;
      }

      if (pathname.startsWith('/sessionserver/')) {
        // join / hasJoined: single-player only, nothing to verify.
        response.writeHead(204).end();
        return;
      }

      response.writeHead(404).end();
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      if (services?.discovery) {
        discoveryDocument = buildDiscoveryDocument(services.discovery, baseUrl);
      }
      resolve({
        url: baseUrl,
        discoveryUrl: `${baseUrl}${DISCOVERY_PATH}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

module.exports = { startSkinServer, buildProfile };
