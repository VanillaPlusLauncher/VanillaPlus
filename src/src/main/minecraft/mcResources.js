'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { fetchJson } = require('../core/http');
const { downloadFile } = require('../core/fileDownloader');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { runWithConcurrency } = require('../core/taskPool');
const { createLogger } = require('../core/logger');
const { getAppPaths } = require('../core/paths');
const { broadcast } = require('../core/broadcast');
const { createTaskReporter } = require('../core/progressReporter');
const { openRemoteZip } = require('../core/remoteZip');
const { CHANNELS } = require('../../shared/channels');
const { createGameLayout } = require('./gameLayout');
const { listInstalledVersions } = require('./installedVersions');
const { listRemoteVersions } = require('./versionManifest');

/*
 * The launcher's Minecraft look and sounds come from the game itself, never bundled: block and
 * item textures and the title-screen panorama are read from an official client jar (one the user
 * already installed, or downloaded once from Mojang), sounds from Mojang's asset server.
 * Everything lands in <userData>/mc-ui and is served to the window as app://mc/<path>.
 */

const FORMAT = 6;
const ASSET_BASE_URL = 'https://resources.download.minecraft.net';
const TEXTURE_CONCURRENCY = 16;

const BLOCKS = [
  'grass_block_side', 'grass_block_top', 'dirt', 'stone', 'cobblestone', 'mossy_cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks',
  'cherry_planks', 'bricks', 'bookshelf', 'crafting_table_front', 'crafting_table_top', 'furnace_front', 'tnt_side', 'tnt_top', 'diamond_ore',
  'emerald_ore', 'gold_ore', 'diamond_block', 'emerald_block', 'gold_block', 'iron_block', 'redstone_block', 'lapis_block', 'amethyst_block',
  'copper_block', 'obsidian', 'netherrack', 'end_stone', 'sand', 'oak_log', 'oak_log_top', 'glowstone', 'deepslate', 'moss_block',
  'honeycomb_block', 'pumpkin_side', 'pumpkin_top', 'melon_side', 'melon_top', 'note_block', 'jukebox_side', 'jukebox_top', 'sculk',
  'snow', 'ice', 'clay', 'hay_block_side', 'hay_block_top', 'quartz_block_side', 'purpur_block', 'prismarine_bricks', 'sea_lantern',
  'oak_leaves', 'nether_bricks', 'crying_obsidian', 'ancient_debris_side', 'ancient_debris_top', 'respawn_anchor_top', 'beacon',
];
const ITEMS = [
  'diamond', 'emerald', 'iron_ingot', 'gold_ingot', 'netherite_ingot', 'diamond_pickaxe', 'diamond_sword', 'netherite_sword', 'apple',
  'golden_apple', 'ender_pearl', 'ender_eye', 'nether_star', 'totem_of_undying', 'book', 'enchanted_book', 'writable_book', 'map', 'bow',
  'fishing_rod', 'cake', 'cookie', 'slime_ball', 'redstone', 'blaze_powder', 'heart_of_the_sea', 'experience_bottle', 'firework_rocket',
  'name_tag', 'saddle', 'elytra', 'trident', 'spyglass', 'bucket', 'water_bucket', 'lava_bucket', 'music_disc_cat', 'music_disc_13',
  'music_disc_pigstep', 'amethyst_shard', 'echo_shard', 'compass_16', 'clock_00', 'carrot', 'golden_carrot', 'sweet_berries', 'honey_bottle',
];
const GUI = {
  button: ['gui/sprites/widget/button.png'],
  button_highlighted: ['gui/sprites/widget/button_highlighted.png'],
  button_disabled: ['gui/sprites/widget/button_disabled.png'],
  menu_background: ['gui/menu_background.png', 'gui/options_background.png'],
  menu_list_background: ['gui/menu_list_background.png'],
  header_separator: ['gui/header_separator.png'],
  footer_separator: ['gui/footer_separator.png'],
  logo: ['gui/title/minecraft.png'],
  edition: ['gui/title/edition.png'],
  slot: ['gui/sprites/container/slot.png'],
  hotbar: ['gui/sprites/hud/hotbar.png'],
  hotbar_selection: ['gui/sprites/hud/hotbar_selection.png'],
  toast: ['gui/sprites/toast/advancement.png'],
  heart: ['gui/sprites/hud/heart/full.png'],
  xp_bar_background: ['gui/sprites/hud/experience_bar_background.png'],
  xp_bar_progress: ['gui/sprites/hud/experience_bar_progress.png'],
  checkbox: ['gui/sprites/widget/checkbox.png'],
  checkbox_selected: ['gui/sprites/widget/checkbox_selected.png'],
  slider: ['gui/sprites/widget/slider.png'],
  slider_handle: ['gui/sprites/widget/slider_handle.png'],
};
const DEFAULT_SKINS = {
  steve: ['entity/player/wide/steve.png', 'entity/steve.png'],
  alex: ['entity/player/slim/alex.png', 'entity/alex.png'],
  // The other default characters (1.19.3+), for ready-made skins in the dressing room.
  ari: ['entity/player/wide/ari.png'],
  efe: ['entity/player/slim/efe.png'],
  kai: ['entity/player/wide/kai.png'],
  makena: ['entity/player/slim/makena.png'],
  noor: ['entity/player/slim/noor.png'],
  sunny: ['entity/player/wide/sunny.png'],
  zuri: ['entity/player/wide/zuri.png'],
};
const SOUNDS = {
  click: ['minecraft/sounds/random/click.ogg'],
  levelup: ['minecraft/sounds/random/levelup.ogg'],
  orb: ['minecraft/sounds/random/orb.ogg'],
  pop: ['minecraft/sounds/random/pop.ogg'],
  toast_in: ['minecraft/sounds/ui/toast/in.ogg'],
  toast_out: ['minecraft/sounds/ui/toast/out.ogg'],
  challenge: ['minecraft/sounds/ui/toast/challenge_complete.ogg'],
  villager_no: ['minecraft/sounds/mob/villager/no1.ogg'],
  villager_yes: ['minecraft/sounds/mob/villager/yes1.ogg'],
  villager_idle: ['minecraft/sounds/mob/villager/idle1.ogg'],
  chest_open: ['minecraft/sounds/block/chest/open.ogg'],
  chest_close: ['minecraft/sounds/block/chest/close1.ogg', 'minecraft/sounds/block/chest/close.ogg'],
  page: ['minecraft/sounds/item/book/open_flip1.ogg', 'minecraft/sounds/item/book/page_turn1.ogg'],
  book_close: ['minecraft/sounds/item/book/close_put1.ogg'],
  anvil: ['minecraft/sounds/random/anvil_use.ogg'],
  enchant: ['minecraft/sounds/block/enchantment_table/enchant1.ogg'],
  bell: ['minecraft/sounds/block/bell/bell_use01.ogg', 'minecraft/sounds/block/bell/use01.ogg'],
  amethyst: ['minecraft/sounds/block/amethyst/shimmer.ogg', 'minecraft/sounds/block/amethyst/shimmer1.ogg'],
  wood_click: ['minecraft/sounds/block/wooden_button/click_on.ogg', 'minecraft/sounds/random/wood_click.ogg'],
  door_open: ['minecraft/sounds/block/wooden_door/open1.ogg', 'minecraft/sounds/random/door_open.ogg'],
  door_close: ['minecraft/sounds/block/wooden_door/close1.ogg', 'minecraft/sounds/random/door_close.ogg'],
  portal: ['minecraft/sounds/portal/trigger.ogg'],
  purr: ['minecraft/sounds/mob/cat/purr1.ogg'],
  loom: ['minecraft/sounds/ui/loom/select_pattern1.ogg'],
  cartography: ['minecraft/sounds/ui/cartography_table/drawmap1.ogg'],
  stonecutter: ['minecraft/sounds/ui/stonecutter/cut1.ogg'],
  firework_launch: ['minecraft/sounds/fireworks/launch1.ogg'],
  firework_blast: ['minecraft/sounds/fireworks/blast1.ogg', 'minecraft/sounds/fireworks/largeBlast1.ogg'],
  firework_twinkle: ['minecraft/sounds/fireworks/twinkle1.ogg'],
  totem: ['minecraft/sounds/item/totem/use_totem.ogg'],
  teleport: ['minecraft/sounds/mob/endermen/portal.ogg', 'minecraft/sounds/mob/endermen/portal1.ogg'],
  meow: ['minecraft/sounds/mob/cat/meow1.ogg'],
  beacon: ['minecraft/sounds/block/beacon/activate.ogg'],
  beacon_off: ['minecraft/sounds/block/beacon/deactivate.ogg'],
  shulker_open: ['minecraft/sounds/block/shulker_box/open.ogg'],
  shulker_close: ['minecraft/sounds/block/shulker_box/close.ogg'],
  barrel_open: ['minecraft/sounds/block/barrel/open1.ogg'],
  barrel_close: ['minecraft/sounds/block/barrel/close.ogg'],
  glass: ['minecraft/sounds/random/glass1.ogg'],
  eat: ['minecraft/sounds/random/eat1.ogg'],
  burp: ['minecraft/sounds/random/burp.ogg'],
  bow: ['minecraft/sounds/random/bow.ogg'],
  chicken: ['minecraft/sounds/mob/chicken/say1.ogg'],
  bubble: ['minecraft/sounds/block/bubble_column/bubble1.ogg'],
  lever: ['minecraft/sounds/block/lever/click.ogg', 'minecraft/sounds/random/click.ogg'],
  pressure_plate: ['minecraft/sounds/block/pressure_plate/click_on.ogg', 'minecraft/sounds/random/wood_click.ogg'],
  item_frame: ['minecraft/sounds/entity/itemframe/add_item1.ogg'],
  lodestone: ['minecraft/sounds/block/lodestone/lock1.ogg'],
  smithing: ['minecraft/sounds/block/smithing_table/smithing_table1.ogg'],
  allay: ['minecraft/sounds/mob/allay/item_given1.ogg'],
  axolotl: ['minecraft/sounds/mob/axolotl/idle_air1.ogg'],
  frog: ['minecraft/sounds/mob/frog/idle1.ogg'],
  bee: ['minecraft/sounds/mob/bee/pollinate1.ogg', 'minecraft/sounds/mob/bee/loop1.ogg'],
  sniffer: ['minecraft/sounds/mob/sniffer/happy1.ogg'],
  note_harp: ['minecraft/sounds/note/harp.ogg'],
  note_bass: ['minecraft/sounds/note/bass.ogg'],
  note_bell: ['minecraft/sounds/note/bell.ogg'],
  note_chime: ['minecraft/sounds/note/icechime.ogg', 'minecraft/sounds/note/chime.ogg'],
  note_flute: ['minecraft/sounds/note/flute.ogg'],
  note_guitar: ['minecraft/sounds/note/guitar.ogg'],
  note_hat: ['minecraft/sounds/note/hat.ogg'],
  note_pling: ['minecraft/sounds/note/pling.ogg'],
  note_snare: ['minecraft/sounds/note/snare.ogg'],
  note_basedrum: ['minecraft/sounds/note/bd.ogg', 'minecraft/sounds/note/basedrum.ogg'],
  note_xylophone: ['minecraft/sounds/note/xylobone.ogg', 'minecraft/sounds/note/xylophone.ogg'],
  note_iron_xylophone: ['minecraft/sounds/note/iron_xylophone.ogg'],
  note_bit: ['minecraft/sounds/note/bit.ogg'],
  note_banjo: ['minecraft/sounds/note/banjo.ogg'],
  note_cow_bell: ['minecraft/sounds/note/cow_bell.ogg'],
  note_didgeridoo: ['minecraft/sounds/note/didgeridoo.ogg'],
};
/** C418's title-screen music; older asset indexes named the files menu1..menu4. */
const MUSIC = [
  { key: 'mutation', assets: ['minecraft/sounds/music/menu/mutation.ogg', 'minecraft/sounds/music/menu/menu1.ogg'] },
  { key: 'moog_city_2', assets: ['minecraft/sounds/music/menu/moog_city_2.ogg', 'minecraft/sounds/music/menu/menu2.ogg'] },
  { key: 'beginning_2', assets: ['minecraft/sounds/music/menu/beginning_2.ogg', 'minecraft/sounds/music/menu/menu3.ogg'] },
  { key: 'floating_trees', assets: ['minecraft/sounds/music/menu/floating_trees.ogg', 'minecraft/sounds/music/menu/menu4.ogg'] },
];

const log = createLogger('mc-resources');
let running = null;

function rootDirectory() {
  return path.join(getAppPaths().root, 'mc-ui');
}

function manifestPath() {
  return path.join(rootDirectory(), 'manifest.json');
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** The latest Minecraft release in Mojang's list: the look always follows the newest game. */
async function latestRelease() {
  return (await listRemoteVersions({ force: true })).find((version) => version.type === 'release');
}

/**
 * Where the textures are read from: the jar of the latest release when the user installed it,
 * otherwise the same jar straight on Mojang's server — only the needed files are fetched with
 * range requests (a few hundred kilobytes, not the whole 40 MB jar).
 * Returns { id, descriptor, read(entryPath) -> Buffer | null }.
 */
async function openSource(layout, latest) {
  const installed = await listInstalledVersions(layout);
  if (installed.some((version) => version.id === latest.id)) {
    const descriptor = await readJsonFile(layout.versionJsonPath(latest.id), null);
    const jarPath = layout.clientJarPath(latest.id);
    if (descriptor?.downloads?.client && (await exists(jarPath))) {
      const zip = new AdmZip(jarPath);
      return { id: latest.id, descriptor, read: async (name) => zip.getEntry(name)?.getData() ?? null };
    }
  }
  const descriptor = await fetchJson(latest.url);
  const remote = await openRemoteZip(descriptor.downloads.client.url);
  log.info(`Читаем текстуры интерфейса прямо из клиента ${latest.id} на сервере Mojang`);
  return { id: latest.id, descriptor, read: (name) => remote.read(name) };
}

/** Copies one jar entry into mc-ui. Returns false when the jar has no such file. */
async function extract(source, entryPath, target) {
  const data = await source.read(entryPath);
  if (!data) {
    return false;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data);
  return true;
}

/** Every texture the interface uses, read in parallel. */
async function extractTextures(source) {
  const root = rootDirectory();
  const textures = { blocks: [], items: [], gui: {}, skins: {}, panorama: [] };
  const jobs = [
    ...BLOCKS.map((name) => async () => {
      if (await extract(source, `assets/minecraft/textures/block/${name}.png`, path.join(root, 'block', `${name}.png`))) {
        textures.blocks.push(name);
      }
    }),
    ...ITEMS.map((name) => async () => {
      if (await extract(source, `assets/minecraft/textures/item/${name}.png`, path.join(root, 'item', `${name}.png`))) {
        textures.items.push(name);
      }
    }),
    // The default skins: shown for profiles without their own skin and as the editor's starting point.
    ...Object.entries(DEFAULT_SKINS).map(([key, candidates]) => async () => {
      for (const candidate of candidates) {
        if (await extract(source, `assets/minecraft/textures/${candidate}`, path.join(root, 'skins', `${key}.png`))) {
          textures.skins[key] = `skins/${key}.png`;
          return;
        }
      }
    }),
    ...Object.entries(GUI).map(([key, candidates]) => async () => {
      for (const candidate of candidates) {
        if (await extract(source, `assets/minecraft/textures/${candidate}`, path.join(root, 'gui', `${key}.png`))) {
          textures.gui[key] = `gui/${key}.png`;
          return;
        }
      }
    }),
  ];
  await runWithConcurrency(jobs, TEXTURE_CONCURRENCY, (job) => job());
  textures.blocks.sort((a, b) => BLOCKS.indexOf(a) - BLOCKS.indexOf(b));
  textures.items.sort((a, b) => ITEMS.indexOf(a) - ITEMS.indexOf(b));
  return textures;
}

/**
 * Title-screen panorama. Recent versions keep it in the asset store (the jar has 1x1 placeholders),
 * older ones in the jar: the asset store is tried first.
 */
async function fetchPanorama(layout, index, source) {
  const root = rootDirectory();
  const panorama = [];
  await runWithConcurrency([0, 1, 2, 3, 4, 5], 6, async (face) => {
    const name = `textures/gui/title/background/panorama_${face}.png`;
    const target = path.join(root, 'panorama', `panorama_${face}.png`);
    let ok = false;
    try {
      ok = await fetchAsset(layout, index, `minecraft/${name}`, target);
    } catch (error) {
      log.warn(`Панорама ${face}: ${error.message}`);
    }
    if (!ok) {
      ok = await extract(source, `assets/minecraft/${name}`, target);
    }
    if (ok) {
      panorama[face] = `panorama/panorama_${face}.png`;
    }
  });
  return panorama.filter(Boolean);
}
async function loadAssetIndex(layout, assetIndex) {
  const shared = layout.assetIndexPath(assetIndex.id);
  if (await exists(shared)) {
    return readJsonFile(shared, null);
  }
  const own = path.join(rootDirectory(), 'indexes', `${assetIndex.id}.json`);
  await downloadFile(assetIndex.url, own, { sha1: assetIndex.sha1, size: assetIndex.size });
  return readJsonFile(own, null);
}

/** Copies one asset into mc-ui: from the game's own asset store when present, else from Mojang. */
async function fetchAsset(layout, index, assetName, target) {
  const object = index.objects?.[assetName];
  if (!object) {
    return false;
  }
  if (await exists(target)) {
    return true;
  }
  const local = layout.assetObjectPath(object.hash);
  if (await exists(local)) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(local, target);
    return true;
  }
  await downloadFile(`${ASSET_BASE_URL}/${object.hash.slice(0, 2)}/${object.hash}`, target, { sha1: object.hash, size: object.size });
  return true;
}

async function fetchSounds(layout, index) {
  const sounds = {};
  await runWithConcurrency(Object.entries(SOUNDS), 6, async ([key, candidates]) => {
    for (const candidate of candidates) {
      try {
        if (await fetchAsset(layout, index, candidate, path.join(rootDirectory(), 'sounds', `${key}.ogg`))) {
          sounds[key] = `sounds/${key}.ogg`;
          return;
        }
      } catch (error) {
        log.warn(`Звук ${key} не загружен: ${error.message}`);
      }
    }
  });
  return sounds;
}

async function build(settings, latest, reporter) {
  const layout = createGameLayout(settings.gameDirectory);
  reporter.report('подготовка', 5, latest.id);
  const source = await openSource(layout, latest);
  await fsp.mkdir(rootDirectory(), { recursive: true });
  // Files of an older format (for example 1x1 panorama placeholders) must not count as present.
  await fsp.rm(path.join(rootDirectory(), 'panorama'), { recursive: true, force: true });
  reporter.report('текстуры', 15, latest.id);
  const [textures, index] = await Promise.all([extractTextures(source), loadAssetIndex(layout, source.descriptor.assetIndex)]);
  reporter.report('панорама и звуки', 60, latest.id);
  const [panorama, sounds] = await Promise.all([fetchPanorama(layout, index, source), fetchSounds(layout, index)]);
  textures.panorama = panorama;
  const manifest = {
    format: FORMAT,
    sourceVersion: source.id,
    assetIndex: source.descriptor.assetIndex,
    builtAt: new Date().toISOString(),
    textures,
    sounds,
    soundKeysTried: Object.keys(SOUNDS),
    skinKeysTried: Object.keys(DEFAULT_SKINS),
    music: [],
  };
  await writeJsonFileAtomic(manifestPath(), manifest);
  log.info(`Ресурсы интерфейса из Minecraft ${source.id}: ${textures.blocks.length} блоков, ${Object.keys(sounds).length} звуков`);
  return manifest;
}
/** Copy of the game's look that ships inside the launcher (assets/mc-ui), so nothing is downloaded on first start. */
const BUNDLED_DIRECTORY = path.join(__dirname, '..', '..', '..', 'assets', 'mc-ui');

/** Recursive copy with plain reads and writes: they also work from inside app.asar. */
async function copyDirectory(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else {
      await fsp.writeFile(target, await fsp.readFile(source));
    }
  }
}

/**
 * First start: puts the bundled look in place before the window opens, so the panorama,
 * textures and sounds are there at once. Later starts keep what is on disk (it may be newer).
 */
async function seedBundledMcResources() {
  if (await readManifest()) {
    return;
  }
  try {
    await copyDirectory(BUNDLED_DIRECTORY, rootDirectory());
    log.info('Оформление Minecraft взято из лаунчера');
  } catch (error) {
    // A public build carries no Minecraft files: they are downloaded right after this.
    log.info(`Встроенного оформления нет, оно будет скачано (${error.code ?? error.message})`);
  }
}

async function readManifest() {
  const manifest = await readJsonFile(manifestPath(), null);
  return manifest?.format === FORMAT ? manifest : null;
}

/**
 * Builds mc-ui (in the background) and tells the window when it is ready. Already built resources
 * are rebuilt when Mojang has released a newer Minecraft: the panorama, textures and sounds follow
 * the latest version. Without internet the existing resources are kept.
 */
function ensureMcResources(settings) {
  if (running) {
    return running;
  }
  running = (async () => {
    const existing = await readManifest();
    let latest;
    try {
      latest = await latestRelease();
    } catch (error) {
      if (existing) {
        return existing;
      }
      throw error;
    }
    if (existing && existing.sourceVersion === latest.id) {
      return topUpSkins(settings, await topUpSounds(settings, existing), latest);
    }
    if (existing) {
      log.info(`Вышел Minecraft ${latest.id}: обновляем панораму и текстуры (были из ${existing.sourceVersion})`);
    }
    // Shown in the top bar, so the plain look of the first seconds does not look like a broken launcher.
    const reporter = createTaskReporter({ taskId: 'mc-resources', kind: 'resources', label: 'Загрузка' });
    try {
      const manifest = await build(settings, latest, reporter);
      // Music already downloaded stays; it does not depend on the version.
      if (existing?.music?.length) {
        manifest.music = existing.music;
        await writeJsonFileAtomic(manifestPath(), manifest);
      }
      reporter.finish('done', latest.id);
      broadcast(CHANNELS.events.mcResources, manifest);
      return manifest;
    } catch (error) {
      reporter.finish('error', error.message);
      throw error;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Sounds added to SOUNDS after the resources were built: fetched quietly in the background, so an
 * update of the launcher never brings back the first-start loading screen. Keys that the game does
 * not have are remembered and not looked for again.
 */
async function topUpSounds(settings, manifest) {
  const tried = new Set(manifest.soundKeysTried ?? Object.keys(manifest.sounds ?? {}));
  const missing = Object.entries(SOUNDS).filter(([key]) => !tried.has(key));
  if (!missing.length) {
    return manifest;
  }
  try {
    const layout = createGameLayout(settings.gameDirectory);
    const index = await loadAssetIndex(layout, manifest.assetIndex);
    const sounds = { ...manifest.sounds };
    await runWithConcurrency(missing, 6, async ([key, candidates]) => {
      for (const candidate of candidates) {
        if (await fetchAsset(layout, index, candidate, path.join(rootDirectory(), 'sounds', `${key}.ogg`)).catch(() => false)) {
          sounds[key] = `sounds/${key}.ogg`;
          return;
        }
      }
    });
    const next = { ...manifest, sounds, soundKeysTried: Object.keys(SOUNDS) };
    await writeJsonFileAtomic(manifestPath(), next);
    log.info(`Новые звуки интерфейса: ${Object.keys(sounds).length - Object.keys(manifest.sounds ?? {}).length} из ${missing.length}`);
    broadcast(CHANNELS.events.mcResources, next);
    return next;
  } catch (error) {
    log.warn(`Новые звуки не загружены: ${error.message}`);
    return manifest;
  }
}

/** Default skins added to DEFAULT_SKINS after the resources were built: read quietly, like sounds. */
async function topUpSkins(settings, manifest, latest) {
  const tried = new Set(manifest.skinKeysTried ?? Object.keys(manifest.textures?.skins ?? {}));
  const missing = Object.entries(DEFAULT_SKINS).filter(([key]) => !tried.has(key));
  if (!missing.length) {
    return manifest;
  }
  try {
    const source = await openSource(createGameLayout(settings.gameDirectory), latest);
    const skins = { ...manifest.textures.skins };
    await runWithConcurrency(missing, 4, async ([key, candidates]) => {
      for (const candidate of candidates) {
        if (await extract(source, `assets/minecraft/textures/${candidate}`, path.join(rootDirectory(), 'skins', `${key}.png`)).catch(() => false)) {
          skins[key] = `skins/${key}.png`;
          return;
        }
      }
    });
    const next = { ...manifest, textures: { ...manifest.textures, skins }, skinKeysTried: Object.keys(DEFAULT_SKINS) };
    await writeJsonFileAtomic(manifestPath(), next);
    log.info(`Стандартные скины: ${Object.keys(skins).length}`);
    broadcast(CHANNELS.events.mcResources, next);
    return next;
  } catch (error) {
    log.warn(`Стандартные скины не загружены: ${error.message}`);
    return manifest;
  }
}

/** Menu music (C418), downloaded only when the user turns music on. Returns the manifest. */
async function ensureMusic(settings) {
  const manifest = (await readManifest()) ?? (await ensureMcResources(settings));
  if (manifest.music.length === MUSIC.length) {
    return manifest;
  }
  // The launcher ships the menu music: copy it from there first, download only what is missing.
  const bundled = [];
  for (const track of MUSIC) {
    const target = path.join(rootDirectory(), 'music', `${track.key}.ogg`);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, await fsp.readFile(path.join(BUNDLED_DIRECTORY, 'music', `${track.key}.ogg`)));
      bundled.push(`music/${track.key}.ogg`);
    } catch {
      // Not in the bundle: downloaded below.
    }
  }
  if (bundled.length === MUSIC.length) {
    const next = { ...manifest, music: bundled };
    await writeJsonFileAtomic(manifestPath(), next);
    broadcast(CHANNELS.events.mcResources, next);
    return next;
  }
  const layout = createGameLayout(settings.gameDirectory);
  const index = await loadAssetIndex(layout, manifest.assetIndex);
  const music = [];
  for (const track of MUSIC) {
    for (const asset of track.assets) {
      try {
        if (await fetchAsset(layout, index, asset, path.join(rootDirectory(), 'music', `${track.key}.ogg`))) {
          music.push(`music/${track.key}.ogg`);
          break;
        }
      } catch (error) {
        log.warn(`Музыка ${track.key} не загружена: ${error.message}`);
      }
    }
  }
  const next = { ...manifest, music };
  await writeJsonFileAtomic(manifestPath(), next);
  broadcast(CHANNELS.events.mcResources, next);
  return next;
}

module.exports = { ensureMcResources, ensureMusic, readManifest, rootDirectory, seedBundledMcResources };
