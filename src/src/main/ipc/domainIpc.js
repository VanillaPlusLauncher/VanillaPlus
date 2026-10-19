'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { BrowserWindow, dialog } = require('electron');
const { CHANNELS } = require('../../shared/channels');
const settingsService = require('../settings/settingsService');
const accountService = require('../accounts/accountService');
const versionService = require('../minecraft/versionService');
const instanceService = require('../minecraft/instanceService');
const instanceFiles = require('../minecraft/instanceFiles');
const worldBackups = require('../minecraft/worldBackups');
const gameService = require('../minecraft/gameService');
const javaService = require('../java/javaService');
const contentService = require('../content/contentService');
const modpackService = require('../content/modpackService');
const { listLoaderVersions } = require('../minecraft/loaderMeta');
const { ensureMcResources, ensureMusic, readManifest } = require('../minecraft/mcResources');
const { getNews } = require('../minecraft/newsService');
const { broadcast } = require('../core/broadcast');
const updateService = require('../updates/updateService');
const shareService = require('../content/shareService');
const optimizer = require('../content/optimizer');
const serverService = require('../minecraft/serverService');

const MAX_WORLD_ICON_BYTES = 64 * 1024;

/**
 * Handlers for settings, accounts, versions, instances, content, the game and Java.
 * Each handler is a thin adapter: validation and logic live in the services.
 */
function registerDomainHandlers(handle) {
  const settings = () => settingsService.getSettings();
  const instancesChanged = (instanceId = null) => broadcast(CHANNELS.events.instancesChanged, { instanceId });

  // curseforgeBuiltIn: the build carries a CurseForge key, so the catalog works without the user's own.
  const withFlags = (value) => ({ ...value, curseforgeBuiltIn: Boolean(require('../content/curseforge').builtInApiKey()) });
  handle(CHANNELS.settings.get, async () => withFlags(await settingsService.getSettings()));
  handle(CHANNELS.settings.update, async (_event, patch) => withFlags(await settingsService.updateSettings(patch ?? {})));
  handle(CHANNELS.settings.reset, () => settingsService.resetSettings());

  handle(CHANNELS.server.get, async (_event, instanceId) => serverService.getServer(await settings(), String(instanceId)));
  handle(CHANNELS.server.create, async (_event, instanceId, options) => serverService.createServer(await settings(), String(instanceId), options ?? {}));
  handle(CHANNELS.server.start, async (_event, instanceId) => serverService.startServer(await settings(), String(instanceId)));
  handle(CHANNELS.server.stop, (_event, instanceId) => serverService.stopServer(String(instanceId)));
  handle(CHANNELS.server.command, (_event, instanceId, text) => serverService.sendCommand(String(instanceId), String(text ?? '')));
  handle(CHANNELS.server.sync, async (_event, instanceId) => serverService.syncServerContent(await settings(), String(instanceId)));
  handle(CHANNELS.server.remove, async (_event, instanceId) => serverService.deleteServer(await settings(), String(instanceId)));
  handle(CHANNELS.share.makeCode, async (_event, instanceId) => shareService.makeShareCode(await settings(), String(instanceId)));
  handle(CHANNELS.share.parseCode, (_event, code) => shareService.parseShareCode(String(code ?? '').slice(0, 200000)));
  handle(CHANNELS.share.importCode, async (_event, code, fields) => {
    const result = await shareService.importShareCode(await settings(), String(code ?? '').slice(0, 200000), {
      name: fields?.name ? String(fields.name).slice(0, 64) : undefined,
      group: fields?.group ? String(fields.group).slice(0, 40) : '',
    });
    instancesChanged(result.instance.id);
    return result;
  });
  // Formats of "Поделиться" → "Файл": file name suffix, save dialog filter and writer.
  const EXPORTS = {
    modrinth: { suffix: '.mrpack', filter: { name: 'Сборка Modrinth', extensions: ['mrpack'] }, write: shareService.exportMrpack },
    curseforge: { suffix: ' (CurseForge).zip', filter: { name: 'Сборка CurseForge', extensions: ['zip'] }, write: shareService.exportCurseForge },
    zip: { suffix: '.zip', filter: { name: 'Архив сборки', extensions: ['zip'] }, write: shareService.exportInstanceZip },
  };
  handle(CHANNELS.share.exportPack, async (event, instanceId, options) => {
    const format = EXPORTS[options?.format] ?? EXPORTS.modrinth;
    const instance = await instanceService.getInstance(await settings(), String(instanceId));
    const choice = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Сохранить сборку',
      defaultPath: `${instance.name.replace(/[\\/:*?"<>|]/g, '_')}${format.suffix}`,
      filters: [format.filter],
    });
    if (choice.canceled || !choice.filePath) {
      return null;
    }
    return format.write(await settings(), instance.id, choice.filePath, {
      includeConfigs: options?.includeConfigs !== false,
      includeWorlds: options?.includeWorlds !== false,
      includeScreenshots: options?.includeScreenshots === true,
    });
  });
  handle(CHANNELS.updates.status, () => updateService.getUpdateStatus());
  handle(CHANNELS.updates.check, () => updateService.checkForUpdates({ manual: true }));
  handle(CHANNELS.updates.download, () => updateService.downloadUpdate());
  handle(CHANNELS.updates.install, () => updateService.installUpdate({ isGameRunning: () => gameService.getStatus().state !== 'idle' }));

  handle(CHANNELS.accounts.list, () => accountService.listAccounts());
  handle(CHANNELS.accounts.addOffline, (_event, username) => accountService.addOfflineAccount(username));
  handle(CHANNELS.accounts.addMicrosoft, (event) =>
    accountService.addMicrosoftAccount(BrowserWindow.fromWebContents(event.sender)).then(() => accountService.listAccounts()),
  );
  handle(CHANNELS.accounts.addEly, (_event, credentials) => accountService.addElyAccount(credentials ?? {}));
  handle(CHANNELS.accounts.addElyBrowser, () => accountService.addElyBrowserAccount());
  handle(CHANNELS.accounts.elyBrowserAvailable, () => accountService.elyOAuthAvailable());
  handle(CHANNELS.accounts.remove, (_event, accountId) => accountService.removeAccount(accountId));
  handle(CHANNELS.accounts.select, (_event, accountId) => accountService.selectAccount(accountId));

  handle(CHANNELS.versions.catalog, async (_event, options) => versionService.getCatalog(await settings(), { force: Boolean(options?.force) }));
  handle(CHANNELS.versions.installed, async () => versionService.listInstalled(await settings()));
  handle(CHANNELS.versions.install, async (_event, versionId) => {
    await versionService.ensureVersionInstalled(assertVersionId(versionId), await settings());
    return { versionId };
  });
  handle(CHANNELS.versions.uninstall, async (_event, versionId) => {
    const id = assertVersionId(versionId);
    if (gameService.isVersionRunning(id)) {
      throw new Error('Нельзя удалить версию, которая сейчас запущена.');
    }
    await versionService.uninstallVersion(id, await settings());
    return { versionId: id };
  });
  handle(CHANNELS.versions.loaders, (_event, type, minecraft) => listLoaderVersions(String(type), assertVersionId(minecraft)));

  handle(CHANNELS.instances.list, async () => instanceService.listInstances(await settings()));
  handle(CHANNELS.instances.create, async (_event, fields) => {
    const instance = await instanceService.createInstance(await settings(), fields ?? {});
    instancesChanged(instance.id);
    return instance;
  });
  handle(CHANNELS.instances.update, async (_event, id, patch) => {
    // Another Minecraft version or loader can break worlds: they are backed up first.
    if (patch?.minecraft || patch?.loader) {
      const current = await instanceService.getInstance(await settings(), id);
      if ((patch.minecraft && patch.minecraft !== current.minecraft) || (patch.loader && patch.loader.type !== current.loader.type)) {
        await worldBackups.backupAllWorlds(current.directory, `Перед сменой версии на ${patch.minecraft ?? current.minecraft}`);
      }
    }
    const instance = await instanceService.updateInstance(await settings(), id, patch ?? {});
    instancesChanged(id);
    return instance;
  });
  handle(CHANNELS.instances.remove, async (_event, id) => {
    if (gameService.isInstanceRunning(id)) {
      throw new Error('Нельзя удалить сборку, которая сейчас запущена.');
    }
    await instanceService.deleteInstance(await settings(), id);
    instancesChanged(id);
  });
  handle(CHANNELS.instances.duplicate, async (_event, id, name) => {
    const copy = await instanceService.duplicateInstance(await settings(), id, name);
    instancesChanged(copy.id);
    return copy;
  });
  handle(CHANNELS.instances.install, async (_event, id, options) => {
    if (options?.repair && gameService.isInstanceRunning(id)) {
      throw new Error('Закройте игру перед починкой файлов.');
    }
    const instance = options?.repair
      ? await instanceService.repairInstance(await settings(), id)
      : await instanceService.ensureInstanceReady(await settings(), id);
    instancesChanged(id);
    return instance;
  });
  handle(CHANNELS.instances.worlds, async (_event, id) => listWorlds(await instanceService.getInstance(await settings(), id)));
  const instanceDirectory = async (id) => (await instanceService.getInstance(await settings(), String(id))).directory;
  handle(CHANNELS.instances.screenshots, async (_event, id) => instanceFiles.listScreenshots(await instanceDirectory(id)));
  handle(CHANNELS.instances.deleteScreenshot, async (_event, id, name) => instanceFiles.deleteScreenshot(await instanceDirectory(id), String(name)));
  handle(CHANNELS.instances.files, async (_event, id, relativePath) => instanceFiles.listFiles(await instanceDirectory(id), String(relativePath ?? '')));
  handle(CHANNELS.instances.openEntry, async (_event, id, relativePath, options) =>
    instanceFiles.openEntry(await instanceDirectory(id), String(relativePath ?? ''), { reveal: Boolean(options?.reveal) }),
  );
  handle(CHANNELS.instances.logs, async (_event, id) => instanceFiles.listLogs(await instanceDirectory(id)));
  handle(CHANNELS.instances.readLog, async (_event, id, logId) => instanceFiles.readLog(await instanceDirectory(id), String(logId)));

  handle(CHANNELS.instances.backups, async (_event, id) => worldBackups.listBackups(await instanceDirectory(id)));
  handle(CHANNELS.instances.createBackup, async (_event, id, world) => worldBackups.createBackup(await instanceDirectory(id), String(world), { reason: 'Вручную' }));
  handle(CHANNELS.instances.restoreBackup, async (_event, id, backupId) => {
    if (gameService.isInstanceRunning(id)) {
      throw new Error('Закройте игру, а потом восстанавливайте мир.');
    }
    return worldBackups.restoreBackup(await instanceDirectory(id), String(backupId));
  });
  handle(CHANNELS.instances.deleteBackup, async (_event, id, backupId) => worldBackups.deleteBackup(await instanceDirectory(id), String(backupId)));
  handle(CHANNELS.instances.backupAll, async (_event, id, reason) => worldBackups.backupAllWorlds(await instanceDirectory(id), String(reason ?? 'Вручную').slice(0, 80)));
  handle(CHANNELS.instances.setIcon, async (_event, id, filePath) => {
    const instance = await instanceService.setCustomIcon(await settings(), id, String(filePath));
    instancesChanged(id);
    return instance;
  });

  handle(CHANNELS.content.search, async (_event, params) => contentService.search(await settings(), params ?? {}));
  handle(CHANNELS.content.project, async (_event, platform, id) => contentService.getProject(await settings(), platform, String(id)));
  handle(CHANNELS.content.versions, async (_event, platform, id, filters) => contentService.getVersions(await settings(), platform, String(id), filters));
  handle(CHANNELS.content.install, async (_event, request) => {
    const result = await contentService.installProject(await settings(), request ?? {});
    instancesChanged(request?.instanceId);
    return result;
  });
  handle(CHANNELS.content.installDatapack, async (_event, request) => contentService.installDatapack(await settings(), request ?? {}));
  // Instances of other launchers on this computer, and moving one into Amethyx.
  handle(CHANNELS.content.scanLaunchers, () => require('../content/launcherImport').scanLaunchers());
  handle(CHANNELS.content.importFromLauncher, async (_event, request) => {
    const result = await require('../content/launcherImport').importFromLauncher(await settings(), {
      launcherId: String(request?.launcherId ?? ''),
      key: String(request?.key ?? ''),
      name: request?.name ? String(request.name).slice(0, 64) : undefined,
      worlds: request?.worlds !== false,
      screenshots: request?.screenshots !== false,
    });
    instancesChanged(result.instance.id);
    return { instance: result.instance, recognised: result.recognised };
  });
  handle(CHANNELS.content.list, async (_event, instanceId, type) => contentService.listContent(await settings(), instanceId, type));
  handle(CHANNELS.content.setEnabled, async (_event, instanceId, type, file, enabled) =>
    contentService.setEnabled(await settings(), instanceId, type, file, Boolean(enabled)),
  );
  handle(CHANNELS.content.remove, async (_event, instanceId, type, file) => contentService.removeContent(await settings(), instanceId, type, file));
  handle(CHANNELS.content.addFiles, async (_event, instanceId, type, paths) =>
    contentService.addLocalFiles(await settings(), instanceId, type, Array.isArray(paths) ? paths.map(String) : []),
  );
  handle(CHANNELS.content.identify, async (_event, instanceId, type) => contentService.identifyContent(await settings(), instanceId, type));
  handle(CHANNELS.content.checkUpdates, async (_event, instanceId, type) => contentService.checkUpdates(await settings(), instanceId, type));
  handle(CHANNELS.content.setEnabledMany, async (_event, instanceId, type, files, enabled) => {
    if (gameService.isInstanceRunning(instanceId)) {
      throw new Error('Закройте игру, чтобы включать и выключать моды.');
    }
    return contentService.setEnabledMany(await settings(), instanceId, type, Array.isArray(files) ? files.map(String) : [], Boolean(enabled));
  });
  handle(CHANNELS.content.optimize, async (_event, instanceId) => optimizer.suggest(await settings(), String(instanceId)));
  handle(CHANNELS.content.optimizeApply, async (_event, instanceId, choices) => {
    const ids = (value) => (Array.isArray(value) ? value.map(String).slice(0, 100) : []);
    const result = await optimizer.apply(await settings(), String(instanceId), {
      ram: choices?.ram === true,
      java: choices?.java === true,
      video: choices?.video === true,
      mods: ids(choices?.mods),
      problems: ids(choices?.problems),
    });
    instancesChanged(String(instanceId));
    return result;
  });
  handle(CHANNELS.content.optimizeUndo, async (_event, instanceId) => {
    const result = await optimizer.undo(await settings(), String(instanceId));
    instancesChanged(String(instanceId));
    return result;
  });
  handle(CHANNELS.content.checkCompatibility, async (_event, request) => contentService.checkCompatibility(await settings(), String(request?.instanceId ?? ''), request ?? {}));
  handle(CHANNELS.content.resolveSides, async (_event, instanceId) => contentService.resolveSides(await settings(), instanceId));
  handle(CHANNELS.content.installModpack, async (_event, request) => {
    const instance = await modpackService.installModpack(await settings(), request ?? {});
    instancesChanged(instance.id);
    return instance;
  });
  handle(CHANNELS.content.importModpack, async (_event, filePath, fields) => {
    const instance = await modpackService.importPackFile(await settings(), String(filePath), fields ?? {});
    instancesChanged(instance.id);
    return instance;
  });

  handle(CHANNELS.game.play, (_event, instanceId, options) =>
    gameService.play(instanceId ? String(instanceId) : null, { server: typeof options?.server === 'string' ? options.server.trim().slice(0, 255) : null }),
  );
  handle(CHANNELS.game.stop, () => gameService.stop());
  handle(CHANNELS.game.status, () => gameService.getStatus());
  handle(CHANNELS.game.logs, () => gameService.getLogs());

  handle(CHANNELS.java.runtimes, () => javaService.listJavaRuntimes());
  handle(CHANNELS.java.install, (_event, majorVersion, vendor) => javaService.installManagedJava(Number(majorVersion), vendor ? String(vendor) : undefined));
  handle(CHANNELS.java.remove, (_event, javaPath) => javaService.removeJava(javaPath));
  handle(CHANNELS.java.vendors, () => javaService.listVendors());

  handle(CHANNELS.minecraft.resources, async () => {
    const manifest = await readManifest();
    if (manifest) {
      return manifest;
    }
    // First start: built in the background, the window gets an event when it is ready.
    ensureMcResources(await settings()).catch(() => {});
    return null;
  });
  handle(CHANNELS.minecraft.music, async () => ensureMusic(await settings()));
  handle(CHANNELS.minecraft.news, () => getNews());
}

/** Worlds of an instance: folder, name, last played and the world's own icon. */
async function listWorlds(instance) {
  const savesDirectory = path.join(instance.directory, 'saves');
  let entries = [];
  try {
    entries = await fsp.readdir(savesDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const worlds = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const folder = path.join(savesDirectory, entry.name);
    try {
      const level = await fsp.stat(path.join(folder, 'level.dat'));
      let icon = null;
      try {
        const png = await fsp.readFile(path.join(folder, 'icon.png'));
        icon = png.length <= MAX_WORLD_ICON_BYTES ? `data:image/png;base64,${png.toString('base64')}` : null;
      } catch {
        // Worlds from old versions have no icon.
      }
      worlds.push({ folder: entry.name, path: folder, lastPlayedAt: level.mtime.toISOString(), icon });
    } catch {
      // Not a world (no level.dat).
    }
  }
  return worlds.sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt));
}

/** Version ids are used as folder names, so only Mojang-style ids are accepted. */
function assertVersionId(versionId) {
  if (typeof versionId !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(versionId)) {
    throw new Error('Некорректный идентификатор версии.');
  }
  return versionId;
}

module.exports = { registerDomainHandlers };
