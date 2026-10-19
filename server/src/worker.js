/*
 * Vanilla+ server (Cloudflare Worker + D1): Vanilla+ skins and capes that other Vanilla+ players
 * see in the game (CustomSkinLoader's CustomSkinAPI), and friends with online status.
 *
 * Accounts:
 *  - Microsoft and Ely.by: proven the way Minecraft servers check players. The launcher "joins" a
 *    server id with its game session at Mojang or Ely.by; this server asks them whether it did.
 *    The game token itself never comes here.
 *  - Offline: no account to check. The first launcher that takes a name gets a secret for it.
 *
 * Every answer is JSON, except PNG textures.
 */

const NAMESPACES = ['ms', 'ely', 'offline'];
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const UUID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 2 * 60 * 1000;
// The launcher reports every 5 minutes while it is open.
const ONLINE_MS = 7 * 60 * 1000;
const MAX_PNG_BYTES = 256 * 1024;
const MAX_FRIENDS = 200;
const MAX_OUTGOING = 50;
const CAPE_WIDTHS = [64, 128, 256, 512];
const HAS_JOINED = {
  ms: 'https://sessionserver.mojang.com/session/minecraft/hasJoined',
  ely: 'https://authserver.ely.by/session/hasJoined',
};
const STATUSES = ['online', 'playing'];

class Failure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(size) {
  return hex(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256(data) {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Width and height of a PNG, or null. */
function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Decodes and checks a skin or cape sent as base64. */
function readPng(base64, kind) {
  if (typeof base64 !== 'string' || base64.length > MAX_PNG_BYTES * 1.4) throw new Failure(400, 'Файл слишком большой.');
  let bytes;
  try {
    bytes = fromBase64(base64);
  } catch {
    throw new Failure(400, 'Файл повреждён.');
  }
  const size = pngSize(bytes);
  if (!size) throw new Failure(400, 'Нужен PNG-файл.');
  const ok =
    kind === 'skin'
      ? size.width === 64 && (size.height === 64 || size.height === 32)
      : CAPE_WIDTHS.includes(size.width) && size.height * 2 === size.width;
  if (!ok) throw new Failure(400, `Размер ${size.width}x${size.height} не подходит.`);
  return { bytes, base64 };
}

async function readJson(request) {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_PNG_BYTES * 2) throw new Failure(413, 'Слишком большой запрос.');
  try {
    const body = await request.json();
    if (body && typeof body === 'object') return body;
  } catch {
    // Falls through to the error below.
  }
  throw new Failure(400, 'Нужен JSON.');
}

// --- Storage ---------------------------------------------------------------------------------

async function saveTexture(env, png) {
  const hash = await sha256(png.bytes);
  await env.DB.prepare('INSERT OR IGNORE INTO textures (hash, data, created_at) VALUES (?, ?, ?)').bind(hash, png.base64, Date.now()).run();
  return hash;
}

/** Removes a texture nobody uses any more. */
async function dropTextureIfUnused(env, hash) {
  if (!hash) return;
  const used = await env.DB.prepare('SELECT 1 FROM users WHERE skin_hash = ?1 OR cape_hash = ?1 LIMIT 1').bind(hash).first();
  if (!used) await env.DB.prepare('DELETE FROM textures WHERE hash = ?').bind(hash).run();
}

async function userByName(env, ns, name) {
  return env.DB.prepare('SELECT * FROM users WHERE ns = ? AND name_lower = ? LIMIT 1').bind(ns, name.toLowerCase()).first();
}

async function createSession(env, user) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.id, now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), user.id, now + SESSION_MS),
  ]);
  return { token, user: publicUser(user, true) };
}

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Failure(401, 'Нужен вход.');
  const row = await env.DB.prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?')
    .bind(await sha256(token), Date.now())
    .first();
  if (!row) throw new Failure(401, 'Вход устарел.');
  return row;
}

function isOnline(user) {
  return Date.now() - user.last_seen < ONLINE_MS;
}

/** What other players may see. Presence details only for friends (`withPresence`). */
function publicUser(user, withPresence = false) {
  const result = { id: user.id, ns: user.ns, name: user.name, skin: user.skin_hash ?? null, model: user.skin_model ?? 'classic', cape: user.cape_hash ?? null };
  if (withPresence) {
    let presence = null;
    try {
      presence = user.presence ? JSON.parse(user.presence) : null;
    } catch {
      presence = null;
    }
    result.online = isOnline(user);
    result.presence = result.online ? presence : null;
    result.lastSeen = user.last_seen || null;
  }
  return result;
}

// --- Sign-in -----------------------------------------------------------------------------

async function startChallenge(request, env) {
  const { ns, name, uuid } = await readJson(request);
  if (!(ns in HAS_JOINED) || !NAME.test(name ?? '') || !UUID.test(uuid ?? '')) throw new Failure(400, 'Неверные данные аккаунта.');
  const id = randomHex(16);
  const serverId = randomHex(16);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO challenges (id, ns, name, uuid, server_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, ns, name, uuid, serverId, now + CHALLENGE_MS),
  ]);
  return json({ challengeId: id, serverId });
}

async function finishChallenge(request, env) {
  const { challengeId } = await readJson(request);
  if (!/^[0-9a-f]{32}$/.test(challengeId ?? '')) throw new Failure(400, 'Неверный запрос.');
  const challenge = await env.DB.prepare('SELECT * FROM challenges WHERE id = ? AND expires_at > ?').bind(challengeId, Date.now()).first();
  if (!challenge) throw new Failure(400, 'Проверка устарела, попробуйте ещё раз.');
  await env.DB.prepare('DELETE FROM challenges WHERE id = ?').bind(challengeId).run();
  const url = `${HAS_JOINED[challenge.ns]}?username=${encodeURIComponent(challenge.name)}&serverId=${challenge.server_id}`;
  const answer = await fetch(url, { headers: { 'User-Agent': 'VanillaPlusServer/1' } });
  const profile = answer.status === 200 ? await answer.json().catch(() => null) : null;
  if (!profile || String(profile.id).replace(/-/g, '').toLowerCase() !== challenge.uuid) {
    throw new Failure(403, challenge.ns === 'ms' ? 'Microsoft не подтвердил аккаунт.' : 'Ely.by не подтвердил аккаунт.');
  }
  const name = String(profile.name ?? challenge.name);
  const id = `${challenge.ns}:${challenge.uuid}`;
  const now = Date.now();
  // Names of these accounts are unique at Mojang / Ely.by: whoever had this name before has changed it.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET name_lower = '' WHERE ns = ? AND name_lower = ? AND id <> ?").bind(challenge.ns, name.toLowerCase(), id),
    env.DB.prepare(
      'INSERT INTO users (id, ns, uuid, name, name_lower, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower',
    ).bind(id, challenge.ns, challenge.uuid, name, name.toLowerCase(), now),
  ]);
  return json(await createSession(env, await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()));
}

async function offlineSignIn(request, env) {
  const { name, secret } = await readJson(request);
  if (!NAME.test(name ?? '') || !/^[0-9a-f]{64}$/.test(secret ?? '')) throw new Failure(400, 'Неверные данные аккаунта.');
  const id = `offline:${name.toLowerCase()}`;
  const secretHash = await sha256(secret);
  const existing = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (existing && existing.secret_hash !== secretHash) {
    throw new Failure(409, `Ник ${name} в Vanilla+ уже занят другим офлайн-игроком.`);
  }
  if (!existing) {
    await env.DB.prepare('INSERT INTO users (id, ns, uuid, name, name_lower, secret_hash, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
      .bind(id, 'offline', name, name.toLowerCase(), secretHash, Date.now())
      .run();
  }
  return json(await createSession(env, await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()));
}

// --- Own profile ---------------------------------------------------------------------------

async function setTexture(request, env, user, kind) {
  const old = kind === 'skin' ? user.skin_hash : user.cape_hash;
  let hash = null;
  let model = null;
  if (request.method === 'PUT') {
    const body = await readJson(request);
    hash = await saveTexture(env, readPng(body.png, kind));
    model = body.model === 'slim' ? 'slim' : 'classic';
  }
  if (kind === 'skin') {
    await env.DB.prepare('UPDATE users SET skin_hash = ?, skin_model = ? WHERE id = ?').bind(hash, model, user.id).run();
  } else {
    await env.DB.prepare('UPDATE users SET cape_hash = ? WHERE id = ?').bind(hash, user.id).run();
  }
  if (old !== hash) await dropTextureIfUnused(env, old);
  return json({ ok: true, hash });
}

async function setPresence(request, env, user) {
  const body = await readJson(request);
  if (body.status === 'offline') {
    await env.DB.prepare('UPDATE users SET last_seen = 0, presence = NULL WHERE id = ?').bind(user.id).run();
    return json({ ok: true });
  }
  const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const presence = {
    status: STATUSES.includes(body.status) ? body.status : 'online',
    instance: text(body.instance, 64),
    minecraft: text(body.minecraft, 32),
    loader: text(body.loader, 16),
    server: text(body.server, 128),
  };
  await env.DB.prepare('UPDATE users SET last_seen = ?, presence = ? WHERE id = ?').bind(Date.now(), JSON.stringify(presence), user.id).run();
  return json({ ok: true });
}

// --- Friends -------------------------------------------------------------------------------

async function listFriends(env, user) {
  const [friends, incoming, outgoing] = await Promise.all([
    env.DB.prepare('SELECT users.* FROM friends JOIN users ON users.id = friends.friend_id WHERE friends.user_id = ? ORDER BY users.name').bind(user.id).all(),
    env.DB.prepare('SELECT users.* FROM friend_requests JOIN users ON users.id = friend_requests.from_id WHERE friend_requests.to_id = ? ORDER BY friend_requests.created_at DESC').bind(user.id).all(),
    env.DB.prepare('SELECT users.* FROM friend_requests JOIN users ON users.id = friend_requests.to_id WHERE friend_requests.from_id = ? ORDER BY friend_requests.created_at DESC').bind(user.id).all(),
  ]);
  return json({
    me: publicUser(user, true),
    unread: await unreadCounts(env, user),
    friends: friends.results.map((row) => publicUser(row, true)),
    incoming: incoming.results.map((row) => publicUser(row)),
    outgoing: outgoing.results.map((row) => publicUser(row)),
  });
}

async function makeFriends(env, a, b) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)').bind(a, b),
    env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, since) VALUES (?, ?, ?)').bind(a, b, now),
    env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, since) VALUES (?, ?, ?)').bind(b, a, now),
  ]);
}

async function requestFriend(request, env, user) {
  const { ns, name } = await readJson(request);
  if (!NAMESPACES.includes(ns) || !NAME.test(name ?? '')) throw new Failure(400, 'Введите ник: латинские буквы, цифры и _, до 16 символов.');
  const target = await userByName(env, ns, name);
  if (!target) throw new Failure(404, `${name} ещё не заходил в Vanilla+ с таким аккаунтом.`);
  if (target.id === user.id) throw new Failure(400, 'Это вы.');
  const already = await env.DB.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').bind(user.id, target.id).first();
  if (already) return json({ state: 'friends', user: publicUser(target) });
  // They already asked us: that is a yes from both sides.
  const reverse = await env.DB.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(target.id, user.id).first();
  if (reverse) {
    await makeFriends(env, user.id, target.id);
    return json({ state: 'friends', user: publicUser(target) });
  }
  const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM friends WHERE user_id = ?1) AS friends, (SELECT COUNT(*) FROM friend_requests WHERE from_id = ?1) AS outgoing').bind(user.id).first();
  if (counts.friends >= MAX_FRIENDS) throw new Failure(400, `Друзей может быть не больше ${MAX_FRIENDS}.`);
  if (counts.outgoing >= MAX_OUTGOING) throw new Failure(400, 'Слишком много заявок ждут ответа.');
  await env.DB.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').bind(user.id, target.id, Date.now()).run();
  return json({ state: 'requested', user: publicUser(target) });
}

async function answerRequest(request, env, user, accept) {
  const { id } = await readJson(request);
  if (typeof id !== 'string' || id.length > 64) throw new Failure(400, 'Неверный запрос.');
  if (accept) {
    const pending = await env.DB.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(id, user.id).first();
    if (!pending) throw new Failure(404, 'Заявка не найдена.');
    await makeFriends(env, user.id, id);
  } else {
    // Declines an incoming request or takes back an outgoing one.
    await env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)').bind(id, user.id).run();
  }
  return json({ ok: true });
}

async function removeFriend(env, user, id) {
  await env.DB.prepare('DELETE FROM friends WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)').bind(user.id, id).run();
  return json({ ok: true });
}

// --- Messages ------------------------------------------------------------------------------

const MAX_TEXT = 2000;
const MAX_IMAGE_BASE64 = 900 * 1024;
const MAX_INVITE_CODE = 60 * 1024;
const IMAGE_DAYS = 30;
const PAGE = 50;

async function areFriends(env, a, b) {
  return Boolean(await env.DB.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').bind(a, b).first());
}

/** Pushes an event to the player's open launchers (LiveHub), if any. Never fails the request. */
async function notify(env, userId, event) {
  if (!env.LIVE) return;
  try {
    const hub = env.LIVE.get(env.LIVE.idFromName(userId));
    await hub.fetch('https://live/notify', { method: 'POST', body: JSON.stringify(event) });
  } catch (error) {
    console.error('notify failed', error);
  }
}

function publicMessage(row) {
  let body = row.body;
  if (row.kind !== 'text') {
    try {
      body = JSON.parse(row.body);
    } catch {
      body = null;
    }
  }
  return { id: row.id, from: row.from_id, to: row.to_id, kind: row.kind, body, createdAt: row.created_at, readAt: row.read_at ?? null };
}

async function storeMessage(env, user, to, kind, body) {
  const now = Date.now();
  const result = await env.DB.prepare('INSERT INTO messages (from_id, to_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)').bind(user.id, to, kind, body, now).run();
  const id = result.meta?.last_row_id ?? result.lastInsertRowid;
  const message = publicMessage({ id: Number(id), from_id: user.id, to_id: to, kind, body, created_at: now });
  await notify(env, to, { type: 'message', message, from: publicUser(user) });
  return json({ message });
}

async function sendMessage(request, env, user) {
  const body = await readJson(request);
  const to = typeof body.to === 'string' ? body.to : '';
  if (!(await areFriends(env, user.id, to))) throw new Failure(403, 'Писать можно только друзьям.');

  if (body.kind === 'image') {
    const data = typeof body.image === 'string' ? body.image : '';
    if (!data || data.length > MAX_IMAGE_BASE64) throw new Failure(400, 'Картинка слишком большая.');
    let bytes;
    try {
      bytes = fromBase64(data.slice(0, 16));
    } catch {
      throw new Failure(400, 'Картинка повреждена.');
    }
    const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : null;
    if (!type) throw new Failure(400, 'Нужна картинка JPEG или PNG.');
    const imageId = randomHex(16);
    await env.DB.prepare('INSERT INTO images (id, owner_id, to_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(imageId, user.id, to, type, data, Date.now()).run();
    const caption = typeof body.caption === 'string' ? body.caption.slice(0, 200) : '';
    const width = Number.isFinite(body.width) ? Math.round(body.width) : null;
    const height = Number.isFinite(body.height) ? Math.round(body.height) : null;
    return storeMessage(env, user, to, 'image', JSON.stringify({ imageId, caption, width, height }));
  }

  if (body.kind === 'invite') {
    const invite = body.invite && typeof body.invite === 'object' ? body.invite : {};
    const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
    const code = typeof invite.code === 'string' && invite.code.length <= MAX_INVITE_CODE ? invite.code : null;
    const tunnel = typeof invite.tunnel === 'string' && /^[0-9a-f]{32}$/.test(invite.tunnel) ? invite.tunnel : null;
    if (tunnel) {
      const owned = await env.DB.prepare('SELECT 1 FROM tunnels WHERE id = ? AND owner_id = ?').bind(tunnel, user.id).first();
      if (!owned) throw new Failure(400, 'Туннель к миру не найден.');
    }
    const clean = { instance: text(invite.instance, 64), minecraft: text(invite.minecraft, 32), loader: text(invite.loader, 16), server: text(invite.server, 128), world: text(invite.world, 64), code, tunnel };
    if (!clean.server && !clean.code && !clean.world && !clean.tunnel) throw new Failure(400, 'В приглашении нет ни сервера, ни сборки.');
    return storeMessage(env, user, to, 'invite', JSON.stringify(clean));
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new Failure(400, 'Пустое сообщение.');
  if (text.length > MAX_TEXT) throw new Failure(400, `Сообщение длиннее ${MAX_TEXT} символов.`);
  return storeMessage(env, user, to, 'text', text);
}

/** A page of the conversation with a friend, newest last. `before` pages back. */
async function listMessages(env, user, url) {
  const other = url.searchParams.get('with') ?? '';
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows = await env.DB.prepare(
    'SELECT * FROM messages WHERE ((from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)) AND id < ?3 ORDER BY id DESC LIMIT ?4',
  )
    .bind(user.id, other, before, PAGE)
    .all();
  return json({ messages: rows.results.reverse().map(publicMessage), more: rows.results.length === PAGE });
}

async function markRead(request, env, user) {
  const { with: other } = await readJson(request);
  if (typeof other !== 'string') throw new Failure(400, 'Неверный запрос.');
  await env.DB.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL').bind(Date.now(), user.id, other).run();
  await notify(env, other, { type: 'read', by: user.id });
  return json({ ok: true });
}

async function unreadCounts(env, user) {
  const rows = await env.DB.prepare('SELECT from_id, COUNT(*) AS count FROM messages WHERE to_id = ? AND read_at IS NULL GROUP BY from_id').bind(user.id).all();
  return Object.fromEntries(rows.results.map((row) => [row.from_id, row.count]));
}

async function image(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(id).first();
  if (!row || (row.owner_id !== user.id && row.to_id !== user.id)) return json({ error: 'Картинка не найдена или устарела.' }, 404);
  return new Response(fromBase64(row.data), { headers: { 'Content-Type': row.type, 'Cache-Control': 'private, max-age=86400' } });
}

/** Daily: pictures older than 30 days go (the messages stay, showing "picture expired"). */
async function cleanup(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM images WHERE created_at < ?').bind(now - IMAGE_DAYS * 86400000),
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM tunnels WHERE created_at < ?').bind(now - TUNNEL_DAYS * 86400000),
  ]);
}

/**
 * One per player: holds the WebSocket of each open launcher of that player and pushes events to
 * them (new message, friend request, read receipt). Hibernates between events, so an idle
 * connection costs nothing.
 */
export class LiveHub {
  constructor(ctx) {
    this.ctx = ctx;
    // Keep-alive pings are answered without waking the object.
    this.ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notify') {
      const text = await request.text();
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(text);
        } catch {
          // A closed socket: it goes away by itself.
        }
      }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage() {
    // Launchers only listen; anything else they send is ignored.
  }

  async webSocketClose(socket, code) {
    try {
      socket.close(code, 'closed');
    } catch {
      // Already closed.
    }
  }
}

/** GET /v1/live?token=…: the launcher's WebSocket for instant events (browsers' WebSocket cannot send headers). */
async function live(request, env, url) {
  if (!env.LIVE) throw new Failure(503, 'Мгновенные уведомления недоступны.');
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${url.searchParams.get('token') ?? ''}`);
  const user = await authenticate(new Request(request.url, { headers }), env);
  const hub = env.LIVE.get(env.LIVE.idFromName(user.id));
  return hub.fetch(request);
}

// --- Tunnels: a friend joins the host's world ----------------------------------------------

/*
 * The host's launcher keeps a "control" WebSocket open in the room. For every game connection of
 * a guest, the guest's launcher opens a "join" WebSocket; the room tells the host, whose launcher
 * opens an "accept" WebSocket and a TCP connection to its world (open to LAN or own server). The
 * room then passes the bytes between the two WebSockets. Launchers send data in batches, so
 * Minecraft's many small packets cost few messages.
 */
const MAX_PENDING_BYTES = 256 * 1024;
const TUNNEL_DAYS = 2;

export class TunnelRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map();
    this.ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  tagOf(socket) {
    return this.ctx.getTags(socket)[0] ?? '';
  }

  peerOf(tag) {
    if (tag.startsWith('guest:')) return this.ctx.getWebSockets(`host:${tag.slice(6)}`)[0] ?? null;
    if (tag.startsWith('host:')) return this.ctx.getWebSockets(`guest:${tag.slice(5)}`)[0] ?? null;
    return null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const [control] = this.ctx.getWebSockets('control');
    let tag;
    if (role === 'control') {
      // One host connection per room: a new one replaces the old.
      for (const old of this.ctx.getWebSockets('control')) old.close(1000, 'replaced');
      tag = 'control';
    } else if (role === 'join') {
      if (!control) return json({ error: 'Хозяин мира сейчас не в игре.' }, 409);
      const id = randomHex(8);
      tag = `guest:${id}`;
      this.pending.set(id, { chunks: [], bytes: 0 });
      control.send(JSON.stringify({ type: 'open', conn: id, from: url.searchParams.get('from') ?? '' }));
    } else if (role === 'accept') {
      const id = url.searchParams.get('conn') ?? '';
      if (!this.ctx.getWebSockets(`guest:${id}`).length) return json({ error: 'Подключение уже закрыто.' }, 404);
      tag = `host:${id}`;
    } else {
      return json({ error: 'Неверная роль.' }, 400);
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tag]);
    if (tag.startsWith('host:')) {
      // What the guest's game sent before the host answered (its handshake).
      const id = tag.slice(5);
      for (const chunk of this.pending.get(id)?.chunks ?? []) pair[1].send(chunk);
      this.pending.delete(id);
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket, message) {
    const tag = this.tagOf(socket);
    if (tag === 'control') return;
    const peer = this.peerOf(tag);
    if (peer) {
      peer.send(message);
      return;
    }
    if (tag.startsWith('guest:')) {
      const waiting = this.pending.get(tag.slice(6)) ?? { chunks: [], bytes: 0 };
      const size = typeof message === 'string' ? message.length : message.byteLength;
      if (waiting.bytes + size <= MAX_PENDING_BYTES) {
        waiting.chunks.push(message);
        waiting.bytes += size;
        this.pending.set(tag.slice(6), waiting);
      }
    }
  }

  async webSocketClose(socket, code) {
    const tag = this.tagOf(socket);
    try {
      socket.close(code === 1005 ? 1000 : code, 'closed');
    } catch {
      // Already closed.
    }
    if (tag === 'control') {
      // The host left: every game connection through the room ends.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== socket) other.close(1000, 'host left');
      }
      this.pending.clear();
      return;
    }
    this.peerOf(tag)?.close(1000, 'peer closed');
    if (tag.startsWith('guest:')) this.pending.delete(tag.slice(6));
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket, 1011);
  }
}

async function createTunnel(env, user) {
  const id = randomHex(16);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tunnels WHERE owner_id = ? AND created_at < ?').bind(user.id, now - TUNNEL_DAYS * 86400000),
    env.DB.prepare('INSERT INTO tunnels (id, owner_id, created_at) VALUES (?, ?, ?)').bind(id, user.id, now),
  ]);
  return json({ id });
}

/** GET /v1/tunnels/<id>/ws?token=…&role=control|accept|join: the host's or a friend's WebSocket. */
async function tunnelSocket(request, env, url, id) {
  if (!env.TUNNEL) throw new Failure(503, 'Туннели недоступны.');
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${url.searchParams.get('token') ?? ''}`);
  const user = await authenticate(new Request(request.url, { headers }), env);
  const tunnel = await env.DB.prepare('SELECT * FROM tunnels WHERE id = ?').bind(id).first();
  if (!tunnel) throw new Failure(404, 'Приглашение в мир устарело.');
  const role = url.searchParams.get('role');
  if (role === 'join') {
    if (tunnel.owner_id !== user.id && !(await areFriends(env, tunnel.owner_id, user.id))) throw new Failure(403, 'Заходить в мир могут только друзья.');
  } else if (tunnel.owner_id !== user.id) {
    throw new Failure(403, 'Это не ваш мир.');
  }
  const target = new URL('https://tunnel/');
  target.searchParams.set('role', role ?? '');
  if (url.searchParams.get('conn')) target.searchParams.set('conn', url.searchParams.get('conn'));
  target.searchParams.set('from', user.name);
  const room = env.TUNNEL.get(env.TUNNEL.idFromName(id));
  return room.fetch(new Request(target, request));
}

// --- CustomSkinLoader ----------------------------------------------------------------------

/**
 * GET /csl/<ns>/<name>.json in CustomSkinAPI format. The game asks with the viewer's kind of
 * account; offline players are also found among Microsoft accounts (they meet on offline servers).
 */
async function cslProfile(env, ns, name) {
  let user = await userByName(env, ns, name);
  if (!user && ns === 'offline') user = await userByName(env, 'ms', name);
  if (!user || (!user.skin_hash && !user.cape_hash)) return json({ errno: 404, msg: 'not found' }, 404, { 'Cache-Control': 'public, max-age=60' });
  const body = { username: user.name };
  if (user.skin_hash) body.skins = { [user.skin_model === 'slim' ? 'slim' : 'default']: user.skin_hash };
  if (user.cape_hash) body.cape = user.cape_hash;
  return json(body, 200, { 'Cache-Control': 'public, max-age=60' });
}

async function texture(env, hash) {
  const row = await env.DB.prepare('SELECT data FROM textures WHERE hash = ?').bind(hash).first();
  if (!row) return new Response('Not found', { status: 404 });
  return new Response(fromBase64(row.data), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}

// --- Routing -------------------------------------------------------------------------------

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/' && method === 'GET') return json({ name: 'Vanilla+ server', api: 1 });

  let match = /^\/csl\/(ms|ely|offline)\/([A-Za-z0-9_]{1,16})\.json$/.exec(pathname);
  if (match && method === 'GET') return cslProfile(env, match[1], match[2]);
  match = /^\/(?:csl\/(?:ms|ely|offline)\/)?textures\/([0-9a-f]{64})$/.exec(pathname);
  if (match && method === 'GET' && HASH.test(match[1])) return texture(env, match[1]);

  if (pathname.startsWith('/v1/')) {
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
      if (!success) throw new Failure(429, 'Слишком много запросов, подождите минуту.');
    }
    if (pathname === '/v1/auth/challenge' && method === 'POST') return startChallenge(request, env);
    if (pathname === '/v1/auth/verify' && method === 'POST') return finishChallenge(request, env);
    if (pathname === '/v1/auth/offline' && method === 'POST') return offlineSignIn(request, env);

    if (pathname === '/v1/live' && method === 'GET') return live(request, env, url);
    match = /^\/v1\/tunnels\/([0-9a-f]{32})\/ws$/.exec(pathname);
    if (match && method === 'GET') return tunnelSocket(request, env, url, match[1]);

    const user = await authenticate(request, env);
    if (pathname === '/v1/me' && method === 'GET') return json(publicUser(user, true));
    if (pathname === '/v1/messages' && method === 'GET') return listMessages(env, user, url);
    if (pathname === '/v1/messages' && method === 'POST') return sendMessage(request, env, user);
    if (pathname === '/v1/messages/read' && method === 'POST') return markRead(request, env, user);
    if (pathname === '/v1/tunnels' && method === 'POST') return createTunnel(env, user);
    match = /^\/v1\/images\/([0-9a-f]{32})$/.exec(pathname);
    if (match && method === 'GET') return image(env, user, match[1]);
    if (pathname === '/v1/me/skin' && (method === 'PUT' || method === 'DELETE')) return setTexture(request, env, user, 'skin');
    if (pathname === '/v1/me/cape' && (method === 'PUT' || method === 'DELETE')) return setTexture(request, env, user, 'cape');
    if (pathname === '/v1/me/presence' && method === 'POST') return setPresence(request, env, user);
    if (pathname === '/v1/friends' && method === 'GET') return listFriends(env, user);
    if (pathname === '/v1/friends/request' && method === 'POST') return requestFriend(request, env, user);
    if (pathname === '/v1/friends/accept' && method === 'POST') return answerRequest(request, env, user, true);
    if (pathname === '/v1/friends/decline' && method === 'POST') return answerRequest(request, env, user, false);
    match = /^\/v1\/friends\/([^/]{1,64})$/.exec(pathname);
    if (match && method === 'DELETE') return removeFriend(env, user, decodeURIComponent(match[1]));
  }
  return json({ error: 'Не найдено.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof Failure) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Ошибка сервера.' }, 500);
    }
  },
  async scheduled(_event, env) {
    await cleanup(env);
  },
};

export { pngSize };
