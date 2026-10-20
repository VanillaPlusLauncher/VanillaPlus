'use strict';

const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const inflateRaw = promisify(zlib.inflateRaw);

/*
 * Reads a few small files out of a zip (a mod's fabric.mod.json, mods.toml, its icon) without
 * loading the whole archive: only the table of contents at its end and the wanted entries are read,
 * asynchronously. A 50 MB jar costs a few kilobytes instead of 50 MB read and parsed on the main
 * thread (what adm-zip does).
 *
 * openZip(path) -> { has(name), size(name), read(name) -> Buffer | null, close() } or null when the
 * file is not a zip this reader understands (ZIP64, damaged); callers then fall back to adm-zip.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;
/** Entries bigger than this are never read whole (the wanted files are a few KB). */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

async function openZip(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw new Error('too small');
    // The end-of-central-directory record: in the last 22 bytes plus at most a 64 KB comment.
    const tailLength = Math.min(size, 22 + MAX_COMMENT);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('no end record');
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    // ZIP64 (marked by all-ones fields) is left to adm-zip.
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('zip64');
    if (directoryOffset + directorySize > size) throw new Error('bad directory');
    const directory = await readAt(handle, directoryOffset, directorySize);

    const entries = new Map();
    let offset = 0;
    for (let n = 0; n < count && offset + 46 <= directory.length; n += 1) {
      if (directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('bad entry');
      const method = directory.readUInt16LE(offset + 10);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const localOffset = directory.readUInt32LE(offset + 42);
      const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength);
      entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    return {
      has: (name) => entries.has(name),
      size: (name) => entries.get(name)?.uncompressedSize ?? null,
      async read(name) {
        const entry = entries.get(name);
        if (!entry || entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) return null;
        const header = await readAt(handle, entry.localOffset, 30);
        if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) return null;
        const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const data = await readAt(handle, dataStart, entry.compressedSize);
        if (entry.method === 0) return data;
        if (entry.method === 8) return inflateRaw(data);
        return null;
      },
      close: () => handle.close(),
    };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

module.exports = { openZip };
