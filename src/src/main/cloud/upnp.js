'use strict';

const dgram = require('node:dgram');
const { request } = require('../core/http');
const { createLogger } = require('../core/logger');

/*
 * Opening a port on the home router (UPnP IGD), so a friend's game can connect to this computer:
 * the router is found on the local network (SSDP), its WAN connection service is asked for the
 * outside address and to forward the port to this computer. Almost every home router can; some
 * have it switched off in their settings. Nothing here leaves the local network.
 */
const log = createLogger('upnp');
const SSDP_HOST = '239.255.255.250';
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
/** A mapping lasts this long unless renewed (tunnel.js renews it while the world is open). */
const LEASE_SECONDS = 2 * 3600;
const ONLY_PERMANENT_LEASES = 725;

class UpnpUnavailable extends Error {}

/** This computer's IPv4 addresses on its network adapters (virtual ones too: the router is behind one). */
function localAddresses() {
  return Object.values(require('node:os').networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

/**
 * The router's description addresses (LOCATION of the SSDP answers). The search goes out of every
 * network adapter: with WSL, Hyper-V or a VPN the default one is often not the home network's.
 */
function discover(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Set();
    const sockets = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      }
      resolve([...found]);
    };
    for (const address of [...localAddresses(), null]) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(socket);
      socket.on('message', (message) => {
        const location = /^location:\s*(\S+)/im.exec(message.toString('utf8'))?.[1];
        if (location && /^http:\/\//i.test(location)) found.add(location);
      });
      socket.on('error', () => {});
      socket.bind(0, address ?? undefined, () => {
        try {
          if (address) socket.setMulticastInterface(address);
        } catch {
          // This adapter cannot send to the network: the others still do.
        }
        for (const target of SEARCH_TARGETS) {
          const search = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_HOST}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`;
          socket.send(search, 1900, SSDP_HOST, () => {});
        }
      });
    }
    setTimeout(finish, timeoutMs);
  });
}

/** The WAN connection service of a router: { type, url } or null. */
async function findService(location) {
  const xml = await (await request(location, { timeoutMs: 4000, retries: 0 })).text();
  const base = xml.match(/<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i)?.[1] || location;
  for (const block of xml.split(/<service>/i).slice(1)) {
    const type = block.match(/<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i)?.[1];
    const control = block.match(/<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i)?.[1];
    if (type && control && /:service:WAN(IP|PPP)Connection:/i.test(type)) return { type, url: new URL(control, base).href, host: new URL(location).hostname };
  }
  return null;
}

let cached = null;

/** The router's service, found once a run (again after a failure). */
async function gateway() {
  if (cached) return cached;
  for (const location of await discover()) {
    try {
      const service = await findService(location);
      if (service) {
        log.info(`Роутер найден: ${service.host} (${service.type.split(':').slice(-2).join(':')})`);
        cached = service;
        return service;
      }
    } catch (error) {
      log.warn(`Ответ роутера не прочитан (${location}): ${error.message}`);
    }
  }
  throw new UpnpUnavailable('Роутер не ответил на UPnP.');
}

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** One SOAP action on the service; resolves with the answer's XML, throws with the router's error code. */
async function soap(service, action, args = {}) {
  const fields = Object.entries(args).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${fields}</u:${action}></s:Body></s:Envelope>`;
  try {
    const response = await request(service.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.type}#${action}"` },
      body,
      timeoutMs: 6000,
      retries: 0,
    });
    return response.text();
  } catch (error) {
    const code = Number(String(error.body ?? '').match(/<errorCode>\s*(\d+)\s*<\/errorCode>/)?.[1]) || null;
    const text = String(error.body ?? '').match(/<errorDescription>\s*([^<]*)<\/errorDescription>/)?.[1]?.trim();
    const failure = new Error(`роутер ответил ${code ?? error.status ?? error.message}${text ? ` (${text})` : ''}`);
    failure.code = code;
    throw failure;
  }
}

/** This computer's address on the network the router is in. */
function localAddressFor(host) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => {
      socket.close();
      resolve(null);
    });
    socket.connect(1900, host, () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}

/** Addresses no one outside can reach: the provider's shared ("grey") address, or a second router. */
function isPrivate(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a === 0 || !a;
}

/** The router's outside address. */
async function externalAddress() {
  const service = await gateway();
  const xml = await soap(service, 'GetExternalIPAddress');
  return xml.match(/<NewExternalIPAddress>\s*([^<\s]*)\s*<\/NewExternalIPAddress>/i)?.[1] || null;
}

/**
 * Forwards TCP `port` (outside and inside the same) to this computer. Resolves with
 * { externalIp, private } — `private` when the router itself has no public address.
 */
async function openPort(port, description) {
  let service;
  try {
    service = await gateway();
  } catch (error) {
    cached = null;
    throw error;
  }
  const client = await localAddressFor(service.host);
  if (!client) throw new UpnpUnavailable('Не удалось узнать адрес этого компьютера в сети роутера.');
  const args = (lease) => ({
    NewRemoteHost: '',
    NewExternalPort: port,
    NewProtocol: 'TCP',
    NewInternalPort: port,
    NewInternalClient: client,
    NewEnabled: 1,
    NewPortMappingDescription: String(description).slice(0, 60),
    NewLeaseDuration: lease,
  });
  try {
    await soap(service, 'AddPortMapping', args(LEASE_SECONDS));
  } catch (error) {
    // Some routers keep only mappings without an end.
    if (error.code !== ONLY_PERMANENT_LEASES) {
      cached = null;
      throw new UpnpUnavailable(`Роутер не открыл порт ${port}: ${error.message}.`);
    }
    await soap(service, 'AddPortMapping', args(0));
  }
  const externalIp = await externalAddress().catch(() => null);
  log.info(`Порт ${port} открыт на роутере → ${client}:${port}${externalIp ? `, снаружи ${externalIp}` : ''}`);
  return { externalIp, private: externalIp ? isPrivate(externalIp) : null };
}

/** Removes the forwarding of `port` (nothing happens when there is none). */
async function closePort(port) {
  if (!cached) return;
  await soap(cached, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }).catch(() => {});
  log.info(`Порт ${port} закрыт на роутере`);
}

module.exports = { openPort, closePort, externalAddress, isPrivate, UpnpUnavailable, LEASE_SECONDS };
