// Read-only check of the live site (public URLs only). dl.php is asked with HEAD, which doesn't count.
const base = 'https://launcher.x-world.plus/';
const res = async (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
const line = (name, ok, extra = '') => console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${extra}`);

let r = await res('');
line('main page', r.status === 200);
const script = await (await res('script.js')).text();
line('new code on the server', script.includes('versionText') ? true : false);
const dlSrc = await res('dl.php', { method: 'HEAD' });
const site = await (await res('api.php?a=site')).json();
const win = site.latest.windows;
line('site: latest Windows', win?.version === '1.7-beta.28', `${win?.version} (id ${win?.id})`);
line('site: all visible versions', true, site.versions.map((v) => `${v.version}/${v.platform}`).join(', '));
line('site: macOS builds', true, JSON.stringify({ arm: site.latest['mac-arm64']?.version ?? null, x64: site.latest['mac-x64']?.version ?? null }));

for (const name of ['beta', 'latest']) {
  r = await res(`updates/${name}.json`);
  if (r.status !== 200) { line(`updates/${name}.json`, name === 'latest' && r.status === 404, `status ${r.status}${name === 'latest' ? ' (no release yet: the launcher then asks GitHub)' : ''}`); continue; }
  const feed = await r.json();
  line(`updates/${name}.json`, /^https:\/\//.test(feed.installer.url) && /^[0-9a-f]{64}$/.test(feed.installer.sha256), `${feed.version} ${feed.installer.url} size ${feed.installer.size}`);
  line(`  Cache-Control`, /no-cache/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control') || 'none');
  line(`  sha256 = beta.28 build`, feed.installer.sha256 === '818826447d552e54c364f7bacd0fad96bc7d2e453202f2783ec02842d5adbafe' && feed.installer.size === 160118860);
  const hop = await fetch(feed.installer.url, { method: 'HEAD', redirect: 'manual' });
  const loc = hop.headers.get('location');
  line(`  installer link redirects`, hop.status === 302 && !!loc, loc);
  if (loc) {
    const file = await fetch(new URL(loc, feed.installer.url), { method: 'HEAD' });
    line(`  installer file`, file.status === 200 && Number(file.headers.get('content-length')) === feed.installer.size, `${file.status} ${file.headers.get('content-length')} bytes`);
    const part = await fetch(new URL(loc, feed.installer.url), { headers: { range: 'bytes=100-199' } });
    line(`  Range (download in parts)`, part.status === 206, `${part.status} ${part.headers.get('content-range')}`);
    await part.arrayBuffer();
  }
}
r = await res('dl.php?platform=windows', { method: 'HEAD' });
line('Download button (dl.php)', r.status === 302, r.headers.get('location'));
for (const p of ['lib/amethyx.php', 'data/', 'downloads/']) { r = await res(p); line(`closed: ${p}`, r.status === 403 || r.status === 404, String(r.status)); }
r = await res('api.php?a=versions'); line('admin API needs login', r.status === 401);
void dlSrc;
