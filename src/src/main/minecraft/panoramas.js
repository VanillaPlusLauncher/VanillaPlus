'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { nativeImage } = require('electron');
const { request, fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { createLogger } = require('../core/logger');
const { getRemoteVersionEntry } = require('./versionManifest');
const { rootDirectory } = require('./mcResources');

/*
 * Title-screen panoramas of many Minecraft versions, for the launcher's background. Each one is
 * fetched from Mojang only when it is wanted: recent versions keep the six faces in the asset store,
 * old ones inside the client jar, where only those six files are read (HTTP range requests on the
 * zip's directory), never the whole jar. Files go to mc-ui/panoramas/<id>/ and are served as app://mc.
 *
 * The list was made by comparing panorama_0.png of every release since 1.7.10 (October 2026): a
 * version is listed where the picture changed. Names describe what the panorama shows.
 */
const PANORAMAS = [
  { id: '26.3', label: 'Осенний лес', version: '26.3' },
  { id: '26.2', label: 'Пещера у подземного озера', version: '26.2' },
  { id: '26.1', label: 'Вишнёвая роща днём', version: '26.1' },
  { id: '1.21.11', label: 'Ночной океан', version: '1.21.11' },
  { id: '1.21.9', label: 'Медный голем в деревне', version: '1.21.9' },
  { id: '1.21.6', label: 'Счастливый гаст над холмами', version: '1.21.6' },
  { id: '1.21.5', label: 'Пустыня на закате', version: '1.21.5' },
  { id: '1.21.4', label: 'Бледный сад', version: '1.21.4' },
  { id: '1.21', label: 'Испытательные залы', version: '1.21' },
  { id: '1.20', label: 'Вишнёвая роща на закате', version: '1.20' },
  { id: '1.19', label: 'Мангровое болото', version: '1.19' },
  { id: '1.18', label: 'Горы на закате', version: '1.18' },
  { id: '1.17', label: 'Аметистовая жеода', version: '1.17' },
  { id: '1.16', label: 'Багровый лес Незера', version: '1.16' },
  { id: '1.15', label: 'Пчёлы на лугу', version: '1.15' },
  { id: '1.14', label: 'Деревня на равнине', version: '1.14' },
  { id: '1.13', label: 'Под водой', version: '1.13' },
  { id: '1.11', label: 'Классика: скалы у реки', version: '1.11' },
  { id: '1.7.10', label: 'Самая первая панорама', version: '1.7.10' },
];
const FACES = [0, 1, 2, 3, 4, 5];
const THUMB_SIZE = 320;
const log = createLogger('panoramas');

/** At most `limit` previews download at once. */
function createPool(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active += 1;
    const { work, resolve, reject } = waiting.shift();
    work()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return {
    run(work) {
      return new Promise((resolve, reject) => {
        waiting.push({ work, resolve, reject });
        next();
      });
    },
  };
}
const previews = createPool(4);

function folderOf(id) {
  return path.join(rootDirectory(), 'panoramas', id);
}

const exists = (file) => fsp.access(file).then(() => true, () => false);
const relative = (id, name) => `panoramas/${id}/${name}`;

function entryOf(id) {
  const entry = PANORAMAS.find((item) => item.id === id);
  if (!entry) throw new Error('Неизвестная панорама.');
  return entry;
}

/** The six faces from the version's asset index, or null when the version keeps them in the jar. */
async function assetFaces(versionJson) {
  const index = await fetchJson(versionJson.assetIndex.url);
  const objects = FACES.map((face) => index.objects?.[`minecraft/textures/gui/title/background/panorama_${face}.png`]);
  // Recent jars have 1x1 placeholders and the real pictures in the asset store.
  return objects.every((object) => object && object.size > 200) ? objects : null;
}

async function range(url, from, to) {
  const response = await request(url, { headers: { Range: `bytes=${from}-${to}` } });
  return Buffer.from(await response.arrayBuffer());
}

/** Reads some files out of a remote zip without downloading it: { name: Buffer }. */
async function remoteZipEntries(url, wanted) {
  // The end of the file in one request ("the last N bytes"), then the directory, then the wanted
  // files all at once. Local headers are read with a margin, so each file costs one request.
  const tailResponse = await request(url, { headers: { Range: 'bytes=-65557' } });
  const tail = Buffer.from(await tailResponse.arrayBuffer());
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Не удалось прочитать файл игры.');
  const directory = await range(url, tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 16) + tail.readUInt32LE(end + 12) - 1);
  const found = [];
  for (let at = 0; at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50; ) {
    const nameLength = directory.readUInt16LE(at + 28);
    const skip = nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
    const key = wanted.find((candidate) => name.endsWith(candidate));
    if (key) {
      found.push({ key, method: directory.readUInt16LE(at + 10), packed: directory.readUInt32LE(at + 20), offset: directory.readUInt32LE(at + 42), nameLength });
    }
    at += 46 + skip;
  }
  const result = {};
  await Promise.all(
    found.map(async ({ key, method, packed, offset, nameLength }) => {
      // Header (30 bytes) + name + an extra field, which in jars is short or empty.
      const chunk = await range(url, offset, offset + 30 + nameLength + 1024 + packed - 1);
      const start = 30 + chunk.readUInt16LE(26) + chunk.readUInt16LE(28);
      const data = start + packed <= chunk.length ? chunk.subarray(start, start + packed) : await range(url, offset + start, offset + start + packed - 1);
      result[key] = method === 8 ? zlib.inflateRawSync(data) : data;
    }),
  );
  return result;
}
/**
 * Where each listed panorama lives, worked out once from Mojang's version files (October 2026):
 * { faces: [[sha1, size] × 6] } in the asset store, or { jar } for old versions. Saves fetching the
 * version JSON and its large asset index for every picture.
 */
const SOURCES = require('./panoramaSources.json');

/** Where a version's faces are: the table above, else asked from Mojang (versions added later). */
async function sourceOf(entry) {
  if (SOURCES[entry.id]) return SOURCES[entry.id];
  const version = await fetchJson((await getRemoteVersionEntry(entry.version)).url);
  const objects = await assetFaces(version);
  return objects ? { faces: objects.map((object) => [object.hash, object.size]) } : { jar: version.downloads.client.url };
}

/** Downloads the wanted faces of one panorama (all six, or just the first for the preview), in parallel. */
async function fetchFaces(id, faces) {
  const entry = entryOf(id);
  const folder = folderOf(id);
  const missing = [];
  for (const face of faces) {
    if (!(await exists(path.join(folder, `panorama_${face}.png`)))) missing.push(face);
  }
  if (!missing.length) return;
  const source = await sourceOf(entry);
  await fsp.mkdir(folder, { recursive: true });
  if (source.faces) {
    await Promise.all(
      missing.map((face) => {
        const [hash, size] = source.faces[face];
        return downloadFile(`https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`, path.join(folder, `panorama_${face}.png`), { sha1: hash, size });
      }),
    );
  } else {
    const names = missing.map((face) => `textures/gui/title/background/panorama_${face}.png`);
    const files = await remoteZipEntries(source.jar, names);
    for (const face of missing) {
      const data = files[`textures/gui/title/background/panorama_${face}.png`];
      if (!data) throw new Error(`В Minecraft ${entry.version} нет панорамы.`);
      await fsp.writeFile(path.join(folder, `panorama_${face}.png`), data);
    }
  }
  log.info(`Панорама ${id}: ${missing.length} стор.`);
}

/** One download per panorama at a time: a preview and the background asking at once share it. */
const inflight = new Map();
function once(key, work) {
  if (!inflight.has(key)) inflight.set(key, work().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

/**
 * A small preview of the first face. Previews go through a queue of their own, a few at a time,
 * so the background chosen meanwhile never waits behind them.
 */
async function thumbnail(id) {
  const target = path.join(folderOf(id), 'thumb.png');
  if (!(await exists(target))) {
    await once(`thumb:${id}`, () =>
      previews.run(async () => {
        await once(`faces:${id}:0`, () => fetchFaces(id, [0]));
        const image = nativeImage.createFromPath(path.join(folderOf(id), 'panorama_0.png'));
        await fsp.writeFile(target, image.resize({ width: THUMB_SIZE, height: THUMB_SIZE, quality: 'good' }).toPNG());
      }),
    );
  }
  return relative(id, 'thumb.png');
}

/** The six faces of a panorama (downloaded when needed, before any preview), as app://mc paths. */
async function faces(id) {
  await once(`faces:${id}`, () => fetchFaces(id, FACES));
  return FACES.map((face) => relative(id, `panorama_${face}.png`));
}

function listPanoramas() {
  return PANORAMAS.map(({ id, label, version }) => ({ id, label, version }));
}

module.exports = { listPanoramas, thumbnail, faces };
