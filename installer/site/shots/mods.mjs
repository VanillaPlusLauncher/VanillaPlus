// Downloads real Fabric mods for one Minecraft version from Modrinth into a test instance's mods
// folder (for the site screenshots). Usage: node mods.mjs <modsDir> <mcVersion> [max]
import fs from 'node:fs';
import path from 'node:path';

const [dir, mc, maxArg] = process.argv.slice(2);
const max = Number(maxArg) || 24;
const SLUGS = [
  'fabric-api', 'sodium', 'lithium', 'iris', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modmenu',
  'cloth-config', 'architectury-api', 'fabric-language-kotlin', 'dynamic-fps', 'badoptimizations',
  'entitytexturefeatures', 'entity-model-features', 'yacl', 'appleskin', 'jade', 'xaeros-minimap',
  'continuity', 'zoomify', 'sodium-extra', 'mouse-tweaks', 'krypton', 'modernfix', 'debugify', 'puzzle',
];
const headers = { 'User-Agent': 'amethyx-launcher-test/1.0' };
fs.mkdirSync(dir, { recursive: true });
let count = 0;
for (const slug of SLUGS) {
  if (count >= max) break;
  const url = `https://api.modrinth.com/v2/project/${slug}/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) { console.log(`${slug}: ${response.status}`); continue; }
    const versions = await response.json();
    const version = versions[0];
    if (!version) { console.log(`${slug}: no ${mc} version`); continue; }
    const file = version.files.find((f) => f.primary) ?? version.files[0];
    const target = path.join(dir, file.filename);
    if (!fs.existsSync(target)) {
      const body = await fetch(file.url, { headers });
      fs.writeFileSync(target, Buffer.from(await body.arrayBuffer()));
    }
    count += 1;
    console.log(`${slug}: ${file.filename}`);
  } catch (error) {
    console.log(`${slug}: ${error.message}`);
  }
}
console.log(`done: ${count} mods`);
