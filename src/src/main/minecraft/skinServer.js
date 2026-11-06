'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { buildDiscoveryDocument, buildPublicKeys } = require('./servicesDiscovery');
const { offlineUuid, isOfflineUuid, texturesOf } = require('./signedSkins');

/*
 * Local Yggdrasil-compatible server. The game is pointed at it (by authlib-injector on older
 * versions, by the services discovery property on newer ones), asks it for the profile of the
 * offline account and gets the skin texture URL back. It listens on 127.0.0.1 only.
 * With the Amethyx server (signedSkins.js) it also answers for other players: a friend who joins
 * a world opened to LAN (hasJoined) and players an offline server sent without a skin.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const PROFILE_PATH = /^\/sessionserver\/session\/minecraft\/profile\/([0-9a-f]{32})$/;
const HAS_JOINED_PATH = '/sessionserver/session/minecraft/hasJoined';
const TEXTURE_PATH = /^\/textures\/([0-9a-f]{64})$/;
const DISCOVERY_PATH = '/discovery/minecraft/client';
const MOJANG_PROFILE_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const MOJANG_HAS_JOINED_URL = 'https://sessionserver.mojang.com/session/minecraft/hasJoined';
const PROXY_TIMEOUT_MS = 8000;
// A friend waits on the loading screen while this is asked (the game gives up after 30 seconds).
const HAS_JOINED_TIMEOUT_MS = 4000;
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

/** Mojang's profile answer for a property signed elsewhere (the Amethyx server). */
function signedAnswer(uuid, name, property) {
  return { id: uuid, name, properties: property ? [property] : [], profileActions: [] };
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

/** Mojang's own answer when a Microsoft player joined with this server id, else null. */
async function mojangHasJoined(search) {
  try {
    const upstream = await fetch(`${MOJANG_HAS_JOINED_URL}${search}`, { signal: AbortSignal.timeout(HAS_JOINED_TIMEOUT_MS) });
    const body = Buffer.from(await upstream.arrayBuffer());
    return upstream.status === 200 && body.length > 0 ? body : null;
  } catch {
    return null; // Offline or Mojang unreachable: the player is let in by name.
  }
}

/**
 * GET hasJoined: the game of a player who opened a world to LAN asks it when someone joins.
 * A Microsoft player gets Mojang's answer, as without the launcher. Anyone else gets the id the
 * game itself would give them (it lets everyone into such a world) and their signed Amethyx skin.
 */
async function handleHasJoined(search, response, amethyx, onPlayer) {
  const username = new URLSearchParams(search).get('username') ?? '';
  if (!username || username.length > 16) {
    response.writeHead(204).end();
    return;
  }
  const uuid = offlineUuid(username);
  const [mojang, property] = await Promise.all([mojangHasJoined(search), amethyx ? amethyx.signed.byName(username, uuid) : null]);
  if (mojang) {
    response.writeHead(200, JSON_HEADERS);
    response.end(mojang);
    return;
  }
  if (property) onPlayer(username);
  sendJson(response, 200, signedAnswer(uuid, username, property));
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
 * amethyx: { url, key, signed } — the Amethyx server, its skin key and createSignedSkins(url) — or null.
 *   authlib-injector trusts one key besides Mojang's, so with it the game trusts the server's key:
 *   other players' skins need it, and the own skin shows with any signature (the game lets the
 *   player's own skin through unchecked). Newer versions take a list of keys: both.
 * Resolves with { url, discoveryUrl, close() } once the server listens on a free local port.
 */
function startSkinServer({ profiles, signingKey, services, amethyx = null, onLog = () => {} }) {
  const trustedKey = amethyx?.key ?? signingKey.publicKey;
  const publicKeyPem = trustedKey.export({ type: 'spki', format: 'pem' });
  const publicKeyDer = signingKey.publicKey.export({ type: 'spki', format: 'der' });
  const extraKeys = amethyx ? [amethyx.key.export({ type: 'spki', format: 'der' })] : [];
  const skinDomains = [...new Set(['127.0.0.1', ...(amethyx ? [new URL(amethyx.url).hostname] : [])])];
  const seenPlayers = new Set();
  const onPlayer = (name) => {
    if (seenPlayers.has(name.toLowerCase())) return;
    seenPlayers.add(name.toLowerCase());
    onLog(`Скин: игрок ${name} — скин Amethyx`);
  };

  const known = new Map();
  const textures = new Map();
  for (const [uuid, profile] of profiles) {
    const hash = profile.png ? textureHash(profile.png) : null;
    const capeHash = profile.cape ? textureHash(profile.cape) : null;
    known.set(uuid, { ...profile, hash, capeHash });
    if (hash) textures.set(hash, profile.png);
    if (capeHash) textures.set(capeHash, profile.cape);
  }

  /**
   * The own profile signed by the Amethyx server when it has exactly this skin and cape: then the
   * friends in the player's world see it too. Asked anew each time (the skin may have just been sent).
   */
  async function ownSigned(uuid, profile) {
    if (!amethyx) return null;
    const property = await amethyx.signed.byName(profile.username, uuid, { fresh: true });
    const shown = property && texturesOf(property);
    const same = shown && shown.skin === profile.hash && shown.cape === profile.capeHash && (!profile.hash || shown.model === (profile.model === 'slim' ? 'slim' : 'classic'));
    return same ? property : null;
  }

  /** A player the game knows only by an offline id: the Amethyx server's signed skin, or 204. */
  async function otherOfflinePlayer(uuid, response) {
    const found = await amethyx.signed.byUuid(uuid);
    if (!found) {
      response.writeHead(204).end();
      return;
    }
    onPlayer(found.name);
    sendJson(response, 200, signedAnswer(uuid, found.name, found.property));
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
          skinDomains,
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
        sendJson(response, 200, buildPublicKeys(services?.publicKeys ?? {}, publicKeyDer, extraKeys));
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
        const uuid = profileMatch[1];
        const profile = known.get(uuid);
        if (!profile) {
          if (amethyx && isOfflineUuid(uuid)) {
            otherOfflinePlayer(uuid, response).catch(() => response.headersSent || response.writeHead(204).end());
          } else {
            proxyMojangProfile(uuid, search, response);
          }
          return;
        }
        onLog(`Скин: игра запросила профиль ${profile.username}`);
        ownSigned(uuid, profile)
          .catch(() => null)
          .then((property) => sendJson(response, 200, property ? signedAnswer(uuid, profile.username, property) : buildProfile(uuid, profile, baseUrl, signingKey.privateKey)));
        return;
      }

      if (pathname === HAS_JOINED_PATH && isGet) {
        handleHasJoined(search, response, amethyx, onPlayer).catch(() => response.headersSent || response.writeHead(204).end());
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
        // join: an offline player has no session to prove; the world's host lets them in by name.
        request.resume();
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
        discoveryDocument = buildDiscoveryDocument(services.discovery, baseUrl, amethyx?.url ?? null);
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
