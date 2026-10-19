'use strict';

const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, screen } = require('electron');
const { createLogger } = require('../core/logger');
const instanceService = require('../minecraft/instanceService');
const { getRequiredJavaMajor } = require('../minecraft/gameLauncher');
const { listJavaRuntimes } = require('../java/javaService');
const contentService = require('./contentService');
const modrinth = require('./modrinth');
const { CATALOG, PROBLEMS, VIDEO, VIDEO_LABELS } = require('./optimizerCatalog');

/*
 * "Оптимизация": one window that turns a slow instance into a smooth one.
 *  1. Looks at the computer: memory, cores, graphics card and its memory, the monitor's refresh rate.
 *  2. Looks at the pack: loader, version, mod count, shaders, conflicts and mods doing the same job.
 *  3. Proposes: performance mods that fit (checked on Modrinth), fixes for conflicts, memory, Java
 *     garbage-collector flags (tested on the instance's Java before they are used), game and Sodium
 *     video settings for this computer.
 *  4. Applies what the user left ticked, after a backup; "Вернуть как было" undoes all of it.
 */

const log = createLogger('optimizer');
const GPU_VENDORS = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x1022: 'AMD', 0x8086: 'Intel', 0x13b5: 'ARM', 0x5143: 'Qualcomm' };
const BACKUP_FOLDER = path.join('.vanillaplus', 'optimizer');
const SODIUM_FILES = ['config/sodium-options.json', 'config/embeddium-options.json', 'config/rubidium-options.json'];

// --- The computer ----------------------------------------------------------------------

function run(file, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Dedicated memory of each graphics adapter from the registry (WMI caps it at 4 GB): { name: MB }. */
async function adapterMemory() {
  if (process.platform !== 'win32') return {};
  const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
  const [names, sizes] = await Promise.all([run('reg', ['query', key, '/s', '/v', 'DriverDesc']), run('reg', ['query', key, '/s', '/v', 'HardwareInformation.qwMemorySize'])]);
  const byKey = (text, pattern) => {
    const result = {};
    let current = null;
    for (const line of text.split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) current = line.trim();
      const match = pattern.exec(line);
      if (current && match) result[current] = match[1].trim();
    }
    return result;
  };
  const nameOf = byKey(names.stdout, /DriverDesc\s+REG_SZ\s+(.+)$/);
  const sizeOf = byKey(sizes.stdout, /qwMemorySize\s+REG_QWORD\s+(0x[0-9a-f]+)/i);
  const result = {};
  for (const [registryKey, name] of Object.entries(nameOf)) {
    if (sizeOf[registryKey]) result[name] = Math.round(Number(BigInt(sizeOf[registryKey]) / 1048576n));
  }
  return result;
}

async function gpuInfo() {
  try {
    const info = await app.getGPUInfo('complete');
    const devices = info.gpuDevice ?? [];
    // Laptops and many desktops report the integrated Intel chip as active: the game is meant for
    // the discrete card, so an NVIDIA or AMD card wins when there is one.
    const discrete = devices.find((device) => device.vendorId === 0x10de) ?? devices.find((device) => device.vendorId === 0x1002 && devices.length > 1);
    const active = discrete ?? devices.find((device) => device.active) ?? devices[0];
    if (!active) return null;
    const vendor = GPU_VENDORS[active.vendorId] ?? 'Неизвестно';
    const name = active.deviceString || active.description || `${vendor} (0x${Number(active.deviceId ?? 0).toString(16)})`;
    // Intel graphics and most AMD/Qualcomm APUs share system memory: treated as integrated.
    const integrated = vendor === 'Intel' ? !/arc/i.test(name) : /radeon\(tm\) graphics|vega \d+ graphics|adreno/i.test(name);
    const memory = await adapterMemory().catch(() => ({}));
    const vramEntry = Object.entries(memory).find(([adapter]) => adapter.toLowerCase() === name.toLowerCase()) ?? Object.entries(memory).find(([adapter]) => adapter.toLowerCase().includes(vendor.toLowerCase()));
    // Mesh shaders (Nvidium): NVIDIA Turing and newer — GTX 16xx and every RTX.
    const meshShaders = vendor === 'NVIDIA' && /rtx|gtx\s*16\d\d/i.test(name);
    return { vendor, name, integrated, vramMb: vramEntry ? vramEntry[1] : null, meshShaders, count: devices.length };
  } catch {
    return null;
  }
}

function displayInfo() {
  try {
    const display = screen.getPrimaryDisplay();
    // Windows reports 59.94 Hz as 59 and 143.98 as 143: the nearest common rate is the real one.
    const raw = display.displayFrequency || 60;
    const common = [60, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 360].find((rate) => Math.abs(rate - raw) <= 2);
    return {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      refreshRate: common ?? Math.round(raw),
    };
  } catch {
    return { width: 1920, height: 1080, refreshRate: 60 };
  }
}

/** The computer, roughly: { ramMb, cores, cpu, gpu, display, tier: 'low' | 'mid' | 'high' }. */
async function systemInfo() {
  const ramMb = Math.round(os.totalmem() / 1048576);
  const cpus = os.cpus();
  const gpu = await gpuInfo();
  const display = displayInfo();
  const weakGpu = !gpu || gpu.integrated || (gpu.vramMb != null && gpu.vramMb < 3500) || /max-q|\bmx\s?\d|\bgt\s?\d|1050|\b7[0-9]0\b/i.test(gpu.name);
  let tier = 'mid';
  if (ramMb <= 8 * 1024 + 512 || cpus.length <= 4 || (gpu?.integrated && ramMb <= 16 * 1024 + 512)) tier = 'low';
  else if (ramMb >= 16 * 1024 - 512 && cpus.length >= 8 && !weakGpu) tier = 'high';
  return { ramMb, cores: cpus.length, cpu: (cpus[0]?.model ?? '').trim(), gpu, display, tier };
}

// --- The pack ---------------------------------------------------------------------------

/**
 * Whether a version range from a mod's own file takes in every version ("*", none, "[0,)"), or at
 * least the newest one, which is what the optimizer would install ("[1.6,)", ">=1.6").
 */
function rangeCovers(range, { newest = false } = {}) {
  return String(range ?? '')
    .split('||')
    .some((part) => {
      const text = part.trim();
      if (!text || text === '*' || /^[[(]\s*(0(\.0)*)?\s*,\s*[)\]]$/.test(text)) return true;
      if (!newest) return false;
      // Maven ("[1.6,)") and Fabric (">=1.6") ranges with no upper end.
      return /^[[(].*,\s*[)\]]$/.test(text) ? /,\s*[)\]]$/.test(text) : /^>/.test(text);
    });
}

function packContext(instance, mods, system) {
  const text = (item) => `${item.file} ${item.title}`;
  const enabled = mods.filter((item) => item.enabled);
  // What the pack's own mods say they cannot run with (neoforge.mods.toml, fabric.mod.json "breaks").
  const declared = enabled.flatMap((item) => (item.incompatible ?? []).map((rule) => ({ ...rule, by: item })));
  return {
    declared,
    /** The mod of the pack that refuses to run with the newest `modId`, or null. */
    blockedBy: (modId) => declared.find((rule) => rule.modId === modId && rule.by.modId !== modId && rangeCovers(rule.versionRange, { newest: true }))?.by ?? null,
    loader: instance.loader.type,
    minecraft: instance.minecraft,
    modCount: enabled.length,
    tier: system.tier,
    cores: system.cores,
    gpu: system.gpu,
    find: (pattern) => enabled.find((item) => pattern.test(text(item))) ?? null,
    findAll: (pattern) => enabled.filter((item) => pattern.test(text(item))),
    has(pattern) {
      return Boolean(this.find(pattern));
    },
  };
}

async function hasShaderPacks(instance) {
  const entries = await fsp.readdir(path.join(instance.directory, 'shaderpacks')).catch(() => []);
  return entries.some((name) => !name.startsWith('.') && !/\.txt$/i.test(name));
}

/** Memory for the instance: more mods, shaders and Distant Horizons need more; never more than the PC can spare. */
function recommendRamMb(system, modCount, { shaders = false, distantHorizons = false } = {}) {
  let wanted = modCount === 0 ? 2048 : modCount < 30 ? 3072 : modCount < 80 ? 4096 : modCount < 150 ? 6144 : modCount < 250 ? 8192 : 10240;
  if (shaders) wanted += 1024;
  if (distantHorizons) wanted += 2048;
  // Half of the computer's memory, and 4 GB left for Windows and the launcher.
  const ceiling = Math.max(2048, Math.min(Math.floor((system.ramMb * 0.5) / 512) * 512, Math.floor((system.ramMb - 4096) / 512) * 512));
  return Math.max(2048, Math.min(wanted, ceiling, 12288));
}

// Garbage-collector flags this optimizer owns: replaced on every run, the user's other flags stay.
const GC_FLAG = /^-XX:[+-]?(Use\w*GC|G1\w+|MaxGCPauseMillis|ParallelRefProcEnabled|UnlockExperimentalVMOptions|ExplicitGCInvokesConcurrent|DisableExplicitGC|PerfDisableSharedMem|ReservedCodeCacheSize|Shenandoah\w*|Z\w+|AlwaysPreTouch|MaxTenuringThreshold|SurvivorRatio|InitiatingHeapOccupancyPercent|GCTimeRatio|AllocatePrefetchStyle)\b/;

/**
 * G1 tuned for a game rather than a server (short pauses, a big young generation for the many
 * short-lived objects Minecraft makes). Server sets like Aikar's cause client stutter. Every flag
 * here exists from Java 8 to 25; they are still tried on the instance's Java before use.
 */
function javaFlags(ramMb, modCount) {
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=50',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:G1NewSizePercent=20',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1ReservePercent=20',
    `-XX:G1HeapRegionSize=${ramMb >= 8192 ? 16 : 8}M`,
    '-XX:+ExplicitGCInvokesConcurrent',
    '-XX:+PerfDisableSharedMem',
    `-XX:ReservedCodeCacheSize=${modCount >= 100 ? 400 : 256}M`,
  ];
}

function mergeJvmArgs(current, flags) {
  const kept = String(current ?? '')
    .split(/\s+/)
    .filter((token) => token && !GC_FLAG.test(token));
  return [...kept, ...flags].join(' ');
}

/**
 * Runs `java <flags> -version` with the Java the instance will use: flags it rejects never reach a
 * launch. Only Java already on the PC is used — looking never downloads one.
 */
async function testJavaFlags(settings, instance, flags) {
  try {
    const effective = instanceService.effectiveSettings(settings, instance);
    const layout = instanceService.layoutFor(settings);
    const required = await getRequiredJavaMajor(layout, instance.versionId ?? instance.minecraft);
    let runtime = null;
    if (effective.javaMode === 'custom' && effective.javaPath) {
      runtime = { path: effective.javaPath, majorVersion: null };
    } else {
      const runtimes = await listJavaRuntimes();
      runtime = runtimes.find((candidate) => candidate.majorVersion === required) ?? runtimes.find((candidate) => candidate.majorVersion > required && required >= 17) ?? null;
      if (!runtime) {
        // The launch will fetch the right Java; the same flags are checked then.
        return { tested: false, ok: true, major: required, error: null };
      }
    }
    const result = await run(runtime.path, [...flags, '-Xmx256M', '-version'], 15000);
    return { tested: true, ok: result.ok, major: runtime.majorVersion, error: result.ok ? null : (result.stderr || result.stdout).split(/\r?\n/).find(Boolean) };
  } catch (error) {
    return { tested: false, ok: true, major: null, error: error.message };
  }
}

// --- Video settings -------------------------------------------------------------------------

async function readOptions(instance) {
  try {
    const text = await fsp.readFile(path.join(instance.directory, 'options.txt'), 'utf8');
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
    }
    return { exists: true, text, values };
  } catch {
    return { exists: false, text: '', values: {} };
  }
}

async function readSodium(instance) {
  for (const relative of SODIUM_FILES) {
    try {
      return { relative, data: JSON.parse(await fsp.readFile(path.join(instance.directory, relative), 'utf8')) };
    } catch {
      // next
    }
  }
  return null;
}

const SHOWN = {
  graphicsMode: { 0: 'быстрая', 1: 'детальная', 2: 'улучшенная' },
  particles: { 0: 'все', 1: 'меньше', 2: 'минимум' },
  renderClouds: { '"true"': 'красивые', '"fast"': 'простые', '"false"': 'выкл.' },
  enableVsync: { true: 'вкл.', false: 'выкл.' },
  entityShadows: { true: 'вкл.', false: 'выкл.' },
};
const show = (key, value) => SHOWN[key]?.[String(value)] ?? String(value).replace(/^"|"$/g, '');

/** Video changes for this computer: [{ key, file, label, from, to }] (only what differs). */
async function videoPlan(instance, system, context, shaders) {
  const options = await readOptions(instance);
  const target = { ...VIDEO[system.tier] };
  // Big packs and shader packs: the CPU and GPU are already busy, keep the view moderate.
  if (context.modCount >= 150 || shaders) target.renderDistance = Math.min(target.renderDistance, 12);
  target.simulationDistance = Math.min(target.simulationDistance, target.renderDistance);
  // Frames are capped at the monitor's rate instead of v-sync: smooth, without v-sync's input lag.
  target.maxFps = Math.max(60, Math.min(260, system.display.refreshRate));
  target.enableVsync = false;
  const changes = [];
  for (const [key, value] of Object.entries(target)) {
    const current = options.values[key];
    // A version without the setting keeps working as it does; a new instance gets them all.
    if (options.exists && current === undefined) continue;
    if (current !== undefined && String(current) === String(value)) continue;
    changes.push({ key, file: 'options.txt', label: VIDEO_LABELS[key] ?? key, from: current === undefined ? null : show(key, current), to: show(key, value), value });
  }
  const sodium = await readSodium(instance);
  if (sodium || context.has(/sodium|embeddium|rubidium/i)) {
    const quality = system.tier === 'low' ? 'FAST' : 'DEFAULT';
    const data = sodium?.data ?? {};
    for (const key of ['weather_quality', 'leaves_quality']) {
      const current = data.quality?.[key];
      if (current !== quality) {
        changes.push({ key, file: 'sodium', label: VIDEO_LABELS[key], from: current ? (current === 'FAST' ? 'быстро' : current === 'FANCY' ? 'красиво' : 'как в игре') : null, to: quality === 'FAST' ? 'быстро' : 'как в игре', value: quality });
      }
    }
  }
  return { changes, optionsExists: options.exists, sodiumFile: sodium?.relative ?? null };
}

async function writeVideo(instance, changes) {
  const optionChanges = changes.filter((change) => change.file === 'options.txt');
  if (optionChanges.length) {
    const options = await readOptions(instance);
    const lines = options.exists ? options.text.split(/\r?\n/) : [];
    for (const change of optionChanges) {
      const value = typeof change.value === 'number' && !Number.isInteger(change.value) ? change.value.toFixed(1) : String(change.value);
      const index = lines.findIndex((line) => line.startsWith(`${change.key}:`));
      if (index >= 0) lines[index] = `${change.key}:${value}`;
      else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, `${change.key}:${value}`);
    }
    await fsp.writeFile(path.join(instance.directory, 'options.txt'), lines.join('\n').replace(/\n*$/, '\n'));
  }
  const sodiumChanges = changes.filter((change) => change.file === 'sodium');
  if (sodiumChanges.length) {
    const existing = await readSodium(instance);
    // A missing file is written with these keys only: Sodium fills in the rest with its defaults.
    const relative = existing?.relative ?? (instance.loader.type === 'forge' ? 'config/embeddium-options.json' : 'config/sodium-options.json');
    const data = existing?.data ?? {};
    data.quality = data.quality ?? {};
    for (const change of sodiumChanges) data.quality[change.key] = change.value;
    await fsp.mkdir(path.join(instance.directory, 'config'), { recursive: true });
    await fsp.writeFile(path.join(instance.directory, relative), `${JSON.stringify(data, null, 2)}\n`);
  }
}

// --- The plan -----------------------------------------------------------------------------

async function availableVersion(projectId, instance) {
  const query = (loader) => modrinth.getVersions(projectId, { gameVersion: instance.minecraft, loader, type: 'mod' }).catch(() => []);
  let versions = await query(instance.loader.type);
  if (!versions.length && instance.loader.type === 'quilt') versions = await query('fabric');
  return versions[0] ?? null;
}

async function backupInfo(instance) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(instance.directory, BACKUP_FOLDER, 'backup.json'), 'utf8'));
    return { createdAt: manifest.createdAt, summary: manifest.summary ?? [] };
  } catch {
    return null;
  }
}

/** Everything the window shows; nothing is changed. */
async function suggest(settings, instanceId) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const system = await systemInfo();
  const mods = await contentService.listContent(settings, instanceId, 'mod');
  const context = packContext(instance, mods, system);
  const loader = instance.loader.type;
  const shaders = context.has(/iris|oculus/i) && (await hasShaderPacks(instance));
  const distantHorizons = context.has(/distant.?horizons/i);
  const currentRam = instance.overrides?.ramMb ?? settings.ramMb;
  const recommendedRam = recommendRamMb(system, context.modCount, { shaders, distantHorizons });
  const n = context.modCount;
  const word = n % 10 === 1 && n % 100 !== 11 ? 'мод' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'мода' : 'модов';
  const ramReasons = [`${n} ${word}`];
  if (shaders) ramReasons.push('шейдеры');
  if (distantHorizons) ramReasons.push('Distant Horizons');

  // Java flags, tried on the instance's own Java.
  const flags = javaFlags(recommendedRam, context.modCount);
  const currentArgs = typeof instance.overrides?.extraJvmArgs === 'string' ? instance.overrides.extraJvmArgs : settings.extraJvmArgs ?? '';
  const recommendedArgs = mergeJvmArgs(currentArgs, flags);
  const javaTest = await testJavaFlags(settings, instance, flags);

  const result = {
    system,
    loader,
    minecraft: instance.minecraft,
    modCount: context.modCount,
    shaders,
    ram: { current: currentRam, recommended: recommendedRam, custom: Number.isFinite(instance.overrides?.ramMb), reasons: ramReasons },
    java: { current: currentArgs, recommended: recommendedArgs, changed: currentArgs.trim() !== recommendedArgs.trim(), test: javaTest, flags },
    mods: [],
    problems: [],
    video: await videoPlan(instance, system, context, shaders),
    backup: await backupInfo(instance),
  };

  // Problems in the pack.
  for (const problem of PROBLEMS) {
    const found = problem.test(context);
    const items = Array.isArray(found) ? found : found ? [found] : [];
    if (items.length) {
      result.problems.push({ id: problem.id, title: problem.title, text: problem.text, files: items.map((item) => item.file), names: items.map((item) => item.title) });
    }
  }
  // A speed mod that another mod of the pack refuses to run with: the game would not even start.
  const speedIds = new Set(CATALOG.map((entry) => entry.modId));
  for (const rule of context.declared) {
    const item = mods.find((candidate) => candidate.enabled && candidate.modId === rule.modId && speedIds.has(candidate.modId) && candidate !== rule.by);
    const id = `incompatible:${item?.file}`;
    if (!item || !rangeCovers(rule.versionRange) || result.problems.some((problem) => problem.id === id)) continue;
    result.problems.push({
      id,
      title: `${item.title} мешает запуску`,
      text: `«${rule.by.title}» не запускается вместе с «${item.title}». Выключить его?`,
      files: [item.file],
      names: [item.title],
    });
  }

  if (loader === 'vanilla') {
    return result;
  }

  // Performance mods: what fits this loader and version, what is already there, what does the same job.
  const candidates = CATALOG.filter((entry) => entry.loaders.includes(loader));
  const projects = await modrinth.getProjectsBrief(candidates.map((entry) => entry.slug)).catch(() => []);
  const bySlug = new Map(projects.map((project) => [project.slug, project]));
  const installedIds = new Set(mods.map((item) => item.projectId).filter(Boolean));
  // Incompatibilities the authors listed on Modrinth, both ways: the speed mod's version naming a
  // mod of the pack, or a mod of the pack naming the speed mod.
  const titleOfProject = new Map(mods.filter((item) => item.enabled && item.projectId).map((item) => [item.projectId, item.title]));
  const versionIds = mods.filter((item) => item.enabled && item.platform === 'modrinth' && item.versionId).map((item) => item.versionId);
  const installedVersions = versionIds.length ? await modrinth.getVersionsByIds(versionIds).catch(() => []) : [];
  const modrinthBlocker = (projectId, version) => {
    const named = (version?.dependencies ?? []).find((dependency) => dependency.type === 'incompatible' && titleOfProject.has(dependency.projectId));
    if (named) return titleOfProject.get(named.projectId);
    const other = installedVersions.find((candidate) => (candidate.dependencies ?? []).some((dependency) => dependency.type === 'incompatible' && dependency.projectId === projectId));
    return other ? (titleOfProject.get(other.projectId) ?? null) : null;
  };
  const checks = await Promise.all(
    candidates.map(async (entry) => {
      const project = bySlug.get(entry.slug);
      if (!project) return null;
      const installedItem = mods.find((item) => item.projectId === project.id) ?? mods.find((item) => entry.match.test(`${item.file} ${item.title}`));
      const version = installedItem ? null : await availableVersion(project.id, instance);
      return { entry, project, installedItem, installed: Boolean(installedItem) || installedIds.has(project.id), version };
    }),
  );
  const takenRoles = new Set(checks.filter((check) => check?.installed).map((check) => check.entry.role));
  // OptiFine takes the render role only until it is switched off (see the problem above).
  const sodiumInstalled = checks.find((check) => check?.installed && check.entry.role === 'render');
  for (const check of checks) {
    if (!check) continue;
    const { entry, project, installed, version } = check;
    const available = installed || Boolean(version);
    let avoided = null;
    if (!installed) {
      const blocker = context.blockedBy(entry.modId)?.title ?? modrinthBlocker(project.id, version);
      avoided = entry.avoid?.(context) ?? (blocker ? `не работает с «${blocker}»` : null);
    }
    const roleTaken = !installed && takenRoles.has(entry.role);
    let suggested = false;
    if (!installed && available && !roleTaken && !avoided) {
      if (entry.kind === 'core') suggested = true;
      else if (entry.kind === 'extra') suggested = entry.tickIf ? Boolean(entry.tickIf(context)) : false;
      if (entry.onlyWithOldSodium) {
        const renderVersion = sodiumInstalled?.installedItem?.version ?? checks.find((other) => other?.entry.slug === 'sodium')?.version?.versionNumber ?? '';
        if (!/^(mc[\d.]+-)?0\.5\./.test(renderVersion)) continue;
        suggested = true;
      }
      // A role is taken by the first mod offered for it (Sodium before Embeddium on NeoForge).
      if (entry.kind !== 'experimental') takenRoles.add(entry.role);
    }
    // Not shown: mods that do not exist for this version, and ones whose job another mod already does.
    if (!installed && (!available || roleTaken)) continue;
    result.mods.push({
      slug: entry.slug,
      projectId: project.id,
      title: project.title,
      iconUrl: project.iconUrl,
      why: entry.why,
      kind: entry.kind,
      risk: entry.risk ?? null,
      role: entry.role,
      installed,
      enabled: check.installedItem ? check.installedItem.enabled : null,
      available,
      suggested,
      roleTaken,
      avoided,
      versionNumber: version?.versionNumber ?? check.installedItem?.version ?? null,
    });
  }
  return result;
}

// --- Applying and undoing ---------------------------------------------------------------------

async function listModFiles(instance) {
  return new Set(await fsp.readdir(path.join(instance.directory, 'mods')).catch(() => []));
}

async function copyIfExists(from, to) {
  try {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies the choices: { ram: bool, java: bool, video: bool, mods: [projectId], problems: [id] }.
 * Returns { installed, disabled, failed, summary }.
 */
async function apply(settings, instanceId, choices = {}) {
  const plan = await suggest(settings, instanceId);
  const instance = await instanceService.getInstance(settings, instanceId);
  const root = path.join(instance.directory, BACKUP_FOLDER);
  await fsp.rm(root, { recursive: true, force: true });
  const files = [];
  for (const relative of ['options.txt', ...SODIUM_FILES]) {
    const existed = await copyIfExists(path.join(instance.directory, relative), path.join(root, 'files', relative));
    files.push({ relative, existed });
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    overrides: { ramMb: instance.overrides?.ramMb ?? null, extraJvmArgs: typeof instance.overrides?.extraJvmArgs === 'string' ? instance.overrides.extraJvmArgs : null },
    files,
    addedMods: [],
    disabledMods: [],
    summary: [],
  };
  const saveManifest = () => fsp.writeFile(path.join(root, 'backup.json'), JSON.stringify(manifest, null, 2));
  await saveManifest();

  const failed = [];
  // Problems first: OptiFine has to go before Sodium comes in.
  const fixed = new Set();
  for (const problem of plan.problems.filter((item) => (choices.problems ?? []).includes(item.id))) {
    for (const file of problem.files) {
      try {
        const renamed = await contentService.setEnabled(settings, instanceId, 'mod', file, false);
        manifest.disabledMods.push(renamed);
      } catch (error) {
        failed.push(`${file}: ${error.message}`);
      }
    }
    fixed.add(problem.id);
    manifest.summary.push(`Выключено: ${problem.names.join(', ')}`);
  }
  await saveManifest();

  const optifineStays = plan.problems.some((item) => item.id === 'optifine') && !fixed.has('optifine');
  const before = await listModFiles(instance);
  const installed = [];
  for (const mod of plan.mods.filter((item) => !item.installed && (choices.mods ?? []).includes(item.projectId))) {
    if (optifineStays && mod.role === 'render') {
      failed.push(`${mod.title}: не поставлен, пока включён OptiFine`);
      continue;
    }
    try {
      await contentService.installProject(settings, { instanceId, platform: 'modrinth', projectId: mod.projectId, type: 'mod', title: mod.title, iconUrl: mod.iconUrl });
      installed.push(mod.title);
    } catch (error) {
      failed.push(`${mod.title}: ${error.message}`);
    }
  }
  const after = await listModFiles(instance);
  manifest.addedMods = [...after].filter((file) => !before.has(file));
  if (installed.length) manifest.summary.push(`Поставлено: ${installed.join(', ')}`);
  await saveManifest();

  const overrides = {};
  if (choices.ram && plan.ram.recommended !== plan.ram.current) {
    overrides.ramMb = plan.ram.recommended;
    manifest.summary.push(`Память: ${Math.round(plan.ram.recommended / 102.4) / 10} ГБ`);
  }
  if (choices.java && plan.java.changed && plan.java.test.ok) {
    overrides.extraJvmArgs = plan.java.recommended;
    manifest.summary.push('Флаги Java для плавной игры');
  }
  if (Object.keys(overrides).length) {
    await instanceService.updateInstance(settings, instanceId, { overrides });
  }
  if (choices.video && plan.video.changes.length) {
    await writeVideo(instance, plan.video.changes);
    manifest.summary.push(`Настройки графики: ${plan.video.changes.length}`);
  }
  await saveManifest();
  log.info(`Оптимизация «${instance.name}»: ${manifest.summary.join('; ') || 'без изменений'}${failed.length ? `; ошибки: ${failed.join('; ')}` : ''}`);
  return { installed, disabled: manifest.disabledMods, failed, summary: manifest.summary };
}

/** Puts back what the last optimization changed. */
async function undo(settings, instanceId) {
  const instance = await instanceService.getInstance(settings, instanceId);
  const root = path.join(instance.directory, BACKUP_FOLDER);
  const manifest = JSON.parse(await fsp.readFile(path.join(root, 'backup.json'), 'utf8'));
  for (const file of manifest.addedMods ?? []) {
    await contentService.removeContent(settings, instanceId, 'mod', file).catch(() => {});
  }
  for (const file of manifest.disabledMods ?? []) {
    await contentService.setEnabled(settings, instanceId, 'mod', file, true).catch(() => {});
  }
  for (const { relative, existed } of manifest.files ?? []) {
    const target = path.join(instance.directory, relative);
    if (existed) await copyIfExists(path.join(root, 'files', relative), target);
    else await fsp.rm(target, { force: true });
  }
  // null removes an override (instanceStore.updateInstance merges overrides).
  await instanceService.updateInstance(settings, instanceId, { overrides: { ramMb: manifest.overrides.ramMb ?? null, extraJvmArgs: manifest.overrides.extraJvmArgs ?? null } });
  await fsp.rm(root, { recursive: true, force: true });
  log.info(`Оптимизация «${instance.name}» отменена`);
  return { restored: true };
}

module.exports = { suggest, apply, undo, systemInfo, recommendRamMb, mergeJvmArgs };
