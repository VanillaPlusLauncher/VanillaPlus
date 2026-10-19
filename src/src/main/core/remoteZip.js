'use strict';

const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { request } = require('./http');

/*
 * Reads single files out of a zip on a web server without downloading the whole archive:
 * HTTP range requests fetch the central directory (the zip's table of contents) and then just the
 * bytes of each wanted entry. For a 40 MB game jar that is a few hundred kilobytes instead.
 */

const inflateRaw = promisify(zlib.inflateRaw);
const TAIL_BYTES = 66 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

async function fetchRange(url, start, end) {
  const range = end === undefined ? `bytes=${start}` : `bytes=${start}-${end}`;
  const response = await request(url, { headers: { Range: range }, timeoutMs: 30000 });
  if (response.status !== 206) {
    throw new Error('Сервер не поддерживает частичную загрузку.');
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Opens a remote zip. Returns { names(), read(name) -> Buffer | null }. */
async function openRemoteZip(url) {
  // "bytes=-N" asks for the last N bytes, where the end-of-directory record lives.
  const tail = await fetchRange(url, -TAIL_BYTES);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Не найдено оглавление архива.');
  }
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  const directory = await fetchRange(url, directoryOffset, directoryOffset + directorySize - 1);

  const entries = new Map();
  let position = 0;
  while (position + 46 <= directory.length && directory.readUInt32LE(position) === CENTRAL_SIGNATURE) {
    const method = directory.readUInt16LE(position + 10);
    const compressedSize = directory.readUInt32LE(position + 20);
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const localOffset = directory.readUInt32LE(position + 42);
    const name = directory.toString('utf8', position + 46, position + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset, nameLength });
    position += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    /** Entry contents, or null when the archive has no such file. */
    async read(name) {
      const entry = entries.get(name);
      if (!entry) {
        return null;
      }
      // The local header repeats the name and may carry its own extra field: read a little more than needed.
      const slack = 30 + entry.nameLength + 1024;
      const chunk = await fetchRange(url, entry.localOffset, entry.localOffset + slack + entry.compressedSize - 1);
      if (chunk.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        throw new Error(`Повреждён файл ${name} в архиве.`);
      }
      const dataStart = 30 + chunk.readUInt16LE(26) + chunk.readUInt16LE(28);
      const data = chunk.subarray(dataStart, dataStart + entry.compressedSize);
      if (entry.method === 0) {
        return Buffer.from(data);
      }
      if (entry.method === 8) {
        return inflateRaw(data);
      }
      throw new Error(`Неизвестное сжатие ${entry.method} у ${name}.`);
    },
  };
}

module.exports = { openRemoteZip };
