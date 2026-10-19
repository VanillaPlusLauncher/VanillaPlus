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
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        body,
        redirect: 'follow',
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        return response;
      }
      const text = await response.text().catch(() => '');
      throw new HttpError(response.status, url, text);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || signal?.aborted) {
        throw error;
      }
    }
    if (attempt < retries) {
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
  const target = new URL(url);
  const client = target.protocol === 'http:' ? require('node:http') : require('node:https');
  return new Promise((resolve, reject) => {
    const req = client.get(target, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal }, (response) => {
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
      resolve({ stream: response, headers: response.headers, url: target.toString() });
    });
    req.on('error', reject);
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
