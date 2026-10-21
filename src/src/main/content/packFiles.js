'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { request } = require('../core/http');
const { createLogger } = require('../core/logger');
const { loadAccountStore } = require('../accounts/accountStore');
const { callAs, requireServer, BUILT_IN_SERVER } = require('../cloud/cloudClient');

/*
 * Files that travel with a share code through the Amethyx server (server/src/worker.js, "Files of
 * share codes"): mods, resource packs and shaders added by hand, uploaded only when the player
 * ticks it. The server keeps them FILE_DAYS days; the friend's launcher downloads them by the pack
 * id in the code and checks every file's SHA-256 before putting it into the instance.
 */

// As on the server.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILE_DAYS = 14;
const PACK_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks'];
const PART_TIMEOUT_MS = 120000;
const PART_TRIES = 3;
const log = createLogger('share');

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function readPart(filePath, offset, length) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Tries a part again after a dropped connection; the server's own refusals are final. */
async function withRetries(task) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= PART_TRIES || (error.status && error.status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/** "mods/name.jar": a file right inside one of the content folders, with a name Windows accepts; else null. */
function packPath(value) {
  const text = String(value ?? '');
  const slash = text.indexOf('/');
  const name = text.slice(slash + 1);
  const ok = PACK_FOLDERS.includes(text.slice(0, slash)) && name.length > 0 && name.length <= 200 && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/^\.+$/.test(name);
  return ok ? text : null;
}

/**
 * Uploads files ([{ path: "mods/name.jar", file: absolute path, size }]) as the selected account
 * and names them in a pack. Parts the server already has are not sent again.
 * Resolves with { id, files, bytes, expiresAt, server }.
 */
async function uploadPackFiles(files, onProgress = () => {}) {
  const { selectedId } = await loadAccountStore();
  if (!selectedId) throw new Error('Добавьте аккаунт: файлы загружаются на сервер Amethyx от его имени.');
  const server = await requireServer();
  const hashed = [];
  for (const entry of files) hashed.push({ ...entry, hash: await sha256File(entry.file) });
  const unique = [...new Map(hashed.map((entry) => [entry.hash, entry])).values()];
  const { partBytes, need } = await callAs(selectedId, 'POST', '/v1/files/start', { files: unique.map((entry) => ({ hash: entry.hash, size: entry.size })) });
  const byHash = new Map(unique.map((entry) => [entry.hash, entry]));
  const total = need.reduce((sum, item) => sum + item.parts.reduce((bytes, part) => bytes + Math.min(partBytes, byHash.get(item.hash).size - part * partBytes), 0), 0);
  let sent = 0;
  onProgress(0, total);
  for (const item of need) {
    const entry = byHash.get(item.hash);
    for (const part of item.parts) {
      const bytes = await readPart(entry.file, part * partBytes, partBytes);
      await withRetries(() => callAs(selectedId, 'PUT', `/v1/files/${item.hash}/${part}`, undefined, { text: bytes.toString('base64'), timeoutMs: PART_TIMEOUT_MS }));
      sent += bytes.length;
      onProgress(sent, total);
    }
  }
  const pack = await callAs(selectedId, 'POST', '/v1/packs', { files: hashed.map((entry) => ({ path: entry.path, hash: entry.hash, size: entry.size })) });
  log.info(`Файлы для кода загружены: ${pack.files} шт., ${Math.round(pack.bytes / 1024)} КБ, пакет ${pack.id}`);
  return { id: pack.id, files: pack.files, bytes: pack.bytes, expiresAt: pack.expiresAt, server };
}

/** The server named in a code (only when it is not the built-in one), else the built-in one. */
function packServer(ref) {
  return typeof ref?.server === 'string' && /^https?:\/\/[^/]+$/.test(ref.server) ? ref.server : BUILT_IN_SERVER;
}

/**
 * Downloads the files of a pack ({ id, server? }) into the instance folder. A file whose size or
 * SHA-256 differs is not kept. Resolves with { done, failed: [file names] }; throws when the pack
 * itself is gone (expired).
 */
async function downloadPackFiles(ref, directory, onProgress = () => {}) {
  const base = packServer(ref);
  let info;
  try {
    info = await (await request(`${base}/packs/${ref.id}`, { timeoutMs: 30000 })).json();
  } catch (error) {
    let message = null;
    try {
      message = JSON.parse(error.body).error;
    } catch {
      // Not the server's JSON.
    }
    throw new Error(message ?? `Файлы автора не скачались: ${error.message}`);
  }
  const files = Array.isArray(info.files) ? info.files.slice(0, 300) : [];
  const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  let received = 0;
  const failed = [];
  onProgress(0, total);
  for (const file of files) {
    const relative = packPath(file?.path);
    if (!relative || !/^[0-9a-f]{64}$/.test(String(file.hash)) || !Number.isInteger(file.size) || file.size > MAX_FILE_BYTES) {
      failed.push(String(file?.path ?? '?'));
      continue;
    }
    const target = path.join(directory, ...relative.split('/'));
    const temporary = `${target}.download`;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const hash = crypto.createHash('sha256');
      const output = await fsp.open(temporary, 'w');
      let size = 0;
      try {
        const parts = Math.max(1, Math.ceil(file.size / info.partBytes));
        for (let part = 0; part < parts; part += 1) {
          const response = await request(`${base}/packs/${ref.id}/${file.hash}/${part}`, { timeoutMs: PART_TIMEOUT_MS });
          const bytes = Buffer.from(await response.text(), 'base64');
          hash.update(bytes);
          await output.write(bytes);
          size += bytes.length;
          received += bytes.length;
          onProgress(received, total);
        }
      } finally {
        await output.close();
      }
      if (size !== file.size || hash.digest('hex') !== file.hash) throw new Error('файл пришёл повреждённым');
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      failed.push(path.basename(relative));
      log.warn(`Файл автора ${relative} не скачан: ${error.message}`);
    }
  }
  return { done: files.length - failed.length, failed };
}

module.exports = { uploadPackFiles, downloadPackFiles, MAX_FILE_BYTES, FILE_DAYS, BUILT_IN_SERVER };
