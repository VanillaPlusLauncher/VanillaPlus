'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { shell } = require('electron');
const { CHANNELS } = require('../../shared/channels');
const { broadcast } = require('../core/broadcast');
const { getAppPaths } = require('../core/paths');
const { getSettings } = require('../settings/settingsService');
const instanceService = require('../minecraft/instanceService');
const devServer = require('../dev/devServer');
const devGuard = require('../dev/devGuard');

/** Folders of an instance the «Разработчик» section opens (made when missing, like config before a first launch). */
const INSTANCE_FOLDERS = new Set(['', 'mods', 'config', 'logs', 'crash-reports', 'saves', 'resourcepacks', 'shaderpacks', '.mixin.out']);

/** Handlers of developer mode (Settings → «Разработчик»). */
function registerDevHandlers(handle) {
  handle(CHANNELS.dev.status, () => devServer.getStatus());
  handle(CHANNELS.dev.newKey, () => devServer.renewKey());
  // Only the window answers the AI's questions: the API itself has no way to say yes.
  handle(CHANNELS.dev.answer, (_event, id, yes) => devGuard.answer(id, yes === true));
  handle(CHANNELS.dev.openFolder, async (_event, instanceId, folder) => {
    let target;
    if (folder === 'launcher-log') {
      const file = path.join(getAppPaths().logsDirectory, 'launcher.log');
      target = (await fsp.stat(file).catch(() => null)) ? file : getAppPaths().logsDirectory;
    } else {
      const name = String(folder ?? '');
      if (!INSTANCE_FOLDERS.has(name)) throw new Error('Неизвестная папка.');
      const instance = await instanceService.getInstance(await getSettings(), String(instanceId));
      target = path.join(instance.directory, name);
      await fsp.mkdir(target, { recursive: true });
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  // «Удалить все тестовые»: the player asked for it in the window (a confirmation there first).
  handle(CHANNELS.dev.removeTests, async () => {
    const settings = await getSettings();
    const gameService = require('../minecraft/gameService');
    const tests = (await instanceService.listInstances(settings)).filter((instance) => instance.test && !gameService.isInstanceRunning(instance.id));
    if (tests.length) require('../content/contentWatcher').stopWatching();
    let removed = 0;
    for (const instance of tests) {
      try {
        await instanceService.deleteInstance(settings, instance.id);
        removed += 1;
      } catch {
        // Being installed or copied now: stays until the next time.
      }
    }
    broadcast(CHANNELS.events.instancesChanged, { instanceId: null });
    return { removed, left: tests.length - removed };
  });
}

module.exports = { registerDevHandlers };
