// Runs the Amethyx server of the site (website/cloud) on PHP's built-in server: a copy of the site
// in a temporary folder with its own data folder (never the real site's data), Mojang and Ely.by
// faked by a small server here. Node 24, no packages. Run from the repository root:
//   node website/cloud/test/cloud.test.mjs
// PHP comes from AMETHYX_TEST_PHP (a php.exe, 7.4 or newer) or the PATH. It needs pdo_sqlite and
// mbstring; curl and openssl for the proxy (its live test is skipped when the internet is not there).
// AMETHYX_TEST_KEEP=1 keeps the temporary folder for a look afterwards; AMETHYX_TEST_NO_CURL=1 runs
// without curl.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const website = path.join(root, 'website');
const php = process.env.AMETHYX_TEST_PHP || 'php';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'amx-cloud-'));
const site = path.join(work, 'site');
const dataDir = path.join(work, 'amethyx-data'); // what amx_data_dir() picks: next to the site folder
const errorLog = path.join(work, 'php-errors.log');
const siteToken = `amx_${crypto.randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(40, 'x').slice(0, 40)}`;
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server = null;
let fake = null;
let base = '';
const joined = new Map(); // what the "launcher" joined at the fake Mojang / Ely.by: "name|serverId" -> profile

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** php.ini for the test: extensions from PHP's own folder when they are not built in, CAs from Node. */
function writeIni() {
  const builtIn = spawnSync(php, ['-n', '-m'], { encoding: 'utf8' }).stdout ?? '';
  const extDir = path.join(path.dirname(php === 'php' ? (spawnSync(php, ['-n', '-r', 'echo PHP_BINARY;'], { encoding: 'utf8' }).stdout || 'php') : php), 'ext');
  const cafile = path.join(work, 'cacert.pem');
  fs.writeFileSync(cafile, tls.rootCertificates.join('\n'));
  const lines = [
    `extension_dir="${extDir}"`,
    `curl.cainfo="${cafile}"`,
    `openssl.cafile="${cafile}"`,
    'post_max_size=16M',
    'memory_limit=256M',
    'display_errors=0',
    'log_errors=1',
    `error_log="${errorLog}"`,
    'error_reporting=E_ALL',
  ];
  // AMETHYX_TEST_NO_CURL=1: as on a hosting without curl (PHP's own streams instead).
  for (const name of ['pdo_sqlite', 'mbstring', 'curl', 'openssl']) {
    if (new RegExp(`^${name}$`, 'mi').test(builtIn) || (name === 'curl' && process.env.AMETHYX_TEST_NO_CURL)) continue;
    if (fs.existsSync(path.join(extDir, `php_${name}.dll`)) || fs.existsSync(path.join(extDir, `${name}.so`))) lines.push(`extension=${name}`);
  }
  const ini = path.join(work, 'php.ini');
  fs.writeFileSync(ini, `${lines.join('\n')}\n`);
  return ini;
}

/** The site's own database with one API token, stored the way amethyx.php keeps them (SHA-256). */
function seedSiteDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, `amethyx-${crypto.randomBytes(12).toString('hex')}.sqlite`));
  db.exec('CREATE TABLE tokens (id INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, used_at INTEGER)');
  db.prepare('INSERT INTO tokens (name, hash, created_at) VALUES (?, ?, ?)').run('test', sha(siteToken), Math.floor(Date.now() / 1000));
  db.close();
}

/** One of the server's databases, opened for a moment to look or to move time. */
function withDb(kind, work) {
  const pattern = kind === 'files' ? /^cloud-files-[0-9a-f]{24}\.sqlite$/ : /^cloud-[0-9a-f]{24}\.sqlite$/;
  const file = fs.readdirSync(dataDir).find((name) => pattern.test(name));
  assert.ok(file, `no ${kind} database in the data folder`);
  const db = new DatabaseSync(path.join(dataDir, file), { timeout: 5000 });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

before(async () => {
  // A copy of the site: the shared lib/ and cloud/ (not its tests).
  fs.cpSync(path.join(website, 'lib'), path.join(site, 'lib'), { recursive: true });
  fs.cpSync(path.join(website, 'cloud'), path.join(site, 'cloud'), { recursive: true, filter: (source) => !source.includes(`${path.sep}cloud${path.sep}test`) });
  // What cloud/.htaccess does on the hosting.
  fs.writeFileSync(path.join(work, 'router.php'), `<?php
$path = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/cloud' || strpos($path, '/cloud/') === 0) {
  if (preg_match('#^/cloud/(lib|test)(/|$)#', $path)) { http_response_code(403); return true; }
  $_SERVER['SCRIPT_NAME'] = '/cloud/index.php';
  require __DIR__ . '/site/cloud/index.php';
  return true;
}
return false;
`);
  seedSiteDb();

  // Mojang / Ely.by: 200 with the profile when the launcher joined that serverId, else 204.
  fake = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fake');
    const profile = joined.get(`${url.searchParams.get('username')}|${url.searchParams.get('serverId')}`);
    if (!profile || !['/ms', '/ely'].includes(url.pathname)) return response.writeHead(204).end();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(profile));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));

  const ini = writeIni();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(php, ['-c', ini, '-S', `127.0.0.1:${port}`, '-t', site, path.join(work, 'router.php')], {
    env: { ...process.env, AMX_CLOUD_TEST_SESSION_SERVER: `http://127.0.0.1:${fake.address().port}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let tries = 0; ; tries += 1) {
    try {
      if ((await fetch(`${base}/cloud/`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (tries > 50 || server.exitCode !== null) throw new Error(`PHP did not start: ${stderr}`);
    await sleep(200);
  }
});

after(async () => {
  server?.kill();
  await new Promise((resolve) => (fake ? fake.close(resolve) : resolve()));
  await sleep(300);
  if (process.env.AMETHYX_TEST_KEEP) console.log(`kept: ${work}`);
  else fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// Every call comes "through nginx" from another address unless it says which: the rate limit
// counts per address, and only its own test may run into it.
let addresses = 0;
function nextAddress() {
  addresses += 1;
  return `10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`;
}

/** A call to /cloud/…; a string body is sent as it is (file parts, SQL). */
async function call(method, pathname, body, token, { ip, headers = {} } = {}) {
  const sent = { ...headers };
  if (ip !== false) sent['X-Forwarded-For'] = ip ?? nextAddress();
  if (body !== undefined) sent['Content-Type'] ??= typeof body === 'string' ? 'text/plain' : 'application/json';
  if (token) sent.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/cloud${pathname}`, { method, headers: sent, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed = bytes;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      parsed = bytes.toString('utf8');
    }
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

function png(width, height, fill = 1) {
  const bytes = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes, 0);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

/** Signs in a Microsoft or Ely.by account through the fake Mojang / Ely.by. */
async function signInJoined(ns, name, uuid) {
  let r = await call('POST', '/v1/auth/challenge', { ns, name, uuid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  joined.set(`${name}|${r.body.serverId}`, { id: uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), name });
  r = await call('POST', '/v1/auth/verify', { challengeId: r.body.challengeId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const secretA = 'a'.repeat(64);
const secretB = 'b'.repeat(64);
const tagB = sha(secretB).slice(0, 4);
const uuid = '0123456789abcdef0123456789abcdef';
const s = {}; // tokens and ids the steps below share

test('php -l passes on every PHP file of cloud/', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  };
  walk(path.join(website, 'cloud'));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const result = spawnSync(php, ['-n', '-l', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stdout}${result.stderr}`);
  }
});

test('the server answers, /ip gives the address nginx passed on', async () => {
  let r = await call('GET', '/');
  assert.deepEqual(r.body, { name: 'Amethyx server', api: 1 });
  r = await call('GET', '/ip', undefined, null, { ip: '10.1.2.3' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ip: '10.1.2.3' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await call('GET', '/ip', undefined, null, { ip: '6.6.6.6, 10.9.9.9' });
  assert.equal(r.body.ip, '10.9.9.9', 'the last X-Forwarded-For entry is the one nginx added');
  r = await call('GET', '/ip', undefined, null, { ip: false });
  assert.equal(r.body.ip, '127.0.0.1');
  r = await call('GET', '/nothing');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Не найдено.');
  r = await call('GET', '/lib/core.php');
  assert.equal(r.status, 403);
});

test('offline sign-in and the name lock (a second Steve gets #tag)', async () => {
  let r = await call('POST', '/v1/auth/offline', { name: 'Steve', secret: secretA });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.steve = r.body.token;
  assert.match(s.steve, /^[0-9a-f]{64}$/);
  assert.equal(r.body.user.tag, null);
  assert.equal(r.body.user.id, 'offline:steve');
  r = await call('POST', '/v1/auth/offline', { name: 'steve', secret: secretB });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, `offline:steve#${tagB}`);
  assert.equal(r.body.user.tag, tagB);
  s.steveB = r.body.token;
  r = await call('POST', '/v1/auth/offline', { name: 'steve', secret: secretB });
  assert.equal(r.body.user.id, `offline:steve#${tagB}`);
  r = await call('POST', '/v1/auth/offline', { name: 'Steve', secret: secretA });
  assert.equal(r.body.user.id, 'offline:steve');
  r = await call('POST', '/v1/auth/offline', { name: 'Ste ve', secret: secretA });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Неверные данные аккаунта.');
  r = await call('POST', '/v1/auth/offline', 'not json', null, { headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Нужен JSON.');
  // The first Steve finds the second one by the name with the code.
  r = await call('POST', '/v1/friends/request', { ns: 'offline', name: `Steve#${tagB}` }, s.steve);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'requested');
  assert.equal(r.body.user.tag, tagB);
  r = await call('POST', '/v1/friends/request', { ns: 'ms', name: `Steve#${tagB}` }, s.steve);
  assert.equal(r.status, 400);
  r = await call('POST', '/v1/friends/decline', { id: `offline:steve#${tagB}` }, s.steve);
  assert.equal(r.status, 200);
});

test('Microsoft and Ely.by sign-in through hasJoined, /v1/me', async () => {
  let r = await call('POST', '/v1/auth/challenge', { ns: 'ms', name: 'Alex', uuid });
  assert.equal(r.status, 200);
  assert.match(r.body.serverId, /^[0-9a-f]{32}$/);
  const failed = await call('POST', '/v1/auth/verify', { challengeId: r.body.challengeId });
  assert.equal(failed.status, 403);
  assert.equal(failed.body.error, 'Microsoft не подтвердил аккаунт.');
  // A used challenge cannot be replayed.
  r = await call('POST', '/v1/auth/verify', { challengeId: r.body.challengeId });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Проверка устарела, попробуйте ещё раз.');
  const alex = await signInJoined('ms', 'Alex', uuid);
  s.alex = alex.token;
  assert.equal(alex.user.id, `ms:${uuid}`);
  assert.equal(alex.user.online, false);
  r = await call('POST', '/v1/auth/challenge', { ns: 'ely', name: 'Elfy', uuid: 'e'.repeat(32) });
  r = await call('POST', '/v1/auth/verify', { challengeId: r.body.challengeId });
  assert.equal(r.body.error, 'Ely.by не подтвердил аккаунт.');
  s.elfy = (await signInJoined('ely', 'Elfy', 'e'.repeat(32))).token;
  r = await call('POST', '/v1/auth/challenge', { ns: 'xbox', name: 'Alex', uuid });
  assert.equal(r.status, 400);

  r = await call('GET', '/v1/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Нужен вход.');
  r = await call('GET', '/v1/me', undefined, 'f'.repeat(64));
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Вход устарел.');
  r = await call('GET', '/v1/me', undefined, s.alex);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['id', 'ns', 'name', 'tag', 'skin', 'model', 'cape', 'online', 'presence', 'lastSeen']);
  assert.equal(r.body.name, 'Alex');
  assert.equal(r.body.model, 'classic');
  assert.equal(r.body.lastSeen, null);
});

test('skin and cape, /csl and /textures, players found across account kinds', async () => {
  let r = await call('PUT', '/v1/me/skin', { png: png(64, 64), model: 'slim' }, s.alex);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const skinHash = r.body.hash;
  assert.equal(skinHash, sha(Buffer.from(png(64, 64), 'base64')));
  r = await call('PUT', '/v1/me/cape', { png: png(64, 32, 2) }, s.alex);
  assert.equal(r.status, 200);
  const capeHash = r.body.hash;
  r = await call('PUT', '/v1/me/cape', { png: png(64, 64) }, s.alex);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Размер 64x64 не подходит.');
  r = await call('PUT', '/v1/me/skin', { png: 'Zm9v' }, s.alex);
  assert.equal(r.body.error, 'Нужен PNG-файл.');
  r = await call('PUT', '/v1/me/skin', { png: '***' }, s.alex);
  assert.equal(r.body.error, 'Файл повреждён.');
  r = await call('PUT', '/v1/me/skin', { png: 'A'.repeat(400000) }, s.alex);
  assert.equal(r.body.error, 'Файл слишком большой.');

  r = await call('GET', '/csl/ms/alex.json');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { username: 'Alex', skins: { slim: skinHash }, cape: capeHash });
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  r = await call('GET', `/csl/ms/textures/${skinHash}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(r.body.toString('base64'), png(64, 64));
  r = await call('GET', `/textures/${capeHash}`);
  assert.equal(r.body.toString('base64'), png(64, 32, 2));
  // Viewers with other kinds of accounts find him too (the fix: before, Ely.by viewers did not).
  r = await call('GET', '/csl/offline/Alex.json');
  assert.equal(r.status, 200);
  assert.equal(r.body.username, 'Alex');
  r = await call('GET', '/csl/ely/Alex.json');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.skins, { slim: skinHash });
  r = await call('GET', '/csl/ms/Nobody.json');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { errno: 404, msg: 'not found' });
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  // An Ely.by player seen by Microsoft and offline viewers.
  r = await call('PUT', '/v1/me/skin', { png: png(64, 32, 5) }, s.elfy);
  const elfySkin = r.body.hash;
  for (const ns of ['ms', 'offline', 'ely']) {
    r = await call('GET', `/csl/${ns}/elfy.json`);
    assert.deepEqual(r.body, { username: 'Elfy', skins: { default: elfySkin } }, ns);
  }
  // The same name with two kinds of accounts: the viewer's own kind first, otherwise whoever was seen last.
  const duoMs = await signInJoined('ms', 'Duo', 'd'.repeat(32));
  r = await call('PUT', '/v1/me/skin', { png: png(64, 64, 7) }, duoMs.token);
  const msSkin = r.body.hash;
  r = await call('POST', '/v1/auth/offline', { name: 'Duo', secret: 'c'.repeat(64) });
  const duoOffline = r.body.token;
  r = await call('PUT', '/v1/me/skin', { png: png(64, 64, 8) }, duoOffline);
  const offlineSkin = r.body.hash;
  assert.deepEqual((await call('GET', '/csl/ms/Duo.json')).body.skins, { default: msSkin });
  assert.deepEqual((await call('GET', '/csl/offline/Duo.json')).body.skins, { default: offlineSkin });
  await call('POST', '/v1/me/presence', { status: 'online' }, duoOffline);
  assert.deepEqual((await call('GET', '/csl/ely/Duo.json')).body.skins, { default: offlineSkin });
  await sleep(5);
  await call('POST', '/v1/me/presence', { status: 'online' }, duoMs.token);
  assert.deepEqual((await call('GET', '/csl/ely/Duo.json')).body.skins, { default: msSkin });

  // Removing the skin removes the unused texture.
  r = await call('DELETE', '/v1/me/skin', undefined, s.alex);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, hash: null });
  r = await call('GET', `/textures/${skinHash}`);
  assert.equal(r.status, 404);
  r = await call('GET', '/csl/ms/Alex.json');
  assert.deepEqual(r.body, { username: 'Alex', cape: capeHash });
});

test('friends: request, list, accept, presence, remove, mutual requests', async () => {
  let r = await call('POST', '/v1/friends/request', { ns: 'ms', name: 'Nobody' }, s.steve);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Nobody ещё не заходил в Amethyx с таким аккаунтом: пусть откроет «Друзья» в своём лаунчере.');
  r = await call('POST', '/v1/friends/request', { ns: 'offline', name: 'Steve' }, s.steve);
  assert.equal(r.body.error, 'Это вы.');
  r = await call('POST', '/v1/friends/request', { ns: 'ms', name: 'alex' }, s.steve);
  assert.equal(r.body.state, 'requested');
  r = await call('GET', '/v1/friends', undefined, s.alex);
  assert.equal(r.body.incoming.length, 1);
  assert.equal(r.body.incoming[0].id, 'offline:steve');
  assert.equal(r.body.incoming[0].online, undefined, 'requests show no presence');
  assert.deepEqual(r.body.unread, {});
  assert.equal(r.body.me.id, `ms:${uuid}`);
  r = await call('GET', '/v1/friends', undefined, s.steve);
  assert.equal(r.body.outgoing[0].id, `ms:${uuid}`);
  r = await call('POST', '/v1/friends/accept', { id: 'offline:nobody' }, s.alex);
  assert.equal(r.status, 404);
  r = await call('POST', '/v1/friends/accept', { id: 'offline:steve' }, s.alex);
  assert.equal(r.status, 200);
  r = await call('POST', '/v1/me/presence', { status: 'playing', instance: '  Fabric 1.21  ', minecraft: '1.21.1', loader: 'fabric', server: 'mc.example.org' }, s.alex);
  assert.equal(r.status, 200);
  r = await call('GET', '/v1/friends', undefined, s.steve);
  assert.equal(r.body.friends.length, 1);
  assert.equal(r.body.friends[0].online, true);
  assert.deepEqual(r.body.friends[0].presence, { status: 'playing', instance: 'Fabric 1.21', minecraft: '1.21.1', loader: 'fabric', server: 'mc.example.org' });
  assert.equal(typeof r.body.friends[0].lastSeen, 'number');
  r = await call('POST', '/v1/me/presence', { status: 'offline' }, s.alex);
  r = await call('GET', '/v1/friends', undefined, s.steve);
  assert.equal(r.body.friends[0].online, false);
  assert.equal(r.body.friends[0].presence, null);
  // Mutual requests become a friendship at once.
  r = await call('DELETE', `/v1/friends/${encodeURIComponent(`ms:${uuid}`)}`, undefined, s.steve);
  assert.equal(r.status, 200);
  r = await call('GET', '/v1/friends', undefined, s.steve);
  assert.equal(r.body.friends.length, 0);
  r = await call('POST', '/v1/friends/request', { ns: 'offline', name: 'Steve' }, s.alex);
  assert.equal(r.body.state, 'requested');
  r = await call('POST', '/v1/friends/request', { ns: 'ms', name: 'Alex' }, s.steve);
  assert.equal(r.body.state, 'friends');
});

test('messages: text, read marks, a 900 KB picture, an invite; strangers get nothing', async () => {
  let r = await call('POST', '/v1/messages', { to: `ms:${uuid}`, text: 'Привет!' }, s.steve);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.body, 'Привет!');
  assert.equal(r.body.message.readAt, null);
  assert.equal(typeof r.body.message.id, 'number');
  r = await call('POST', '/v1/messages', { to: `ms:${uuid}`, text: '   ' }, s.steve);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Пустое сообщение.');
  r = await call('POST', '/v1/messages', { to: `ms:${uuid}`, text: 'я'.repeat(2001) }, s.steve);
  assert.equal(r.body.error, 'Сообщение длиннее 2000 символов.');
  r = await call('GET', `/v1/messages?with=${encodeURIComponent('offline:steve')}`, undefined, s.alex);
  assert.deepEqual(r.body.messages.map((message) => message.body), ['Привет!']);
  assert.equal(r.body.more, false);
  r = await call('GET', '/v1/friends', undefined, s.alex);
  assert.equal(r.body.unread['offline:steve'], 1);
  r = await call('POST', '/v1/messages/read', { with: 'offline:steve' }, s.alex);
  assert.equal(r.status, 200);
  r = await call('GET', '/v1/friends', undefined, s.alex);
  assert.equal(r.body.unread['offline:steve'], undefined);

  // A picture of 900 KB of base64 goes through (it used to hit a 512 KB limit and get 413).
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(691200 - 4)]);
  const jpeg = jpegBytes.toString('base64');
  assert.equal(jpeg.length, 900 * 1024);
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'image', image: jpeg, caption: 'Мой дом', width: 1600.4, height: 899.5 }, s.alex);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.kind, 'image');
  assert.equal(r.body.message.body.caption, 'Мой дом');
  assert.equal(r.body.message.body.width, 1600);
  assert.equal(r.body.message.body.height, 900);
  const imageId = r.body.message.body.imageId;
  r = await call('GET', `/v1/images/${imageId}`, undefined, s.steve);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
  assert.ok(r.body.equals(jpegBytes));
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'image', image: `${jpeg}AAAA` }, s.alex);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Картинка слишком большая.');
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'image', image: 'A'.repeat(1300 * 1024) }, s.alex);
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'Слишком большой запрос.');
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'image', image: Buffer.from('not an image').toString('base64') }, s.alex);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Нужна картинка JPEG или PNG.');
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'invite', invite: { instance: 'Выживание', minecraft: '1.21.1', loader: 'fabric', server: 'play.example.org', code: 'VP1-abc', icon: 'block:grass_block', kind: 'world' } }, s.alex);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.message.body, { instance: 'Выживание', minecraft: '1.21.1', loader: 'fabric', server: 'play.example.org', world: null, code: 'VP1-abc', tunnel: null, icon: 'block:grass_block', kind: 'world' });
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'invite', invite: { instance: 'Мир', code: 'VP1-abc', icon: 'javascript:alert(1)', kind: 'bad' } }, s.alex);
  assert.equal(r.body.message.body.icon, null);
  assert.equal(r.body.message.body.kind, null);
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'invite', invite: { instance: 'Мир' } }, s.alex);
  assert.equal(r.body.error, 'В приглашении нет ни сервера, ни сборки.');
  r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'invite', invite: { instance: 'Мир', tunnel: 'a'.repeat(32) } }, s.alex);
  assert.equal(r.body.error, 'Туннель к миру не найден.');
  r = await call('POST', '/v1/auth/offline', { name: 'Stranger', secret: 'd'.repeat(64) });
  s.stranger = r.body.token;
  r = await call('POST', '/v1/messages', { to: 'offline:steve', text: 'спам' }, s.stranger);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Писать можно только друзьям.');
  r = await call('GET', `/v1/images/${imageId}`, undefined, s.stranger);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Картинка не найдена или устарела.');
  r = await call('GET', `/v1/messages?with=${encodeURIComponent(`ms:${uuid}`)}`, undefined, s.steve);
  assert.deepEqual(r.body.messages.map((message) => message.kind), ['text', 'image', 'invite', 'invite']);
  assert.equal(typeof r.body.messages[0].readAt, 'number');
  r = await call('GET', `/v1/messages?with=${encodeURIComponent(`ms:${uuid}`)}&before=${r.body.messages[1].id}`, undefined, s.steve);
  assert.deepEqual(r.body.messages.map((message) => message.kind), ['text']);
});

test('/v1/updates: the clock first, then new messages and read marks', async () => {
  await sleep(1100); // the messages of the test before are behind the clock given below
  let r = await call('GET', '/v1/updates', undefined, s.steve);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events, []);
  assert.ok(Math.abs(r.body.now - Date.now()) < 5000);
  // since=0 (start, account switch) and a clock older than 10 minutes only set the clock.
  r = await call('GET', '/v1/updates?since=0', undefined, s.steve);
  assert.deepEqual(r.body.events, []);
  const steveSince = r.body.now;
  r = await call('GET', `/v1/updates?since=${Date.now() - 11 * 60 * 1000}`, undefined, s.steve);
  assert.deepEqual(r.body.events, [], 'messages of the last tests are older than since, but the window is past');
  r = await call('GET', '/v1/updates?since=0');
  assert.equal(r.status, 401);
  r = await call('GET', '/v1/updates?since=0', undefined, s.alex);
  const alexSince = r.body.now;

  r = await call('POST', '/v1/messages', { to: 'offline:steve', text: 'Новое' }, s.alex);
  const sent = r.body.message;
  await sleep(1100); // the server's clock for updates runs a second behind
  r = await call('GET', `/v1/updates?since=${steveSince}`, undefined, s.steve);
  assert.equal(r.status, 200);
  const messages = r.body.events.filter((event) => event.type === 'message');
  assert.equal(messages.length, 1, JSON.stringify(r.body));
  assert.deepEqual(messages[0].message, sent);
  assert.equal(messages[0].from.id, `ms:${uuid}`);
  assert.equal(messages[0].from.online, undefined, 'the sender as publicUser without presence');
  assert.deepEqual(Object.keys(messages[0]), ['type', 'message', 'from']);
  const steveNext = r.body.now;
  assert.ok(steveNext > steveSince);
  r = await call('GET', `/v1/updates?since=${steveNext}`, undefined, s.steve);
  assert.deepEqual(r.body.events, [], 'nothing twice');

  r = await call('POST', '/v1/messages/read', { with: `ms:${uuid}` }, s.steve);
  await sleep(1100);
  r = await call('GET', `/v1/updates?since=${alexSince}`, undefined, s.alex);
  assert.deepEqual(r.body.events, [{ type: 'read', by: 'offline:steve' }]);
});

test('share-code files: upload in parts, a pack, download by its id, cleanup', async () => {
  const big = crypto.randomBytes(3_000_000);
  const small = Buffer.from('tiny file');
  let r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: big.length }, { hash: sha(small), size: small.length }] }, s.steve);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const partBytes = r.body.partBytes;
  assert.equal(partBytes, 1400000);
  assert.deepEqual(r.body.need, [{ hash: sha(big), parts: [0, 1, 2] }, { hash: sha(small), parts: [0] }]);
  const partOf = (bytes, part) => bytes.subarray(part * partBytes, (part + 1) * partBytes).toString('base64');
  r = await call('PUT', `/v1/files/${sha(big)}/0`, partOf(big, 0), s.steve);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `/v1/files/${sha(big)}/1`, partOf(big, 1).slice(1), s.steve);
  assert.equal(r.status, 400, 'a short part is refused');
  assert.equal(r.body.error, 'Часть файла пришла не целиком.');
  r = await call('PUT', `/v1/files/${sha(big)}/1`, `${partOf(big, 1)}AAAA`, s.steve);
  assert.equal(r.status, 413);
  r = await call('PUT', `/v1/files/${sha(big)}/3`, partOf(big, 2), s.steve);
  assert.equal(r.status, 400, 'no fourth part');
  r = await call('PUT', `/v1/files/${sha(big)}/1`, partOf(big, 1));
  assert.equal(r.status, 401);
  r = await call('PUT', `/v1/files/${'9'.repeat(64)}/0`, 'AAAA', s.steve);
  assert.equal(r.status, 404);
  const packFiles = [{ path: 'mods/big.jar', hash: sha(big), size: big.length }, { path: 'resourcepacks/small.zip', hash: sha(small), size: small.length }];
  r = await call('POST', '/v1/packs', { files: packFiles }, s.steve);
  assert.equal(r.status, 409, 'not all parts are there yet');
  assert.equal(r.body.error, 'Файл mods/big.jar загружен не целиком.');
  // The launcher asks again (as after a broken connection): only the missing parts.
  r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: big.length }, { hash: sha(small), size: small.length }] }, s.steve);
  assert.deepEqual(r.body.need, [{ hash: sha(big), parts: [1, 2] }, { hash: sha(small), parts: [0] }]);
  for (const part of [1, 2]) assert.equal((await call('PUT', `/v1/files/${sha(big)}/${part}`, partOf(big, part), s.steve)).status, 200);
  assert.equal((await call('PUT', `/v1/files/${sha(small)}/0`, partOf(small, 0), s.steve)).status, 200);
  for (const bad of ['config/options.txt', 'mods/../evil.jar', 'mods/..', 'mods/a:b.jar', '../mods/x.jar', 'modsx']) {
    r = await call('POST', '/v1/packs', { files: [{ path: bad, hash: sha(small), size: small.length }] }, s.steve);
    assert.equal(r.status, 400, bad);
  }
  r = await call('POST', '/v1/packs', { files: packFiles }, s.alex);
  assert.equal(r.status, 409, "someone else's files cannot be packed");
  r = await call('POST', '/v1/packs', { files: packFiles }, s.steve);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.files, 2);
  assert.equal(r.body.bytes, big.length + small.length);
  const packId = r.body.id;
  r = await call('POST', '/v1/packs', { files: packFiles }, s.steve);
  assert.equal(r.body.id, packId, 'the same files make the same pack (the code stays the same)');
  r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: big.length }] }, s.steve);
  assert.deepEqual(r.body.need, [], 'uploaded files are not sent twice');
  r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: 65 * 1024 * 1024 }] }, s.steve);
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'Моды больше 64 МБ на сервер не загружаются.');
  r = await call('POST', '/v1/files/start', { files: [{ hash: 'x', size: 1 }] }, s.steve);
  assert.equal(r.body.error, 'Неверный список файлов.');
  r = await call('POST', '/v1/files/start', { files: [{ hash: sha(Buffer.from('huge')), size: 151 * 1024 * 1024 }] }, s.steve);
  assert.equal(r.status, 413);
  // A pack about to expire: downloading it is using the code, it stays a week more (its files too).
  withDb('files', (db) => db.prepare('UPDATE packs SET expires_at = ? WHERE id = ?').run(Date.now() + 60000, packId));
  r = await call('GET', `/packs/${packId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files, packFiles);
  assert.equal(r.body.partBytes, partBytes);
  const week = Date.now() + 6.9 * 86400000;
  withDb('files', (db) => {
    assert.ok(db.prepare('SELECT expires_at FROM packs WHERE id = ?').get(packId).expires_at > week, 'the pack stays a week after a download');
    assert.ok(db.prepare('SELECT MIN(expires_at) AS at FROM blobs WHERE owner_id = ?').get('offline:steve').at > week, 'so do its files');
  });
  const parts = [];
  for (let part = 0; part < 3; part += 1) {
    r = await call('GET', `/packs/${packId}/${sha(big)}/${part}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=us-ascii');
    assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
    parts.push(Buffer.from(r.body.toString('ascii'), 'base64'));
  }
  assert.equal(sha(Buffer.concat(parts)), sha(big));
  r = await call('GET', `/packs/${'0'.repeat(32)}`);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Моды автора уже удалены с сервера.');
  // Alex uploads a file of his own: Steve's pack id does not open it.
  const alexFile = Buffer.from('alex only');
  await call('POST', '/v1/files/start', { files: [{ hash: sha(alexFile), size: alexFile.length }] }, s.alex);
  await call('PUT', `/v1/files/${sha(alexFile)}/0`, alexFile.toString('base64'), s.alex);
  r = await call('GET', `/packs/${packId}/${sha(alexFile)}/0`);
  assert.equal(r.status, 404);
  // A second pack with the small file only; then the first expires and takes the big file with it
  // at the next hourly cleanup (started by any request).
  r = await call('POST', '/v1/packs', { files: [packFiles[1]] }, s.steve);
  const secondPack = r.body.id;
  withDb('files', (db) => {
    db.prepare('UPDATE packs SET expires_at = 1 WHERE id = ?').run(packId);
    db.prepare('UPDATE blobs SET expires_at = 1 WHERE hash = ?').run(sha(big));
  });
  withDb('main', (db) => db.prepare("UPDATE cloud_state SET v = '0' WHERE k = 'cleanup'").run());
  await call('GET', '/');
  r = await call('GET', `/packs/${packId}`);
  assert.equal(r.status, 404);
  withDb('files', (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM blob_parts WHERE hash = ?').get(sha(big)).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM blobs WHERE hash = ?').get(sha(big)).count, 0);
  });
  withDb('main', (db) => assert.ok(Number(db.prepare("SELECT v FROM cloud_state WHERE k = 'cleanup'").get().v) > Date.now() / 1000 - 60));
  r = await call('GET', `/packs/${secondPack}/${sha(small)}/0`);
  assert.equal(Buffer.from(r.body.toString('ascii'), 'base64').toString(), 'tiny file');
});

test('tunnels and the live socket are gone: 410', async () => {
  for (const [method, pathname] of [['GET', '/v1/tunnels'], ['POST', '/v1/tunnels'], ['GET', `/v1/tunnels/${'a'.repeat(32)}`], ['DELETE', `/v1/tunnels/${'a'.repeat(32)}`], ['GET', `/v1/tunnels/${'a'.repeat(32)}/ws?role=control&token=${s.steve}`]]) {
    const r = await call(method, pathname, method === 'POST' ? {} : undefined, s.steve);
    assert.equal(r.status, 410, `${method} ${pathname}`);
    assert.deepEqual(r.body, { error: 'Туннели отключены: друзья подключаются напрямую.' });
  }
  const r = await call('GET', `/v1/live?token=${s.steve}`);
  assert.equal(r.status, 410);
});

test('rate limit: 60 a minute per address on /v1 and /ip; file parts and updates apart', async () => {
  const ip = '10.250.0.1';
  let limited = null;
  for (let count = 1; count <= 130 && !limited; count += 1) {
    const r = await call('GET', '/v1/me', undefined, s.steve, { ip });
    if (r.status === 429) limited = { count, r };
    else assert.equal(r.status, 200);
  }
  assert.ok(limited, 'no 429 after 130 requests');
  assert.ok(limited.count >= 61, `limited after ${limited.count}`);
  assert.equal(limited.r.body.error, 'Слишком много запросов, подождите минуту.');
  assert.equal((await call('GET', '/ip', undefined, null, { ip })).status, 429);
  assert.equal((await call('POST', '/v1/auth/offline', { name: 'Steve', secret: secretA }, null, { ip })).status, 429);
  // Not limited: file parts (as in the worker) and the news (their own wider limit).
  assert.equal((await call('PUT', `/v1/files/${'9'.repeat(64)}/0`, 'AAAA', s.steve, { ip })).status, 404);
  assert.equal((await call('GET', '/v1/updates?since=0', undefined, s.steve, { ip })).status, 200);
  // Another address is not touched.
  assert.equal((await call('GET', '/v1/me', undefined, s.steve)).status, 200);
});

test('proxy: only https to Modrinth / CurseForge hosts, streamed', async (t) => {
  for (const target of ['https://example.com/icon.png', 'http://cdn.modrinth.com/data/AANobbMI/icon.png', 'https://cdn.modrinth.com@example.com/x', 'https://cdn.modrinth.com.example.com/x',
    'https://cdn.modrinth.com:8443/x', 'https://cdn.modrinth.com\\@example.com/', 'file:///etc/passwd', '']) {
    const r = await call('GET', `/proxy?u=${encodeURIComponent(target)}`);
    assert.equal(r.status, 403, target);
    assert.equal(r.body.error, 'Этот адрес прокси не открывает.');
  }
  assert.equal((await call('POST', `/proxy?u=${encodeURIComponent('https://cdn.modrinth.com/data/AANobbMI/icon.png')}`, {})).status, 404, 'only GET');
  const r = await call('GET', `/proxy?u=${encodeURIComponent('https://cdn.modrinth.com/data/AANobbMI/icon.png')}`, undefined, null, { headers: { Cookie: 'a=b', 'X-Other': 'no' } });
  if (r.status === 502) {
    t.skip(`no internet here: ${JSON.stringify(r.body)}`);
    return;
  }
  assert.equal(r.status, 200, r.body.toString().slice(0, 200));
  assert.match(r.headers.get('content-type') ?? '', /^image\//);
  assert.ok(r.body.length > 100);
  if (r.headers.get('content-type') === 'image/png') assert.equal(r.body.subarray(0, 4).toString('hex'), '89504e47');
  if (r.headers.get('content-length')) assert.equal(Number(r.headers.get('content-length')), r.body.length);
  assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(r.headers.get('set-cookie'), null);
  // A conditional request comes back as 304 without a body when the CDN gave an ETag.
  const etag = r.headers.get('etag');
  if (etag) {
    const again = await call('GET', `/proxy?u=${encodeURIComponent('https://cdn.modrinth.com/data/AANobbMI/icon.png')}`, undefined, null, { headers: { 'If-None-Match': etag } });
    assert.ok([200, 304].includes(again.status));
  }
});

test('proxy: redirects are resolved against the address and checked against the hosts', () => {
  const script = path.join(work, 'redirects.php');
  fs.writeFileSync(script, `<?php
define('AMX', true);
require $argv[1];
$cases = json_decode($argv[2], true);
echo json_encode(array_map(function ($case) { $url = cloud_proxy_resolve($case[0], $case[1]); return [$url, cloud_proxy_allowed($url)]; }, $cases), JSON_UNESCAPED_SLASHES);
`);
  const from = 'https://edge.forgecdn.net/files/1/2/a.jar?x=1';
  const cases = [
    [from, 'https://mediafilez.forgecdn.net/files/1/2/a.jar', 'https://mediafilez.forgecdn.net/files/1/2/a.jar', true],
    [from, '/files/x.jar', 'https://edge.forgecdn.net/files/x.jar', true],
    [from, 'b.jar', 'https://edge.forgecdn.net/files/1/2/b.jar', true],
    [from, '//media.forgecdn.net/y', 'https://media.forgecdn.net/y', true],
    [from, 'https://www.curseforge.com/x', 'https://www.curseforge.com/x', false],
    [from, 'http://edge.forgecdn.net/x', 'http://edge.forgecdn.net/x', false],
    [from, '//evil.example/y', 'https://evil.example/y', false],
  ];
  const result = spawnSync(php, ['-n', script, path.join(site, 'cloud', 'lib', 'proxy.php'), JSON.stringify(cases.map(([a, b]) => [a, b]))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), cases.map(([, , url, ok]) => [url, ok]));
});

test('import of the old data: site token only, INSERTs only, reset, counts', async () => {
  const sql = (text) => text.trim();
  let r = await call('GET', '/admin/import');
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Нужен токен сайта.');
  r = await call('POST', '/admin/import?db=main', 'INSERT INTO users VALUES(1);', `amx_${'x'.repeat(40)}`);
  assert.equal(r.status, 401, 'an unknown token');
  r = await call('POST', '/admin/import?db=main', 'INSERT INTO users VALUES(1);', s.steve);
  assert.equal(r.status, 401, "a player's session is not the site's token");
  r = await call('GET', '/admin/import', undefined, siteToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.maxBytes >= 1024 * 1024);
  r = await call('POST', '/admin/import?db=other', 'SELECT 1;', siteToken);
  assert.equal(r.status, 400);

  const oldUuid = '1'.repeat(32);
  const oldToken = 'c'.repeat(64);
  const bobToken = 'b'.repeat(64);
  const skin = png(64, 64, 9);
  const skinHash = sha(Buffer.from(skin, 'base64'));
  const later = Date.now() + 86400000;
  const dump = sql(`
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (
  id TEXT PRIMARY KEY, -- a comment; with a semicolon
  ns TEXT NOT NULL
);
INSERT INTO "users" ("id","ns","uuid","name","name_lower","secret_hash","skin_hash","skin_model","cape_hash","presence","last_seen","created_at") VALUES('ms:${oldUuid}','ms','${oldUuid}','Old','old',NULL,'${skinHash}','classic',NULL,'{"status":"online","instance":null,"minecraft":null,"loader":null,"server":null}',0,1700000000000);
INSERT INTO users VALUES('offline:bob','offline',NULL,'Bob','bob','${sha(bobToken)}',NULL,NULL,NULL,NULL,0,1700000000001);
INSERT INTO "textures" ("hash","data","created_at") VALUES('${skinHash}','${skin}',1700000000000);
INSERT INTO "sessions" ("token_hash","user_id","expires_at") VALUES('${sha(oldToken)}','ms:${oldUuid}',${later}),('${sha(bobToken)}','offline:bob',${later});
INSERT INTO "friends" ("user_id","friend_id","since") VALUES('ms:${oldUuid}','offline:bob',1),('offline:bob','ms:${oldUuid}',1);
/* a block comment */
INSERT INTO "messages" ("id","from_id","to_id","kind","body","created_at","read_at") VALUES(41,'offline:bob','ms:${oldUuid}','text',replace('line one\\nit''s two','\\n',char(10)),1700000000000,NULL);
INSERT INTO "messages" ("id","from_id","to_id","kind","body","created_at","read_at") VALUES(40,'ms:${oldUuid}','offline:bob','text',unistr('caf\\00e9 \\u00e0 la carte'),1699999999999,-5);
INSERT INTO "tunnels" ("id","owner_id","created_at") VALUES('${'a'.repeat(32)}','ms:${oldUuid}',1700000000000);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('messages',41);
CREATE INDEX users_by_name ON users (ns, name_lower);
`);
  r = await call('POST', '/admin/import?db=main', dump, siteToken, { headers: { 'X-Import-Reset': '1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.tables, { users: 2, textures: 1, sessions: 2, challenges: 0, friend_requests: 0, friends: 2, messages: 2, images: 0, tunnels: 1 });
  assert.equal(r.body.skipped, 5);
  assert.equal(r.body.reset, true);
  assert.equal(r.body.totals.users, 2, 'the reset emptied the tables first');
  // The players before the import are gone; the imported ones are there with their sessions.
  assert.equal((await call('GET', '/v1/me', undefined, s.steve)).status, 401);
  r = await call('GET', '/v1/me', undefined, oldToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Old');
  r = await call('GET', '/csl/ely/Old.json');
  assert.deepEqual(r.body, { username: 'Old', skins: { default: skinHash } });
  r = await call('GET', `/v1/messages?with=${encodeURIComponent('offline:bob')}`, undefined, oldToken);
  assert.deepEqual(r.body.messages.map((message) => message.body), ['café à la carte', "line one\nit's two"]);
  assert.equal(r.body.messages[0].readAt, -5);
  // New messages go on after the imported ids.
  r = await call('POST', '/v1/messages', { to: `ms:${oldUuid}`, text: 'после переезда' }, bobToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.id, 42);

  // Anything but INSERTs into these tables refuses the whole piece; nothing of it is written.
  for (const bad of ['DROP TABLE users;', "ATTACH DATABASE 'x.db' AS x;", 'UPDATE users SET name = 1;', 'DELETE FROM users;', 'INSERT INTO evil VALUES(1);',
    'INSERT INTO users SELECT * FROM sessions;', "INSERT INTO main.users (id) VALUES('x');", "INSERT INTO users (id, secret) VALUES('x', 'y');",
    "INSERT INTO textures VALUES('h', load_extension('x'), 1);", 'CREATE TRIGGER t AFTER INSERT ON users BEGIN DELETE FROM users; END;',
    "INSERT INTO textures VALUES('h','d',1) ON CONFLICT DO NOTHING;", "INSERT INTO textures VALUES('h','d');"]) {
    r = await call('POST', '/admin/import?db=main', `INSERT INTO "textures" VALUES('zz','d',1);\n${bad}`, siteToken, { headers: { 'X-Import-Reset': '1' } });
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /^Принимаются только INSERT в таблицы Amethyx/, bad);
  }
  withDb('main', (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2, 'a refused piece changes nothing');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM textures WHERE hash = 'zz'").get().count, 0);
  });
  // A second piece without the reset adds to the first; a piece sent twice does no harm.
  for (let round = 0; round < 2; round += 1) {
    r = await call('POST', '/admin/import?db=main', "INSERT INTO \"textures\" (\"hash\",\"data\",\"created_at\") VALUES('ab','cd',1);", siteToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.tables.textures, 1);
    assert.equal(r.body.totals.textures, 2);
  }

  // The files database: a pack and its file, downloadable at once.
  const file = Buffer.from('moved file');
  const packId = 'f'.repeat(32);
  const files = JSON.stringify([{ path: 'mods/moved.jar', hash: sha(file), size: file.length }]);
  r = await call('POST', '/admin/import?db=files', sql(`
INSERT INTO "blobs" ("owner_id","hash","size","parts","created_at","expires_at") VALUES('offline:bob','${sha(file)}',${file.length},1,1,${later});
INSERT INTO "blob_parts" ("owner_id","hash","part","data") VALUES('offline:bob','${sha(file)}',0,'${file.toString('base64')}');
INSERT INTO "packs" ("id","owner_id","files","created_at","expires_at") VALUES('${packId}','offline:bob','${files.replace(/'/g, "''")}',1,${later});
`), siteToken, { headers: { 'X-Import-Reset': '1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.tables, { blobs: 1, blob_parts: 1, packs: 1 });
  r = await call('GET', `/packs/${packId}`);
  assert.deepEqual(r.body.files, JSON.parse(files));
  r = await call('GET', `/packs/${packId}/${sha(file)}/0`);
  assert.equal(Buffer.from(r.body.toString('ascii'), 'base64').toString(), 'moved file');
  r = await call('POST', '/admin/import?db=files', "INSERT INTO users VALUES('x');", siteToken);
  assert.equal(r.status, 400, 'tables of the other database are refused');
});

test('server/tools/import-to-site.mjs moves a dump in pieces (dry run, then for real)', () => {
  const dumpFile = path.join(work, 'dump.sql');
  const later = Date.now() + 86400000;
  const rows = [];
  for (let n = 0; n < 30; n += 1) {
    rows.push(`INSERT INTO "users" ("id","ns","uuid","name","name_lower","secret_hash","skin_hash","skin_model","cape_hash","presence","last_seen","created_at") VALUES('offline:p${n}','offline',NULL,'P${n}','p${n}','${sha(`s${n}`)}',NULL,NULL,NULL,NULL,0,${1700000000000 + n});`);
  }
  fs.writeFileSync(dumpFile, [
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE users (id TEXT PRIMARY KEY, -- not; the end\n ns TEXT /* nor; this */ NOT NULL);',
    ...rows,
    `INSERT INTO "sessions" ("token_hash","user_id","expires_at") VALUES('${sha('9'.repeat(64))}','offline:p7',${later});`,
    "INSERT INTO \"textures\" (\"hash\",\"data\",\"created_at\") VALUES('semi','a;b -- c /* d',1);",
    'CREATE INDEX users_by_name ON users (ns, name_lower);',
    '',
  ].join('\n'));
  const tool = path.join(root, 'server', 'tools', 'import-to-site.mjs');
  const run = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', env: { ...process.env, AMETHYX_SITE_TOKEN: siteToken } });
  let result = run(['--db', 'main', dumpFile, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /users: 30/);
  assert.match(result.stdout, /sessions: 1/);
  assert.match(result.stdout, /\(PRAGMA\): 1/);
  assert.ok(!result.stdout.includes(siteToken));
  result = run(['--db', 'main', dumpFile, '--site', base, '--chunk-mb', '0.002']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes(siteToken), 'the token is never printed');
  assert.ok((result.stdout.match(/^Часть \d+/gm) ?? []).length >= 3, result.stdout);
  assert.match(result.stdout, /users: 30/);
  assert.match(result.stdout, /textures: 1/);
  withDb('main', (db) => assert.equal(db.prepare("SELECT data FROM textures WHERE hash = 'semi'").get().data, 'a;b -- c /* d'));
  const me = spawnSync(process.execPath, ['-e', `fetch('${base}/cloud/v1/me', { headers: { Authorization: 'Bearer ${'9'.repeat(64)}' } }).then((r) => r.json()).then((b) => console.log(b.id))`], { encoding: 'utf8' });
  assert.equal(me.stdout.trim(), 'offline:p7');
  const wrong = spawnSync(process.execPath, [tool, '--db', 'main', dumpFile, '--site', base], { encoding: 'utf8', env: { ...process.env, AMETHYX_SITE_TOKEN: `amx_${'y'.repeat(40)}` } });
  assert.equal(wrong.status, 1, 'a wrong token stops it');
  assert.match(wrong.stderr, /^Ошибка: сайт ответил 401/m);
  withDb('main', (db) => assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 30, 'and changes nothing'));
});

test('PHP logged no warnings or errors', () => {
  const log = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : '';
  assert.equal(log.trim(), '', log);
});
