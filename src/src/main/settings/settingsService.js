'use strict';

const os = require('node:os');
const path = require('node:path');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { SerialQueue } = require('../core/serialQueue');
const { getAppPaths, getDefaultGameDirectory } = require('../core/paths');
const { configureDownloads } = require('../core/downloadConfig');
const { isLightSystem } = require('../core/system');

const MEGABYTE = 1024 * 1024;
const MIN_RAM_MB = 512;
const JAVA_MODES = ['auto', 'custom'];
const JAVA_VENDORS = ['mojang', 'temurin', 'zulu', 'corretto', 'microsoft', 'liberica', 'oracle'];
const VERSION_TYPES = ['release', 'snapshot', 'old_beta', 'old_alpha'];
const AFTER_LAUNCH = ['keep', 'minimize', 'hide'];
const ACCENTS = ['amethyst', 'vanilla', 'berry', 'lavender', 'diamond', 'gold', 'redstone', 'lapis', 'copper'];
// Only Minecraft panoramas: the latest one, one of a given version, or a random one each start.
// Old values (valley, forest, village, dirt) fall back to the latest panorama.
const BACKGROUND = /^panorama(:(random|[0-9][0-9.]{0,15}))?$/;
const FONTS = ['pixel', 'clean'];
const LANGUAGES = ['ru', 'en', 'uk', 'pl', 'de', 'fr', 'es', 'pt', 'zh'];
const SIDEBARS = ['labels', 'hotbar', 'icons'];
const CARD_STYLES = ['tile', 'card', 'slot'];
const CONTENT_SOURCES = ['modrinth', 'curseforge'];
const INSTANCE_VIEWS = ['grid', 'list'];
const UI_SCALES = [80, 90, 100, 110, 125];
const SOUND_FLAGS = ['enabled', 'clicks', 'hover', 'events', 'music'];
const NAV_SOUNDS = ['click', 'xp', 'note'];
/** Updates read, merge and write the file: two at once would lose one of them. */
const writeQueue = new SerialQueue();

function totalMemoryMb() {
  return Math.floor(os.totalmem() / MEGABYTE);
}

/**
 * 40% of physical RAM, rounded to 512 MB and kept between 2 and 8 GB; at least 2 GB stay for the
 * system and the launcher (on a 3 GB computer the game gets 1 GB, never more than there is).
 */
function suggestedRamMb() {
  const suggested = Math.floor((totalMemoryMb() * 0.4) / 512) * 512;
  const room = Math.floor((totalMemoryMb() - 2048) / 512) * 512;
  return Math.max(1024, Math.min(8192, Math.max(2048, suggested), room));
}

function buildDefaults() {
  // Windows 7 / 8 and computers with 4 GB or less start with the heavy effects off
  // (core/system.js); everything can be turned on in Settings.
  const light = isLightSystem();
  return {
    gameDirectory: null,
    ramMb: suggestedRamMb(),
    javaMode: 'auto',
    javaVendor: 'temurin',
    javaPath: '',
    extraJvmArgs: '',
    afterLaunch: 'minimize',
    /** Closing the window keeps the launcher in the system tray (main/tray.js). */
    closeToTray: true,
    showLogOnLaunch: false,
    gameWidth: null,
    gameHeight: null,
    fullscreen: false,
    selectedVersionId: null,
    selectedInstanceId: null,
    versionFilters: { release: true, snapshot: false, old_beta: false, old_alpha: false },
    collapsedGroups: [],
    // Groups made with "Новая группа" (they exist even while empty), in the order shown.
    instanceGroups: [],
    instanceView: 'grid',
    contentSource: 'modrinth',
    curseforgeApiKey: '',
    ui: {
      accent: 'amethyst',
      background: 'panorama',
      // null: the system's language until one is chosen (renderer/js/core/i18n.js).
      language: null,
      font: 'pixel',
      sidebar: 'labels',
      cards: 'tile',
      animations: !light,
      /** Pixel sparks fly from a button when it is pressed. */
      sparks: !light,
      scale: 100,
      blur: !light,
    },
    sounds: {
      enabled: true,
      volume: 60,
      clicks: true,
      hover: false,
      events: true,
      navSound: 'click',
      actions: {},
      music: !light,
      musicVolume: 35,
    },
    downloads: {
      /** Mods and other files downloaded at the same time (updates, modpacks, game files). */
      parallel: light ? 4 : 8,
      /** A big file (8 MB and more) is downloaded in this many parts at once; 1 = in one piece. */
      segments: light ? 2 : 4,
    },
    compat: {
      /** Warn about possible mod conflicts before installing. */
      warn: true,
      /** Warnings the user chose not to see again (keys from checkCompatibility). */
      ignored: [],
    },
    updates: {
      autoCheck: true,
      autoDownload: true,
      /** A downloaded update installs by itself: the launcher closes, updates and opens again. */
      autoInstall: true,
      /** Where the launcher looks for new versions (latest.json); empty = the built-in address. */
      feedUrl: '',
    },
    social: {
      /** CustomSkinLoader in modded instances: Amethyx skins and capes in the game. */
      skinsInMods: true,
      /** Skins, capes and friends through the Amethyx server. */
      online: true,
      /** Friends see which instance and server you play. */
      shareActivity: true,
      /** Address of the Amethyx server; empty = the built-in one. */
      serverUrl: '',
      /** Invites carry the instance (its share code), so a friend builds the same one in a click. */
      inviteWithPack: true,
      /** Mods on neither Modrinth nor CurseForge in an invite: 'always' uploaded, 'never', or 'ask'. */
      inviteUpload: 'always',
      /** A friend's invite, clicked: 'join' builds and joins at once, 'build' only builds the instance. */
      acceptInvite: 'join',
    },
  };
}

function clampInt(value, min, max) {
  return Math.round(Math.min(Math.max(value, min), max));
}

function sanitizeUi(input, defaults) {
  const ui = { ...defaults };
  if (!input || typeof input !== 'object') {
    return ui;
  }
  if (ACCENTS.includes(input.accent)) ui.accent = input.accent;
  if (typeof input.background === 'string' && BACKGROUND.test(input.background)) ui.background = input.background;
  if (FONTS.includes(input.font)) ui.font = input.font;
  if (SIDEBARS.includes(input.sidebar)) ui.sidebar = input.sidebar;
  if (CARD_STYLES.includes(input.cards)) ui.cards = input.cards;
  if (typeof input.animations === 'boolean') ui.animations = input.animations;
  if (typeof input.sparks === 'boolean') ui.sparks = input.sparks;
  if (typeof input.blur === 'boolean') ui.blur = input.blur;
  if (UI_SCALES.includes(input.scale)) ui.scale = input.scale;
  if (LANGUAGES.includes(input.language)) ui.language = input.language;
  return ui;
}

function sanitizeSounds(input, defaults) {
  const sounds = { ...defaults };
  if (!input || typeof input !== 'object') {
    return sounds;
  }
  for (const flag of SOUND_FLAGS) {
    if (typeof input[flag] === 'boolean') sounds[flag] = input[flag];
  }
  if (NAV_SOUNDS.includes(input.navSound)) sounds.navSound = input.navSound;
  // A sound per action: { navigate: 'xp', error: 'villager_no', ... } (names from renderer/js/core/sound.js).
  if (input.actions && typeof input.actions === 'object') {
    sounds.actions = {};
    for (const [action, preset] of Object.entries(input.actions).slice(0, 40)) {
      if (/^[a-zA-Z]{1,24}$/.test(action) && typeof preset === 'string' && /^[a-z_]{1,24}$/.test(preset)) sounds.actions[action] = preset;
    }
  }
  if (Number.isFinite(input.volume)) sounds.volume = clampInt(input.volume, 0, 100);
  if (Number.isFinite(input.musicVolume)) sounds.musicVolume = clampInt(input.musicVolume, 0, 100);
  return sounds;
}

function sanitizeUpdates(input, defaults) {
  const updates = { ...defaults };
  if (!input || typeof input !== 'object') {
    return updates;
  }
  if (typeof input.autoCheck === 'boolean') updates.autoCheck = input.autoCheck;
  if (typeof input.autoDownload === 'boolean') updates.autoDownload = input.autoDownload;
  if (typeof input.autoInstall === 'boolean') updates.autoInstall = input.autoInstall;
  if (typeof input.feedUrl === 'string' && (input.feedUrl === '' || /^https:\/\/\S+$/i.test(input.feedUrl.trim()))) {
    updates.feedUrl = input.feedUrl.trim().slice(0, 500);
  }
  return updates;
}

/** Keeps only known keys with valid types. Anything else in the file is dropped. */
function sanitize(input, defaults) {
  const result = { ...defaults };
  if (typeof input.gameDirectory === 'string' && path.isAbsolute(input.gameDirectory)) {
    result.gameDirectory = path.normalize(input.gameDirectory);
  } else if (input.gameDirectory === null || input.gameDirectory === '') {
    result.gameDirectory = null;
  }
  if (Number.isFinite(input.ramMb)) {
    result.ramMb = Math.round(Math.min(Math.max(input.ramMb, MIN_RAM_MB), Math.max(MIN_RAM_MB, totalMemoryMb())));
  }
  if (JAVA_MODES.includes(input.javaMode)) {
    result.javaMode = input.javaMode;
  }
  if (JAVA_VENDORS.includes(input.javaVendor)) {
    result.javaVendor = input.javaVendor;
  }
  if (typeof input.javaPath === 'string') {
    result.javaPath = input.javaPath.trim().slice(0, 500);
  }
  if (typeof input.extraJvmArgs === 'string') {
    result.extraJvmArgs = input.extraJvmArgs.slice(0, 2000);
  }
  // Earlier builds stored only "hide the launcher: yes/no".
  if (typeof input.hideLauncherOnLaunch === 'boolean' && input.afterLaunch === undefined) {
    result.afterLaunch = input.hideLauncherOnLaunch ? 'minimize' : 'keep';
  }
  if (AFTER_LAUNCH.includes(input.afterLaunch)) {
    result.afterLaunch = input.afterLaunch;
  }
  if (typeof input.showLogOnLaunch === 'boolean') {
    result.showLogOnLaunch = input.showLogOnLaunch;
  }
  if (typeof input.closeToTray === 'boolean') {
    result.closeToTray = input.closeToTray;
  }
  for (const key of ['gameWidth', 'gameHeight']) {
    if (Number.isFinite(input[key]) && input[key] > 0) {
      result[key] = clampInt(input[key], 320, 7680);
    } else if (input[key] === null) {
      result[key] = null;
    }
  }
  if (typeof input.fullscreen === 'boolean') {
    result.fullscreen = input.fullscreen;
  }
  if (typeof input.selectedVersionId === 'string' || input.selectedVersionId === null) {
    result.selectedVersionId = input.selectedVersionId;
  }
  if (typeof input.selectedInstanceId === 'string' || input.selectedInstanceId === null) {
    result.selectedInstanceId = input.selectedInstanceId;
  }
  if (Array.isArray(input.collapsedGroups)) {
    result.collapsedGroups = input.collapsedGroups.filter((group) => typeof group === 'string').slice(0, 100);
  }
  if (Array.isArray(input.instanceGroups)) {
    result.instanceGroups = [...new Set(input.instanceGroups.filter((group) => typeof group === 'string' && group.trim()).map((group) => group.trim().slice(0, 40)))].slice(0, 100);
  }
  if (INSTANCE_VIEWS.includes(input.instanceView)) {
    result.instanceView = input.instanceView;
  }
  if (CONTENT_SOURCES.includes(input.contentSource)) {
    result.contentSource = input.contentSource;
  }
  if (typeof input.curseforgeApiKey === 'string') {
    result.curseforgeApiKey = input.curseforgeApiKey.trim().slice(0, 200);
  }
  result.ui = sanitizeUi(input.ui, defaults.ui);
  result.sounds = sanitizeSounds(input.sounds, defaults.sounds);
  result.updates = sanitizeUpdates(input.updates, defaults.updates);
  result.social = {
    skinsInMods: typeof input.social?.skinsInMods === 'boolean' ? input.social.skinsInMods : defaults.social.skinsInMods,
    online: typeof input.social?.online === 'boolean' ? input.social.online : defaults.social.online,
    shareActivity: typeof input.social?.shareActivity === 'boolean' ? input.social.shareActivity : defaults.social.shareActivity,
    // https only; plain http just for a server on this computer (testing `wrangler dev`).
    serverUrl:
      typeof input.social?.serverUrl === 'string' && /^(https:\/\/\S+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)?$/i.test(input.social.serverUrl.trim())
        ? input.social.serverUrl.trim().replace(/\/+$/, '').slice(0, 300)
        : defaults.social.serverUrl,
    inviteWithPack: typeof input.social?.inviteWithPack === 'boolean' ? input.social.inviteWithPack : defaults.social.inviteWithPack,
    inviteUpload: ['always', 'never', 'ask'].includes(input.social?.inviteUpload) ? input.social.inviteUpload : defaults.social.inviteUpload,
    acceptInvite: ['join', 'build'].includes(input.social?.acceptInvite) ? input.social.acceptInvite : defaults.social.acceptInvite,
  };
  result.downloads = {
    parallel: Number.isFinite(input.downloads?.parallel) ? clampInt(input.downloads.parallel, 1, 32) : defaults.downloads.parallel,
    segments: Number.isFinite(input.downloads?.segments) ? clampInt(input.downloads.segments, 1, 16) : defaults.downloads.segments,
  };
  result.compat = {
    warn: typeof input.compat?.warn === 'boolean' ? input.compat.warn : defaults.compat.warn,
    ignored: Array.isArray(input.compat?.ignored) ? input.compat.ignored.filter((key) => typeof key === 'string').slice(-500) : [],
  };
  if (input.versionFilters && typeof input.versionFilters === 'object') {
    result.versionFilters = { ...defaults.versionFilters };
    for (const type of VERSION_TYPES) {
      if (typeof input.versionFilters[type] === 'boolean') {
        result.versionFilters[type] = input.versionFilters[type];
      }
    }
  }
  return result;
}

/** Settings as stored on disk (gameDirectory may be null, meaning the default folder). */
async function readStoredSettings() {
  const defaults = buildDefaults();
  const stored = await readJsonFile(getAppPaths().settingsFile, {});
  return sanitize(stored && typeof stored === 'object' ? stored : {}, defaults);
}

/** Settings with the effective game directory filled in, ready for the rest of the app. */
async function getSettings() {
  const stored = await readStoredSettings();
  // Every download in the launcher follows the latest "Загрузки" settings.
  configureDownloads(stored.downloads);
  return {
    ...stored,
    gameDirectory: stored.gameDirectory ?? getDefaultGameDirectory(),
    defaultGameDirectory: getDefaultGameDirectory(),
    maxRamMb: totalMemoryMb(),
  };
}

function updateSettings(patch) {
  return writeQueue.run(async () => {
    const current = await readStoredSettings();
    // Nested groups are merged, so the UI can send { sounds: { volume: 40 } } alone.
    const merged = { ...current, ...patch };
    for (const group of ['ui', 'sounds', 'updates', 'compat', 'social', 'downloads']) {
      if (patch[group] && typeof patch[group] === 'object') {
        merged[group] = { ...current[group], ...patch[group] };
      }
    }
    const next = sanitize(merged, buildDefaults());
    await writeJsonFileAtomic(getAppPaths().settingsFile, next);
    return getSettings();
  });
}

function resetSettings() {
  return writeQueue.run(async () => {
    await writeJsonFileAtomic(getAppPaths().settingsFile, buildDefaults());
    return getSettings();
  });
}

module.exports = { getSettings, updateSettings, resetSettings, sanitize, buildDefaults, suggestedRamMb };
