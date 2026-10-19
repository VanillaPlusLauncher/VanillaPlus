'use strict';

const dns = require('node:dns/promises');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const nbt = require('./nbt');

/*
 * The instance's multiplayer server list (servers.dat, the same file the game's "Multiplayer"
 * screen uses) and the Minecraft status ping: online players, version, message of the day and
 * latency, as the game shows them.
 */

const PING_TIMEOUT_MS = 5000;
const DEFAULT_PORT = 25565;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;

function serversFile(directory) {
  return path.join(directory, 'servers.dat');
}

async function readRoot(directory) {
  try {
    return nbt.read(await fsp.readFile(serversFile(directory)));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { name: '', value: { servers: { type: nbt.TAG.list, value: { itemType: nbt.TAG.compound, items: [] } } } };
    }
    throw new Error(`servers.dat не читается: ${error.message}`);
  }
}

/** Servers of an instance: [{ key, name, address, icon (data URL or null), hidden }]. */
async function listServers(directory) {
  const root = await readRoot(directory);
  const items = root.value.servers?.value?.items ?? [];
  return items.map((server, index) => ({
    key: index,
    name: server.name?.value ?? '',
    address: server.ip?.value ?? '',
    icon: server.icon?.value ? `data:image/png;base64,${server.icon.value}` : null,
    hidden: Boolean(server.hidden?.value),
  }));
}

/**
 * Saves the list in the given order. Each entry is { key?, name, address }: an entry with the
 * key of an existing server keeps that server's other data (icon, resource pack choice).
 */
async function saveServers(directory, servers) {
  const root = await readRoot(directory);
  const existing = root.value.servers?.value?.items ?? [];
  const items = [];
  for (const server of servers) {
    const name = String(server.name ?? '').trim().slice(0, 80) || 'Сервер Minecraft';
    const address = String(server.address ?? '').trim().slice(0, 255);
    if (!address) {
      continue;
    }
    const base = Number.isInteger(server.key) && existing[server.key] ? { ...existing[server.key] } : {};
    if (base.ip && base.ip.value !== address) {
      // Another address: the old icon belongs to the old server.
      delete base.icon;
    }
    base.name = { type: nbt.TAG.string, value: name };
    base.ip = { type: nbt.TAG.string, value: address };
    items.push(base);
  }
  root.value.servers = { type: nbt.TAG.list, value: { itemType: nbt.TAG.compound, items } };
  const file = serversFile(directory);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, nbt.write(root));
  await fsp.rename(temp, file);
  return listServers(directory);
}

// --- Status ping ---------------------------------------------------------------------------

function varInt(value) {
  const bytes = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

function packet(id, ...parts) {
  const body = Buffer.concat([varInt(id), ...parts]);
  return Buffer.concat([varInt(body.length), body]);
}

function mcString(text) {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([varInt(bytes.length), bytes]);
}

/** Reads a VarInt at `offset`; null when the buffer does not hold all of it yet. */
function readVarInt(buffer, offset) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset + index >= buffer.length) return null;
    const byte = buffer[offset + index];
    value |= (byte & 0x7f) << (7 * index);
    if ((byte & 0x80) === 0) return { value, size: index + 1 };
  }
  throw new Error('Неверный ответ сервера.');
}

/** "host", "host:port", "[ipv6]:port" → { host, port, explicitPort }. */
function parseAddress(address) {
  const text = String(address).trim();
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) return { host: bracket[1], port: Number(bracket[2] ?? DEFAULT_PORT), explicitPort: Boolean(bracket[2]) };
  const parts = text.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return { host: parts[0], port: Number(parts[1]), explicitPort: true };
  return { host: text, port: DEFAULT_PORT, explicitPort: false };
}

/** Plain text of a status "description" (a string or a chat component), without § codes. */
function chatText(component) {
  if (component == null) return '';
  if (typeof component === 'string') return component;
  const own = component.text ?? component.translate ?? '';
  const extra = Array.isArray(component.extra) ? component.extra.map(chatText).join('') : '';
  return `${own}${extra}`;
}

function exchange(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let status = null;
    let pingSentAt = 0;
    const timer = setTimeout(() => finish(new Error('Сервер не отвечает.')), PING_TIMEOUT_MS);
    function finish(error, result) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on('error', (error) => finish(new Error(error.code === 'ENOTFOUND' ? 'Адрес не найден.' : error.code === 'ECONNREFUSED' ? 'Сервер выключен.' : error.message)));
    socket.on('connect', () => {
      const portBytes = Buffer.alloc(2);
      portBytes.writeUInt16BE(port);
      // Handshake (protocol -1: "any version", next state 1: status), then the status request.
      socket.write(packet(0x00, varInt(-1), mcString(host), portBytes, varInt(1)));
      socket.write(packet(0x00));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_STATUS_BYTES) {
        finish(new Error('Слишком большой ответ сервера.'));
        return;
      }
      for (;;) {
        const length = readVarInt(buffer, 0);
        if (!length || buffer.length < length.size + length.value) return;
        const frame = buffer.subarray(length.size, length.size + length.value);
        buffer = buffer.subarray(length.size + length.value);
        const id = readVarInt(frame, 0);
        if (id.value === 0x00 && !status) {
          const textLength = readVarInt(frame, id.size);
          status = JSON.parse(frame.toString('utf8', id.size + textLength.size, id.size + textLength.size + textLength.value));
          const payload = Buffer.alloc(8);
          payload.writeBigInt64BE(BigInt(Date.now()));
          pingSentAt = Date.now();
          socket.write(packet(0x01, payload));
        } else if (id.value === 0x01) {
          finish(null, { status, latencyMs: Date.now() - pingSentAt });
          return;
        }
      }
    });
    socket.on('end', () => (status ? finish(null, { status, latencyMs: null }) : finish(new Error('Сервер закрыл соединение.'))));
  });
}

/** Status of a server as the game's server list shows it. Never throws: offline servers say why. */
async function pingServer(address) {
  const target = parseAddress(address);
  if (!target.host) {
    return { online: false, error: 'Пустой адрес.' };
  }
  let { host, port } = target;
  if (!target.explicitPort && !net.isIP(host)) {
    // Like the game: a _minecraft._tcp SRV record may point to another host and port.
    try {
      const [record] = await dns.resolveSrv(`_minecraft._tcp.${host}`);
      if (record) {
        host = record.name;
        port = record.port;
      }
    } catch {
      // No SRV record: the plain address is used.
    }
  }
  try {
    const { status, latencyMs } = await exchange(host, port);
    return {
      online: true,
      latencyMs,
      version: status.version?.name ?? null,
      protocol: status.version?.protocol ?? null,
      players: { online: status.players?.online ?? 0, max: status.players?.max ?? 0, sample: (status.players?.sample ?? []).map((player) => player.name).slice(0, 12) },
      motd: chatText(status.description).replace(/§./g, '').trim(),
      favicon: typeof status.favicon === 'string' && status.favicon.startsWith('data:image/png;base64,') ? status.favicon : null,
    };
  } catch (error) {
    return { online: false, error: error.message };
  }
}

module.exports = { listServers, saveServers, pingServer, parseAddress };
