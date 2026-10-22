'use strict';

const net = require('node:net');

/*
 * Moving a Minecraft TCP connection over the Amethyx server's tunnel room (WebSockets, see
 * TunnelRoom in server/src/worker.js):
 *  host  — keeps a "control" socket; for each friend's connection opens an "accept" socket and a
 *          TCP connection to its own world (open to LAN or own server) and joins the two;
 *  guest — listens on 127.0.0.1:<port>; the game connects there, each connection gets a "join"
 *          socket to the room.
 * Data is sent in small batches (BATCH_MS): Minecraft writes many tiny packets, and every
 * WebSocket message counts toward the server's daily limit. After a quiet moment a packet goes at
 * once, so the ping stays low.
 * `socketUrl(role, conn)` gives (or resolves with) the room's WebSocket address with the account's
 * token: asked for each connection, so a launcher open for days never uses an expired token.
 */

const BATCH_MS = 30;
const BATCH_BYTES = 64 * 1024;
const HIGH_WATER = 1024 * 1024;
const PING_MS = 30 * 1000;

async function openSocket(address) {
  const url = await address;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const fail = () => reject(new Error('Туннель не открылся: сервер Amethyx не ответил.'));
    socket.addEventListener('open', () => {
      socket.removeEventListener('error', fail);
      resolve(socket);
    });
    socket.addEventListener('error', fail);
  });
}

/** Joins a TCP socket and a WebSocket both ways; closing one closes the other. */
function pipe(tcp, socket) {
  let queue = [];
  let queued = 0;
  let timer = null;
  let closed = false;
  let lastSent = 0;
  const flush = () => {
    timer = null;
    lastSent = Date.now();
    if (!queued || socket.readyState !== WebSocket.OPEN) return;
    const data = queue.length === 1 ? queue[0] : Buffer.concat(queue, queued);
    queue = [];
    queued = 0;
    socket.send(data);
    // Slow network: stop reading from the game until the WebSocket catches up.
    if (socket.bufferedAmount > HIGH_WATER) {
      tcp.pause();
      const wait = setInterval(() => {
        if (closed || socket.bufferedAmount < HIGH_WATER / 2) {
          clearInterval(wait);
          if (!closed) tcp.resume();
        }
      }, 20);
    }
  };
  tcp.setNoDelay(true);
  tcp.on('data', (chunk) => {
    queue.push(chunk);
    queued += chunk.length;
    if (queued >= BATCH_BYTES) {
      clearTimeout(timer);
      flush();
    } else if (!timer) {
      const quiet = Date.now() - lastSent >= BATCH_MS;
      if (quiet) flush();
      else timer = setTimeout(flush, BATCH_MS - (Date.now() - lastSent));
    }
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') return;
    tcp.write(Buffer.from(event.data));
  });
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    flush();
    tcp.destroy();
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  };
  tcp.on('close', close);
  tcp.on('error', close);
  socket.addEventListener('close', close);
  socket.addEventListener('error', close);
  return close;
}

/**
 * The host's side. Resolves once the control socket is open. `close()` ends the room's connections;
 * `onEvent({ type: 'join' | 'leave' | 'closed', from })` — "closed" when the control socket dropped
 * by itself (the caller reconnects).
 */
async function startHost({ socketUrl, port, host = '127.0.0.1', onEvent = () => {} }) {
  const control = await openSocket(socketUrl('control'));
  const connections = new Set();
  const ping = setInterval(() => control.readyState === WebSocket.OPEN && control.send('ping'), PING_MS);
  control.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string' || event.data === 'pong') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== 'open') return;
    let accept;
    try {
      accept = await openSocket(socketUrl('accept', message.conn));
    } catch {
      return;
    }
    const tcp = net.connect(port, host);
    tcp.on('error', () => {});
    const close = pipe(tcp, accept);
    connections.add(close);
    onEvent({ type: 'join', from: message.from });
    tcp.on('close', () => {
      connections.delete(close);
      onEvent({ type: 'leave', from: message.from });
    });
  });
  let stopped = false;
  control.addEventListener('close', () => {
    clearInterval(ping);
    if (!stopped) onEvent({ type: 'closed' });
  });
  return {
    close() {
      stopped = true;
      clearInterval(ping);
      for (const close of connections) close();
      try {
        control.close();
      } catch {
        // Already closed.
      }
    },
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', failed);
      resolve(server.address().port);
    });
  });
}

/** What the guest sends before the room says the host is there; the room holds up to 256 KB. */
const BEFORE_READY_BYTES = 128 * 1024;

/**
 * The friend's side: a local port for the game, `port` when it is free (so the address in the
 * game's server list stays the same), else any. Resolves with { port, close() }.
 * `onEvent({ type: 'error', message })` when the room cannot be reached. The game's first bytes
 * (its handshake, well under BEFORE_READY_BYTES) go at once; more waits here until the room says
 * the host is there ("ready"), as the room only holds a little for it.
 */
async function startGuest({ socketUrl, port = 0, onEvent = () => {} }) {
  const connections = new Set();
  const server = net.createServer(async (tcp) => {
    tcp.pause();
    tcp.on('error', () => {});
    let socket;
    try {
      socket = await openSocket(socketUrl('join'));
    } catch (error) {
      onEvent({ type: 'error', message: error.message });
      tcp.destroy();
      return;
    }
    const close = pipe(tcp, socket);
    connections.add(close);
    let ready = false;
    let early = 0;
    let held = false;
    tcp.on('data', (chunk) => {
      if (ready) return;
      early += chunk.length;
      if (early >= BEFORE_READY_BYTES) {
        held = true;
        tcp.pause();
      }
    });
    socket.addEventListener('message', (event) => {
      if (event.data !== 'ready' || ready) return;
      ready = true;
      if (held) tcp.resume();
    });
    tcp.resume();
    tcp.on('close', () => connections.delete(close));
  });
  let bound;
  try {
    bound = await listen(server, port);
  } catch {
    bound = await listen(server, 0);
  }
  return {
    port: bound,
    close() {
      for (const close of connections) close();
      server.close();
    },
  };
}

module.exports = { startHost, startGuest, pipe };
