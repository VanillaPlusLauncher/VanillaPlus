// Live check: without a login nothing private answers. Read-only requests only (no login attempts).
const base = 'https://launcher.x-world.plus/';
const ok = (name, good, extra = '') => console.log(`${good ? 'ok  ' : 'FAIL'} ${name.padEnd(40)} ${extra}`);
const H = { 'X-Amethyx': '1', 'Content-Type': 'application/json' };
for (const a of ['versions', 'stats', 'tokens', 'limits', 'me']) {
  const r = await fetch(base + 'api.php?a=' + a, { headers: H });
  const body = await r.text();
  const leaked = a === 'me' ? /"admin"\s*:\s*\{/.test(body) : r.status === 200;
  ok(`api ${a} without login`, !leaked, `${r.status} ${body.slice(0, 80)}`);
}
for (const [a, data] of [['version-delete', { id: 1 }], ['token-create', { name: 'x' }], ['upload-start', { name: 'x.exe', size: 1 }], ['setup', { login: 'x', password: 'xxxxxxxxxxxx' }]]) {
  const r = await fetch(base + 'api.php?a=' + a, { method: 'POST', headers: H, body: JSON.stringify(data) });
  ok(`api ${a} without login`, r.status >= 400, `${r.status} ${(await r.text()).slice(0, 80)}`);
}
for (const p of ['lib/amethyx.php', 'lib/', 'data/', '../amethyx-data/', 'amethyx-data/', 'downloads/', 'updates/', '.htaccess']) {
  const r = await fetch(base + p, { redirect: 'manual' });
  const t = await r.text();
  ok(`GET /${p}`, r.status === 403 || r.status === 404 || (r.status === 200 && !/<\?php|Index of|SQLite/.test(t) && p !== '.htaccess'), `${r.status}`);
}
