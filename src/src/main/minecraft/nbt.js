'use strict';

/*
 * Minimal Named Binary Tag (NBT) reader and writer, big-endian Java edition format, enough for
 * servers.dat. Values keep their tag types so a file is written back unchanged except for what
 * the launcher edits: { type, value } where compounds hold objects and lists hold { itemType, items }.
 */

const TAG = { end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 };

function read(buffer) {
  let offset = 0;
  const u8 = () => buffer.readUInt8(offset++);
  const take = (bytes, fn) => {
    const value = fn(offset);
    offset += bytes;
    return value;
  };
  const string = () => {
    const length = take(2, (at) => buffer.readUInt16BE(at));
    const value = buffer.toString('utf8', offset, offset + length);
    offset += length;
    return value;
  };

  function payload(type) {
    switch (type) {
      case TAG.byte: return take(1, (at) => buffer.readInt8(at));
      case TAG.short: return take(2, (at) => buffer.readInt16BE(at));
      case TAG.int: return take(4, (at) => buffer.readInt32BE(at));
      case TAG.long: return take(8, (at) => buffer.readBigInt64BE(at));
      case TAG.float: return take(4, (at) => buffer.readFloatBE(at));
      case TAG.double: return take(8, (at) => buffer.readDoubleBE(at));
      case TAG.byteArray: {
        const length = take(4, (at) => buffer.readInt32BE(at));
        const value = Buffer.from(buffer.subarray(offset, offset + length));
        offset += length;
        return value;
      }
      case TAG.string: return string();
      case TAG.list: {
        const itemType = u8();
        const length = take(4, (at) => buffer.readInt32BE(at));
        const items = [];
        for (let index = 0; index < length; index += 1) {
          items.push(payload(itemType));
        }
        return { itemType, items };
      }
      case TAG.compound: {
        const value = {};
        for (;;) {
          const childType = u8();
          if (childType === TAG.end) {
            return value;
          }
          const name = string();
          value[name] = { type: childType, value: payload(childType) };
        }
      }
      case TAG.intArray: {
        const length = take(4, (at) => buffer.readInt32BE(at));
        return Array.from({ length }, () => take(4, (at) => buffer.readInt32BE(at)));
      }
      case TAG.longArray: {
        const length = take(4, (at) => buffer.readInt32BE(at));
        return Array.from({ length }, () => take(8, (at) => buffer.readBigInt64BE(at)));
      }
      default:
        throw new Error(`Неизвестный тип NBT: ${type}`);
    }
  }

  const rootType = u8();
  if (rootType !== TAG.compound) {
    throw new Error('Файл NBT не начинается с составного тега.');
  }
  const name = string();
  return { name, value: payload(TAG.compound) };
}

function write(root) {
  const chunks = [];
  const push = (size, fn) => {
    const chunk = Buffer.alloc(size);
    fn(chunk);
    chunks.push(chunk);
  };
  const string = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    push(2, (chunk) => chunk.writeUInt16BE(bytes.length));
    chunks.push(bytes);
  };

  function payload(type, value) {
    switch (type) {
      case TAG.byte: return push(1, (chunk) => chunk.writeInt8(value));
      case TAG.short: return push(2, (chunk) => chunk.writeInt16BE(value));
      case TAG.int: return push(4, (chunk) => chunk.writeInt32BE(value));
      case TAG.long: return push(8, (chunk) => chunk.writeBigInt64BE(BigInt(value)));
      case TAG.float: return push(4, (chunk) => chunk.writeFloatBE(value));
      case TAG.double: return push(8, (chunk) => chunk.writeDoubleBE(value));
      case TAG.byteArray:
        push(4, (chunk) => chunk.writeInt32BE(value.length));
        chunks.push(Buffer.from(value));
        return undefined;
      case TAG.string: return string(value);
      case TAG.list:
        push(1, (chunk) => chunk.writeUInt8(value.items.length ? value.itemType : TAG.end));
        push(4, (chunk) => chunk.writeInt32BE(value.items.length));
        value.items.forEach((item) => payload(value.itemType, item));
        return undefined;
      case TAG.compound:
        for (const [name, child] of Object.entries(value)) {
          push(1, (chunk) => chunk.writeUInt8(child.type));
          string(name);
          payload(child.type, child.value);
        }
        return push(1, (chunk) => chunk.writeUInt8(TAG.end));
      case TAG.intArray:
        push(4, (chunk) => chunk.writeInt32BE(value.length));
        value.forEach((item) => push(4, (chunk) => chunk.writeInt32BE(item)));
        return undefined;
      case TAG.longArray:
        push(4, (chunk) => chunk.writeInt32BE(value.length));
        value.forEach((item) => push(8, (chunk) => chunk.writeBigInt64BE(BigInt(item))));
        return undefined;
      default:
        throw new Error(`Неизвестный тип NBT: ${type}`);
    }
  }

  push(1, (chunk) => chunk.writeUInt8(TAG.compound));
  string(root.name ?? '');
  payload(TAG.compound, root.value);
  return Buffer.concat(chunks);
}

module.exports = { TAG, read, write };
