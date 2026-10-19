'use strict';

const http = require('node:http');

/*
 * Offline accounts have no Realms access: the game still asks Mojang with the token "0"
 * and logs authentication errors on every start. With realms.environment=local the game asks
 * http://localhost:8080 instead (the address is fixed in the game). This stub answers that
 * Realms is not available for this client, which the game accepts quietly.
 */

const REALMS_PORT = 8080;
const RESPONSES = [
  // Not COMPATIBLE: the game then marks Realms unavailable and polls nothing else.
  { pattern: /\/mco\/client\/compatible$/, type: 'text/plain', body: 'OTHER' },
  { pattern: /\/feature\/v1$/, type: 'application/json', body: '[]' },
  { pattern: /\/mco\/available$/, type: 'text/plain', body: 'true' },
  { pattern: /\/trial$/, type: 'text/plain', body: 'false' },
  { pattern: /\/notifications$/, type: 'application/json', body: '{"notifications":[]}' },
  { pattern: /\/invites\/count\/pending$/, type: 'text/plain', body: '0' },
  { pattern: /\/worlds$/, type: 'application/json', body: '{"servers":[]}' },
];

function listen(server, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(REALMS_PORT, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function createServer() {
  return http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const match = RESPONSES.find((entry) => entry.pattern.test(pathname));
    if (!match) {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"errorCode":404,"errorMsg":"Not available offline"}');
      return;
    }
    response.writeHead(200, { 'Content-Type': `${match.type}; charset=utf-8` }).end(match.body);
  });
}

/**
 * Starts the stub on localhost:8080 (IPv4, plus IPv6 when available).
 * Resolves with { close() }, or null when the port is taken: then the game keeps its default behaviour.
 */
async function startRealmsStub() {
  const ipv4 = createServer();
  try {
    await listen(ipv4, '127.0.0.1');
  } catch {
    return null;
  }
  const ipv6 = createServer();
  const ipv6Ready = await listen(ipv6, '::1').then(
    () => true,
    () => false,
  );
  const servers = ipv6Ready ? [ipv4, ipv6] : [ipv4];
  return {
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise((done) => {
              server.close(() => done());
              server.closeAllConnections?.();
            }),
        ),
      ),
  };
}

module.exports = { startRealmsStub };
