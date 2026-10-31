'use strict';

// Electron 22 (the Windows 7 / 8 build): fetch and structuredClone for its older Node.
require('./core/compat').installCompat();
const { app, BrowserWindow, net, protocol } = require('electron');
const { initLogger, createLogger } = require('./core/logger');
const { getAppPaths, getDefaultGameDirectory } = require('./core/paths');
const { setupUserData, finishMigration, takeMigrationNotes } = require('./core/migration');
const { registerIpcHandlers } = require('./ipc/registerIpcHandlers');
const { registerAppProtocol, APP_SCHEME } = require('./appProtocol');
const { createMainWindow, getMainWindow } = require('./window');
const { setupTray, showWindow } = require('./tray');
const { setupScreenshotMode } = require('./screenshotMode');
const { getSettings } = require('./settings/settingsService');
const { ensureMcResources, seedBundledMcResources } = require('./minecraft/mcResources');
const { ensureDefaultAccount } = require('./accounts/accountService');
const { startUpdateChecks, installPendingAtStart } = require('./updates/updateService');
const { startVersionWatch } = require('./minecraft/versionWatcher');

const APP_USER_MODEL_ID = 'dev.amethyx.launcher';

// Windows 7 / 8 and computers with 4 GB or less: Chromium's low-memory mode (smaller caches and
// buffers for the window). Must be set before the app is ready.
if (require('./core/system').isLightSystem()) {
  app.commandLine.appendSwitch('enable-low-end-device-mode');
}

// Must run before the app is ready: lets the renderer load ES modules and fetch assets over app://.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// The data folder is chosen first: the single-instance lock and everything else live in it
// (RichLauncher's folder is renamed here on the first start, see core/migration.js).
setupUserData(app);

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  // A second start brings the window back, also from the tray.
  app.on('second-instance', () => {
    const window = getMainWindow();
    if (window) {
      showWindow(window);
    }
  });

  app.whenReady().then(async () => {
    initLogger(getAppPaths().logsDirectory);
    const log = createLogger('main');
    // A failure in background work (a dropped download, a broken server answer) must not pop up
    // Electron's "JavaScript error in the main process" box: it is logged and the launcher goes on.
    process.on('uncaughtException', (error) => log.error(`Необработанная ошибка: ${error?.stack ?? error}`));
    process.on('unhandledRejection', (reason) => log.warn(`Необработанный отказ: ${reason?.stack ?? reason}`));
    log.info(`Amethyx Launcher ${app.getVersion()} запущен`);
    // An update downloaded last time goes in before the window opens: the launcher closes, updates
    // and opens again by itself.
    if (await installPendingAtStart().catch((error) => log.warn(`Скачанное обновление не установлено: ${error.message}`))) {
      return;
    }
    // Folders of the old name: the game folder, then paths saved in settings and instances.
    getDefaultGameDirectory();
    await finishMigration({ settingsFile: getAppPaths().settingsFile, gameDirectory: async () => (await getSettings()).gameDirectory }).catch((error) =>
      log.warn(`Перенос данных прежней версии не завершён: ${error.message}`),
    );
    takeMigrationNotes().forEach((note) => log.info(note));

    registerAppProtocol(protocol, net);
    registerIpcHandlers();
    // Before the window asks for accounts: the first start already has a profile to play with.
    await ensureDefaultAccount().catch((error) => log.warn(`Профиль по умолчанию не создан: ${error.message}`));
    // The game's look ships with the launcher: in place before the first window, nothing to wait for.
    await seedBundledMcResources();
    const mainWindow = createMainWindow();
    setupTray(mainWindow);
    setupScreenshotMode(mainWindow);

    // Minecraft textures and sounds for the interface: prepared once, in the background.
    getSettings()
      .then((settings) => ensureMcResources(settings))
      .catch((error) => log.warn(`Ресурсы Minecraft для интерфейса не подготовлены: ${error.message}`));

    // New launcher versions: checked a few seconds after start and then every few hours.
    if (!process.env.AMETHYX_SCREENSHOT && !process.env.AMETHYX_MAIN_SCRIPT) {
      // The launcher does not close for an update while a game, a server or a download is running.
      startUpdateChecks({
        busy: () =>
          require('./minecraft/gameService').getStatus().state !== 'idle' ||
          require('./minecraft/serverService').anyServerRunning() ||
          require('./core/progressReporter').runningTaskCount() > 0,
      });
      startVersionWatch();
      // "Online" for friends on the Amethyx server (nothing happens while no server is set up).
      require('./cloud/cloudFriends').startPresence();
      // New messages and read marks, asked for every few seconds.
      require('./cloud/cloudLive').startLive();
      // Friends' worlds and servers are joined directly by their addresses: nothing to reopen (tunnel.js).
      setTimeout(() => require('./cloud/tunnel').restoreJoined().catch((error) => log.warn(`Подключения к друзьям не восстановлены: ${error.message}`)), 8000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Servers made from instances are stopped properly (their worlds are saved) before quitting;
  // friends see "offline" at once.
  let serversStopped = false;
  app.on('before-quit', (event) => {
    const { stopAll } = require('./minecraft/serverService');
    if (serversStopped) {
      return;
    }
    event.preventDefault();
    serversStopped = true;
    require('./cloud/cloudLive').stopLive();
    require('./cloud/tunnel').stopAll();
    Promise.all([stopAll().catch(() => {}), require('./cloud/cloudFriends').stopPresence().catch(() => {})]).finally(() => app.quit());
  });
}
