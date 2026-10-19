'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { openStream, HttpError } = require('./http');
const { sha1File } = require('./hashing');

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

/**
 * Downloads `url` into `destination` atomically (temp file + rename).
 * Skips the download when an up-to-date file already exists.
 * `onProgress(receivedBytes, totalBytes)` is called while streaming.
 */
async function downloadFile(url, destination, { sha1, size, deepVerify = true, onProgress, retries = 3 } = {}) {
  if (await isFileUpToDate(destination, { sha1, size, deepVerify })) {
    return { downloaded: false };
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const tempPath = `${destination}.${crypto.randomBytes(4).toString('hex')}.part`;
    const controller = new AbortController();
    let idleTimer = null;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('нет данных от сервера больше минуты')), IDLE_TIMEOUT_MS);
    };
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
