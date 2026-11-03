// A look-only stand for the site without PHP: serves the stripped test copy (argv[2]) and answers
// api.php with made-up versions, so the download list and the admin panel can be seen.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const port = Number(process.argv[3] || 8821);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json' };
const v = (id, version, platform, notes = '', size = 105003280) => ({ id, version, platform, channel: /beta/.test(version) ? 'beta' : 'release', size, sha256: 'x', notes, date: '2026-10-30', url: 'dl.php?id=' + id });
const versions = [
  v(9, '1.7.1-beta', 'windows', 'Мягкий вид, умный помощник и загрузка сборки.'),
  v(10, '1.7.1-beta', 'windows-legacy'),
  v(11, '1.7.1-beta', 'mac-arm64', '', 160000000),
  v(12, '1.7.1-beta', 'mac-x64', '', 162000000),
  v(8, '1.7-beta.64', 'windows', 'Исправления.'),
  v(7, '1.7-beta.61', 'mac-arm64'),
];
const site = { latest: { windows: versions[0], 'windows-legacy': versions[1], 'mac-arm64': versions[2], 'mac-x64': versions[3] }, versions };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.endsWith('/api.php')) {
    const a = url.searchParams.get('a');
    const body = a === 'site' ? site : a === 'me' ? { admin: null, setup: false } : { ok: true };
    res.writeHead(a === 'site' || a === 'me' || a === 'hit' ? 200 : 401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('mock site on ' + port));
