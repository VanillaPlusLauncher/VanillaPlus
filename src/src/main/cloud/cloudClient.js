'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { request, HttpError } = require('../core/http');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { SerialQueue } = require('../core/serialQueue');
const { getAppPaths } = require('../core/paths');
const { createLogger } = require('../core/logger');
const { getSettings } = require('../settings/settingsService');
const { loadAccountStore, encryptSecret, decryptSecret } = require('../accounts/accountStore');

/*
 * Talks to the Amethyx server (server/ in this repository): sign-in per account, then JSON calls
 * with the session token. How each kind of account proves who it is:
 *  - Microsoft / Ely.by: the launcher "joins" a one-time server id at Mojang / Ely.by with the
 *    game session, and the Amethyx server checks that with them. The game token is sent only to
 *    Mojang / Ely.by, never to the Amethyx server.
 *  - Offline: a random secret made on this computer holds the name.
 * Tokens and secrets are kept encrypted (Windows DPAPI) in cloud.json.
 */

/** The Amethyx server built into releases (server/ deployed to Cloudflare, see server/README.md). */
const BUILT_IN_SERVER = 'https://vanillaplus.vanillaplus-server.workers.dev';
const JOIN_URL = {
  microsoft: 'https://sessionserver.mojang.com/session/minecraft/join',
  ely: 'https://authserver.ely.by/session/join',
};
const NAMESPACE = { microsoft: 'ms', ely: 'ely', offline: 'offline' };
const TIMEOUT_MS = 15000;
const queue = new SerialQueue();
const log = createLogger('cloud');
const signIns = new Map();

class CloudUnavailable extends Error {}

function storePath() {
  return path.join(getAppPaths().root, 'cloud.json');
}

async function readStore() {
  const stored = await readJsonFile(storePath(), null);
  return { sessions: {}, secrets: {}, published: {}, ...(stored && typeof stored === 'object' ? stored : {}) };
}

function updateStore(change) {
  return queue.run(async () => {
    const store = await readStore();
    change(store);
    await writeJsonFileAtomic(storePath(), store);
    return store;
  });
}

/** Encrypted when Windows can do it; a plain value only lives in memory then. */
function seal(value) {
  try {
    return { sealed: encryptSecret(value) };
  } catch {
    return null;
  }
}

function unseal(entry) {
  try {
    return entry?.sealed ? decryptSecret(entry.sealed) : null;
  } catch {
    return null;
  }
}

/** The server address, or null when online features are off or no server exists yet. */
function serverUrl(settings) {
  if (settings.social?.online === false) return null;
  return settings.social?.serverUrl || BUILT_IN_SERVER || null;
}

async function requireServer() {
  const url = serverUrl(await getSettings());
  if (!url) {
    throw new CloudUnavailable('Сервер Amethyx не подключён: друзья и общие скины пока недоступны.');
  }
  return url;
}

async function callServer(base, method, pathname, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await request(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: TIMEOUT_MS, retries: method === 'GET' ? 1 : 0 });
    return response.status === 204 ? null : response.json();
  } catch (error) {
    if (error instanceof HttpError) {
      let message = null;
      try {
        message = JSON.parse(error.body).error;
      } catch {
        // Not our JSON: keep the HTTP error.
      }
      if (message) {
        const friendly = new Error(message);
        friendly.status = error.status;
        throw friendly;
      }
    } else if (!(error instanceof Error && error.status)) {
      throw new Error(`Сервер Amethyx не отвечает (${error.message}).`);
    }
    throw error;
  }
}

async function findAccount(accountId) {
  const { accounts } = await loadAccountStore();
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new Error('Аккаунт не найден.');
  return account;
}

async function signIn(base, account) {
  if (account.type === 'offline') {
    const key = `offline:${String(account.uuid).replace(/-/g, '').toLowerCase()}`;
    const store = await readStore();
    let secret = unseal(store.secrets[key]);
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      const sealed = seal(secret);
      if (sealed) await updateStore((next) => { next.secrets[key] = sealed; });
    }
    return callServer(base, 'POST', '/v1/auth/offline', { body: { name: account.username, secret } });
  }
  const provider = account.type === 'ely' ? 'ely' : 'microsoft';
  // Lazy: accountService pulls in the sign-in flows.
  const { getLaunchSession } = require('../accounts/accountService');
  const session = await getLaunchSession(account.id);
  const uuid = String(session.uuid).replace(/-/g, '').toLowerCase();
  const challenge = await callServer(base, 'POST', '/v1/auth/challenge', { body: { ns: NAMESPACE[provider], name: session.username, uuid } });
  try {
    await request(JOIN_URL[provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: session.accessToken, selectedProfile: uuid, serverId: challenge.serverId }),
      timeoutMs: TIMEOUT_MS,
      retries: 0,
    });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new Error(provider === 'ely' ? 'Сессия Ely.by устарела: войдите в аккаунт заново.' : 'Сессия Microsoft устарела: войдите в аккаунт заново.');
    }
    throw error;
  }
  return callServer(base, 'POST', '/v1/auth/verify', { body: { challengeId: challenge.challengeId } });
}

/** A valid token for the account, signing in when there is none (one sign-in at a time per account). */
async function tokenFor(base, account, { fresh = false } = {}) {
  if (!fresh) {
    const store = await readStore();
    const saved = store.sessions[account.id];
    const token = saved?.server === base ? unseal(saved.token) : null;
    if (token) return token;
  }
  const key = `${base}|${account.id}`;
  if (!signIns.has(key)) {
    signIns.set(
      key,
      (async () => {
        const { token, user } = await signIn(base, account);
        const sealed = seal(token);
        if (sealed) {
          await updateStore((store) => {
            store.sessions[account.id] = { server: base, token: sealed, userId: user.id };
          });
        }
        log.info(`Вход на сервер Amethyx: ${user.id}`);
        return token;
      })().finally(() => signIns.delete(key)),
    );
  }
  return signIns.get(key);
}

/** A call as the given account; a stale token is renewed once. */
async function callAs(accountId, method, pathname, body) {
  const base = await requireServer();
  const account = await findAccount(accountId);
  let token = await tokenFor(base, account);
  try {
    return await callServer(base, method, pathname, { body, token });
  } catch (error) {
    if (error.status !== 401) throw error;
    token = await tokenFor(base, account, { fresh: true });
    return callServer(base, method, pathname, { body, token });
  }
}

/** The server address and a token for the account (for the live connection), signing in if needed. */
async function sessionFor(accountId) {
  const base = await requireServer();
  const account = await findAccount(accountId);
  return { base, token: await tokenFor(base, account) };
}

/** Raw GET as the account (pictures): resolves with the response body as a Buffer. */
async function fetchAs(accountId, pathname) {
  const base = await requireServer();
  const account = await findAccount(accountId);
  const get = async (token) => Buffer.from(await (await request(`${base}${pathname}`, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: TIMEOUT_MS, retries: 1 })).arrayBuffer());
  try {
    return await get(await tokenFor(base, account));
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    return get(await tokenFor(base, account, { fresh: true }));
  }
}

/** Forgets the server session of a removed account. */
function forgetAccount(accountId) {
  return updateStore((store) => {
    delete store.sessions[accountId];
    delete store.published[accountId];
  });
}

module.exports = { serverUrl, callAs, fetchAs, sessionFor, findAccount, readStore, updateStore, forgetAccount, CloudUnavailable, NAMESPACE };
