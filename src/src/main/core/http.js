'use strict';

// Sites like Modrinth ask launchers to say who they are and where to find them.
const USER_AGENT = `Amethyx/${require('../../../package.json').version} (github.com/VanillaPlusLauncher/VanillaPlus)`;
const DEFAULT_TIMEOUT_MS = 30000;

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} при запросе ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Where Cloudflare is blocked (Russia), Modrinth's and CurseForge's API, files and pictures do not
 * load. Once a direct try at one of those sites fails without an answer, it and everything after it
 * from that site (for this run) go through the Amethyx server's proxy instead (website/cloud,
 * /proxy: only these sites, on the site's own hosting). A direct try waits DIRECT_WAIT_MS at most.
 */
const PROXY = 'https://launcher.x-world.plus/cloud/proxy?u=';
const PROXIED_HOSTS = new Set(['api.modrinth.com', 'cdn.modrinth.com', 'api.curseforge.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net', 'forgecdn.net']);
const DIRECT_WAIT_MS = 15000;
const throughProxy = new Set();

function proxyHost(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && PROXIED_HOSTS.has(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/** The address to ask: the proxy's for a site that is blocked here, else the site's own. */
function routed(url) {
  const host = proxyHost(url);
  return host && throughProxy.has(host) ? `${PROXY}${encodeURIComponent(url)}` : url;
}

/** A direct try at `url` failed without an answer: its site goes through the proxy from now on. */
function switchToProxy(url, error) {
  const host = proxyHost(url);
  if (!host || throughProxy.has(host)) return false;
  throughProxy.add(host);
  require('./logger').createLogger('http').warn(`${host} не отвечает напрямую (${error.message}): дальше через сервер Amethyx`);
  return true;
}

function isRetryable(error) {
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 429;
  }
  return true; // network errors and timeouts
}

/**
 * fetch() with timeout, a User-Agent and retries for transient failures.
 * Resolves with the Response; throws HttpError for non-2xx answers.
 * The timeout covers the whole request including the body; a caller that streams a large body
 * passes its own `signal` instead and decides itself when the transfer is stuck.
 */
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, signal } = {}) {
  let lastError;
  let tries = retries;
  for (let attempt = 0; attempt <= tries; attempt += 1) {
    const target = routed(url);
    const direct = target === url && Boolean(proxyHost(url));
    try {
      const response = await fetch(target, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        body,
        redirect: 'follow',
        signal: signal ?? AbortSignal.timeout(direct ? Math.min(timeoutMs, DIRECT_WAIT_MS) : timeoutMs),
      });
      if (response.ok) {
        return response;
      }
      const text = await response.text().catch(() => '');
      throw new HttpError(response.status, url, text);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) {
        throw error;
      }
      // No answer from a site that is blocked here: the next try goes through the proxy at once.
      if (direct && !(error instanceof HttpError) && switchToProxy(url, error)) {
        tries = Math.max(tries, attempt + 1);
        continue;
      }
      if (!isRetryable(error)) {
        throw error;
      }
    }
    if (attempt < tries) {
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

const MAX_REDIRECTS = 8;

/**
 * GET as a Node stream (node:https), for large downloads. fetch()'s streaming body can crash the
 * whole main process when a server closes the connection while the reader is paused
 * (undici "assert(!this.paused)"), so files are not downloaded through fetch.
 * Resolves with { stream, headers, url } for a 2xx answer; `signal` aborts the transfer.
 */
function openStream(url, { headers = {}, signal } = {}, redirects = 0) {
  const target = new URL(routed(url));
  const direct = target.href === new URL(url).href && Boolean(proxyHost(url));
  const client = target.protocol === 'http:' ? require('node:http') : require('node:https');
  return new Promise((resolve, reject) => {
    let answered = false;
    // A site blocked here does not answer at all: after DIRECT_WAIT_MS it goes through the proxy.
    const failDirect = (error) => {
      if (!answered && direct && !signal?.aborted && switchToProxy(url, error)) {
        resolve(openStream(url, { headers, signal }, redirects));
        return true;
      }
      return false;
    };
    const waiting = direct ? setTimeout(() => req.destroy(new Error(`нет ответа за ${DIRECT_WAIT_MS / 1000} с`)), DIRECT_WAIT_MS) : null;
    const req = client.get(target, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal }, (response) => {
      answered = true;
      clearTimeout(waiting);
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`Слишком много перенаправлений: ${url}`));
          return;
        }
        resolve(openStream(new URL(response.headers.location, target).toString(), { headers, signal }, redirects + 1));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new HttpError(status, url, ''));
        return;
      }
      resolve({ stream: response, headers: response.headers, url: target.toString(), status });
    });
    req.on('error', (error) => {
      clearTimeout(waiting);
      if (!failDirect(error)) reject(error);
    });
  });
}

async function fetchJson(url, options) {
  const response = await request(url, { ...options, headers: { Accept: 'application/json', ...options?.headers } });
  return response.json();
}

async function postJson(url, payload, headers = {}) {
  const response = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function postForm(url, fields) {
  const response = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  return response.json();
}

module.exports = { request, openStream, fetchJson, postJson, postForm, HttpError };
