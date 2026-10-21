// Runs the Amethyx worker against an in-memory SQLite database shaped like D1, with Mojang and
// Ely.by answers faked. Run from the repository root: node server/test/worker.test.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8'));
const filesDb = new DatabaseSync(':memory:');
filesDb.exec(fs.readFileSync(path.join(root, 'server', 'files-schema.sql'), 'utf8'));

/** A D1-shaped binding over a node:sqlite database. */
function d1(database) {
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...values) => statement(sql, values),
    first: async () => database.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...params) }),
    run: async () => database.prepare(sql).run(...params),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      database.exec('BEGIN');
      try {
        for (const item of list) database.prepare(item.sql).run(...item.params);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
const env = { DB: d1(db), FILES: d1(filesDb) };

// Mojang / Ely.by: a set of serverIds the "launcher" has joined.
const joined = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = new URL(url);
  const key = `${target.searchParams.get('username')}|${target.searchParams.get('serverId')}`;
  if (joined.has(key)) return new Response(JSON.stringify(joined.get(key)), { status: 200 });
  return new Response(null, { status: 204 });
};

const worker = (await import(pathToFileURL(path.join(root, 'server', 'src', 'worker.js')))).default;
/** A JSON call; a string body is sent as it is (file parts). */
async function call(method, pathname, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = typeof body === 'string' ? 'text/plain' : 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const response = await worker.fetch(new Request(`https://vp.example${pathname}`, { method, headers, body: payload }), env);
  const type = response.headers.get('Content-Type') ?? '';
  return { status: response.status, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}

function png(width, height, fill = 1) {
  const bytes = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes, 0);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

// Offline sign-in and the name lock.
const secretA = 'a'.repeat(64);
let r = await call('POST', '/v1/auth/offline', { name: 'Steve', secret: secretA });
assert.equal(r.status, 200, JSON.stringify(r.body));
const steve = r.body.token;
assert.equal(r.body.user.tag, null);
// A second Steve is not turned away: he gets the name with a code from his own secret.
const secretB = 'b'.repeat(64);
const tagB = (await import('node:crypto')).createHash('sha256').update(secretB).digest('hex').slice(0, 4);
r = await call('POST', '/v1/auth/offline', { name: 'steve', secret: secretB });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.user.id, `offline:steve#${tagB}`);
assert.equal(r.body.user.tag, tagB);
const steveB = r.body.token;
r = await call('POST', '/v1/auth/offline', { name: 'steve', secret: secretB });
assert.equal(r.body.user.id, `offline:steve#${tagB}`);
r = await call('POST', '/v1/auth/offline', { name: 'Steve', secret: secretA });
assert.equal(r.status, 200);
assert.equal(r.body.user.id, 'offline:steve');
// The first Steve finds the second one by the name with the code.
r = await call('POST', '/v1/friends/request', { ns: 'offline', name: `Steve#${tagB}` }, steve);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.user.tag, tagB);
r = await call('POST', '/v1/friends/request', { ns: 'ms', name: `Steve#${tagB}` }, steve);
assert.equal(r.status, 400);
r = await call('POST', '/v1/friends/decline', { id: `offline:steve#${tagB}` }, steve);
assert.equal(r.status, 200);
assert.ok(steveB);

// Microsoft sign-in: fails without join, works after it.
const uuid = '0123456789abcdef0123456789abcdef';
r = await call('POST', '/v1/auth/challenge', { ns: 'ms', name: 'Alex', uuid });
assert.equal(r.status, 200);
let failed = await call('POST', '/v1/auth/verify', { challengeId: r.body.challengeId });
assert.equal(failed.status, 403);
r = await call('POST', '/v1/auth/challenge', { ns: 'ms', name: 'Alex', uuid });
joined.set(`Alex|${r.body.serverId}`, { id: uuid, name: 'Alex' });
r = await call('POST', '/v1/auth/verify', { challengeId: r.body.challengeId });
assert.equal(r.status, 200, JSON.stringify(r.body));
const alex = r.body.token;
assert.equal(r.body.user.id, `ms:${uuid}`);
// A used challenge cannot be replayed.
r = await call('POST', '/v1/auth/verify', { challengeId: '0'.repeat(32) });
assert.equal(r.status, 400);

// Without a token.
r = await call('GET', '/v1/me');
assert.equal(r.status, 401);

// Skin and cape, CustomSkinLoader answers.
r = await call('PUT', '/v1/me/skin', { png: png(64, 64), model: 'slim' }, alex);
assert.equal(r.status, 200, JSON.stringify(r.body));
const skinHash = r.body.hash;
r = await call('PUT', '/v1/me/cape', { png: png(64, 32, 2) }, alex);
assert.equal(r.status, 200);
const capeHash = r.body.hash;
r = await call('PUT', '/v1/me/cape', { png: png(64, 64) }, alex);
assert.equal(r.status, 400);
r = await call('GET', '/csl/ms/alex.json');
assert.deepEqual(r.body, { username: 'Alex', skins: { slim: skinHash }, cape: capeHash });
r = await call('GET', `/csl/ms/textures/${skinHash}`);
assert.equal(r.status, 200);
assert.equal(r.body.toString('base64'), png(64, 64));
// Offline viewers find Microsoft players too; Ely.by viewers do not.
r = await call('GET', '/csl/offline/Alex.json');
assert.equal(r.status, 200);
r = await call('GET', '/csl/ely/Alex.json');
assert.equal(r.status, 404);
// Removing the skin removes the unused texture.
r = await call('DELETE', '/v1/me/skin', undefined, alex);
assert.equal(r.status, 200);
r = await call('GET', `/textures/${skinHash}`);
assert.equal(r.status, 404);
r = await call('GET', '/csl/ms/Alex.json');
assert.deepEqual(r.body, { username: 'Alex', cape: capeHash });

// Friends: request, list, accept, presence, remove.
r = await call('POST', '/v1/friends/request', { ns: 'ms', name: 'Nobody' }, steve);
assert.equal(r.status, 404);
r = await call('POST', '/v1/friends/request', { ns: 'ms', name: 'alex' }, steve);
assert.equal(r.body.state, 'requested');
r = await call('GET', '/v1/friends', undefined, alex);
assert.equal(r.body.incoming.length, 1);
assert.equal(r.body.incoming[0].id, 'offline:steve');
r = await call('POST', '/v1/friends/accept', { id: 'offline:steve' }, alex);
assert.equal(r.status, 200);
r = await call('POST', '/v1/me/presence', { status: 'playing', instance: 'Fabric 1.21', minecraft: '1.21.1', loader: 'fabric', server: 'mc.example.org' }, alex);
assert.equal(r.status, 200);
r = await call('GET', '/v1/friends', undefined, steve);
assert.equal(r.body.friends.length, 1);
assert.equal(r.body.friends[0].online, true);
assert.equal(r.body.friends[0].presence.server, 'mc.example.org');
r = await call('POST', '/v1/me/presence', { status: 'offline' }, alex);
r = await call('GET', '/v1/friends', undefined, steve);
assert.equal(r.body.friends[0].online, false);
assert.equal(r.body.friends[0].presence, null);
// Mutual requests become a friendship at once.
r = await call('DELETE', `/v1/friends/${encodeURIComponent(`ms:${uuid}`)}`, undefined, steve);
assert.equal(r.status, 200);
r = await call('POST', '/v1/friends/request', { ns: 'offline', name: 'Steve' }, alex);
assert.equal(r.body.state, 'requested');
r = await call('POST', '/v1/friends/request', { ns: 'ms', name: 'Alex' }, steve);
assert.equal(r.body.state, 'friends');

// Messages between friends: text, read marks, a picture, an invite; strangers get nothing.
r = await call('POST', '/v1/messages', { to: `ms:${uuid}`, text: 'Привет!' }, steve);
assert.equal(r.status, 200, JSON.stringify(r.body));
r = await call('POST', '/v1/messages', { to: `ms:${uuid}`, text: '   ' }, steve);
assert.equal(r.status, 400);
r = await call('GET', `/v1/messages?with=${encodeURIComponent('offline:steve')}`, undefined, alex);
assert.deepEqual(r.body.messages.map((message) => message.body), ['Привет!']);
r = await call('GET', '/v1/friends', undefined, alex);
assert.equal(r.body.unread['offline:steve'], 1);
r = await call('POST', '/v1/messages/read', { with: 'offline:steve' }, alex);
r = await call('GET', '/v1/friends', undefined, alex);
assert.equal(r.body.unread['offline:steve'], undefined);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]).toString('base64');
r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'image', image: jpeg, caption: 'Мой дом', width: 1600, height: 900 }, alex);
assert.equal(r.status, 200, JSON.stringify(r.body));
const imageId = r.body.message.body.imageId;
r = await call('GET', `/v1/images/${imageId}`, undefined, steve);
assert.equal(r.status, 200);
assert.equal(r.body.toString('base64'), jpeg);
r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'image', image: Buffer.from('not an image').toString('base64') }, alex);
assert.equal(r.status, 400);
r = await call('POST', '/v1/messages', { to: 'offline:steve', kind: 'invite', invite: { instance: 'Выживание', minecraft: '1.21.1', loader: 'fabric', server: 'play.example.org', code: 'VP1-abc' } }, alex);
assert.equal(r.body.message.body.server, 'play.example.org');
r = await call('POST', '/v1/auth/offline', { name: 'Stranger', secret: 'd'.repeat(64) });
const stranger = r.body.token;
r = await call('POST', '/v1/messages', { to: 'offline:steve', text: 'спам' }, stranger);
assert.equal(r.status, 403);
r = await call('GET', `/v1/images/${imageId}`, undefined, stranger);
assert.equal(r.status, 404);
r = await call('GET', `/v1/messages?with=${encodeURIComponent(`ms:${uuid}`)}`, undefined, steve);
assert.deepEqual(r.body.messages.map((message) => message.kind), ['text', 'image', 'invite']);

// A renamed Microsoft account frees the old name.
r = await call('POST', '/v1/auth/challenge', { ns: 'ms', name: 'Alex2', uuid });
joined.set(`Alex2|${r.body.serverId}`, { id: uuid, name: 'Alex2' });
r = await call('POST', '/v1/auth/verify', { challengeId: r.body.challengeId });
assert.equal(r.body.user.name, 'Alex2');
r = await call('GET', '/csl/ms/Alex.json');
assert.equal(r.status, 404);

// Tunnels: five for free, the sixth is refused until one is deleted.
r = await call('GET', '/v1/tunnels', undefined, steve);
assert.deepEqual(r.body, { count: 0, limit: 5 });
const tunnelIds = [];
for (let index = 0; index < 5; index += 1) {
  r = await call('POST', '/v1/tunnels', {}, steve);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  tunnelIds.push(r.body.id);
}
r = await call('POST', '/v1/tunnels', {}, steve);
assert.equal(r.status, 402);
r = await call('GET', '/v1/tunnels', undefined, steve);
assert.deepEqual(r.body, { count: 5, limit: 5 });
r = await call('DELETE', `/v1/tunnels/${tunnelIds[0]}`, undefined, alex);
r = await call('GET', '/v1/tunnels', undefined, steve);
assert.equal(r.body.count, 5, 'someone else cannot delete my tunnel');
r = await call('DELETE', `/v1/tunnels/${tunnelIds[0]}`, undefined, steve);
assert.equal(r.status, 200);
r = await call('POST', '/v1/tunnels', {}, steve);
assert.equal(r.status, 200);

// Share-code files: upload in parts, a pack, download by its id without signing in, cleanup.
const { createHash, randomBytes } = await import('node:crypto');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const big = randomBytes(3_000_000);
const small = Buffer.from('tiny file');
r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: big.length }, { hash: sha(small), size: small.length }] }, steve);
assert.equal(r.status, 200, JSON.stringify(r.body));
const partBytes = r.body.partBytes;
assert.deepEqual(r.body.need, [{ hash: sha(big), parts: [0, 1, 2] }, { hash: sha(small), parts: [0] }]);
const partOf = (bytes, part) => bytes.subarray(part * partBytes, (part + 1) * partBytes).toString('base64');
r = await call('PUT', `/v1/files/${sha(big)}/0`, partOf(big, 0), steve);
assert.equal(r.status, 200, JSON.stringify(r.body));
r = await call('PUT', `/v1/files/${sha(big)}/1`, partOf(big, 1).slice(1), steve);
assert.equal(r.status, 400, 'a short part is refused');
r = await call('PUT', `/v1/files/${sha(big)}/3`, partOf(big, 2), steve);
assert.equal(r.status, 400, 'no fourth part');
r = await call('PUT', `/v1/files/${sha(big)}/1`, partOf(big, 1));
assert.equal(r.status, 401);
const packFiles = [{ path: 'mods/big.jar', hash: sha(big), size: big.length }, { path: 'resourcepacks/small.zip', hash: sha(small), size: small.length }];
r = await call('POST', '/v1/packs', { files: packFiles }, steve);
assert.equal(r.status, 409, 'not all parts are there yet');
// The launcher asks again (as after a broken connection): only the missing parts.
r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: big.length }, { hash: sha(small), size: small.length }] }, steve);
assert.deepEqual(r.body.need, [{ hash: sha(big), parts: [1, 2] }, { hash: sha(small), parts: [0] }]);
for (const part of [1, 2]) assert.equal((await call('PUT', `/v1/files/${sha(big)}/${part}`, partOf(big, part), steve)).status, 200);
assert.equal((await call('PUT', `/v1/files/${sha(small)}/0`, partOf(small, 0), steve)).status, 200);
for (const bad of ['config/options.txt', 'mods/../evil.jar', 'mods/..', 'mods/a:b.jar', '../mods/x.jar']) {
  r = await call('POST', '/v1/packs', { files: [{ path: bad, hash: sha(small), size: small.length }] }, steve);
  assert.equal(r.status, 400, bad);
}
r = await call('POST', '/v1/packs', { files: packFiles }, alex);
assert.equal(r.status, 409, "someone else's files cannot be packed");
r = await call('POST', '/v1/packs', { files: packFiles }, steve);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.files, 2);
assert.equal(r.body.bytes, big.length + small.length);
const packId = r.body.id;
r = await call('POST', '/v1/packs', { files: packFiles }, steve);
assert.equal(r.body.id, packId, 'the same files make the same pack (the code stays the same)');
r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: big.length }] }, steve);
assert.deepEqual(r.body.need, [], 'uploaded files are not sent twice');
r = await call('POST', '/v1/files/start', { files: [{ hash: sha(big), size: 65 * 1024 * 1024 }] }, steve);
assert.equal(r.status, 413);
// A pack about to expire: downloading it is using the code, it stays a week more (its files too).
filesDb.prepare('UPDATE packs SET expires_at = ? WHERE id = ?').run(Date.now() + 60000, packId);
r = await call('GET', `/packs/${packId}`);
assert.equal(r.status, 200);
assert.deepEqual(r.body.files, packFiles);
const week = Date.now() + 6.9 * 86400000;
assert.ok(filesDb.prepare('SELECT expires_at FROM packs WHERE id = ?').get(packId).expires_at > week, 'the pack stays a week after a download');
assert.ok(filesDb.prepare('SELECT MIN(expires_at) AS at FROM blobs WHERE owner_id = ?').get('offline:steve').at > week, 'so do its files');
const parts = [];
for (let part = 0; part < 3; part += 1) {
  r = await call('GET', `/packs/${packId}/${sha(big)}/${part}`);
  assert.equal(r.status, 200);
  parts.push(Buffer.from(r.body.toString('ascii'), 'base64'));
}
assert.equal(sha(Buffer.concat(parts)), sha(big));
r = await call('GET', `/packs/${'0'.repeat(32)}`);
assert.equal(r.status, 404);
// Alex uploads a file of his own: Steve's pack id does not open it.
const alexFile = Buffer.from('alex only');
await call('POST', '/v1/files/start', { files: [{ hash: sha(alexFile), size: alexFile.length }] }, alex);
await call('PUT', `/v1/files/${sha(alexFile)}/0`, alexFile.toString('base64'), alex);
r = await call('GET', `/packs/${packId}/${sha(alexFile)}/0`);
assert.equal(r.status, 404);
// A second pack with the small file only; then the first expires and takes the big file with it.
r = await call('POST', '/v1/packs', { files: [packFiles[1]] }, steve);
const secondPack = r.body.id;
filesDb.prepare('UPDATE packs SET expires_at = 1 WHERE id = ?').run(packId);
filesDb.prepare('UPDATE blobs SET expires_at = 1 WHERE hash = ?').run(sha(big));
await worker.scheduled(null, env);
r = await call('GET', `/packs/${packId}`);
assert.equal(r.status, 404);
assert.equal(filesDb.prepare('SELECT COUNT(*) AS count FROM blob_parts WHERE hash = ?').get(sha(big)).count, 0);
r = await call('GET', `/packs/${secondPack}/${sha(small)}/0`);
assert.equal(Buffer.from(r.body.toString('ascii'), 'base64').toString(), 'tiny file');

globalThis.fetch = realFetch;
console.log('server tests passed');
