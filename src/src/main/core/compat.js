'use strict';

/*
 * The build for Windows 7 and 8 runs on Electron 22, whose Node (16) has no global fetch and no
 * structuredClone. What the launcher uses of them is added here, only when missing, so the same
 * code runs on both builds. Loaded first thing in index.js.
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

const MAX_REDIRECTS = 8;

/** The parts of fetch's Response the launcher reads: ok, status, url, headers.get, text/json/arrayBuffer. */
function makeResponse(status, url, headers, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => body.toString('utf8'),
    json: async () => JSON.parse(body.toString('utf8')),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function decode(response, buffer) {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip') return zlib.gunzipSync(buffer);
  if (encoding === 'deflate') return zlib.inflateSync(buffer);
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  return buffer;
}

/** fetch(url, { method, headers, body, signal, redirect }) over node:http(s), the whole body in memory. */
function fetchCompat(input, init = {}, redirects = 0) {
  const url = new URL(String(input));
  const client = url.protocol === 'http:' ? http : https;
  const headers = { 'Accept-Encoding': 'gzip, deflate, br', ...(init.headers ?? {}) };
  const body = init.body === undefined || init.body === null ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
  if (body) headers['Content-Length'] = String(body.length);
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(init.signal.reason ?? new Error('Aborted'));
      return;
    }
    const request = client.request(url, { method: init.method ?? 'GET', headers, signal: init.signal }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location && init.redirect !== 'manual') {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects: ${url}`));
          return;
        }
        // 303 (and 301/302 after a POST) go on as GET without a body, like browsers do.
        const asGet = status === 303 || ((status === 301 || status === 302) && (init.method ?? 'GET') !== 'GET');
        resolve(fetchCompat(new URL(location, url).toString(), asGet ? { ...init, method: 'GET', body: null } : init, redirects + 1));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve(makeResponse(status, url.toString(), response.headers, decode(response, Buffer.concat(chunks))));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function installCompat() {
  if (typeof globalThis.fetch !== 'function') globalThis.fetch = fetchCompat;
  if (typeof globalThis.structuredClone !== 'function') globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

module.exports = { installCompat, fetchCompat };
