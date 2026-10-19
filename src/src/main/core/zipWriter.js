'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');

/*
 * A small streaming zip writer: files are read and compressed one by one straight into the archive,
 * so exporting an instance with big worlds never holds them in memory. Zip64 is not written:
 * archives over 4 GB are refused with a clear error.
 */

const LIMIT = 0xffffffff;
// Already compressed: deflated quickly, there is little to win.
const PACKED = /\.(jar|zip|png|jpe?g|ogg|mp3|gz|xz|7z|mrpack|mca)$/i;
// Bit 3: sizes and CRC follow the data; bit 11: names are UTF-8.
const FLAGS = 0x0808;

function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class ZipWriter {
  constructor(target) {
    this.target = target;
    this.stream = fs.createWriteStream(target);
    this.offset = 0;
    this.entries = [];
  }

  async #write(buffer) {
    this.offset += buffer.length;
    if (this.offset > LIMIT) {
      throw new Error('Архив получается больше 4 ГБ: уберите из него миры или скриншоты.');
    }
    if (!this.stream.write(buffer)) {
      await once(this.stream, 'drain');
    }
  }

  async #entry(name, date, writeData) {
    if (this.entries.length >= 0xffff) {
      throw new Error('В архиве больше 65 535 файлов: уберите из него миры или скриншоты.');
    }
    const nameBuffer = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const { time, day } = dosDateTime(date);
    const start = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt16LE(nameBuffer.length, 26);
    await this.#write(header);
    await this.#write(nameBuffer);
    const { crc, size, packed } = await writeData();
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(packed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.#write(descriptor);
    this.entries.push({ nameBuffer, time, day, crc, size, packed, start });
  }

  addBuffer(name, data, date = new Date()) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this.#entry(name, date, async () => {
      const compressed = zlib.deflateRawSync(buffer);
      await this.#write(compressed);
      return { crc: zlib.crc32(buffer), size: buffer.length, packed: compressed.length };
    });
  }

  async addFile(name, filePath) {
    const stat = await fsp.stat(filePath);
    if (stat.size > LIMIT) {
      throw new Error(`Файл ${path.basename(filePath)} больше 4 ГБ.`);
    }
    return this.#entry(name, stat.mtime, async () => {
      let crc = 0;
      let size = 0;
      let packed = 0;
      const source = fs.createReadStream(filePath);
      const deflate = zlib.createDeflateRaw({ level: PACKED.test(name) ? 1 : 6 });
      source.on('data', (chunk) => {
        crc = zlib.crc32(chunk, crc);
        size += chunk.length;
      });
      source.on('error', (error) => deflate.destroy(error));
      source.pipe(deflate);
      for await (const chunk of deflate) {
        packed += chunk.length;
        await this.#write(chunk);
      }
      return { crc, size, packed };
    });
  }

  /** Adds every file under `directory` as `<prefix>/<relative path>`; `skip(relative)` leaves parts out. */
  async addFolder(prefix, directory, skip = () => false, relative = '') {
    const entries = await fsp.readdir(path.join(directory, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (skip(child)) continue;
      if (entry.isDirectory()) {
        await this.addFolder(prefix, directory, skip, child);
      } else if (entry.isFile()) {
        await this.addFile(prefix ? `${prefix}/${child}` : child, path.join(directory, child));
      }
    }
  }

  async close() {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.day, 14);
      record.writeUInt32LE(entry.crc >>> 0, 16);
      record.writeUInt32LE(entry.packed, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.nameBuffer.length, 28);
      record.writeUInt32LE(entry.start, 42);
      await this.#write(record);
      await this.#write(entry.nameBuffer);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await this.#write(end);
    this.stream.end();
    await once(this.stream, 'finish');
  }

  /** Stops writing and removes the unfinished file. */
  async abort() {
    this.stream.destroy();
    await once(this.stream, 'close').catch(() => {});
    await fsp.rm(this.target, { force: true }).catch(() => {});
  }
}

/** Writes a zip at `target` with `fill(writer)`; a failure leaves no half-written file behind. */
async function writeZip(target, fill) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const writer = new ZipWriter(target);
  try {
    await fill(writer);
    await writer.close();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

module.exports = { writeZip };
