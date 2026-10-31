#!/usr/bin/env node
// Moves a dump of the old Cloudflare databases (npx wrangler d1 export … --output=<file>.sql) into
// the Amethyx server on the site (website/cloud, POST /cloud/admin/import). The dump is read as a
// stream and split into whole statements; they go in pieces under the hosting's request limit, the
// first piece emptying that database on the site first. A piece sent twice does no harm, so the
// whole run may simply be repeated after a failure. Node 24, no packages.
//
//   node server/tools/import-to-site.mjs --db main vanillaplus.sql
//   node server/tools/import-to-site.mjs --db files amethyx-files.sql
//   options: --site https://launcher.x-world.plus   --chunk-mb 4   --dry-run (only counts, sends nothing)
//
// The token is the site's API token (admin panel, "Токены"): AMETHYX_SITE_TOKEN or
// installer/site-token.txt. It is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEPARATOR = Buffer.from(';\n');
const READ_BYTES = 16 * 1024 * 1024;

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { db: '', site: 'https://launcher.x-world.plus', chunkMb: 4, dryRun: false, file: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) fail(`после ${arg} нужно значение`);
      return argv[++index];
    };
    if (arg === '--db') options.db = value();
    else if (arg === '--site') options.site = value();
    else if (arg === '--chunk-mb') options.chunkMb = Number(value());
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node server/tools/import-to-site.mjs --db main|files <файл.sql> [--site https://launcher.x-world.plus] [--chunk-mb 4] [--dry-run]');
      process.exit(0);
    } else if (arg.startsWith('--')) fail(`неизвестный параметр ${arg}`);
    else options.file = arg;
  }
  if (!['main', 'files'].includes(options.db)) fail('укажите базу: --db main (vanillaplus) или --db files (amethyx-files)');
  if (!options.file) fail('укажите файл выгрузки, например vanillaplus.sql');
  if (!fs.existsSync(options.file)) fail(`файла ${options.file} нет`);
  if (!(options.chunkMb > 0)) fail('--chunk-mb должен быть числом больше нуля');
  options.site = options.site.replace(/\/+$/, '');
  return options;
}

function readToken() {
  let token = process.env.AMETHYX_SITE_TOKEN ?? '';
  const file = path.join(root, 'installer', 'site-token.txt');
  if (!token && fs.existsSync(file)) token = fs.readFileSync(file, 'utf8');
  token = token.trim();
  if (!token) fail('нет токена сайта: создайте его в админке («Токены») и положите в installer\\site-token.txt или в переменную AMETHYX_SITE_TOKEN');
  if (!/^amx_[A-Za-z0-9]{40}$/.test(token)) fail('токен сайта не похож на amx_… (проверьте installer\\site-token.txt)');
  return token;
}

/**
 * The statements of an SQL file one by one ({ text: Buffer, done: bytes read }), split at the
 * semicolons outside strings, quoted names and comments. Read in blocks, so a dump of hundreds of
 * megabytes never has to fit in memory at once.
 */
function* statements(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(READ_BYTES);
  // 0 SQL, 1 '…', 2 "…", 3 `…`, 4 […], 5 -- comment, 6 /* comment */
  let state = 0;
  let previous = 0;
  let pending = [];
  let done = 0;
  try {
    for (;;) {
      const length = fs.readSync(fd, buffer, 0, READ_BYTES, null);
      if (length === 0) break;
      const block = buffer.subarray(0, length);
      let start = 0;
      let index = 0;
      while (index < length) {
        if (state === 1) {
          // Long strings (pictures, file parts) are skipped in one jump.
          const end = block.indexOf(0x27, index);
          if (end === -1) { index = length; break; }
          index = end + 1;
          state = 0;
          previous = 0;
          continue;
        }
        const byte = block[index];
        index += 1;
        if (state === 0) {
          if (byte === 0x27) state = 1;
          else if (byte === 0x22) state = 2;
          else if (byte === 0x60) state = 3;
          else if (byte === 0x5b) state = 4;
          else if (byte === 0x2d && previous === 0x2d) state = 5;
          else if (byte === 0x2a && previous === 0x2f) state = 6;
          else if (byte === 0x3b) {
            const text = Buffer.concat([...pending, block.subarray(start, index - 1)]);
            pending = [];
            start = index;
            if (text.toString('latin1').trim()) yield { text, done: done + index };
          }
          previous = state === 0 ? byte : 0;
        } else if (state === 2) {
          if (byte === 0x22) state = 0;
        } else if (state === 3) {
          if (byte === 0x60) state = 0;
        } else if (state === 4) {
          if (byte === 0x5d) state = 0;
        } else if (state === 5) {
          if (byte === 0x0a) state = 0;
        } else if (state === 6) {
          if (byte === 0x2f && previous === 0x2a) { state = 0; previous = 0; continue; }
          previous = byte;
        }
      }
      if (start < length) pending.push(Buffer.from(block.subarray(start, length)));
      done += length;
    }
    const rest = Buffer.concat(pending);
    if (rest.toString('latin1').trim()) yield { text: rest, done };
  } finally {
    fs.closeSync(fd);
  }
}

/** The table an INSERT goes to (for the counts of --dry-run), or the statement's first word. */
function kindOf(text) {
  let head = text.subarray(0, 400).toString('utf8');
  for (;;) {
    const stripped = head.replace(/^\s+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '');
    if (stripped === head) break;
    head = stripped;
  }
  const insert = /^(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/i.exec(head);
  if (insert) return insert.slice(1).find(Boolean).toLowerCase();
  return `(${(/^\w+/.exec(head)?.[0] ?? '?').toUpperCase()})`;
}

const megabytes = (bytes) => (bytes / 1048576).toFixed(1);

async function request(url, token, init = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    } catch (error) {
      if (attempt >= 4) fail(`сайт не отвечает (${error.cause?.code ?? error.message})`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      continue;
    }
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (response.ok && body) return body;
    if (response.status >= 500 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      continue;
    }
    if (response.status === 413) fail('хостинг не принял такую большую часть (413): запустите ещё раз с --chunk-mb 1');
    if (response.status === 404 && !body) fail(`по адресу ${url.split('?')[0]} нет сервера Amethyx: папка cloud/ загружена на сайт?`);
    fail(`сайт ответил ${response.status}: ${body?.message ?? body?.error ?? text.slice(0, 200)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fileBytes = fs.statSync(options.file).size;
  const counts = new Map();
  const count = (text) => {
    const kind = kindOf(text);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  };

  if (options.dryRun) {
    let pieces = 0;
    let size = 0;
    const max = Math.floor(options.chunkMb * 1048576);
    for (const { text } of statements(options.file)) {
      count(text);
      if (size + text.length + SEPARATOR.length > max || pieces === 0) { pieces += 1; size = 0; }
      size += text.length + SEPARATOR.length;
    }
    console.log(`Файл ${options.file}: ${megabytes(fileBytes)} МБ. Что в нём (INSERT по таблицам, остальное в скобках, это сайт пропустит):`);
    for (const [kind, n] of [...counts].sort()) console.log(`  ${kind}: ${n}`);
    console.log(`Частей по ${options.chunkMb} МБ: около ${pieces}. Ничего не отправлено (--dry-run).`);
    return;
  }

  const token = readToken();
  const endpoint = `${options.site}/cloud/admin/import`;
  const { maxBytes } = await request(endpoint, token);
  const max = Math.min(Math.floor(options.chunkMb * 1048576), Number(maxBytes) || 1048576);
  console.log(`Сайт ${options.site} принимает части до ${megabytes(maxBytes)} МБ, отправляю по ${megabytes(max)} МБ в базу ${options.db}.`);

  let parts = [];
  let size = 0;
  let sent = 0;
  let last = null;
  const send = async (done) => {
    const body = Buffer.concat(parts);
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (sent === 0) headers['X-Import-Reset'] = '1';
    last = await request(`${endpoint}?db=${options.db}`, token, { method: 'POST', headers, body });
    sent += 1;
    const added = Object.entries(last.tables ?? {}).filter(([, n]) => n > 0).map(([table, n]) => `${table} +${n}`).join(', ');
    console.log(`Часть ${sent} (${megabytes(done)} из ${megabytes(fileBytes)} МБ файла): ${added || 'только служебные строки'}`);
    parts = [];
    size = 0;
  };
  let done = 0;
  for (const statement of statements(options.file)) {
    const { text } = statement;
    if (text.length + SEPARATOR.length > max) {
      fail(`одна строка таблицы ${kindOf(text)} больше части (${megabytes(text.length)} МБ): увеличьте post_max_size на хостинге и запустите с бо́льшим --chunk-mb`);
    }
    if (size + text.length + SEPARATOR.length > max) await send(done);
    parts.push(text, SEPARATOR);
    size += text.length + SEPARATOR.length;
    done = statement.done;
  }
  // The last piece; an empty dump still empties the database, as a dump of an empty one should.
  if (parts.length || sent === 0) await send(fileBytes);
  console.log('Готово. Теперь на сайте:');
  for (const [table, n] of Object.entries(last?.totals ?? {})) console.log(`  ${table}: ${n}`);
}

main().catch((error) => fail(error.message));
