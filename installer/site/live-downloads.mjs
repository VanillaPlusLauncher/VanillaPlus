// Every version's download link on the live site: dl.php (HEAD, not counted) -> file (HEAD).
const base = 'https://launcher.x-world.plus/';
const site = await (await fetch(base + 'api.php?a=site&nc=' + Date.now())).json();
for (const v of site.versions) {
  const hop = await fetch(base + v.url, { method: 'HEAD', redirect: 'manual' });
  const loc = hop.headers.get('location');
  let file = '-';
  if (loc) { const f = await fetch(new URL(loc, base + v.url), { method: 'HEAD' }); file = `${f.status} ${f.headers.get('content-length')} ${f.headers.get('content-type')}`; }
  console.log(`${v.id} ${v.version} ${v.platform} size=${v.size} -> ${hop.status} ${loc} -> ${file}`);
}
