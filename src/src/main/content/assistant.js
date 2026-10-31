'use strict';

const os = require('node:os');
const { createLogger } = require('../core/logger');
const instanceService = require('../minecraft/instanceService');
const contentService = require('./contentService');
const modrinth = require('./modrinth');
const { packContext, rangeCovers } = require('./optimizer');
const { CATALOG, PROBLEMS } = require('./optimizerCatalog');

/*
 * "Умный помощник": the grass block on the builds pages. No AI and nothing to pay for — it answers
 * from what the launcher can check itself:
 *  - check(): what in the pack keeps the game from starting or makes it crash — the same mod twice,
 *    mods for another loader or game version, mods their authors say do not work together, required
 *    mods that are missing or switched off, and the optimizer's known conflicts. Each problem comes
 *    with the fixes the window can apply (turn files off or on, install a mod).
 *  - suggest(): mods worth adding — speed mods and handy ones that fit the version and loader and
 *    are not there yet, or the most downloaded mods on a topic ("магия", "техника"…) from Modrinth.
 * Updates are contentService.checkUpdates.
 */

const log = createLogger('assistant');

/** Compares game versions numerically: -1, 0 or 1 (1.20.1 < 1.21 < 26.1). */
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) < (pb[index] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** "1.21.1" → "1.21": versions of one family usually share mods. */
const family = (version) => String(version).split('.').slice(0, 2).join('.');

const LOADER_NAMES = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', 'forge-legacy': 'старый Forge' };

/** Which jars a loader runs: the descriptors from modMetadata.js it reads. */
function acceptedLoaders(instance, mods) {
  const minecraft = instance.minecraft;
  switch (instance.loader.type) {
    case 'fabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return compareVersions(minecraft, '1.13') < 0 ? ['forge-legacy'] : ['forge'];
    case 'neoforge': {
      // NeoForge read mods.toml until 1.20.5; Sinytra Connector runs Fabric mods on it.
      const accepted = compareVersions(minecraft, '1.20.5') < 0 ? ['neoforge', 'forge'] : ['neoforge'];
      if (mods.some((item) => item.enabled && item.modId === 'connector')) accepted.push('fabric');
      return accepted;
    }
    default:
      return null;
  }
}

/**
 * Which copy of a mod stays: the newest version; of equal ones the copy the launcher knows (from
 * Modrinth or CurseForge: its icon, page and updates), then the newest file.
 */
function keepFirst(a, b) {
  return compareVersions(b.version ?? '', a.version ?? '') || Number(Boolean(b.platform)) - Number(Boolean(a.platform)) || String(b.modifiedAt).localeCompare(String(a.modifiedAt));
}

const norm = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function listNames(names, limit = 4) {
  const shown = names.slice(0, limit).map((name) => `«${name}»`).join(', ');
  return names.length > limit ? `${shown} и ещё ${names.length - limit}` : shown;
}

const disable = (label, items) => ({ label, action: 'disable', files: items.map((item) => item.file) });

/**
 * Problems found in the files alone (no internet needed): { problems, kept } — `kept` is the pack
 * without the extra copies of a mod, so the other checks see each mod once.
 */
function offlineProblems(instance, mods) {
  const problems = [];

  if (instance.loader.type === 'vanilla') {
    const count = mods.filter((item) => item.enabled).length;
    if (count) {
      problems.push({
        id: 'vanilla',
        level: 'warn',
        title: 'Моды без загрузчика не работают',
        text: `В сборке ${count} модов, но она без загрузчика (ванилла) — игра их просто не видит. Поставь Fabric или NeoForge в «Настройки» → «Версия».`,
        names: [],
        fixes: [],
      });
    }
    return { problems, kept: [] };
  }

  // The same mod more than once: the game refuses to start ("duplicate mods").
  const byId = new Map();
  for (const item of mods.filter((candidate) => candidate.enabled && candidate.modId)) {
    const key = item.modId.toLowerCase();
    byId.set(key, [...(byId.get(key) ?? []), item]);
  }
  const extras = new Set();
  const repeated = [];
  for (const copies of byId.values()) {
    if (copies.length < 2) continue;
    const [keep, ...rest] = [...copies].sort(keepFirst);
    repeated.push({ title: keep.title, times: copies.length });
    rest.forEach((item) => extras.add(item));
  }
  if (extras.size) {
    const one = repeated.length === 1 ? repeated[0] : null;
    problems.push({
      id: 'duplicates',
      level: 'error',
      title: one ? `«${one.title}» стоит ${one.times === 2 ? 'два раза' : `${one.times} раза`}` : `Одни и те же моды стоят по несколько раз (${repeated.length})`,
      text: `${one ? 'Несколько файлов одного мода' : `Несколько файлов одного мода: ${listNames(repeated.map((entry) => entry.title))}`} — с таким игра не запустится. Оставлю самые новые, лишние копии выключу.`,
      names: repeated.map((entry) => entry.title),
      fixes: [disable(extras.size === 1 ? 'Выключить копию' : `Выключить копии (${extras.size})`, [...extras])],
    });
  }
  const kept = mods.filter((item) => !extras.has(item));
  const enabled = kept.filter((item) => item.enabled);

  // Mods made for another loader.
  const accepted = acceptedLoaders(instance, kept);
  if (accepted) {
    const foreign = enabled.filter((item) => item.loaders?.length && !item.loaders.some((loader) => accepted.includes(loader)));
    if (foreign.length) {
      const kinds = [...new Set(foreign.flatMap((item) => item.loaders))].map((loader) => LOADER_NAMES[loader] ?? loader);
      problems.push({
        id: 'loader',
        level: 'error',
        title: foreign.length === 1 ? `«${foreign[0].title}» — не для ${LOADER_NAMES[instance.loader.type]}` : `Моды не для ${LOADER_NAMES[instance.loader.type]} (${foreign.length})`,
        text: `Сборка на ${LOADER_NAMES[instance.loader.type]}, а ${foreign.length === 1 ? 'этот мод сделан' : `${listNames(foreign.map((item) => item.title))} сделаны`} для ${kinds.join(', ')}. Игра с ${foreign.length === 1 ? 'ним' : 'ними'} не запустится — лучше выключить и найти версию для своего загрузчика.`,
        names: foreign.map((item) => item.title),
        fixes: [disable(foreign.length === 1 ? 'Выключить' : `Выключить (${foreign.length})`, foreign)],
      });
    }
  }

  // What the mods' own files say they cannot run with (for every version of the other mod).
  const context = packContext(instance, kept, { tier: 'mid', cores: os.cpus().length, gpu: null });
  const seen = new Set();
  for (const rule of context.declared) {
    if (!rangeCovers(rule.versionRange)) continue;
    const other = enabled.find((item) => item.modId === rule.modId && item !== rule.by);
    if (!other) continue;
    const key = [rule.by.file, other.file].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push({
      id: `declared:${key}`,
      level: 'error',
      title: `«${rule.by.title}» и «${other.title}» не работают вместе`,
      text: `Так написано в самом «${rule.by.title}»${rule.reason ? `: ${rule.reason}` : ''}. Нужно оставить один из них.`,
      names: [rule.by.title, other.title],
      fixes: [disable(`Выключить «${other.title}»`, [other]), disable(`Выключить «${rule.by.title}»`, [rule.by])],
    });
  }

  // The optimizer's known conflicts: two render engines, OptiFine, C2ME in a big pack…
  for (const problem of PROBLEMS) {
    const found = problem.test(context);
    const items = Array.isArray(found) ? found : found ? [found] : [];
    if (!items.length) continue;
    problems.push({
      id: `pack:${problem.id}`,
      level: 'warn',
      title: problem.title,
      text: `${problem.text.replace(/\s*[^.!]*\?$/, '')} Выключу ${listNames(items.map((item) => item.title))}.`,
      names: items.map((item) => item.title),
      fixes: [disable('Исправить', items)],
    });
  }
  return { problems, kept };
}

/** Problems Modrinth knows about: the versions behind the files and what they need. */
async function onlineProblems(instance, mods) {
  const problems = [];
  const enabled = mods.filter((item) => item.enabled);
  const fromModrinth = enabled.filter((item) => item.platform === 'modrinth' && item.versionId);
  if (!fromModrinth.length || instance.loader.type === 'vanilla') return problems;
  const versions = await modrinth.getVersionsByIds(fromModrinth.map((item) => item.versionId));
  const itemOfVersion = new Map(fromModrinth.map((item) => [item.versionId, item]));
  const enabledByProject = new Map(enabled.filter((item) => item.projectId).map((item) => [item.projectId, item]));
  const disabledByProject = new Map(mods.filter((item) => !item.enabled && item.projectId).map((item) => [item.projectId, item]));

  // Made for another game version (another family: a 1.20 mod in 1.21.1, not 1.21 in 1.21.1).
  const otherVersion = versions
    .filter((version) => version.gameVersions.length && !version.gameVersions.some((game) => game === instance.minecraft || family(game) === family(instance.minecraft)))
    .map((version) => ({ item: itemOfVersion.get(version.id), games: version.gameVersions }))
    .filter((entry) => entry.item);
  if (otherVersion.length) {
    const games = [...new Set(otherVersion.flatMap((entry) => entry.games.slice(-1)))].sort(compareVersions);
    problems.push({
      id: 'game-version',
      level: 'warn',
      title: otherVersion.length === 1 ? `«${otherVersion[0].item.title}» — для другой версии игры` : `Моды для другой версии игры (${otherVersion.length})`,
      text: `Сборка на ${instance.minecraft}, а ${otherVersion.length === 1 ? 'этот мод сделан' : `${listNames(otherVersion.map((entry) => entry.item.title))} сделаны`} для ${games.slice(-3).join(', ')}. Скорее всего, игра с ${otherVersion.length === 1 ? 'ним' : 'ними'} вылетит.`,
      names: otherVersion.map((entry) => entry.item.title),
      fixes: [disable(otherVersion.length === 1 ? 'Выключить' : `Выключить (${otherVersion.length})`, otherVersion.map((entry) => entry.item))],
    });
  }

  // Incompatibilities the authors listed on Modrinth.
  const pairs = new Set();
  for (const version of versions) {
    const item = itemOfVersion.get(version.id);
    for (const dependency of version.dependencies) {
      const other = dependency.type === 'incompatible' && enabledByProject.get(dependency.projectId);
      if (!item || !other || other === item) continue;
      const key = [item.projectId, other.projectId].sort().join('|');
      if (pairs.has(key)) continue;
      pairs.add(key);
      problems.push({
        id: `pair:${key}`,
        level: 'error',
        title: `«${item.title}» и «${other.title}» не работают вместе`,
        text: `Так указали авторы «${item.title}» на Modrinth. Нужно оставить один из них.`,
        names: [item.title, other.title],
        fixes: [disable(`Выключить «${other.title}»`, [other]), disable(`Выключить «${item.title}»`, [item])],
      });
    }
  }

  // Required mods: switched off, or not there at all.
  const needs = new Map();
  for (const version of versions) {
    const item = itemOfVersion.get(version.id);
    for (const dependency of version.dependencies) {
      if (!item || dependency.type !== 'required' || !dependency.projectId || enabledByProject.has(dependency.projectId)) continue;
      needs.set(dependency.projectId, [...(needs.get(dependency.projectId) ?? []), item.title]);
    }
  }
  const switchedOff = [...needs.keys()].filter((projectId) => disabledByProject.has(projectId));
  for (const projectId of switchedOff) {
    const off = disabledByProject.get(projectId);
    problems.push({
      id: `off:${projectId}`,
      level: 'error',
      title: `«${off.title}» выключен, а он нужен`,
      text: `Без него не запустятся ${listNames(needs.get(projectId))}.`,
      names: [off.title],
      fixes: [{ label: `Включить «${off.title}»`, action: 'enable', files: [off.file] }],
    });
  }
  const missingIds = [...needs.keys()].filter((projectId) => !disabledByProject.has(projectId));
  if (missingIds.length) {
    // A mod added as a file has no project: it is recognised by its id or name ("architectury" for
    // "architectury-api"), so nothing already there is offered again.
    const present = mods.flatMap((item) => [norm(item.modId), norm(item.title)]).filter((name) => name.length >= 4);
    const projects = await modrinth.getProjectsBrief(missingIds);
    for (const project of projects) {
      const slug = norm(project.slug);
      const title = norm(project.title);
      if (present.some((name) => name === slug || name === title || slug.startsWith(name))) continue;
      problems.push({
        id: `missing:${project.id}`,
        level: 'error',
        title: `Не хватает «${project.title}»`,
        text: `Он нужен для ${listNames(needs.get(project.id) ?? [])}: без него игра не запустится.`,
        names: [project.title],
        fixes: [{ label: `Поставить «${project.title}»`, action: 'install', project: { platform: 'modrinth', projectId: project.id, title: project.title, iconUrl: project.iconUrl } }],
      });
    }
  }
  return problems;
}

/**
 * Everything that keeps the pack from starting or makes it crash:
 * { modCount, problems: [{ id, level, title, text, names, fixes: [{ label, action, files | project }] }], offline }.
 */
async function check(settings, instanceId) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const mods = await contentService.listContent(settings, instanceId, 'mod');
  const { problems, kept } = offlineProblems(instance, mods);
  let offline = false;
  try {
    problems.push(...(await onlineProblems(instance, kept)));
  } catch (error) {
    offline = true;
    log.warn(`Помощник: Modrinth не ответил: ${error.message}`);
  }
  // Errors first: what keeps the game from starting matters most.
  problems.sort((a, b) => Number(a.level !== 'error') - Number(b.level !== 'error'));
  return { modCount: mods.filter((item) => item.enabled).length, problems, offline };
}

// --- Suggestions ------------------------------------------------------------------------------

/** Handy mods most packs want; one per role, the first that exists for the version wins. */
const HANDY = [
  { slug: 'jei', role: 'recipes', match: /\bjei\b|just.?enough.?items|\bemi\b|roughly.?enough|\brei\b/i, why: 'Рецепты всех предметов: что из чего крафтится и где используется' },
  { slug: 'emi', role: 'recipes', match: /\bemi\b/i, why: 'Рецепты всех предметов: что из чего крафтится и где используется' },
  { slug: 'jade', role: 'look', match: /\bjade\b|wthit|hwyla|the.?one.?probe/i, why: 'Подсказка сверху экрана: что за блок или моб перед тобой и из какого он мода' },
  { slug: 'appleskin', role: 'food', match: /appleskin/i, why: 'Видно, сколько сытости даёт еда' },
  { slug: 'mouse-tweaks', role: 'inventory', match: /mouse.?tweaks|mouse.?wheelie|inventory.?profiles/i, why: 'Удобнее перекладывать предметы мышкой' },
  { slug: 'xaeros-minimap', role: 'map', match: /xaero|journeymap|ftb.?chunks|voxelmap|map.?atlases/i, why: 'Миникарта в углу экрана' },
  { slug: 'journeymap', role: 'map', match: /journeymap/i, why: 'Миникарта и большая карта мира' },
  { slug: 'controlling', role: 'keys', match: /controlling/i, why: 'Поиск в управлении: удобно, когда модов много' },
  { slug: 'modmenu', role: 'menu', loaders: ['fabric', 'quilt'], match: /mod.?menu/i, why: 'Список модов и их настройки прямо из меню игры' },
];

/** Topics for "посоветуй моды на …": a Modrinth category, or a search for a few kinds. */
const TOPICS = {
  magic: { title: 'Магия', category: 'magic' },
  tech: { title: 'Техника', category: 'technology' },
  decor: { title: 'Декор и стройка', category: 'decoration' },
  mobs: { title: 'Мобы', category: 'mobs' },
  adventure: { title: 'Приключения', category: 'adventure' },
  worldgen: { title: 'Новые биомы и миры', category: 'worldgen' },
  storage: { title: 'Хранение', category: 'storage' },
  food: { title: 'Еда и фермы', category: 'food' },
  transport: { title: 'Транспорт', category: 'transportation' },
  equipment: { title: 'Оружие и броня', category: 'equipment' },
  map: { title: 'Карты', query: 'map' },
  utility: { title: 'Полезные мелочи', category: 'utility' },
  speed: { title: 'Скорость', category: 'optimization' },
};

/** The newest version of a project for the instance (Quilt runs Fabric builds too), or null. */
async function availableVersion(projectId, instance) {
  const query = (loader) => modrinth.getVersions(projectId, { gameVersion: instance.minecraft, loader, type: 'mod' }).catch(() => []);
  let versions = await query(instance.loader.type);
  if (!versions.length && instance.loader.type === 'quilt') versions = await query('fabric');
  return versions[0] ?? null;
}

function installedTest(mods) {
  const projectIds = new Set(mods.map((item) => item.projectId).filter(Boolean));
  const names = new Set(mods.flatMap((item) => [norm(item.modId), norm(item.title)]).filter((name) => name.length >= 3));
  const texts = mods.map((item) => `${item.file} ${item.title}`);
  return {
    project: (project) => projectIds.has(project.id) || names.has(norm(project.slug)) || names.has(norm(project.title)),
    matches: (pattern) => texts.some((text) => pattern.test(text)),
  };
}

const toItem = (project, why) => ({ platform: 'modrinth', projectId: project.id, slug: project.slug, title: project.title, iconUrl: project.iconUrl ?? null, why });

/** Speed mods from the optimizer's list: safe ones only, one per job, not there yet. */
async function speedMods(instance, mods, installed) {
  const context = packContext(instance, mods, { tier: 'mid', cores: os.cpus().length, gpu: null });
  const entries = CATALOG.filter((entry) => entry.kind === 'core' && entry.loaders.includes(instance.loader.type));
  const taken = new Set(entries.filter((entry) => installed.matches(entry.match)).map((entry) => entry.role));
  const wanted = [];
  for (const entry of entries) {
    if (taken.has(entry.role) || context.blockedBy(entry.modId) || entry.avoid?.(context)) continue;
    wanted.push(entry);
  }
  const projects = await modrinth.getProjectsBrief(wanted.map((entry) => entry.slug));
  const bySlug = new Map(projects.map((project) => [project.slug, project]));
  const checked = await Promise.all(
    wanted.map(async (entry) => {
      const project = bySlug.get(entry.slug);
      if (!project || installed.project(project)) return null;
      return (await availableVersion(project.id, instance)) ? { entry, project } : null;
    }),
  );
  // The first mod offered for a job takes it (Sodium before Embeddium on NeoForge).
  const result = [];
  for (const found of checked) {
    if (!found || taken.has(found.entry.role)) continue;
    taken.add(found.entry.role);
    result.push(toItem(found.project, found.entry.why));
  }
  return result;
}

async function handyMods(instance, mods, installed) {
  const entries = HANDY.filter((entry) => !entry.loaders || entry.loaders.includes(instance.loader.type));
  const taken = new Set(entries.filter((entry) => installed.matches(entry.match)).map((entry) => entry.role));
  const wanted = entries.filter((entry) => !taken.has(entry.role) && (entry.role !== 'keys' || mods.length >= 20));
  const projects = await modrinth.getProjectsBrief(wanted.map((entry) => entry.slug));
  const bySlug = new Map(projects.map((project) => [project.slug, project]));
  const checked = await Promise.all(
    wanted.map(async (entry) => {
      const project = bySlug.get(entry.slug);
      if (!project || installed.project(project)) return null;
      return (await availableVersion(project.id, instance)) ? { entry, project } : null;
    }),
  );
  const result = [];
  for (const found of checked) {
    if (!found || taken.has(found.entry.role)) continue;
    taken.add(found.entry.role);
    result.push(toItem(found.project, found.entry.why));
  }
  return result;
}

/** The most downloaded mods on a topic that fit the instance and are not there yet. */
async function topicMods(instance, topic, installed) {
  const loader = instance.loader.type === 'quilt' ? 'fabric' : instance.loader.type;
  const { hits } = await modrinth.search({ type: 'mod', query: topic.query ?? '', gameVersion: instance.minecraft, loader, category: topic.category ?? null, sort: 'downloads', limit: 30 });
  return hits
    .filter((hit) => !hit.categories.includes('library') && !installed.project({ id: hit.id, slug: hit.slug, title: hit.title }))
    .slice(0, 6)
    .map((hit) => toItem({ id: hit.id, slug: hit.slug, title: hit.title, iconUrl: hit.iconUrl }, hit.description));
}

/**
 * Mods worth adding: { loader, groups: [{ key, title, items: [{ platform, projectId, slug, title, iconUrl, why }] }] }.
 * With a topic (a key of TOPICS) only that topic's most downloaded mods.
 */
async function suggest(settings, instanceId, topicKey = null) {
  const instance = await instanceService.getInstance(settings, instanceId);
  if (instance.loader.type === 'vanilla') {
    return { loader: 'vanilla', groups: [] };
  }
  const mods = await contentService.listContent(settings, instanceId, 'mod');
  const installed = installedTest(mods);
  const topic = TOPICS[topicKey] ?? null;
  if (topic && topicKey !== 'speed') {
    return { loader: instance.loader.type, groups: [{ key: topicKey, title: topic.title, items: await topicMods(instance, topic, installed) }] };
  }
  if (topicKey === 'speed') {
    return { loader: instance.loader.type, groups: [{ key: 'speed', title: 'Для скорости', items: await speedMods(instance, mods, installed) }] };
  }
  const [speed, handy] = await Promise.all([speedMods(instance, mods, installed), handyMods(instance, mods, installed)]);
  return {
    loader: instance.loader.type,
    groups: [
      { key: 'speed', title: 'Для скорости', items: speed },
      { key: 'handy', title: 'Для удобства', items: handy },
    ],
  };
}

module.exports = { check, suggest, TOPICS };
