'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { app } = require('electron');
const { getAppPaths } = require('../core/paths');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { broadcast } = require('../core/broadcast');
const { CHANNELS } = require('../../shared/channels');
const { createLogger } = require('../core/logger');
const { getSettings } = require('../settings/settingsService');
const devTools = require('./devTools');

/*
 * Developer access for AI tools (Settings → «Разработчик» → «Доступ для ИИ»): an MCP server
 * (Streamable HTTP, POST /mcp, JSON answers, no sessions) and the same tools as a plain API
 * (GET /api, POST /api/<tool>). It listens on 127.0.0.1 only, runs only while developer mode and
 * the access are both on, and every request needs the key (Authorization: Bearer <key>). Requests
 * from web pages are refused: a browser always sends Origin, AI clients do not. The key and port
 * live in <data>/dev-api.json, not in settings.json.
 */

const DEFAULT_PORT = 47615;
const PORT_TRIES = 10;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const JOURNAL_LIMIT = 60;
const INSTRUCTIONS = [
  'Amethyx Launcher (Minecraft: Java Edition) on this computer, for testing mods.',
  'Typical loop: create_test_instance (Minecraft version, loader, mods from Modrinth or the .jar you built) → launch_instance →',
  'wait_for_game with fromLine and a pattern such as "Sound engine started" (loaded) or until it exits → read_game_log /',
  'read_instance_log (log "crash" after a crash) → fix the mod → add_mods with the new .jar (same file name replaces it) → stop_game → launch again.',
  'Instances you create are test ones: change and delete them freely. The player\'s own instances: list, read and launch;',
  'changing or deleting them asks the player in the launcher window — if they refuse, do not retry. One game runs at a time.',
].join(' ');

const log = createLogger('dev-api');
let server = null;
let port = null;
let lastError = null;
let saved = null;
const sockets = new Set();
const journal = [];
/** start/stop one after another, in the order the settings changed. */
let switching = Promise.resolve();

function keyFile() {
  return path.join(getAppPaths().root, 'dev-api.json');
}

const newKey = () => `amx_${crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

async function loadSaved() {
  if (saved) return saved;
  const stored = await readJsonFile(keyFile(), null);
  saved = {
    key: typeof stored?.key === 'string' && /^amx_[\w-]{24,}$/.test(stored.key) ? stored.key : newKey(),
    port: Number.isInteger(stored?.port) && stored.port > 1024 && stored.port < 65536 ? stored.port : DEFAULT_PORT,
  };
  if (saved.key !== stored?.key || saved.port !== stored?.port) await writeJsonFileAtomic(keyFile(), saved);
  return saved;
}

/** What the settings page shows: { running, url, key, port, error, journal }. */
function status() {
  return {
    running: Boolean(server),
    port,
    url: server ? `http://127.0.0.1:${port}/mcp` : null,
    apiUrl: server ? `http://127.0.0.1:${port}/api` : null,
    key: saved?.key ?? null,
    error: lastError,
    journal: [...journal],
  };
}

const announce = () => broadcast(CHANNELS.events.devStatus, status());

/** One line of "Что делал ИИ": { at, tool, subject, outcome: 'ok' | 'error' | 'denied', detail }. */
function note(tool, subject, outcome, detail = null) {
  journal.unshift({ at: new Date().toISOString(), tool, subject: subject ?? null, outcome, detail: detail ? String(detail).slice(0, 300) : null });
  journal.splice(JOURNAL_LIMIT);
  announce();
}

/** Runs a tool for the API or MCP. Throws with a message for the AI. */
async function runTool(name, args) {
  const tool = devTools.findTool(name);
  if (!tool) throw Object.assign(new Error(`Unknown tool "${name}".`), { code: 'unknown-tool' });
  const settings = await getSettings();
  if (!settings.dev?.enabled || !settings.dev?.api) {
    throw new Error('Developer access is off in the launcher (Settings → Developer).');
  }
  const context = { settings, subject: null };
  try {
    const result = await tool.run(devTools.checkArguments(tool, args), context);
    if (!tool.readOnly) note(tool.name, context.subject, 'ok');
    return result;
  } catch (error) {
    if (!tool.readOnly || error.code === 'denied') note(tool.name, context.subject, error.code === 'denied' ? 'denied' : 'error', error.message);
    throw error;
  }
}

// --- MCP (JSON-RPC 2.0) ------------------------------------------------------------------

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function answerRpc(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'amethyx-launcher', title: 'Amethyx Launcher', version: app.getVersion() },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: devTools.describeTools() });
    case 'tools/call': {
      if (!devTools.findTool(params?.name)) return rpcError(id, -32602, `Unknown tool "${params?.name}".`);
      try {
        const result = await runTool(params.name, params.arguments ?? {});
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }], isError: false });
      } catch (error) {
        return rpcResult(id, { content: [{ type: 'text', text: error.message }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcp(body) {
  const batch = Array.isArray(body);
  const replies = [];
  for (const message of batch ? body : [body]) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      replies.push(rpcError(message?.id, -32600, 'Invalid JSON-RPC message.'));
    } else if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
      replies.push(await answerRpc(message));
    }
    // Notifications (notifications/initialized…) and responses need no answer.
  }
  if (replies.length === 0) return null;
  return batch ? replies : replies[0];
}

// --- HTTP ----------------------------------------------------------------------------------

function send(response, status, body, headers = {}) {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('The body is not JSON.'), { status: 400, parse: true }));
      }
    });
    request.on('error', reject);
  });
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Only this computer, only with the key, never a web page. Returns an error text or null. */
function refusal(request) {
  const address = request.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return [403, 'Only this computer may connect.'];
  // A page from the internet that renamed itself to 127.0.0.1 (DNS rebinding) still sends its own Host.
  if (!LOOPBACK_HOST.test(String(request.headers.host ?? ''))) return [403, 'Wrong Host.'];
  const origin = request.headers.origin;
  if (origin && !LOOPBACK_ORIGIN.test(String(origin))) return [403, 'Requests from web pages are not allowed.'];
  const given = /^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
  const expected = Buffer.from(saved?.key ?? '');
  const actual = Buffer.from(given);
  if (!expected.length || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return [401, 'Wrong or missing key: copy the command again in the launcher (Settings → Developer).'];
  }
  return null;
}

async function onRequest(request, response) {
  const denied = refusal(request);
  if (denied) {
    send(response, denied[0], { error: denied[1] }, denied[0] === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        // No server-sent stream: every answer comes with its request.
        send(response, 405, { error: 'Use POST.' }, { Allow: 'POST' });
        return;
      }
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        send(response, error.status ?? 400, error.parse ? rpcError(null, -32700, 'Parse error.') : { error: error.message });
        return;
      }
      const reply = await handleMcp(body);
      if (reply === null) {
        response.writeHead(202).end();
      } else {
        send(response, 200, reply);
      }
      return;
    }
    if (url.pathname === '/api' && request.method === 'GET') {
      send(response, 200, { tools: devTools.describeTools().map((tool) => ({ name: tool.name, description: tool.description, input: tool.inputSchema })) });
      return;
    }
    const call = /^\/api\/([a-z_]+)$/.exec(url.pathname);
    if (call && request.method === 'POST') {
      const args = await readBody(request);
      try {
        send(response, 200, { ok: true, result: await runTool(call[1], args) });
      } catch (error) {
        send(response, error.code === 'unknown-tool' ? 404 : error.code === 'denied' ? 403 : 400, { ok: false, error: error.message, denied: error.code === 'denied' });
      }
      return;
    }
    send(response, 404, { error: 'Not found. MCP: POST /mcp. API: GET /api, POST /api/<tool>.' });
  } catch (error) {
    if (!response.headersSent) send(response, error.status ?? 500, { error: error.message });
  }
}

function listen(candidate) {
  return new Promise((resolve, reject) => {
    const instance = http.createServer((request, response) => {
      onRequest(request, response).catch(() => response.destroy());
    });
    // A tool may wait for the game for minutes (wait_for_game).
    instance.requestTimeout = 0;
    instance.timeout = 0;
    instance.keepAliveTimeout = 5000;
    instance.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    instance.once('error', reject);
    instance.listen(candidate, '127.0.0.1', () => {
      instance.removeListener('error', reject);
      instance.on('error', (error) => log.warn(`Доступ для ИИ: ${error.message}`));
      resolve(instance);
    });
  });
}

async function start() {
  const { port: wanted } = await loadSaved();
  lastError = null;
  for (let offset = 0; offset < PORT_TRIES; offset += 1) {
    const candidate = wanted + offset;
    try {
      server = await listen(candidate);
      port = candidate;
      if (candidate !== saved.port) {
        // The next start keeps this port, so the AI's settings stay right.
        saved.port = candidate;
        await writeJsonFileAtomic(keyFile(), saved);
      }
      log.info(`Доступ для ИИ включён: http://127.0.0.1:${port}/mcp`);
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        lastError = error.message;
        break;
      }
    }
  }
  lastError ??= `Ports ${wanted}–${wanted + PORT_TRIES - 1} are busy.`;
  log.warn(`Доступ для ИИ не включён: ${lastError}`);
}

function stop() {
  if (!server) return Promise.resolve();
  const closing = server;
  server = null;
  port = null;
  return new Promise((resolve) => {
    closing.close(() => resolve());
    for (const socket of sockets) socket.destroy();
    log.info('Доступ для ИИ выключен');
  });
}

/** Starts or stops the server after a settings change (and once at start). */
function applySettings(settings) {
  const wanted = Boolean(settings?.dev?.enabled && settings?.dev?.api);
  switching = switching
    .then(async () => {
      if (wanted && !server) await start();
      else if (!wanted && server) await stop();
      if (!wanted) lastError = null;
      if (wanted) await loadSaved();
    })
    .catch((error) => {
      lastError = error.message;
    })
    .finally(announce);
  return switching;
}

/** «Новый ключ»: the old one stops working at once. */
async function renewKey() {
  await loadSaved();
  saved.key = newKey();
  await writeJsonFileAtomic(keyFile(), saved);
  log.info('Ключ доступа для ИИ заменён');
  announce();
  return status();
}

async function getStatus() {
  await loadSaved();
  return status();
}

module.exports = { applySettings, getStatus, renewKey, runTool, stop, note };
