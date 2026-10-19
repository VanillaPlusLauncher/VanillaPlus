'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { openStream, HttpError } = require('./http');
const { sha1File } = require('./hashing');
const { segmentsFor } = require('./downloadConfig');

/** A download is stuck when no data arrived for this long; slow but moving downloads may take any time. */
const IDLE_TIMEOUT_MS = 60000;

/**
 * True when the file exists and matches the expected size and SHA-1.
 * `deepVerify: false` skips hashing (used for large sets of small assets whose
 * names are already their hashes).
 */
async function isFileUpToDate(filePath, { sha1, size, deepVerify = true } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    return false;
  }
  if (size !== undefined && stat.size !== size) {
    return false;
  }
  if (sha1 && deepVerify) {
    return (await sha1File(filePath)) === sha1;
  }
  return true;
}

/** Thrown when the server sends the whole file instead of a part: the file is then downloaded whole. */
class NoRangeSupport extends Error {}

/**
 * Downloads `size` bytes in `parts` pieces at once (HTTP Range), each into its place in `tempPath`,
 * like a browser's download manager does for big files. Throws NoRangeSupport when the server
 * ignores Range (answers 200 instead of 206).
 */
async function downloadInParts(url, tempPath, size, parts, { signal, touch, onProgress }) {
  const handle = await fsp.open(tempPath, 'w');
  await handle.truncate(size);
  await handle.close();
  const partSize = Math.ceil(size / parts);
  const received = new Array(parts).fill(0);
  await Promise.all(
    Array.from({ length: parts }, async (_, index) => {
      const start = index * partSize;
      const end = Math.min(size, start + partSize) - 1;
      const { stream, status } = await openStream(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
      if (status !== 206) {
        stream.destroy();
        throw new NoRangeSupport('сервер не отдаёт файл частями');
      }
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          touch();
          received[index] += chunk.length;
          if (received[index] > end - start + 1) {
            callback(new Error('сервер прислал лишние данные'));
            return;
          }
          onProgress?.(received.reduce((sum, value) => sum + value, 0), size);
          callback(null, chunk);
        },
      });
      await pipeline(stream, counter, fs.createWriteStream(tempPath, { flags: 'r+', start }), { signal });
      if (received[index] !== end - start + 1) throw new Error('часть файла пришла не полностью');
    }),
  );
}

/**
 * Downloads `url` into `destination` atomically (temp file + rename).
 * Skips the download when an up-to-date file already exists.
 * `onProgress(receivedBytes, totalBytes)` is called while streaming.
 * A big file with a known size is downloaded in several parts at once (Settings → "Загрузки");
 * a server that cannot do that gets the usual single download.
 */
async function downloadFile(url, destination, { sha1, size, deepVerify = true, onProgress, retries = 3 } = {}) {
  if (await isFileUpToDate(destination, { sha1, size, deepVerify })) {
    return { downloaded: false };
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });

  let lastError;
  let inParts = segmentsFor(size) > 1;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const tempPath = `${destination}.${crypto.randomBytes(4).toString('hex')}.part`;
    const controller = new AbortController();
    let idleTimer = null;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('нет данных от сервера больше минуты')), IDLE_TIMEOUT_MS);
    };
    if (inParts) {
      try {
        touch();
        await downloadInParts(url, tempPath, size, segmentsFor(size), { signal: controller.signal, touch, onProgress });
        if (sha1 && (await sha1File(tempPath)) !== sha1) {
          throw new Error(`контрольная сумма не совпадает (${path.basename(destination)})`);
        }
        clearTimeout(idleTimer);
        await fsp.rename(tempPath, destination);
        return { downloaded: true };
      } catch (error) {
        controller.abort();
        // The other parts' streams let go of the file first (Windows cannot delete it while open).
        await new Promise((resolve) => setTimeout(resolve, 150));
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        // Parts did not work out (no Range support, a broken part): the same attempt goes on whole.
        inParts = false;
        if (!(error instanceof NoRangeSupport)) lastError = error;
        clearTimeout(idleTimer);
        attempt -= error instanceof NoRangeSupport ? 1 : 0;
        continue;
      }
    }
    try {
      touch();
      const { stream, headers } = await openStream(url, { signal: controller.signal });
      const total = Number(headers['content-length']) || undefined;
      const hash = crypto.createHash('sha1');
      let received = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          touch();
          hash.update(chunk);
          received += chunk.length;
          onProgress?.(received, total);
          callback(null, chunk);
        },
      });
      await pipeline(stream, counter, fs.createWriteStream(tempPath), { signal: controller.signal });

      if (size !== undefined && received !== size) {
        throw new Error(`размер файла не совпадает (${path.basename(destination)})`);
      }
      if (sha1 && hash.digest('hex') !== sha1) {
        throw new Error(`контрольная сумма не совпадает (${path.basename(destination)})`);
      }
      await fsp.rename(tempPath, destination);
      return { downloaded: true };
    } catch (error) {
      lastError = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error;
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      // A missing file (404) will not appear on a retry.
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        break;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }
  throw new Error(`Не удалось скачать ${url}: ${lastError.message}`);
}

module.exports = { downloadFile, isFileUpToDate };
