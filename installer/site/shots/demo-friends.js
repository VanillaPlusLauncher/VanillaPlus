// A stand-in for the friends server, only for the site screenshots: demo friends, a chat, an
// incoming request. Speaks the same API as the real server for what the launcher calls.
// Usage: node demo-friends.js <skinsFolder> [port]   (skins are read by name: <skinsFolder>/<name>.png)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [skins, portArg] = process.argv.slice(2);
const PORT = Number(portArg) || 8797;
const now = Date.now();
const min = 60000;

const user = (name, skin, model, presence, lastSeen = now) => ({ id: `offline:${name.toLowerCase()}`, ns: 'offline', name, skin, model, cape: null, presence, lastSeen });
const DEMO = [
  user('Kira_Craft', 'efe', 'slim', { status: 'playing', instance: 'Create: Skyline', minecraft: '1.21.1', loader: 'neoforge', server: null }),
  user('MaxBuilds', 'kai', 'classic', { status: 'online' }),
  user('Lumi_Blocks', 'zuri', 'classic', { status: 'playing', instance: 'Survival+', minecraft: '1.21.1', loader: 'fabric', server: null }),
  user('Nova_Pixel', 'makena', 'slim', null, now - 135 * min),
];
// An offline player whose name was taken: added by "Steve#3fa1" (like the real server does).
const REQUEST = { ...user('Steve', 'sunny', 'classic', { status: 'online' }), id: 'offline:steve#3fa1', tag: '3fa1' };
let incoming = [REQUEST];
const sessions = new Map();
let me = null;
let nextId = 100;
const messages = [];
const unread = { [DEMO[1].id]: 2 };

function seedChat() {
  const kira = DEMO[0].id;
  const max = DEMO[1].id;
  const at = (minutesAgo) => now - minutesAgo * min;
  const add = (from, to, kind, body, minutesAgo, read = true) => messages.push({ id: nextId++, from, to, kind, body, createdAt: at(minutesAgo), readAt: read ? at(minutesAgo - 1) : null });
  add(kira, me.id, 'text', 'hey! did you try the new Create pack?', 42);
  add(me.id, kira, 'text', 'yes!! the trains are insane', 40);
  add(kira, me.id, 'text', "I built a sky station, come see it tonight", 38);
  add(me.id, kira, 'text', 'deal. send me the world when you open it', 37);
  add(kira, me.id, 'invite', { instance: 'Create: Skyline', minecraft: '1.21.1', loader: 'neoforge', server: 'kira-skyline.eu.e4mc.link', world: 'Create: Skyline', code: null }, 3);
  add(kira, me.id, 'text', "it's open, jump in!", 2);
  add(max, me.id, 'text', 'gg yesterday', 15, false);
  add(max, me.id, 'text', 'rematch in the arena?', 14, false);
}

// Demo friends stay online for the whole recording; Nova_Pixel was seen two hours ago.
const isOnline = (u) => u === me || u.lastSeen >= now;
const pub = (u, withPresence = false) => {
  const result = { id: u.id, ns: u.ns, name: u.name, skin: u.skin ?? null, model: u.model ?? 'classic', cape: null, ...(u.tag ? { tag: u.tag } : {}) };
  if (withPresence) {
    result.online = isOnline(u);
    result.presence = result.online ? (u.presence ?? { status: 'online' }) : null;
    result.lastSeen = u.lastSeen;
  }
  return result;
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (chunk) => (data += chunk));
  req.on('end', () => {
    try {
      resolve(data ? JSON.parse(data) : {});
    } catch {
      resolve({});
    }
  });
});

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (req.method === 'GET' && url.pathname.startsWith('/textures/')) {
        const name = path.basename(url.pathname);
        const file = path.join(skins, `${name}.png`);
        if (fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), 'image/png');
        if (me?.skinPng && name === 'me') return send(res, 200, me.skinPng, 'image/png');
        return send(res, 404, { error: 'not found' });
      }
      if (route === 'POST /v1/auth/offline') {
        const body = await readBody(req);
        const token = crypto.randomBytes(32).toString('hex');
        if (!me) {
          me = user(body.name, null, 'classic', { status: 'online' });
          seedChat();
        }
        sessions.set(token, me);
        return send(res, 200, { token, user: pub(me, true) });
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!sessions.has(token)) return send(res, 401, { error: 'Нужен вход.' });
      if (route === 'GET /v1/me') return send(res, 200, pub(me, true));
      if (route === 'PUT /v1/me/skin') {
        const body = await readBody(req);
        me.skinPng = Buffer.from(body.png ?? '', 'base64');
        me.skin = 'me';
        me.model = body.model === 'slim' ? 'slim' : 'classic';
        return send(res, 200, { ok: true, hash: 'me' });
      }
      if (/^(PUT|DELETE) \/v1\/me\/(skin|cape)$/.test(route)) return send(res, 200, { ok: true, hash: null });
      if (route === 'POST /v1/me/presence') {
        const body = await readBody(req);
        me.presence = body;
        me.lastSeen = Date.now();
        return send(res, 200, { ok: true });
      }
      if (route === 'GET /v1/friends') {
        return send(res, 200, { me: pub(me, true), unread, friends: DEMO.map((u) => pub(u, true)), incoming: incoming.map((u) => pub(u)), outgoing: [] });
      }
      if (route === 'POST /v1/friends/accept') {
        const body = await readBody(req);
        const found = incoming.find((u) => u.id === body.id);
        incoming = incoming.filter((u) => u.id !== body.id);
        if (found) DEMO.splice(1, 0, found);
        return send(res, 200, { ok: true, user: found ? pub(found) : null });
      }
      if (/^POST \/v1\/friends\//.test(route)) return send(res, 200, { ok: true });
      if (route === 'GET /v1/messages') {
        const other = url.searchParams.get('with');
        const list = messages.filter((m) => (m.from === me.id && m.to === other) || (m.from === other && m.to === me.id));
        return send(res, 200, { messages: list, more: false });
      }
      if (route === 'POST /v1/messages') {
        const body = await readBody(req);
        const kind = body.kind === 'invite' ? 'invite' : body.kind === 'image' ? 'image' : 'text';
        const message = { id: nextId++, from: me.id, to: body.to, kind, body: kind === 'text' ? body.text : kind === 'invite' ? body.invite : { caption: body.caption }, createdAt: Date.now(), readAt: null };
        messages.push(message);
        return send(res, 200, { message });
      }
      if (route === 'POST /v1/messages/read') {
        const body = await readBody(req);
        delete unread[body.with];
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`demo server on ${PORT}`));
