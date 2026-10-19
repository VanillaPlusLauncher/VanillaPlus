'use strict';

const http = require('node:http');

/*
 * Versions before 1.7 have no authlib: they download skins straight from Mojang's old
 * addresses (www.minecraft.net/skin/, s3.amazonaws.com/MinecraftSkins/, skins.minecraft.net),
 * which no longer serve anything. The game is started with -Dhttp.proxyHost pointing here,
 * so this proxy answers those requests with the player's own skin and passes every other
 * plain-HTTP request through unchanged. HTTPS does not use http.proxyHost and is not affected.
 */

const SKIN_PATHS = [
  /^\/MinecraftSkins\/([^/]+)\.png$/i, // beta and release up to 1.6
  /^\/skin\/([^/]+)\.png$/i, // classic, indev, alpha (www.minecraft.net)
];
const CLOAK_PATHS = [/^\/MinecraftCloaks\//i, /^\/cloak\//i];
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

/**
 * skins: Map<lower-case username, PNG Buffer in the 64x32 layout old versions expect>.
 * Resolves with { port, close() }.
 */
function startLegacySkinProxy({ skins, onLog = () => {} }) {
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
        const png = skins.get(safeDecode(skinMatch[1]).toLowerCase());
        if (png) {
          onLog('Скин: игра загрузила текстуру скина');
          response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
          response.end(png);
        } else {
          response.writeHead(404).end();
        }
        return;
      }
      if (CLOAK_PATHS.some((pattern) => pattern.test(target.pathname))) {
        response.writeHead(404).end();
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
