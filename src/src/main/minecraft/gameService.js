'use strict';

const { spawn } = require('node:child_process');
const { broadcast } = require('../core/broadcast');
const { createLogger } = require('../core/logger');
const { CHANNELS } = require('../../shared/channels');
const { startGameProcess, getRequiredJavaMajor } = require('./gameLauncher');
const { resolveJavaForLaunch } = require('../java/javaService');
const { prepareSkinAgent } = require('./skinAgent');
const { migrateSharedGameData } = require('./instanceMigration');
const instanceService = require('./instanceService');
const { getSettings, updateSettings } = require('../settings/settingsService');
const { getLaunchSession } = require('../accounts/accountService');
const { loadAccountStore } = require('../accounts/accountStore');
const { saveLastRun, crashReportSince } = require('./instanceFiles');
const { analyzeLog, describeExitCode } = require('./logAnalyzer');
const { parseLogLine } = require('./worldShare');

const LOG_LIMIT = 4000;
/** Lines kept for the saved copy of one run (the journal shows the end of longer runs). */
const RUN_LOG_LIMIT = 30000;
const log = createLogger('game-service');

/** The single running game (the launcher starts at most one at a time). */
let current = null;
/** Instance being prepared for launch (install, Java, session): a second Play must wait for it. */
let launchingId = null;
const logLines = [];
/** Output of the run being prepared or played: saved into the instance when the game exits. */
let runLog = null;

/** "Open to LAN" in the game: 1.20+ logs "Started serving on 51234", older "Local game hosted on port 51234". */
const LAN_PORT = /(?:Started serving on|hosted on port)\s*\[?(\d{2,5})\]?/;

function pushLogLine(line) {
  const lan = current && LAN_PORT.exec(line);
  if (lan) {
    current.activity.lanPort = Number(lan[1]);
    broadcast(CHANNELS.events.friendEvent, { type: 'lan-open', port: current.activity.lanPort, shared: true });
    // Friends with an earlier invite can come in through the tunnel at once (cloud/tunnel.js).
    require('../cloud/tunnel').onLanOpen();
  }
  // e4mc's public address of the world opened to LAN (see worldShare.js).
  const shared = current && parseLogLine(line);
  if (shared?.address && shared.address !== current.activity.worldAddress) {
    current.activity.worldAddress = shared.address;
    broadcast(CHANNELS.events.friendEvent, { type: 'world-shared', address: shared.address });
  } else if (shared?.closed && current.activity.worldAddress) {
    current.activity.worldAddress = null;
    broadcast(CHANNELS.events.friendEvent, { type: 'world-closed' });
  }
  logLines.push(line);
  if (logLines.length > LOG_LIMIT) {
    logLines.splice(0, logLines.length - LOG_LIMIT);
  }
  if (runLog) {
    runLog.lines.push(line);
    if (runLog.lines.length > RUN_LOG_LIMIT) {
      runLog.lines.splice(0, runLog.lines.length - RUN_LOG_LIMIT);
    }
  }
  broadcast(CHANNELS.events.gameLog, line);
}

function getStatus() {
  if (!current) {
    return { state: launchingId ? 'launching' : 'idle', instanceId: launchingId, versionId: null, startedAt: null };
  }
  return { state: 'running', instanceId: current.instanceId, versionId: current.versionId, startedAt: current.startedAt };
}

/** What is being played, for the friends' status: { instanceName, minecraft, loader, server } or null. */
function getActivity() {
  return current?.activity ?? null;
}

/**
 * Amethyx skins and capes for this launch: the server gets the account's current skin (so others
 * see it), a modded instance gets CustomSkinLoader with the list of skin sources. Never blocks.
 */
async function prepareAmethyxSkins({ settings, instance, session, selectedId, gameDirectory }) {
  // Lazy: the cloud and content modules are only needed here.
  const { serverUrl } = require('../cloud/cloudClient');
  const base = serverUrl(settings);
  if (base && selectedId) {
    await require('../cloud/cloudSkins')
      .syncAccount(selectedId)
      .catch((error) => pushLogLine(`Скин не отправлен на сервер Amethyx: ${error.message}`));
  }
  const { prepareCustomSkins } = require('./customSkins');
  await prepareCustomSkins({
    settings,
    instance,
    session,
    gameDirectory,
    serverUrl: base,
    installMod: (projectId) => require('../content/contentService').installProject(settings, { instanceId: instance.id, platform: 'modrinth', projectId, title: 'CustomSkinLoader' }),
    onLog: pushLogLine,
  });
}

function broadcastStatus(extra = {}) {
  broadcast(CHANNELS.events.gameState, { ...getStatus(), ...extra });
}

/** What happens to the launcher window while the game runs: 'keep', 'minimize' or 'hide'. */
function setLauncherVisible(visible, mode) {
  // Only the launcher's window: not the skin site or a notice card.
  for (const window of [require('../window').getMainWindow()].filter(Boolean)) {
    if (window.isDestroyed()) {
      continue;
    }
    if (visible) {
      if (!window.isVisible()) {
        window.show();
      }
      window.restore();
      window.focus();
    } else if (mode === 'hide') {
      window.hide();
    } else if (mode === 'minimize') {
      window.minimize();
    }
  }
}

const PRE_LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs an instance's own command (Prism-style "pre-launch" / "post-exit") in the instance folder,
 * with INST_* variables describing the instance. Resolves with the exit code.
 */
function runInstanceCommand(command, instance, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: directory,
      windowsHide: true,
      env: { ...process.env, INST_NAME: instance.name, INST_ID: instance.id, INST_DIR: directory, INST_MC_VERSION: instance.minecraft },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Команда перед запуском работает дольше 5 минут и остановлена.'));
    }, PRE_LAUNCH_TIMEOUT_MS);
    const forward = (chunk) => chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((line) => pushLogLine(`[команда] ${line}`));
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

/**
 * Plays an instance: installs its version and loader when missing, renews the account session
 * and starts the JVM. `instanceId` defaults to the instance selected in settings.
 */
/** options.server joins that server for this launch only (the Servers tab's Play button). */
async function play(requestedInstanceId, options = {}) {
  if (current) {
    throw new Error('Игра уже запущена.');
  }
  if (launchingId) {
    throw new Error('Игра уже запускается.');
  }
  // Claimed before the first await, so a double click cannot start two games.
  launchingId = requestedInstanceId || '…';
  try {
    return await launch(requestedInstanceId, options);
  } finally {
    launchingId = null;
    if (!current) {
      runLog = null;
      broadcastStatus();
    }
  }
}

async function launch(requestedInstanceId, { server = null } = {}) {
  let settings = await getSettings();
  const instanceId = requestedInstanceId || settings.selectedInstanceId;
  if (!instanceId) {
    throw new Error('Выберите сборку для запуска на вкладке «Сборки».');
  }
  launchingId = instanceId;
  broadcastStatus();
  const { selectedId } = await loadAccountStore();
  const session = await getLaunchSession(selectedId);

  if (instanceId !== settings.selectedInstanceId) {
    settings = await updateSettings({ selectedInstanceId: instanceId });
  }
  const layout = instanceService.layoutFor(settings);
  try {
    const migratedTo = await migrateSharedGameData(layout);
    if (migratedTo) {
      pushLogLine(`Миры и настройки из общей папки перенесены в папку сборки ${migratedTo} (instances\\${migratedTo})`);
    }
  } catch (error) {
    log.warn(`Перенос данных игры не удался: ${error.message}`);
  }

  const instance = await instanceService.ensureInstanceReady(settings, instanceId);
  const versionId = instance.versionId;
  const runSettings = instanceService.effectiveSettings(settings, instance);
  // Install and launch both need Java: fetch it first, so a missing runtime is downloaded before the game starts.
  const runtime = await resolveJavaForLaunch(await getRequiredJavaMajor(layout, versionId), runSettings);

  const gameDirectory = layout.instanceDirectory(instance.id);
  runLog = { directory: gameDirectory, lines: [] };
  pushLogLine(`--- Запуск «${instance.name}» (${versionId}) для ${session.username} ---`);
  pushLogLine(`Папка сборки: ${gameDirectory}`);
  const overrides = instance.overrides ?? {};
  if (overrides.autoUpdateMods && instance.loader.type !== 'vanilla') {
    // Lazy: the content service is only needed here.
    const { updateAllContent } = require('../content/contentService');
    pushLogLine('Проверка обновлений модов…');
    try {
      const { updated, failed } = await updateAllContent(settings, instance.id, 'mod', pushLogLine, {
        // Updated mods can break a world: each one is backed up first.
        beforeChange: async () => {
          const { backupAllWorlds } = require('./worldBackups');
          const count = await backupAllWorlds(instance.directory ?? layout.instanceDirectory(instance.id), 'Перед обновлением модов');
          if (count) pushLogLine(`Сделаны копии миров: ${count}`);
        },
      });
      pushLogLine(updated.length || failed.length ? `Модов обновлено: ${updated.length}${failed.length ? `, не удалось: ${failed.length}` : ''}` : 'Все моды актуальны');
    } catch (error) {
      // No network or the site is down: play with the mods that are there.
      pushLogLine(`Обновления модов не проверены: ${error.message}`);
    }
  }
  if (overrides.preLaunchCommand) {
    pushLogLine(`Команда перед запуском: ${overrides.preLaunchCommand}`);
    const code = await runInstanceCommand(overrides.preLaunchCommand, instance, gameDirectory);
    if (code !== 0) {
      throw new Error(`Команда перед запуском завершилась с кодом ${code}: игра не запущена.`);
    }
  }
  const afterLaunch = overrides.afterLaunch ?? settings.afterLaunch;
  await prepareAmethyxSkins({ settings, instance, session, selectedId, gameDirectory });
  const skinAgent = await prepareSkinAgent({ session, layout, versionId, onLog: pushLogLine });
  let child;
  try {
    child = await startGameProcess({
      versionId,
      layout,
      gameDirectory,
      homeKey: instance.id,
      settings: runSettings,
      session,
      runtime,
      options: { ...instanceService.launchOptions(settings, instance), ...(server ? { joinServer: server } : {}) },
      agentArguments: skinAgent?.args ?? [],
      extraEnv: skinAgent?.env ?? {},
      onLog: pushLogLine,
    });
  } catch (error) {
    await skinAgent?.stop();
    throw error;
  }

  const startedAt = new Date();
  current = {
    instanceId: instance.id,
    versionId,
    child,
    startedAt: startedAt.toISOString(),
    skinAgent,
    afterLaunch,
    postExit: overrides.postExitCommand ? { command: overrides.postExitCommand, instance, directory: gameDirectory } : null,
    activity: { instanceName: instance.name, minecraft: instance.minecraft, loader: instance.loader.type, server: server || overrides.joinServer || null },
  };
  instanceService.updateInstance(settings, instance.id, { lastPlayedAt: startedAt.toISOString() }).catch(() => {});
  broadcastStatus();
  require('../cloud/cloudFriends').reportPresence();
  if (afterLaunch !== 'keep') {
    setLauncherVisible(false, afterLaunch);
  }

  child.on('error', (error) => {
    log.error(`Не удалось запустить процесс Java: ${error.message}`);
    pushLogLine(`Ошибка запуска Java: ${error.message}`);
    finish(null);
  });
  child.on('exit', (code) => {
    pushLogLine(`--- Игра завершилась с кодом ${code ?? 'неизвестен'} ---`);
    finish(code);
  });
  return getStatus();
}

function finish(exitCode) {
  if (!current) {
    return;
  }
  const { instanceId, versionId, skinAgent, stopRequested, startedAt, afterLaunch, postExit } = current;
  current = null;
  skinAgent?.stop().catch(() => {});
  require('../cloud/tunnel').onGameExit();
  require('../cloud/cloudFriends').reportPresence();
  const finishedRun = runLog;
  runLog = null;
  if (postExit) {
    pushLogLine(`Команда после выхода: ${postExit.command}`);
    runInstanceCommand(postExit.command, postExit.instance, postExit.directory).catch((error) => pushLogLine(`Команда после выхода не выполнена: ${error.message}`));
  }
  // A game stopped from the launcher is not a crash: no error code for the UI.
  const crashed = !stopRequested && exitCode !== 0;
  broadcastStatus({ exitCode: stopRequested ? null : exitCode, instanceId, versionId, analyzing: crashed });
  if (finishedRun) {
    saveLastRun(finishedRun.directory, finishedRun.lines).catch((error) => log.warn(`Журнал запуска не сохранён: ${error.message}`));
    if (crashed) {
      explainCrash(finishedRun, new Date(startedAt), exitCode)
        .then((report) => broadcast(CHANNELS.events.gameCrash, { instanceId, versionId, exitCode, ...report }))
        .catch((error) => log.warn(`Разбор вылета не удался: ${error.message}`));
    }
  }
  getSettings()
    .then(async (settings) => {
      if (afterLaunch !== 'keep') {
        setLauncherVisible(true);
      }
      const instance = await instanceService.getInstance(settings, instanceId);
      const played = Date.now() - new Date(startedAt).getTime();
      await instanceService.updateInstance(settings, instanceId, { playTimeMs: (instance.playTimeMs ?? 0) + played });
      broadcast(CHANNELS.events.instancesChanged, { instanceId });
    })
    .catch((error) => log.warn(`Не удалось обновить данные после игры: ${error.message}`));
}

/**
 * Why the game crashed, as far as the logs tell: the game output and the crash report written
 * during this run are both read. { problems, crash, exitText, logId }.
 */
async function explainCrash(run, startedAt, exitCode) {
  const report = await crashReportSince(run.directory, startedAt).catch(() => null);
  const fromReport = report ? analyzeLog(report.text) : { problems: [], crash: null };
  const fromOutput = analyzeLog(run.lines.join('\n'));
  const problems = [...fromReport.problems];
  for (const problem of fromOutput.problems) {
    if (!problems.some((existing) => existing.id === problem.id)) {
      problems.push(problem);
    }
  }
  return {
    problems,
    crash: fromReport.crash ?? fromOutput.crash,
    exitText: describeExitCode(exitCode),
    logId: report?.id ?? '.amethyx/last-run.log',
  };
}

function stop() {
  if (!current) {
    return getStatus();
  }
  current.stopRequested = true;
  current.child.kill();
  return getStatus();
}

function isInstanceRunning(instanceId) {
  return current?.instanceId === instanceId || launchingId === instanceId;
}

function isVersionRunning(versionId) {
  return current?.versionId === versionId;
}

function getLogs() {
  return [...logLines];
}

module.exports = { play, stop, getStatus, getActivity, getLogs, isInstanceRunning, isVersionRunning };
