'use strict';

const fsp = require('node:fs/promises');

/*
 * CurseForge's file fingerprint: MurmurHash2 (32-bit, seed 1) of the file with every tab, line
 * feed, carriage return and space byte left out. CurseForge finds a mod by it
 * (POST /v1/fingerprints), the way Modrinth finds one by SHA-1.
 */

const SKIPPED = new Set([9, 10, 13, 32]);
const M = 0x5bd1e995;

function fingerprintOf(buffer) {
  const bytes = Buffer.allocUnsafe(buffer.length);
  let length = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (!SKIPPED.has(byte)) bytes[length++] = byte;
  }
  let hash = (1 ^ length) >>> 0;
  let i = 0;
  for (; length - i >= 4; i += 4) {
    let k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    k = Math.imul(k, M);
    k ^= k >>> 24;
    k = Math.imul(k, M);
    hash = Math.imul(hash, M) ^ k;
  }
  const rest = length - i;
  if (rest > 0) {
    if (rest === 3) hash ^= bytes[i + 2] << 16;
    if (rest >= 2) hash ^= bytes[i + 1] << 8;
    hash ^= bytes[i];
    hash = Math.imul(hash, M);
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, M);
  hash ^= hash >>> 15;
  return hash >>> 0;
}

async function fingerprintFile(filePath) {
  return fingerprintOf(await fsp.readFile(filePath));
}

module.exports = { fingerprintOf, fingerprintFile };
