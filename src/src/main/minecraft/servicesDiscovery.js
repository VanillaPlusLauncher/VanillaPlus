'use strict';

const { fetchJson } = require('../core/http');
const { createLogger } = require('../core/logger');

/*
 * Newer game versions (authlib 10+, Minecraft 26.x) no longer have hard-coded Mojang URLs:
 * they download a "discovery" document that lists every service endpoint. authlib-injector
 * cannot redirect those, but the game reads -Dminecraft.api.discovery.host, so the skin server
 * serves a copy of Mojang's document where only the profile, key and texture entries point to it.
 */

const DISCOVERY_URL = 'https://discovery.minecraftservices.com/minecraft/client';
const PUBLIC_KEYS_URL = 'https://api.minecraftservices.com/publickeys';
const FETCH_OPTIONS = { timeoutMs: 6000, retries: 0 };
const log = createLogger('services-discovery');

/** Mojang's discovery document as of 2026-10; used when the real one cannot be downloaded. */
const FALLBACK_DISCOVERY = {
  environment: 'prod',
  product: 'minecraft',
  discovery: {
    authentication: {
      endpoints: {
        getPublicKeys: { uri: 'https://api.minecraftservices.com/publickeys' },
        loginXbox: { uri: 'https://api.minecraftservices.com/authentication/login_with_xbox' },
      },
    },
    session: {
      endpoints: {
        getProfileById: { uri: 'https://sessionserver.mojang.com/session/minecraft/profile/{profileId}' },
        verify: { uri: 'https://sessionserver.mojang.com/session/minecraft/hasJoined' },
        join: { uri: 'https://sessionserver.mojang.com/session/minecraft/join' },
      },
    },
    player: {
      endpoints: {
        updatePresence: { uri: 'https://api.minecraftservices.com/presence' },
        sendReport: { uri: 'https://api.minecraftservices.com/player/report' },
        getAttributes: { uri: 'https://api.minecraftservices.com/player/attributes' },
        getFriends: { uri: 'https://api.minecraftservices.com/friends' },
        getCertificates: { uri: 'https://api.minecraftservices.com/player/certificates' },
        updateAttributes: { uri: 'https://api.minecraftservices.com/player/attributes' },
        updateFriends: { uri: 'https://api.minecraftservices.com/friends' },
        getBlocklist: { uri: 'https://api.minecraftservices.com/privacy/blocklist' },
      },
    },
    profiles: {
      endpoints: {
        getManyByName: { uri: 'https://api.mojang.com/profiles/minecraft' },
        getByName: { uri: 'https://api.mojang.com/users/profiles/minecraft/{name}' },
        getTexture: {
          validUris: ['https://textures.minecraft.net/texture/{textureId}', 'http://textures.minecraft.net/texture/{textureId}'],
        },
      },
    },
    telemetry: {
      endpoints: {
        sendEvents: { uri: 'https://api.minecraftservices.com/events' },
      },
    },
  },
};

/**
 * Downloads Mojang's discovery document and public keys (profile textures of other players
 * stay valid with them). Never throws: missing pieces fall back to the built-in copy / no keys.
 */
async function fetchMojangServices() {
  const [discovery, publicKeys] = await Promise.all([
    fetchJson(DISCOVERY_URL, FETCH_OPTIONS).catch((error) => {
      log.warn(`Не удалось получить discovery Mojang (${error.message}), используем встроенную копию`);
      return null;
    }),
    fetchJson(PUBLIC_KEYS_URL, FETCH_OPTIONS).catch((error) => {
      log.warn(`Не удалось получить ключи Mojang (${error.message})`);
      return null;
    }),
  ]);
  return {
    discovery: discovery?.discovery ? discovery : FALLBACK_DISCOVERY,
    publicKeys: publicKeys && typeof publicKeys === 'object' ? publicKeys : {},
  };
}

/** Mojang's document with the profile, public key and texture entries pointing at the local server. */
function buildDiscoveryDocument(template, baseUrl) {
  const document = structuredClone(template);
  const services = (document.discovery ??= {});
  const endpoints = (service) => ((services[service] ??= {}).endpoints ??= {});

  endpoints('authentication').getPublicKeys = { uri: `${baseUrl}/minecraftservices/publickeys` };
  endpoints('session').getProfileById = { uri: `${baseUrl}/sessionserver/session/minecraft/profile/{profileId}` };
  // Mojang answers 401 to the offline token "0"; the local answers keep the log clean.
  endpoints('player').getAttributes = { uri: `${baseUrl}/minecraftservices/player/attributes` };
  endpoints('player').updateAttributes = { uri: `${baseUrl}/minecraftservices/player/attributes` };
  endpoints('player').getBlocklist = { uri: `${baseUrl}/minecraftservices/privacy/blocklist` };
  const texture = endpoints('profiles').getTexture ?? {};
  endpoints('profiles').getTexture = {
    ...texture,
    validUris: [...(texture.validUris ?? []), `${baseUrl}/textures/{textureId}`],
  };
  return document;
}

/** Public key set: ours signs the local profiles, Mojang's keep other players' skins valid. */
function buildPublicKeys(mojangKeys, ownPublicKeyDer) {
  return {
    ...mojangKeys,
    profilePropertyKeys: [{ publicKey: ownPublicKeyDer.toString('base64') }, ...(mojangKeys.profilePropertyKeys ?? [])],
    playerCertificateKeys: mojangKeys.playerCertificateKeys ?? [],
  };
}

module.exports = { fetchMojangServices, buildDiscoveryDocument, buildPublicKeys, FALLBACK_DISCOVERY };
