'use strict';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SKIN_BYTES = 256 * 1024;
/** Minecraft skins: 64x64 (current) and 64x32 (legacy, no second arm/leg layer). */
const ALLOWED_SIZES = [
  { width: 64, height: 64 },
  { width: 64, height: 32 },
];

/** Reads width and height from the IHDR chunk. Returns null when the buffer is not a PNG. */
function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Throws a user-facing error when the buffer is not an acceptable skin PNG. */
function assertSkinPng(buffer) {
  if (buffer.length === 0 || buffer.length > MAX_SKIN_BYTES) {
    throw new Error('Файл скина пустой или слишком большой.');
  }
  const size = readPngSize(buffer);
  if (!size) {
    throw new Error('Скин должен быть PNG-файлом.');
  }
  if (!ALLOWED_SIZES.some((allowed) => allowed.width === size.width && allowed.height === size.height)) {
    throw new Error(`Размер скина ${size.width}x${size.height} не поддерживается. Нужен 64x64 или 64x32.`);
  }
}

/** Capes: 64x32 like the game's, or the same layout drawn 2, 4 or 8 times larger (HD capes). */
const CAPE_WIDTHS = [64, 128, 256, 512];

/** Throws a user-facing error when the buffer is not an acceptable cape PNG. */
function assertCapePng(buffer) {
  if (buffer.length === 0 || buffer.length > MAX_SKIN_BYTES) {
    throw new Error('Файл плаща пустой или слишком большой.');
  }
  const size = readPngSize(buffer);
  if (!size) {
    throw new Error('Плащ должен быть PNG-файлом.');
  }
  if (!CAPE_WIDTHS.includes(size.width) || size.height * 2 !== size.width) {
    throw new Error(`Размер плаща ${size.width}x${size.height} не поддерживается. Нужен 64x32 (или 128x64, 256x128, 512x256).`);
  }
}

module.exports = { assertSkinPng, assertCapePng, readPngSize, MAX_SKIN_BYTES };
