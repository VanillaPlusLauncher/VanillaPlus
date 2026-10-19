'use strict';

/*
 * What the optimizer knows about performance mods. Gathered from the mods' own pages, their issue
 * trackers and the community lists (TheUsefulLists, Fabulously Optimized); checked against Modrinth
 * in October 2026. Whether a mod exists for a given Minecraft version and loader is never assumed:
 * the optimizer asks Modrinth each time.
 *
 * kind:  'core'         — safe, ticked by default when it fits;
 *        'extra'        — helps on some computers or packs, ticked only where `tickIf` says so;
 *        'experimental' — real gains but known risks, never ticked by itself, the risk is shown.
 * role:  two mods with the same role do the same job; only one is offered or kept.
 * modId: the id inside the jar: mods of the pack that declare it incompatible (neoforge.mods.toml,
 *        fabric.mod.json "breaks") keep it from being offered, see optimizer.js.
 * match: how an installed copy is recognised when it did not come from Modrinth (file or mod name).
 * avoid(context): a reason not to offer it at all in this pack, or null.
 */

// Mods whose world generation is known to clash with C2ME's parallel generation (thread-safety
// crashes, worlds stuck at 97%), or that reshape terrain enough to make it a gamble.
const WORLDGEN_RISK = /dynamic.?trees|chisels.?(and|&).?bits|terrablender|biomes.?o.?plenty|oh.?the.?biomes|byg|regions.?unexplored|twilight.?forest|aether|blue.?skies|alex.?s.?caves|tectonic|lithostitched|distant.?horizons/i;

const CATALOG = [
  // Rendering: the biggest win, one engine only.
  {
    slug: 'sodium',
    modId: 'sodium',
    role: 'render',
    kind: 'core',
    loaders: ['fabric', 'quilt', 'neoforge'],
    match: /^sodium(?!.?extra|.?dynamic|.?options|.?shadowy)|sodium-fabric|sodium-neoforge/i,
    why: 'Новый движок отрисовки: обычно в 2–3 раза больше FPS и меньше подтормаживаний',
  },
  {
    slug: 'embeddium',
    modId: 'embeddium',
    role: 'render',
    kind: 'core',
    loaders: ['forge', 'neoforge'],
    match: /embeddium(?!.?plus|.?extra)/i,
    why: 'Sodium для Forge: быстрее отрисовка, хорошо дружит с модами',
  },
  // Game logic, memory, loading.
  {
    slug: 'lithium',
    modId: 'lithium',
    role: 'logic',
    kind: 'core',
    loaders: ['fabric', 'quilt', 'neoforge'],
    match: /^lithium/i,
    why: 'Ускоряет мобов, физику, редстоун и тики мира, ничего не меняя в игре',
  },
  {
    slug: 'radium',
    modId: 'radium',
    role: 'logic',
    kind: 'core',
    loaders: ['forge', 'neoforge'],
    match: /^radium/i,
    why: 'Lithium для Forge: быстрее мобы, физика и тики мира',
  },
  {
    slug: 'canary',
    modId: 'canary',
    role: 'logic',
    kind: 'core',
    loaders: ['forge'],
    match: /^canary/i,
    why: 'Lithium для старого Forge: быстрее мобы, физика и тики мира',
    avoid: (context) => (context.has(/apotheosis/i) ? 'конфликтует с Apotheosis' : null),
  },
  {
    slug: 'ferrite-core',
    modId: 'ferritecore',
    role: 'memory',
    kind: 'core',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge'],
    match: /ferrite.?core/i,
    why: 'Игра занимает заметно меньше памяти, особенно в больших сборках',
  },
  {
    slug: 'modernfix',
    modId: 'modernfix',
    role: 'loading',
    kind: 'core',
    loaders: ['fabric', 'forge', 'neoforge'],
    match: /modernfix/i,
    why: 'Быстрее запуск и вход в мир, меньше памяти, исправления утечек',
  },
  {
    slug: 'immediatelyfast',
    modId: 'immediatelyfast',
    role: 'ui',
    kind: 'core',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge'],
    match: /immediately.?fast/i,
    why: 'Быстрее отрисовка интерфейса, текста, карт и частиц',
  },
  {
    slug: 'entityculling',
    modId: 'entityculling',
    role: 'entity-culling',
    kind: 'core',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge'],
    match: /entity.?culling/i,
    why: 'Не рисует мобов, сундуки и таблички, которых не видно за стенами',
  },
  {
    slug: 'dynamic-fps',
    modId: 'dynamic_fps',
    role: 'background',
    kind: 'core',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge'],
    match: /dynamic.?fps/i,
    why: 'Когда игра свёрнута или в фоне, почти не нагружает компьютер',
  },
  {
    slug: 'badoptimizations',
    modId: 'badoptimizations',
    role: 'micro',
    kind: 'extra',
    loaders: ['fabric', 'forge', 'neoforge'],
    match: /badoptimizations/i,
    why: 'Мелкие ускорения отрисовки: освещение, небо, частицы, карты',
    tickIf: (context) => context.tier !== 'high',
  },
  {
    slug: 'moreculling',
    modId: 'moreculling',
    role: 'block-culling',
    kind: 'extra',
    loaders: ['fabric', 'quilt', 'neoforge'],
    match: /more.?culling/i,
    why: 'Не рисует невидимые грани листвы и блоков: плюс FPS в лесах',
    tickIf: (context) => context.tier !== 'high',
  },
  {
    slug: 'scalablelux',
    modId: 'scalablelux',
    role: 'light',
    kind: 'extra',
    loaders: ['fabric', 'neoforge'],
    match: /scalable.?lux|starlight/i,
    why: 'Быстрее просчёт света: меньше рывков при загрузке и генерации мира',
    tickIf: (context) => context.cores >= 6,
    // Sable (the physics of Create Aeronautics) refuses to start with it; its authors won't fix that.
    avoid: (context) => (context.has(/^sable|aeronautics/i) ? 'не работает с Sable и Create Aeronautics' : null),
  },
  {
    slug: 'particle-core',
    modId: 'particle_core',
    role: 'particles',
    kind: 'extra',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge'],
    match: /particle.?core/i,
    why: 'Не рисует частицы за спиной и вдали: меньше просадок у взрывов и ферм',
    tickIf: (context) => context.tier === 'low',
  },
  {
    slug: 'memoryleakfix',
    modId: 'memoryleakfix',
    role: 'leaks',
    kind: 'extra',
    loaders: ['fabric', 'quilt', 'forge'],
    match: /memory.?leak.?fix/i,
    why: 'Исправляет утечки памяти в старых версиях игры',
    tickIf: (context) => context.modCount >= 60,
  },
  {
    slug: 'indium',
    modId: 'indium',
    role: 'frapi',
    kind: 'extra',
    loaders: ['fabric', 'quilt'],
    match: /^indium/i,
    why: 'Нужен Sodium 0.5, чтобы правильно рисовались блоки некоторых модов',
    // Offered only together with Sodium 0.5 (newer Sodium has this built in): see optimizer.js.
    onlyWithOldSodium: true,
  },
  // Risky: big gains, known problems.
  {
    slug: 'nvidium',
    modId: 'nvidium',
    role: 'nvidium',
    kind: 'experimental',
    loaders: ['fabric', 'quilt'],
    match: /nvidium/i,
    why: 'Отрисовка через mesh-шейдеры NVIDIA: огромная дальность прорисовки почти без потери FPS',
    risk: 'Бывают вылеты; с шейдерами Iris сам отключается',
    avoid: (context) => (context.gpu?.meshShaders ? null : 'нужна видеокарта NVIDIA GTX 16xx или RTX'),
  },
  {
    slug: 'c2me-fabric',
    modId: 'c2me',
    role: 'worldgen',
    kind: 'experimental',
    loaders: ['fabric', 'quilt'],
    match: /c2me|concurrent.?chunk/i,
    why: 'Генерация и загрузка чанков на всех ядрах: мир прогружается в разы быстрее',
    risk: 'В больших сборках и с модами на генерацию мира бывают вылеты и зависания при входе в мир',
    avoid: c2meRisk,
  },
  {
    slug: 'c2me-neoforge',
    modId: 'c2me',
    role: 'worldgen',
    kind: 'experimental',
    loaders: ['neoforge'],
    match: /c2me|concurrent.?chunk/i,
    why: 'Генерация и загрузка чанков на всех ядрах: мир прогружается в разы быстрее',
    risk: 'В больших сборках и с модами на генерацию мира бывают вылеты и зависания при входе в мир',
    avoid: c2meRisk,
  },
  {
    slug: 'noisium',
    modId: 'noisium',
    role: 'noise',
    kind: 'experimental',
    loaders: ['fabric', 'quilt', 'forge', 'neoforge'],
    match: /noisium/i,
    why: 'Быстрее генерация рельефа, мир получается точно таким же',
    risk: 'Полезен только в одиночной игре на новых чанках',
    avoid: (context) => (context.has(WORLDGEN_RISK) ? 'в сборке есть моды, меняющие генерацию мира' : null),
  },
];

function c2meRisk(context) {
  if (context.modCount > 60) return `в сборке ${context.modCount} модов: в больших сборках C2ME часто ломает генерацию`;
  if (context.has(WORLDGEN_RISK)) return 'в сборке есть моды на генерацию мира, с ними C2ME бывает несовместим';
  return null;
}

/*
 * Things in a pack that cost performance or stability: conflicts, two mods doing one job, mods
 * that are useless on this version. Each one can be fixed by turning mods off (files get
 * ".disabled"), which the undo button turns back on.
 */
const PROBLEMS = [
  {
    id: 'optifine',
    test: (context) => context.find(/optifine|optifabric/i),
    title: 'OptiFine',
    text: 'OptiFine несовместим с Sodium и Iris и заметно медленнее их. Выключить его и поставить Sodium?',
  },
  {
    id: 'two-render-engines',
    test: (context) => {
      const engines = context.findAll(/^sodium(?!.?extra|.?dynamic|.?options|.?shadowy)|sodium-fabric|sodium-neoforge|embeddium(?!.?plus|.?extra)|rubidium|magnesium/i);
      if (engines.length < 2) return [];
      // Keep the engine that belongs to the loader: Sodium on Fabric/NeoForge, Embeddium on Forge.
      const keep = context.loader === 'forge' ? /embeddium/i : /sodium/i;
      const keeper = engines.find((item) => keep.test(`${item.file} ${item.title}`)) ?? engines[0];
      return engines.filter((item) => item !== keeper);
    },
    title: 'Два движка отрисовки',
    text: 'Sodium, Embeddium, Rubidium и Magnesium делают одно и то же и мешают друг другу. Оставить один?',
  },
  {
    id: 'two-logic-mods',
    test: (context) => {
      const mods = context.findAll(/^lithium|^radium|^canary/i);
      if (mods.length < 2) return [];
      const keeper = mods.find((item) => /lithium/i.test(`${item.file} ${item.title}`)) ?? mods[0];
      return mods.filter((item) => item !== keeper);
    },
    title: 'Lithium и его копии',
    text: 'Radium и Canary — копии Lithium. Вместе они конфликтуют. Оставить один?',
  },
  {
    id: 'c2me-big-pack',
    test: (context) => (c2meRisk(context) ? context.findAll(/c2me|concurrent.?chunk/i) : []),
    title: 'C2ME в большой сборке',
    text: 'C2ME ускоряет генерацию, но в больших сборках и с модами на генерацию мира из-за него бывают вылеты и зависания при входе в мир. Выключить?',
  },
  {
    id: 'two-light-engines',
    test: (context) => {
      const mods = context.findAll(/starlight|scalable.?lux|phosphor/i);
      if (mods.length < 2) return [];
      const keeper = mods.find((item) => /scalable.?lux/i.test(`${item.file} ${item.title}`)) ?? mods[0];
      return mods.filter((item) => item !== keeper);
    },
    title: 'Два движка освещения',
    text: 'Starlight, ScalableLux и Phosphor переписывают одно и то же освещение. Оставить один?',
  },
  {
    id: 'fastload-ksyxis',
    test: (context) => (context.find(/ksyxis/i) ? context.findAll(/fastload/i) : []),
    title: 'Fastload и Ksyxis',
    text: 'Эти моды несовместимы: оба меняют загрузку мира при входе. Выключить Fastload?',
  },
];

/** Vanilla video settings by computer class. Only keys the game already has are changed. */
const VIDEO = {
  low: { renderDistance: 8, simulationDistance: 6, graphicsMode: 0, biomeBlendRadius: 0, entityDistanceScaling: 0.75, mipmapLevels: 2, particles: 1, renderClouds: '"fast"', entityShadows: false },
  mid: { renderDistance: 12, simulationDistance: 8, graphicsMode: 1, biomeBlendRadius: 1, entityDistanceScaling: 1.0, mipmapLevels: 4, particles: 0, renderClouds: '"true"', entityShadows: true },
  high: { renderDistance: 16, simulationDistance: 10, graphicsMode: 1, biomeBlendRadius: 2, entityDistanceScaling: 1.0, mipmapLevels: 4, particles: 0, renderClouds: '"true"', entityShadows: true },
};

const VIDEO_LABELS = {
  renderDistance: 'Дальность прорисовки',
  simulationDistance: 'Дальность симуляции',
  graphicsMode: 'Графика',
  biomeBlendRadius: 'Смешивание биомов',
  entityDistanceScaling: 'Дальность сущностей',
  mipmapLevels: 'Мипмапы',
  particles: 'Частицы',
  renderClouds: 'Облака',
  entityShadows: 'Тени сущностей',
  maxFps: 'Лимит FPS',
  enableVsync: 'Вертикальная синхронизация',
  weather_quality: 'Погода (Sodium)',
  leaves_quality: 'Листва (Sodium)',
};

module.exports = { CATALOG, PROBLEMS, VIDEO, VIDEO_LABELS, WORLDGEN_RISK };
