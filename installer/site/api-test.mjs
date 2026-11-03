// End-to-end test of the site API against a local PHP server (argv[2] = base URL).
import crypto from 'node:crypto';
const base = process.argv[2] || 'http://127.0.0.1:8820/';
let cookie = '';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

async function call(action, { body, method, headers = {}, query = '', raw } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) { h['content-type'] = 'application/json'; }
  const res = await fetch(`${base}api.php?a=${action}${query}`, {
    method: method || (body !== undefined || raw ? 'POST' : 'GET'), headers: h,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const A = { 'x-amethyx': '1' };
const PASS = crypto.randomBytes(9).toString('base64url') + 'Aa1';

let r = await call('me'); check('me before setup', r.data.setup === true && r.data.admin === null);
r = await call('site'); check('site has no versions before import', Object.keys(r.data.latest).length === 0);
let d = await fetch(base + 'dl.php?platform=windows', { redirect: 'manual' });
check('dl.php imports the shipped installer', d.status === 302 && d.headers.get('location') === 'downloads/Amethyx-Setup-1.7.0-beta.26.exe', d.headers.get('location'));
r = await call('site'); check('site latest windows', r.data.latest.windows?.version === '1.7.0-beta.26', JSON.stringify(r.data.latest.windows));
r = await call('setup', { body: { login: 'boss', password: PASS } }); check('setup without the panel header refused', r.status === 403);
r = await call('setup', { body: { login: 'boss', password: 'short' }, headers: A }); check('setup rejects short password', r.status === 400);
r = await call('setup', { body: { login: 'boss', password: PASS }, headers: A }); check('setup', r.status === 200 && r.data.admin === 'boss');
r = await call('setup', { body: { login: 'evil', password: PASS }, headers: A }); check('second setup refused', r.status === 409);
{
  // A visitor gets no session cookie; a forged session id is not taken.
  const anon = await fetch(base + 'api.php?a=me');
  check('no cookie for visitors', !anon.headers.get('set-cookie'), anon.headers.get('set-cookie'));
  const forged = await (await fetch(base + 'api.php?a=me', { headers: { cookie: 'AMXSESS=deadbeefdeadbeefdeadbeefdeadbeef' } })).json();
  check('forged session id is not an admin', forged.admin === null);
}
{
  const beta = await (await fetch(base + 'updates/beta.json')).json();
  check('beta feed written', beta.version === '1.7.0-beta.26' && /\/dl\.php\?id=1$/.test(beta.installer.url) && beta.installer.size === 16, JSON.stringify(beta));
  const rel = await fetch(base + 'updates/latest.json');
  check('no release feed while only betas exist', rel.status === 404);
  // The site folder wiped and filled again: the feed comes back on the next page view.
  const fs = await import('node:fs');
  const www = process.env.TEMP + '/rldev/sitetest/www';
  fs.rmSync(www + '/updates', { recursive: true, force: true });
  check('feed gone after a wipe', (await fetch(base + 'updates/beta.json')).status === 404);
  await call('site');
  const healed = await fetch(base + 'updates/beta.json');
  check('feed healed by a page view', healed.status === 200 && (await healed.json()).installer.url === beta.installer.url);
  // A build whose file vanished is not offered.
  fs.copyFileSync(www + '/downloads/Amethyx-Setup-1.7.0-beta.26.exe', www + '/downloads/Amethyx-Setup-1.7.0-beta.25.exe');
  await call('import', { body: {}, headers: A });
  fs.rmSync(www + '/downloads/Amethyx-Setup-1.7.0-beta.25.exe');
  const s = await call('site');
  {
    // Uploading the vanished file again brings the same version back.
    const blob = Buffer.from('fake installer\r\n');
    const st = await call('upload-start', { body: { name: 'Amethyx-Setup-1.7.0-beta.25.exe', size: blob.length }, headers: A });
    await call('upload-chunk', { query: `&id=${st.data.id}&offset=0`, raw: blob, headers: A });
    const fin = await call('upload-finish', { body: { id: st.data.id }, headers: A });
    const back = await call('site');
    check('re-upload restores the vanished version', fin.status === 200 && back.data.versions.filter((v) => v.version === '1.7.0-beta.25').length === 1, JSON.stringify(fin.data));
    fs.rmSync(www + '/downloads/Amethyx-Setup-1.7.0-beta.25.exe');
  }
  check('missing file not listed',!s.data.versions.some((v) => v.version === '1.7.0-beta.25') && s.data.latest.windows.version === '1.7.0-beta.26', JSON.stringify(s.data.versions.map((v) => v.version)));
}
r = await call('versions'); { const b26 = r.data.versions.find((v) => v.version === '1.7.0-beta.26'); check('versions (session)', b26 && b26.downloads === 1 && r.data.versions.find((v) => v.version === '1.7.0-beta.25')?.missing === true, JSON.stringify(r.data.versions)); }
r = await call('import', { body: {} }); check('POST without header refused', r.status === 403);
r = await call('token-create', { body: { name: 'build.ps1' }, headers: A }); const token = r.data.token;
check('token created', /^amx_[A-Za-z0-9]{40}$/.test(token || ''));
r = await call('limits'); check('limits', r.data.chunk > 0, JSON.stringify(r.data));

// Upload a 20 MB "Mac build" with the token only (no cookie), in pieces.
const saved = cookie; cookie = '';
const T = { authorization: 'Bearer ' + token };
const file = crypto.randomBytes(20 * 1024 * 1024 + 123);
const sha = crypto.createHash('sha256').update(file).digest('hex');
r = await call('upload-start', { body: { name: 'Amethyx-1.7.0-mac-arm64.zip', size: file.length, latest: true }, headers: T });
check('upload-start (token)', r.status === 200, JSON.stringify(r.data));
const { id, chunk } = r.data;
let off = 0, pieces = 0;
while (off < file.length) {
  r = await call('upload-chunk', { query: `&id=${id}&offset=${off}`, raw: file.subarray(off, off + chunk), headers: { ...T, 'content-type': 'application/octet-stream' } });
  if (r.status !== 200) { check('chunk', false, JSON.stringify(r.data)); break; }
  off = r.data.received; pieces++;
}
check('all pieces arrived', off === file.length, `${pieces} pieces`);
r = await call('upload-chunk', { query: `&id=${id}&offset=0`, raw: Buffer.from('x'), headers: T }); check('wrong offset refused', r.status === 409 || r.status === 400);
r = await call('upload-finish', { body: { id, sha256: sha }, headers: T });
check('upload-finish', r.status === 200 && r.data.version.platform === 'mac-arm64' && r.data.version.version === '1.7.0' && r.data.version.sha256 === sha, JSON.stringify(r.data));
const macId = r.data.version?.id;
const got = Buffer.from(await (await fetch(base + 'downloads/Amethyx-1.7.0-mac-arm64.zip')).arrayBuffer());
check('uploaded file is intact', crypto.createHash('sha256').update(got).digest('hex') === sha);
r = await call('token-create', { body: { name: 'x' }, headers: T }); check('token cannot make tokens', r.status === 401);
r = await call('upload-start', { body: { name: 'evil.php', size: 10 }, headers: T }); check('php upload refused', r.status === 400);
r = await call('upload-start', { body: { name: 'Amethyx-1.7.0-mac-arm64.zip', size: 10 }, headers: T }); check('duplicate name refused', r.status === 409);
r = await call('versions', { headers: { authorization: 'Bearer amx_' + 'a'.repeat(40) } }); check('bad token refused', r.status === 401);
{
  // A file left in downloads without a version (a finish that broke off): the same file again is
  // recorded; a different one under that name is refused.
  const fs = await import('node:fs');
  const www = process.env.TEMP + '/rldev/sitetest/www';
  const same = Buffer.from('orphan mac build');
  fs.writeFileSync(www + '/downloads/Amethyx-1.8-linux.AppImage', same);
  const send = async (name, bytes) => {
    const s = await call('upload-start', { body: { name, size: bytes.length }, headers: T });
    if (s.status !== 200) return s;
    await call('upload-chunk', { query: `&id=${s.data.id}&offset=0`, raw: bytes, headers: T });
    return call('upload-finish', { body: { id: s.data.id }, headers: T });
  };
  let f = await send('Amethyx-1.8-linux.AppImage', same);
  check('orphan file recorded by uploading it again', f.status === 200 && f.data.version.version === '1.8', JSON.stringify(f.data));
  fs.writeFileSync(www + '/downloads/Amethyx-1.9-linux.AppImage', Buffer.from('one file'));
  f = await send('Amethyx-1.9-linux.AppImage', Buffer.from('another file'));
  check('different file under an orphan name refused', f.status === 409, JSON.stringify(f.data));
  f = await call('import', { body: {}, headers: T });
  check('import works with a token', f.status === 200 && f.data.added === 1, JSON.stringify(f.data));
}
cookie = saved;

// Version actions and counters.
r = await call('version-update', { body: { id: macId, hidden: true }, headers: A }); check('hide', r.status === 200);
r = await call('site'); check('hidden version not public', !r.data.latest['mac-arm64']);
d = await fetch(base + 'dl.php?id=' + macId, { redirect: 'manual' }); check('hidden version not downloadable', d.status === 404);
r = await call('version-update', { body: { id: macId, latest: true, notes: 'Первая сборка для Mac' }, headers: A }); check('mark latest unhides', r.status === 200);
r = await call('site'); check('mac latest public', r.data.latest['mac-arm64']?.notes === 'Первая сборка для Mac');
for (let i = 0; i < 3; i++) await call('hit', { body: { kind: 'view' } });
await call('hit', { body: { kind: 'video' } });
r = await call('hit', { body: { kind: 'evil' } }); check('unknown hit kind refused', r.status === 400);
await fetch(base + 'dl.php?platform=mac-arm64', { redirect: 'manual' });
// A launcher download in parts: only the part from byte 0 counts; HEAD never does.
await fetch(base + 'dl.php?platform=mac-arm64', { redirect: 'manual', headers: { range: 'bytes=0-999' } });
await fetch(base + 'dl.php?platform=mac-arm64', { redirect: 'manual', headers: { range: 'bytes=1000-1999' } });
await fetch(base + 'dl.php?platform=mac-arm64', { redirect: 'manual', headers: { range: 'bytes=2000-' } });
await fetch(base + 'dl.php?platform=mac-arm64', { redirect: 'manual', method: 'HEAD' });
r = await call('stats'); const today = r.data.days.at(-1);
check('stats today', today.view === 3 && today.video === 1 && today.download === 3, JSON.stringify(today));
r = await call('versions'); check('per-version downloads (parts count once)', r.data.versions.find(v => v.id === macId).downloads === 2);
r = await call('version-delete', { body: { id: macId }, headers: A }); check('delete', r.status === 200);
d = await fetch(base + 'downloads/Amethyx-1.7.0-mac-arm64.zip'); check('file removed', d.status === 404);
{
  const small = Buffer.from('tiny mac build');
  const s = await call('upload-start', { body: { name: 'Amethyx-1.7.1-mac-x64.zip', size: small.length }, headers: A });
  await call('upload-chunk', { query: `&id=${s.data.id}&offset=0`, raw: small, headers: A });
  const f = await call('upload-finish', { body: { id: s.data.id }, headers: A });
  check('new version gets a fresh number', f.data.version.id !== macId && f.data.version.downloads === 0, JSON.stringify({ id: f.data.version.id, macId }));
  const win = Buffer.from('release installer');
  const w = await call('upload-start', { body: { name: 'Amethyx-Setup-1.7.exe', size: win.length, latest: true, notes: 'Релиз' }, headers: A });
  await call('upload-chunk', { query: `&id=${w.data.id}&offset=0`, raw: win, headers: A });
  const wf = await call('upload-finish', { body: { id: w.data.id }, headers: A });
  const rel = await (await fetch(base + 'updates/latest.json')).json();
  const beta = await (await fetch(base + 'updates/beta.json')).json();
  check('release feed follows the upload', rel.version === '1.7' && rel.notes === 'Релиз' && rel.installer.url.endsWith('dl.php?id=' + wf.data.version.id), JSON.stringify(rel));
  // The Windows 7 / 8 build: its own platform and feeds, never in the regular ones.
  const w7 = Buffer.from('win7 installer');
  const s7 = await call('upload-start', { body: { name: 'Amethyx-Setup-1.7-beta.50-win7.exe', size: w7.length, latest: true }, headers: A });
  await call('upload-chunk', { query: `&id=${s7.data.id}&offset=0`, raw: w7, headers: A });
  const f7 = await call('upload-finish', { body: { id: s7.data.id }, headers: A });
  check('win7 file goes to windows-legacy', f7.data.version?.platform === 'windows-legacy' && f7.data.version?.version === '1.7-beta.50', JSON.stringify(f7.data));
  const b7 = await (await fetch(base + 'updates/beta-win7.json')).json();
  check('beta-win7.json has the win7 build', b7.version === '1.7-beta.50' && b7.installer.url.endsWith('dl.php?id=' + f7.data.version.id), JSON.stringify(b7));
  const regular = await (await fetch(base + 'updates/beta.json')).json();
  check('beta.json never gives the win7 build', regular.version !== '1.7-beta.50', JSON.stringify(regular));
  check('no release feed for win7 yet', (await fetch(base + 'updates/latest-win7.json')).status === 404);
  const site7 = await call('site');
  check('site keeps windows and windows-legacy apart', site7.data.latest['windows-legacy']?.version === '1.7-beta.50' && site7.data.latest.windows?.version !== '1.7-beta.50', JSON.stringify(site7.data.latest));
  check('beta feed keeps the newest beta',beta.version === '1.7.0-beta.26' && /^[0-9a-f]{64}$/.test(beta.installer.sha256), JSON.stringify(beta));
}
{
  // Changing the password ends every other session; this one stays.
  const mine = cookie;
  cookie = '';
  r = await call('login', { body: { login: 'boss', password: PASS } }); check('login without the panel header refused', r.status === 403);
  r = await call('login', { body: { login: 'boss', password: PASS }, headers: A }); check('second login', r.status === 200);
  const other = cookie;
  cookie = mine;
  const NEW = PASS + 'x';
  r = await call('password', { body: { old: PASS, new: NEW }, headers: A }); check('password changed', r.status === 200);
  r = await call('versions'); check('this session stays', r.status === 200);
  cookie = other;
  r = await call('versions'); check('the other session ended', r.status === 401);
  cookie = '';
  r = await call('login', { body: { login: 'boss', password: NEW }, headers: A }); check('login with the new password', r.status === 200);
  r = await call('password', { body: { old: NEW, new: PASS }, headers: A }); check('password changed back', r.status === 200);
}
r = await call('password', { body: { old: 'nope', new: 'whatever12345' }, headers: A }); check('password change needs old one', r.status === 401);

r = await call('logout', { body: {}, headers: A }); cookie = '';
r = await call('versions'); check('versions needs login', r.status === 401);
r = await call('login', { body: { login: 'nobody', password: 'wrong' }, headers: A }); check('unknown login looks like a wrong password', r.status === 401 && r.data.error === 'wrong');
for (let i = 0; i < 2; i++) r = await call('login', { body: { login: 'boss', password: 'wrong' + i }, headers: A });
check('wrong password', r.status === 401);
r = await call('versions', { headers: { authorization: 'Bearer amx_' + 'Z'.repeat(40) } }); check('unknown token refused (and counted)', r.status === 401 || r.status === 429); // the earlier bad token counted too
r = await call('login', { body: { login: 'boss', password: PASS }, headers: A }); check('locked after 5 failures', r.status === 429);
// Versions are listed by number, newest first, whatever order they were uploaded in.
{
  const { execFileSync } = await import('node:child_process');
  const php = process.env.AMETHYX_TEST_PHP || process.env.TEMP + '\\rldev\\php74\\php.exe';
  const code = `define('AMX',1); require 'website/lib/amethyx.php';
    $rows = []; foreach (['1.7-alpha','1.7-beta.28','1.7-beta.39','1.7.0-beta.26','1.7-beta.35','1.7','1.6.2','1.10-beta.1'] as $i => $v) $rows[] = ['version'=>$v,'platform'=>'windows','created_at'=>$i,'id'=>$i,'latest'=>0];
    echo implode(' ', array_column(amx_sort_versions($rows), 'version'));`;
  const order = execFileSync(php, ['-r', code], { encoding: 'utf8' }).trim();
  check('versions sorted by number', order === '1.10-beta.1 1.7 1.7-beta.39 1.7-beta.35 1.7-beta.28 1.7.0-beta.26 1.7-alpha 1.6.2', order);
}
console.log('PASS=' + PASS);
process.exitCode = failures ? 1 : 0;
