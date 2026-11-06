'use strict';

const http = require('node:http');

/*
 * Versions before 1.7.6 download every player's skin and cape by name, straight from Mojang's old
 * addresses (www.minecraft.net/skin/, s3.amazonaws.com/MinecraftSkins/, skins.minecraft.net),
 * which no longer serve anything. The game is started with -Dhttp.proxyHost pointing here, so this
 * proxy answers those requests itself — Amethyx skins of all players, no mod needed (playerSkins.js) —
 * and passes every other plain-HTTP request through unchanged. HTTPS does not use http.proxyHost.
 */

const SKIN_PATHS = [
  /^\/MinecraftSkins\/([^/]+)\.png$/i, // beta and release up to 1.7.5
  /^\/skin\/([^/]+)\.png$/i, // classic, indev, alpha (www.minecraft.net)
];
const CLOAK_PATHS = [
  /^\/MinecraftCloaks\/([^/]+)\.png$/i, // beta and release up to 1.7.5
];
const CLOAK_PAGE = /^\/cloak\/get\.jsp$/i; // alpha: www.minecraft.net/cloak/get.jsp?user=<name>
const RESOURCES_PATH = /^\/MinecraftResources\/?$/i;
// The old resource bucket is gone; an empty listing makes the game skip it instead of logging an error.
const EMPTY_BUCKET =
  '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>MinecraftResources</Name><IsTruncated>false</IsTruncated></ListBucketResult>';
/**
 * 1.5.2 checks this flag on every main menu to announce 1.6; Mojang's host now answers 502 and the
 * game prints a stack trace each time. An empty answer means "no notice", exactly as before 1.6.
 */
const RELEASE_FLAG = { hostname: 'assets.minecraft.net', pathname: '/1_6_has_been_released.flag' };
const UPSTREAM_TIMEOUT_MS = 15000;
const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'];

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function forward(request, response, target) {
  const headers = { ...request.headers, host: target.host };
  for (const name of HOP_BY_HOP) {
    delete headers[name];
  }
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502);
    }
    response.end();
  });
  request.pipe(upstream);
}

function sendPng(response, png) {
  response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
  response.end(png);
}

/**
 * lookup(name) → Promise<{ png, cape, source } | null> (playerSkins.js); toLegacy(png) turns a skin
 * into the 64x32 layout old versions expect. Resolves with { port, close() }.
 */
function startLegacySkinProxy({ lookup, toLegacy = (png) => png, onLog = () => {} }) {
  const told = new Set();
  /** Answers a skin or cape request for `name`; 404 when the player has none. */
  function answer(response, name, kind) {
    lookup(safeDecode(name))
      .then((found) => {
        const png = kind === 'skin' ? found?.png && toLegacy(found.png) : found?.cape;
        if (!png) {
          response.writeHead(404).end();
          return;
        }
        const note = `${kind}:${name.toLowerCase()}`;
        if (!told.has(note)) {
          told.add(note);
          onLog(`Скин: ${kind === 'skin' ? 'скин' : 'плащ'} игрока ${safeDecode(name)} (${found.source})`);
        }
        sendPng(response, png);
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(404);
        response.end();
      });
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      let target;
      try {
        // A proxied request carries the absolute URL ("GET http://host/path").
        target = new URL(request.url);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (target.protocol !== 'http:') {
        response.writeHead(400).end();
        return;
      }

      const skinMatch = SKIN_PATHS.map((pattern) => pattern.exec(target.pathname)).find(Boolean);
      if (skinMatch) {
        answer(response, skinMatch[1], 'skin');
        return;
      }
      const cloakMatch = CLOAK_PATHS.map((pattern) => pattern.exec(target.pathname)).find(Boolean);
      if (cloakMatch || CLOAK_PAGE.test(target.pathname)) {
        answer(response, cloakMatch ? cloakMatch[1] : target.searchParams.get('user') ?? '', 'cape');
        return;
      }
      if (target.hostname === RELEASE_FLAG.hostname && target.pathname === RELEASE_FLAG.pathname) {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 0 }).end();
        return;
      }
      if (RESOURCES_PATH.test(target.pathname) && target.hostname === 's3.amazonaws.com') {
        response.writeHead(200, { 'Content-Type': 'application/xml' }).end(EMPTY_BUCKET);
        return;
      }
      forward(request, response, target);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

module.exports = { startLegacySkinProxy };
