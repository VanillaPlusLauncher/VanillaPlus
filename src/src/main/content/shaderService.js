'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../core/logger');
const instanceService = require('../minecraft/instanceService');
const contentService = require('./contentService');
const modrinth = require('./modrinth');
const { systemInfo } = require('./optimizer');

/*
 * Shader optimization: shaders switched on and set up for this computer in one window.
 *  - The shader loader the pack needs: Iris (Fabric, Quilt, NeoForge; it brings Sodium) or Oculus
 *    (Forge; with Embeddium). OptiFine and Canvas cannot run beside them.
 *  - The shader pack: chosen automatically — the heaviest one this computer can carry at the
 *    chosen level ("Скорость", "Баланс", "Красота"), and one that draws Distant Horizons' far terrain
 *    when that mod is in the pack — or picked by hand among the known packs and those already there.
 *  - The level also sets how far shadows are drawn, the setting that costs shaders the most.
 * Choices are kept in the instance (overrides.shaders) and written to Iris' / Oculus' own settings
 * file, so the game starts with them.
 */

/** Known shader packs on Modrinth, from light to heavy (weight: rough cost, 1 = barely any). */
const PACKS = [
  { projectId: 'izsIPI7a', slug: 'makeup-ultra-fast-shaders', title: 'MakeUp Ultra Fast', weight: 1, dh: false, about: 'Самые лёгкие: мягкий свет и тени почти без потери FPS' },
  { projectId: 'UaS8ROxa', slug: 'miniature-shader', title: 'Miniature', weight: 1.5, dh: false, about: 'Лёгкие и уютные: вода, небо и свет без тяжёлых теней' },
  // Of two equally heavy packs the later one is picked: Complementary is the better all-rounder.
  { projectId: 'LMIZZNxZ', slug: 'super-duper-vanilla', title: 'Super Duper Vanilla', weight: 2.5, dh: false, about: 'Ванильный стиль с яркими красками' },
  { projectId: 'HVnmMxH1', slug: 'complementary-reimagined', title: 'Complementary Reimagined', weight: 2.5, dh: true, about: 'Как ванильный Minecraft, только красивее; хорошо настраиваются' },
  { projectId: 'Q1vvjJYV', slug: 'bsl-shaders', title: 'BSL', weight: 3, dh: false, about: 'Классика: тёплый свет, объёмные облака' },
  { projectId: 'R6NEzAwj', slug: 'complementary-unbound', title: 'Complementary Unbound', weight: 3.5, dh: true, about: 'Самые красивые из Complementary: отражения, туман, облака' },
  { projectId: 'EpQFjzrQ', slug: 'solas-shader', title: 'Solas', weight: 4, dh: false, about: 'Сказочное небо и свет; нужна сильная видеокарта' },
  { projectId: 'lLqFfGNs', slug: 'photon-shader', title: 'Photon', weight: 4, dh: true, about: 'Реалистичный свет и облака; нужна сильная видеокарта' },
  { projectId: 'ZvMtQlho', slug: 'bliss-shader', title: 'Bliss', weight: 4.5, dh: true, about: 'Кинематографичный свет; самая тяжёлая' },
];
const LEVELS = ['speed', 'balance', 'beauty'];
/** How heavy a pack this computer carries at "Баланс"; "Скорость" one step lighter, "Красота" one step heavier. */
const BUDGET = { low: 1.5, mid: 2.5, high: 4 };
const LEVEL_SHIFT = { speed: -1, balance: 0, beauty: 1 };
/** Shadow distance in chunks: what costs shaders the most. */
const SHADOW_DISTANCE = { speed: 8, balance: 16, beauty: 32 };
const ENGINES = {
  iris: { projectId: 'YL57xq9U', title: 'Iris', config: 'iris.properties' },
  oculus: { projectId: 'GchcoXML', title: 'Oculus', config: 'oculus.properties' },
};
const BLOCKERS = [
  { match: /optifine|optifabric/i, title: 'OptiFine' },
  { match: /canvas-?renderer|\bcanvas\b/i, title: 'Canvas' },
];
const log = createLogger('shaders');

const text = (item) => `${item.file} ${item.title} ${item.modId ?? ''}`;

/** Iris and Oculus keep "key=value" lines; the ones given are set, everything else stays. */
async function readProperties(file) {
  const lines = (await fsp.readFile(file, 'utf8').catch(() => '')).split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const match = /^\s*([^#=\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return { lines, values };
}

async function writeProperties(file, patch) {
  const { lines } = await readProperties(file);
  const left = new Map(Object.entries(patch));
  const next = lines.filter((line, index) => line || index < lines.length - 1).map((line) => {
    const match = /^\s*([^#=\s][^=]*?)\s*=/.exec(line);
    if (match && left.has(match[1])) {
      const value = left.get(match[1]);
      left.delete(match[1]);
      return `${match[1]}=${value}`;
    }
    return line;
  });
  for (const [key, value] of left) next.push(`${key}=${value}`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${next.join('\n')}\n`, 'utf8');
}

/** Iris for Fabric, Quilt and NeoForge, Oculus for Forge; null for Vanilla. */
function engineFor(loader) {
  if (loader === 'forge') return 'oculus';
  if (['fabric', 'quilt', 'neoforge'].includes(loader)) return 'iris';
  return null;
}

async function engineAvailable(engine, instance) {
  const query = (loader) => modrinth.getVersions(ENGINES[engine].projectId, { gameVersion: instance.minecraft, loader, type: 'mod' }).catch(() => []);
  let versions = await query(instance.loader.type);
  if (!versions.length && instance.loader.type === 'quilt') versions = await query('fabric');
  return versions.length > 0;
}

/** The pack for a level: the heaviest that fits the computer's budget (one for Distant Horizons when it is there). */
function pick(packs, tier, level, distantHorizons) {
  const budget = Math.max(1, BUDGET[tier] + LEVEL_SHIFT[level]);
  const usable = packs.filter((pack) => pack.available && (!distantHorizons || pack.dh));
  const fitting = usable.filter((pack) => pack.weight <= budget);
  const chosen = fitting.length ? fitting[fitting.length - 1] : usable[0];
  // No pack for Distant Horizons for this version: the usual choice (far terrain stays without shaders).
  return chosen ?? (distantHorizons ? pick(packs, tier, level, false) : null);
}

/** Everything the window shows; nothing is changed. */
async function plan(settings, instanceId) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const [system, mods, installedShaders] = await Promise.all([
    systemInfo(),
    contentService.listContent(settings, instanceId, 'mod'),
    contentService.listContent(settings, instanceId, 'shader'),
  ]);
  const enabled = mods.filter((item) => item.enabled);
  const find = (pattern) => enabled.find((item) => pattern.test(text(item))) ?? null;
  const engine = engineFor(instance.loader.type);
  const engineMod = find(/\biris\b|iris-|oculus/i);
  const blockers = BLOCKERS.map((blocker) => (find(blocker.match) ? blocker.title : null)).filter(Boolean);
  const distantHorizons = Boolean(find(/distant.?horizons/i));

  const [available, briefs, versions] = await Promise.all([
    engine && !engineMod ? engineAvailable(engine, instance) : Promise.resolve(Boolean(engineMod)),
    modrinth.getProjectsBrief(PACKS.map((pack) => pack.projectId)).catch(() => []),
    Promise.all(PACKS.map((pack) => modrinth.getVersions(pack.projectId, { gameVersion: instance.minecraft, type: 'shader' }).catch(() => []))),
  ]);
  const icons = new Map(briefs.map((brief) => [brief.id, brief.iconUrl]));
  const packs = PACKS.map((pack, index) => {
    const installed = installedShaders.find((item) => item.projectId === pack.projectId) ?? null;
    return { ...pack, iconUrl: icons.get(pack.projectId) ?? null, available: versions[index].length > 0 || Boolean(installed), installed: Boolean(installed), file: installed?.file ?? null };
  });
  const known = new Set(packs.map((pack) => pack.file).filter(Boolean));
  const ownPacks = installedShaders.filter((item) => !known.has(item.file)).map((item) => ({ file: item.file, title: item.title, iconUrl: item.icon ?? null, enabled: item.enabled }));

  const configFile = engine ? path.join(instance.directory, 'config', ENGINES[engine].config) : null;
  const current = configFile ? (await readProperties(configFile)).values : {};
  const recommended = Object.fromEntries(LEVELS.map((level) => [level, pick(packs, system.tier, level, distantHorizons)?.projectId ?? null]));
  const saved = instance.overrides?.shaders && typeof instance.overrides.shaders === 'object' ? instance.overrides.shaders : null;
  return {
    loader: instance.loader.type,
    minecraft: instance.minecraft,
    system: { tier: system.tier, gpu: system.gpu?.name ?? null, integrated: Boolean(system.gpu?.integrated) },
    engine: engine ? { id: engine, title: ENGINES[engine].title, installed: Boolean(engineMod), available } : null,
    blockers,
    distantHorizons,
    packs,
    ownPacks,
    current: { enabled: current.enableShaders === 'true', pack: current.shaderPack ?? null },
    recommended,
    // Not set up here before: the window opens ready to switch shaders on (that is what it is opened for).
    saved: saved ?? { enabled: true, auto: true, level: 'balance', pack: null },
  };
}

/**
 * Applies the window's choices: { enabled, auto, level, pack } — `pack` a known pack's projectId or
 * "file:<name>" of one already in shaderpacks. Installs the shader loader and the pack when they
 * are missing. Resolves with { summary: [lines], failed: [lines] }.
 */
async function apply(settings, instanceId, choices = {}) {
  const level = LEVELS.includes(choices.level) ? choices.level : 'balance';
  const auto = choices.auto !== false;
  const enabled = choices.enabled !== false;
  const current = await plan(settings, instanceId);
  const instance = await instanceService.getInstance(settings, instanceId);
  const summary = [];
  const failed = [];
  if (!current.engine) throw new Error('Шейдерам нужен загрузчик модов: поставьте Fabric в «Настройки» → «Версия».');
  const configFile = path.join(instance.directory, 'config', ENGINES[current.engine.id].config);
  const choice = { enabled, auto, level, pack: auto ? null : String(choices.pack ?? '') || null };

  if (!enabled) {
    await writeProperties(configFile, { enableShaders: 'false' });
    await instanceService.updateInstance(settings, instanceId, { overrides: { shaders: choice } });
    return { summary: ['Шейдеры выключены'], failed };
  }
  if (current.blockers.length) throw new Error(`${current.blockers.join(' и ')} не работает вместе с ${current.engine.title}: выключите в модах или в «Оптимизации».`);

  if (!current.engine.installed) {
    if (!current.engine.available) throw new Error(`${current.engine.title} пока нет для Minecraft ${current.minecraft}.`);
    await contentService.installProject(settings, { instanceId, platform: 'modrinth', projectId: ENGINES[current.engine.id].projectId, type: 'mod', title: current.engine.title });
    summary.push(`Поставлен ${current.engine.title}`);
  }

  let file = null;
  let title = null;
  const wanted = auto ? current.recommended[level] : choice.pack;
  if (wanted?.startsWith('file:')) {
    file = wanted.slice(5);
    title = current.ownPacks.find((pack) => pack.file === file)?.title ?? file;
  } else {
    const pack = current.packs.find((candidate) => candidate.projectId === wanted);
    if (!pack) throw new Error('Шейдер не выбран.');
    title = pack.title;
    if (!pack.installed) {
      await contentService.installProject(settings, { instanceId, platform: 'modrinth', projectId: pack.projectId, type: 'shader', title: pack.title, iconUrl: pack.iconUrl });
      summary.push(`Скачан шейдер ${pack.title}`);
    }
    const items = await contentService.listContent(settings, instanceId, 'shader');
    file = items.find((item) => item.projectId === pack.projectId)?.file ?? null;
    if (!file) failed.push(`${pack.title}: файл не найден в shaderpacks`);
  }
  if (file) {
    await writeProperties(configFile, { shaderPack: file, enableShaders: 'true', maxShadowRenderDistance: String(SHADOW_DISTANCE[level]) });
    summary.push(`Включён ${title}, тени до ${SHADOW_DISTANCE[level]} чанков`);
  }
  await instanceService.updateInstance(settings, instanceId, { overrides: { shaders: choice } });
  log.info(`Шейдеры «${instance.name}»: ${summary.join('; ')}${failed.length ? `; ошибки: ${failed.join('; ')}` : ''}`);
  return { summary, failed };
}

module.exports = { plan, apply, PACKS };
