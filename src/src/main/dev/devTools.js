'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { broadcast } = require('../core/broadcast');
const { CHANNELS } = require('../../shared/channels');
const { getAppPaths } = require('../core/paths');
const store = require('../minecraft/instanceStore');
const instanceService = require('../minecraft/instanceService');
const instanceFiles = require('../minecraft/instanceFiles');
const { analyzeLog } = require('../minecraft/logAnalyzer');
const devGame = require('./devGame');
const { allowChange } = require('./devGuard');

/*
 * What AI tools can do through developer mode (the MCP server and the plain API in devServer.js
 * share these). Descriptions are in English: they are read by the AI, not shown to the player.
 * Rules: instances the API makes are test ones (store `test: true`, group «Тесты ИИ»); the player's
 * own instances can be listed, read and launched, but every change to them goes through
 * devGuard.allowChange (the player says yes in the launcher's window, or the call fails).
 */

/** The group test instances go into, in the launcher's language (group names are not translated on screen). */
const TEST_GROUPS = { ru: 'Тесты ИИ', en: 'AI tests', uk: 'Тести ШІ', pl: 'Testy AI', de: 'KI-Tests', fr: 'Tests IA', es: 'Pruebas de IA', pt: 'Testes de IA', zh: 'AI 测试' };
const testGroup = (settings) => TEST_GROUPS[settings.ui?.language] ?? TEST_GROUPS.en;
const MAX_TEST_INSTANCES = 30;
const MAX_MOD_BYTES = 256 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 4 * 1024 * 1024;
/** Files of an instance the API never writes: the launcher's own description and data. */
const PROTECTED_FILES = /^(instance\.json$|\.amethyx(\/|$))/i;

const instancesChanged = (instanceId) => broadcast(CHANNELS.events.instancesChanged, { instanceId });
const gameService = () => require('../minecraft/gameService');
const contentService = () => require('../content/contentService');

function clampInt(value, fallback, min, max) {
  const number = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(number, min), max);
}

function regexOf(text, name) {
  if (text === undefined || text === null || text === '') return null;
  try {
    return new RegExp(String(text).slice(0, 500), 'i');
  } catch (error) {
    throw new Error(`"${name}" is not a valid regular expression: ${error.message}`);
  }
}

function summary(instance) {
  return {
    id: instance.id,
    name: instance.name,
    group: instance.group || null,
    minecraft: instance.minecraft,
    loader: instance.loader?.type ?? 'vanilla',
    loaderVersion: instance.loader?.version ?? null,
    test: instance.test === true,
    installed: instance.installed ?? null,
    installing: instance.installing ?? false,
    copying: instance.copying ?? false,
    running: gameService().isInstanceRunning(instance.id),
    lastPlayedAt: instance.lastPlayedAt ?? null,
    directory: instance.directory ?? null,
  };
}

async function findInstance(settings, id) {
  if (typeof id !== 'string' || !id) throw new Error('instanceId is required (see list_instances).');
  return instanceService.getInstance(settings, id);
}

function refuseWhileRunning(instance, what) {
  if (gameService().isInstanceRunning(instance.id)) {
    throw new Error(`"${instance.name}" is running now: stop the game first (stop_game), then ${what}.`);
  }
}

/** A path inside the instance folder, "/"-separated; nothing outside it. */
function insidePath(instance, relative) {
  const clean = String(relative ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('path must be relative to the instance folder, like "config/mymod.toml" (no "..").');
  }
  return { clean, full: path.join(instance.directory, ...clean.split('/')) };
}

/** A mod as the AI names it: a Modrinth slug, {modrinth}, {curseforge} or {file}. */
function parseMod(spec) {
  if (typeof spec === 'string') {
    const text = spec.trim();
    if (/\.jar$/i.test(text) && path.isAbsolute(text)) return { file: text };
    const prefixed = /^(modrinth|curseforge):(.+)$/i.exec(text);
    if (prefixed) return { platform: prefixed[1].toLowerCase(), project: prefixed[2].trim() };
    if (text) return { platform: 'modrinth', project: text };
  } else if (spec && typeof spec === 'object') {
    if (typeof spec.file === 'string') return { file: spec.file };
    const version = spec.version ? String(spec.version) : undefined;
    if (spec.modrinth) return { platform: 'modrinth', project: String(spec.modrinth), version };
    if (spec.curseforge) return { platform: 'curseforge', project: String(spec.curseforge), version };
  }
  throw new Error(`Cannot read the mod ${JSON.stringify(spec)}: give a Modrinth slug ("sodium"), {"modrinth": "slug", "version": "<version id>"}, {"curseforge": "<project id>"} or {"file": "C:\\\\path\\\\to\\\\mod.jar"}.`);
}

const describeMod = (mod) => mod.file ?? `${mod.platform}:${mod.project}`;

/** Puts mods into an instance: files are copied, projects downloaded with their required libraries. */
async function installMods(settings, instance, specs) {
  const added = [];
  const failed = [];
  for (const spec of specs) {
    let mod = null;
    try {
      mod = parseMod(spec);
      if (mod.file) {
        if (!path.isAbsolute(mod.file)) throw new Error('the file path must be absolute');
        const stat = await fsp.stat(mod.file).catch(() => null);
        if (!stat?.isFile()) throw new Error('no such file');
        if (!/\.jar$/i.test(mod.file)) throw new Error('only .jar files are mods');
        if (stat.size > MAX_MOD_BYTES) throw new Error('the file is larger than 256 MB');
        const names = await contentService().addLocalFiles(settings, instance.id, 'mod', [mod.file]);
        added.push({ mod: mod.file, files: names });
      } else {
        // A slug is turned into the project's id, so the launcher knows the mod for updates later.
        const project = await contentService().getProject(settings, mod.platform, mod.project);
        const result = await contentService().installProject(settings, {
          instanceId: instance.id,
          platform: mod.platform,
          projectId: String(project.id),
          versionId: mod.version,
          type: 'mod',
          title: project.title,
          iconUrl: project.iconUrl ?? null,
        });
        added.push({ mod: describeMod(mod), installed: result.installed, skippedDependencies: result.skipped });
      }
    } catch (error) {
      failed.push({ mod: mod ? describeMod(mod) : spec, error: error.message });
    }
  }
  instancesChanged(instance.id);
  return { added, failed };
}

async function tailFile(file, bytes) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), truncated: size > length };
  } finally {
    await handle.close();
  }
}

function pickLines(text, { last, filter }) {
  let list = text.split(/\r?\n/);
  if (list.length && list[list.length - 1] === '') list.pop();
  if (filter) list = list.filter((line) => filter.test(line));
  return { lines: list.slice(-last), total: list.length };
}

const MOD_SPEC = {
  description: 'Mods to put in: a Modrinth slug or id ("fabric-api"), "curseforge:<id>", {"modrinth": "slug", "version": "<Modrinth version id>"}, {"curseforge": "<id>"}, or {"file": "<absolute path to a .jar you built>"}. A file with the same name replaces the old one; required libraries of Modrinth mods come along.',
  type: 'array',
  items: { anyOf: [{ type: 'string' }, { type: 'object' }] },
};
const INSTANCE_ID = { type: 'string', description: 'Instance id (folder name) from list_instances or create_test_instance.' };

const TOOLS = [
  {
    name: 'launcher_status',
    title: 'Launcher status',
    readOnly: true,
    description: 'The launcher, the selected account, the game state and how many instances there are. Start here.',
    properties: {},
    async run(_args, { settings }) {
      const instances = await instanceService.listInstances(settings);
      const { loadAccountStore } = require('../accounts/accountStore');
      const { selectedId, accounts } = await loadAccountStore();
      const account = accounts.find((entry) => entry.id === selectedId);
      const dev = settings.dev ?? {};
      return {
        launcher: `Amethyx Launcher ${app.getVersion()}`,
        gameDirectory: settings.gameDirectory,
        account: account ? { name: account.username ?? null, type: account.type ?? null } : null,
        game: devGame.status(),
        instances: instances.length,
        testInstances: instances.filter((instance) => instance.test).length,
        launchOptions: { verboseLogs: dev.verboseLogs, javaDebugPort: dev.javaDebug ? 5005 : null, mixinExport: dev.mixinExport, commandsInAllWorlds: dev.cheats },
        rules: 'Test instances (made by create_test_instance) may be changed and deleted freely. The player\'s own instances: list, read and launch only; any change asks the player in the launcher window.',
      };
    },
  },
  {
    name: 'list_instances',
    title: 'List instances',
    readOnly: true,
    description: 'All instances with their Minecraft version, mod loader, whether they are test ones, installed and running.',
    properties: { testOnly: { type: 'boolean', description: 'Only the test instances.' } },
    async run({ testOnly }, { settings }) {
      const instances = await instanceService.listInstances(settings);
      return instances.filter((instance) => !testOnly || instance.test).map(summary);
    },
  },
  {
    name: 'list_minecraft_versions',
    title: 'List Minecraft versions',
    readOnly: true,
    description: 'Minecraft versions from Mojang, newest first.',
    properties: {
      type: { type: 'string', enum: ['release', 'snapshot', 'all'], description: 'Default "release".' },
      limit: { type: 'integer', description: 'Default 30, at most 1000.' },
    },
    async run({ type = 'release', limit }, { settings }) {
      const { versions } = await require('../minecraft/versionService').getCatalog(settings);
      return versions
        .filter((version) => type === 'all' || version.type === type)
        .slice(0, clampInt(limit, 30, 1, 1000))
        .map((version) => ({ id: version.id, type: version.type, releaseTime: version.releaseTime ?? null, installed: version.installed }));
    },
  },
  {
    name: 'list_loader_versions',
    title: 'List mod loader versions',
    readOnly: true,
    description: 'Versions of Fabric, Quilt, Forge or NeoForge for a Minecraft version, newest first.',
    properties: {
      loader: { type: 'string', enum: ['fabric', 'quilt', 'forge', 'neoforge'] },
      minecraft: { type: 'string', description: 'Minecraft version, like "1.21.1".' },
      limit: { type: 'integer', description: 'Default 20.' },
    },
    required: ['loader', 'minecraft'],
    async run({ loader, minecraft, limit }) {
      const list = await require('../minecraft/loaderMeta').listLoaderVersions(loader, minecraft);
      return list.slice(0, clampInt(limit, 20, 1, 500)).map((entry) => ({ version: entry.version, stable: entry.stable ?? null }));
    },
  },
  {
    name: 'create_test_instance',
    title: 'Create a test instance',
    description:
      'Makes a new TEST instance (in the group "AI tests") with a Minecraft version, a mod loader and mods. The game and the loader are downloaded on the first launch. ' +
      'Test instances may be changed and deleted without asking the player. Returns the instance id.',
    properties: {
      minecraft: { type: 'string', description: 'Minecraft version, like "1.21.1" (see list_minecraft_versions).' },
      loader: { type: 'string', enum: ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'], description: 'Default "vanilla".' },
      loaderVersion: { type: 'string', description: 'Exact loader version (see list_loader_versions); default: the recommended / latest stable one.' },
      name: { type: 'string', description: 'Name shown in the launcher; default "Test <version> <loader>".' },
      mods: MOD_SPEC,
      ramMb: { type: 'integer', description: 'Memory for the game in MB; default: the launcher setting.' },
      jvmArgs: { type: 'string', description: 'Extra JVM arguments for this instance.' },
    },
    required: ['minecraft'],
    async run({ minecraft, loader = 'vanilla', loaderVersion, name, mods = [], ramMb, jvmArgs }, ctx) {
      const { settings } = ctx;
      const layout = instanceService.layoutFor(settings);
      const existing = await store.listInstances(layout);
      if (existing.filter((instance) => instance.test).length >= MAX_TEST_INSTANCES) {
        throw new Error(`There are already ${MAX_TEST_INSTANCES} test instances: delete old ones first (delete_instance).`);
      }
      // An unknown version is said now, not at the first launch (skipped when Mojang cannot be reached).
      const catalog = await require('../minecraft/versionService').getCatalog(settings).catch(() => null);
      if (catalog && !catalog.versions.some((version) => version.id === minecraft)) {
        throw new Error(`Unknown Minecraft version "${minecraft}" (see list_minecraft_versions).`);
      }
      const type = loader || 'vanilla';
      const overrides = {};
      if (Number.isFinite(ramMb)) overrides.ramMb = clampInt(ramMb, 2048, 512, 65536);
      if (typeof jvmArgs === 'string' && jvmArgs.trim()) overrides.extraJvmArgs = jvmArgs.trim().slice(0, 2000);
      const created = await store.createInstance(layout, {
        name: String(name ?? '').trim() || `Test ${minecraft}${type === 'vanilla' ? '' : ` ${type}`}`,
        group: testGroup(settings),
        minecraft,
        loader: { type, version: type === 'vanilla' ? null : loaderVersion || null },
        versionId: type === 'vanilla' ? minecraft : null,
        overrides,
        test: true,
      });
      const instance = { ...created, directory: layout.instanceDirectory(created.id) };
      ctx.subject = instance.name;
      instancesChanged(instance.id);
      const installed = mods.length ? await installMods(settings, instance, mods) : { added: [], failed: [] };
      return {
        instance: summary(instance),
        mods: installed,
        next: 'launch_instance with this id, then wait_for_game; read_game_log or read_instance_log to see what happened.',
      };
    },
  },
  {
    name: 'add_mods',
    title: 'Add mods',
    description: 'Puts mods into an instance (Modrinth, CurseForge or your .jar). For the player\'s own instance the player is asked first. A .jar with the same name replaces the old one; a renamed build needs remove_mod for the old file.',
    properties: { instanceId: INSTANCE_ID, mods: MOD_SPEC },
    required: ['instanceId', 'mods'],
    async run({ instanceId, mods }, ctx) {
      const instance = await findInstance(ctx.settings, instanceId);
      ctx.subject = instance.name;
      refuseWhileRunning(instance, 'add mods');
      if (!mods.length) throw new Error('mods is empty.');
      await allowChange(instance, 'addMods', mods.map((spec) => { try { return path.basename(describeMod(parseMod(spec))); } catch { return String(spec); } }).join(', '));
      return installMods(ctx.settings, instance, mods);
    },
  },
  {
    name: 'list_mods',
    title: 'List mods',
    readOnly: true,
    description: 'Mod files of an instance with their mod id, version and whether they are enabled.',
    properties: { instanceId: INSTANCE_ID },
    required: ['instanceId'],
    async run({ instanceId }, { settings }) {
      const instance = await findInstance(settings, instanceId);
      const list = await contentService().listContent(settings, instance.id, 'mod');
      return list.map((mod) => ({ file: mod.file, modId: mod.modId, title: mod.title, version: mod.version, enabled: mod.enabled, platform: mod.platform, projectId: mod.projectId }));
    },
  },
  {
    name: 'remove_mod',
    title: 'Remove a mod',
    description: 'Deletes one mod file from an instance (file name from list_mods). For the player\'s own instance the player is asked first.',
    properties: { instanceId: INSTANCE_ID, file: { type: 'string', description: 'File name in the mods folder, like "mymod-1.0.0.jar".' } },
    required: ['instanceId', 'file'],
    async run({ instanceId, file }, ctx) {
      const instance = await findInstance(ctx.settings, instanceId);
      ctx.subject = instance.name;
      refuseWhileRunning(instance, 'remove mods');
      const mods = await contentService().listContent(ctx.settings, instance.id, 'mod');
      if (!mods.some((mod) => mod.file === file)) throw new Error(`No mod file "${file}" in "${instance.name}" (see list_mods).`);
      await allowChange(instance, 'removeMod', file);
      await contentService().removeContent(ctx.settings, instance.id, 'mod', file);
      instancesChanged(instance.id);
      return { removed: file };
    },
  },
  {
    name: 'launch_instance',
    title: 'Launch an instance',
    description:
      'Starts the game in an instance with the player\'s selected account; Minecraft, the loader and Java are downloaded first when missing (that can take minutes). ' +
      'Returns at once with fromLine: then call wait_for_game (a pattern like "Sound engine started" means the game has loaded) and read_game_log. Only one game runs at a time.',
    properties: { instanceId: INSTANCE_ID },
    required: ['instanceId'],
    async run({ instanceId }, ctx) {
      const instance = await findInstance(ctx.settings, instanceId);
      ctx.subject = instance.name;
      const state = gameService().getStatus();
      if (state.state !== 'idle') {
        throw new Error(`A game is already ${state.state} (instance "${state.instanceId}"). Stop it first with stop_game.`);
      }
      const fromLine = devGame.nextLine();
      const launch = devGame.noteLaunch(instance.id);
      const run = gameService().play(instance.id).catch((error) => devGame.noteLaunchError(launch, error));
      // Mistakes found at once (no account, a broken instance) come back with this call.
      await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (launch.error) throw new Error(`The game did not start: ${launch.error}`);
      return { instanceId: instance.id, state: gameService().getStatus().state, fromLine, next: 'wait_for_game with fromLine, then read_game_log.' };
    },
  },
  {
    name: 'game_status',
    title: 'Game status',
    readOnly: true,
    description: 'Whether a game is launching or running, how the last run ended (exit code, crash report problems), the last launch error, and nextLine of the game log.',
    properties: {},
    async run() {
      return devGame.status();
    },
  },
  {
    name: 'wait_for_game',
    title: 'Wait for the game',
    readOnly: true,
    description:
      'Waits until a game log line matches pattern (a regular expression, case-insensitive), the game closes or crashes, or timeoutSeconds pass. ' +
      'Lines from fromLine on are searched too, so nothing printed before the call is missed. Without pattern it waits for the game to close.',
    properties: {
      pattern: { type: 'string', description: 'Regular expression, like "Sound engine started|Exception".' },
      fromLine: { type: 'integer', description: 'Log line number to search from (fromLine of launch_instance).' },
      timeoutSeconds: { type: 'integer', description: 'Default 120, at most 600.' },
    },
    async run({ pattern, fromLine, timeoutSeconds }) {
      return devGame.waitFor({
        pattern: regexOf(pattern, 'pattern'),
        from: Number.isFinite(fromLine) ? fromLine : null,
        timeoutMs: clampInt(timeoutSeconds, 120, 1, 600) * 1000,
      });
    },
  },
  {
    name: 'read_game_log',
    title: 'Read the game log',
    readOnly: true,
    description: 'Output of the game (and the launcher\'s lines about the launch) from this launcher session, with line numbers. Use fromLine to read only new lines; nextLine continues.',
    properties: {
      fromLine: { type: 'integer', description: 'First line number to return; without it, the newest lines.' },
      maxLines: { type: 'integer', description: 'Default 200, at most 2000.' },
      filter: { type: 'string', description: 'Only lines matching this regular expression (case-insensitive).' },
    },
    async run({ fromLine, maxLines, filter }) {
      const result = devGame.readLines({ from: Number.isFinite(fromLine) ? fromLine : null, last: clampInt(maxLines, 200, 1, 2000), filter: regexOf(filter, 'filter') });
      return { ...result, lines: result.lines.map((line) => `${line.n}: ${line.text}`) };
    },
  },
  {
    name: 'read_instance_log',
    title: 'Read an instance log file',
    readOnly: true,
    description: 'A log file of an instance: "latest" (logs/latest.log), "debug" (logs/debug.log), "last-run" (the launcher\'s copy of the last run) or "crash" (the newest crash report). Problems the launcher recognises come with it.',
    properties: {
      instanceId: INSTANCE_ID,
      log: { type: 'string', enum: ['latest', 'debug', 'last-run', 'crash'], description: 'Default "latest".' },
      maxLines: { type: 'integer', description: 'Last lines to return; default 300, at most 5000.' },
      filter: { type: 'string', description: 'Only lines matching this regular expression (case-insensitive).' },
    },
    required: ['instanceId'],
    async run({ instanceId, log = 'latest', maxLines, filter }, { settings }) {
      const instance = await findInstance(settings, instanceId);
      let id = { latest: 'logs/latest.log', debug: 'logs/debug.log', 'last-run': instanceFiles.LAST_RUN_LOG.split(path.sep).join('/') }[log];
      if (log === 'crash') {
        const crash = (await instanceFiles.listLogs(instance.directory)).find((entry) => entry.kind === 'crash');
        if (!crash) return { log: null, note: 'This instance has no crash reports.' };
        id = crash.id;
      }
      const file = await instanceFiles.readLog(instance.directory, id).catch(() => null);
      if (!file) return { log: id, note: 'No such log yet (the game has not written it).' };
      const picked = pickLines(file.text, { last: clampInt(maxLines, 300, 1, 5000), filter: regexOf(filter, 'filter') });
      return { log: id, path: file.path, ...picked, truncatedFile: file.truncated, problems: (file.problems ?? []).map(devGame.describeProblem), crash: file.crash ?? null };
    },
  },
  {
    name: 'stop_game',
    title: 'Stop the game',
    description: 'Closes the running game. A game the player started themselves in their own instance is closed only if the player allows it.',
    properties: {},
    async run(_args, ctx) {
      const state = gameService().getStatus();
      if (state.state === 'idle') return { stopped: false, note: 'No game is running.' };
      if (state.state === 'launching') throw new Error('The game is still being prepared (downloads); wait_for_game until it runs, then stop it.');
      const instance = await instanceService.getInstance(ctx.settings, state.instanceId).catch(() => null);
      ctx.subject = instance?.name ?? state.instanceId;
      if (instance && !devGame.launchedByApi.has(instance.id)) {
        await allowChange(instance, 'stopGame');
      }
      gameService().stop();
      const after = await devGame.waitFor({ timeoutMs: 20000 });
      return { stopped: after.result !== 'timeout', status: after.status };
    },
  },
  {
    name: 'delete_instance',
    title: 'Delete an instance',
    destructive: true,
    description: 'Deletes an instance with all its files. Test instances go at once; the player\'s own only if the player allows it in the launcher window (do not retry a refusal).',
    properties: { instanceId: INSTANCE_ID },
    required: ['instanceId'],
    async run({ instanceId }, ctx) {
      const instance = await findInstance(ctx.settings, instanceId);
      ctx.subject = instance.name;
      refuseWhileRunning(instance, 'delete it');
      await allowChange(instance, 'delete');
      // A watched folder may stay behind on Windows (the same as deleting from the window).
      require('../content/contentWatcher').stopWatching();
      await instanceService.deleteInstance(ctx.settings, instance.id);
      instancesChanged(instance.id);
      return { deleted: instance.id, name: instance.name };
    },
  },
  {
    name: 'read_instance_file',
    title: 'Read a file of an instance',
    readOnly: true,
    description: 'A text file inside an instance folder, like "options.txt" or "config/mymod.toml" (at most 1 MB). Without path: the list of files and folders at the top.',
    properties: { instanceId: INSTANCE_ID, path: { type: 'string', description: 'Path relative to the instance folder; a folder gives its list.' } },
    required: ['instanceId'],
    async run({ instanceId, path: relative }, { settings }) {
      const instance = await findInstance(settings, instanceId);
      const target = relative ? insidePath(instance, relative) : { clean: '', full: instance.directory };
      const stat = await fsp.stat(target.full).catch(() => null);
      if (!stat) throw new Error(`No "${target.clean}" in "${instance.name}".`);
      if (stat.isDirectory()) {
        const entries = await fsp.readdir(target.full, { withFileTypes: true });
        return { folder: target.clean || '.', entries: entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort() };
      }
      if (stat.size > MAX_READ_BYTES) throw new Error(`"${target.clean}" is larger than 1 MB.`);
      return { path: target.clean, text: await fsp.readFile(target.full, 'utf8') };
    },
  },
  {
    name: 'write_instance_file',
    title: 'Write a file of an instance',
    description: 'Writes a text file inside an instance folder (configs, options.txt, a datapack file…); folders are made as needed. For the player\'s own instance the player is asked first.',
    properties: {
      instanceId: INSTANCE_ID,
      path: { type: 'string', description: 'Path relative to the instance folder, like "config/mymod.toml".' },
      content: { type: 'string', description: 'The whole new text of the file (UTF-8, at most 2 MB).' },
    },
    required: ['instanceId', 'path', 'content'],
    async run({ instanceId, path: relative, content }, ctx) {
      const instance = await findInstance(ctx.settings, instanceId);
      ctx.subject = instance.name;
      const target = insidePath(instance, relative);
      if (PROTECTED_FILES.test(target.clean)) throw new Error('instance.json and .amethyx are the launcher\'s own: not written through the API.');
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('content is larger than 2 MB.');
      await allowChange(instance, 'writeFile', target.clean);
      await fsp.mkdir(path.dirname(target.full), { recursive: true });
      await fsp.writeFile(target.full, content, 'utf8');
      return { written: target.clean, bytes: Buffer.byteLength(content, 'utf8') };
    },
  },
  {
    name: 'read_launcher_log',
    title: 'Read the launcher log',
    readOnly: true,
    description: 'The launcher\'s own log (downloads, installs, launches, errors of the launcher itself), newest lines last.',
    properties: {
      maxLines: { type: 'integer', description: 'Default 200, at most 5000.' },
      filter: { type: 'string', description: 'Only lines matching this regular expression (case-insensitive).' },
    },
    async run({ maxLines, filter }) {
      const file = path.join(getAppPaths().logsDirectory, 'launcher.log');
      const { text } = await tailFile(file, LOG_TAIL_BYTES).catch(() => ({ text: '' }));
      return pickLines(text, { last: clampInt(maxLines, 200, 1, 5000), filter: regexOf(filter, 'filter') });
    },
  },
];

/** Checks the arguments against a tool's properties (types, required, enums); unknown ones are ignored. */
function checkArguments(tool, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const clean = {};
  for (const name of tool.required ?? []) {
    if (input[name] === undefined || input[name] === null || input[name] === '') throw new Error(`"${name}" is required.`);
  }
  for (const [name, schema] of Object.entries(tool.properties)) {
    const value = input[name];
    if (value === undefined || value === null) continue;
    const ok = {
      string: typeof value === 'string',
      integer: Number.isInteger(value),
      boolean: typeof value === 'boolean',
      array: Array.isArray(value),
    }[schema.type];
    if (ok === false) throw new Error(`"${name}" must be ${schema.type === 'integer' ? 'an integer' : `a ${schema.type}`}.`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`"${name}" must be one of: ${schema.enum.join(', ')}.`);
    clean[name] = typeof value === 'string' ? value.slice(0, 10_000_000) : value;
  }
  if (Array.isArray(clean.mods) && clean.mods.length > 100) throw new Error('At most 100 mods at once.');
  return clean;
}

/** The tools as MCP lists them. */
function describeTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, ...(tool.required ? { required: tool.required } : {}) },
    annotations: { title: tool.title, readOnlyHint: tool.readOnly === true, destructiveHint: tool.destructive === true, openWorldHint: false },
  }));
}

function findTool(name) {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

module.exports = { describeTools, findTool, checkArguments, testGroup };
