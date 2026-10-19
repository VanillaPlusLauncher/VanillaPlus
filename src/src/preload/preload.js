'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { CHANNELS } = require('../shared/channels');

/** Calls a handler and unwraps the { ok, data | error } envelope from the main process. */
async function invoke(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) {
    throw new Error(reply.error);
  }
  return reply.data;
}

/** Subscribes to a main-process event. Returns an unsubscribe function. */
function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/**
 * The only API the renderer can reach. Each method maps to one IPC channel,
 * so the renderer never gets Node or Electron objects.
 */
const bridge = {
  app: {
    info: () => invoke(CHANNELS.app.getInfo),
    minimizeWindow: () => invoke(CHANNELS.app.minimizeWindow),
    toggleFullscreen: (value) => invoke(CHANNELS.app.toggleFullscreen, value),
    panoramas: () => invoke(CHANNELS.app.panoramas),
    panoramaThumb: (id) => invoke(CHANNELS.app.panoramaThumb, id),
    panoramaFaces: (id) => invoke(CHANNELS.app.panoramaFaces, id),
    closeWindow: () => invoke(CHANNELS.app.closeWindow),
    openExternal: (url) => invoke(CHANNELS.app.openExternal, url),
    openFolder: (folder) => invoke(CHANNELS.app.openFolder, folder),
    pickDirectory: (title) => invoke(CHANNELS.app.pickDirectory, title),
    pickJavaExecutable: () => invoke(CHANNELS.app.pickJavaExecutable),
    pickFiles: (options) => invoke(CHANNELS.app.pickFiles, options),
    setZoom: (percent) => invoke(CHANNELS.app.setZoom, percent),
    /** Asks where to save content (text) and writes it. Resolves with the path or null. */
    saveText: (options) => invoke(CHANNELS.app.saveText, options),
    /** Disk path of a file dropped onto the window (drag and drop of mods and packs). */
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  settings: {
    get: () => invoke(CHANNELS.settings.get),
    update: (patch) => invoke(CHANNELS.settings.update, patch),
    reset: () => invoke(CHANNELS.settings.reset),
  },
  accounts: {
    list: () => invoke(CHANNELS.accounts.list),
    addOffline: (username) => invoke(CHANNELS.accounts.addOffline, username),
    addMicrosoft: () => invoke(CHANNELS.accounts.addMicrosoft),
    addEly: (credentials) => invoke(CHANNELS.accounts.addEly, credentials),
    addElyBrowser: () => invoke(CHANNELS.accounts.addElyBrowser),
    elyBrowserAvailable: () => invoke(CHANNELS.accounts.elyBrowserAvailable),
    remove: (id) => invoke(CHANNELS.accounts.remove, id),
    select: (id) => invoke(CHANNELS.accounts.select, id),
  },
  versions: {
    catalog: (options) => invoke(CHANNELS.versions.catalog, options),
    installed: () => invoke(CHANNELS.versions.installed),
    install: (versionId) => invoke(CHANNELS.versions.install, versionId),
    uninstall: (versionId) => invoke(CHANNELS.versions.uninstall, versionId),
    loaders: (type, minecraft) => invoke(CHANNELS.versions.loaders, type, minecraft),
  },
  instances: {
    list: () => invoke(CHANNELS.instances.list),
    create: (fields) => invoke(CHANNELS.instances.create, fields),
    update: (id, patch) => invoke(CHANNELS.instances.update, id, patch),
    remove: (id) => invoke(CHANNELS.instances.remove, id),
    duplicate: (id, name) => invoke(CHANNELS.instances.duplicate, id, name),
    install: (id, options) => invoke(CHANNELS.instances.install, id, options ?? {}),
    worlds: (id) => invoke(CHANNELS.instances.worlds, id),
    setIcon: (id, filePath) => invoke(CHANNELS.instances.setIcon, id, filePath),
    screenshots: (id) => invoke(CHANNELS.instances.screenshots, id),
    deleteScreenshot: (id, name) => invoke(CHANNELS.instances.deleteScreenshot, id, name),
    files: (id, relativePath) => invoke(CHANNELS.instances.files, id, relativePath ?? ''),
    openEntry: (id, relativePath, options) => invoke(CHANNELS.instances.openEntry, id, relativePath, options ?? {}),
    logs: (id) => invoke(CHANNELS.instances.logs, id),
    readLog: (id, logId) => invoke(CHANNELS.instances.readLog, id, logId),
    backups: (id) => invoke(CHANNELS.instances.backups, id),
    createBackup: (id, world) => invoke(CHANNELS.instances.createBackup, id, world),
    restoreBackup: (id, backupId) => invoke(CHANNELS.instances.restoreBackup, id, backupId),
    deleteBackup: (id, backupId) => invoke(CHANNELS.instances.deleteBackup, id, backupId),
    backupAll: (id, reason) => invoke(CHANNELS.instances.backupAll, id, reason),
  },
  content: {
    search: (params) => invoke(CHANNELS.content.search, params),
    project: (platform, id) => invoke(CHANNELS.content.project, platform, id),
    versions: (platform, id, filters) => invoke(CHANNELS.content.versions, platform, id, filters),
    install: (request) => invoke(CHANNELS.content.install, request),
    list: (instanceId, type) => invoke(CHANNELS.content.list, instanceId, type),
    setEnabled: (instanceId, type, file, enabled) => invoke(CHANNELS.content.setEnabled, instanceId, type, file, enabled),
    remove: (instanceId, type, file) => invoke(CHANNELS.content.remove, instanceId, type, file),
    addFiles: (instanceId, type, paths) => invoke(CHANNELS.content.addFiles, instanceId, type, paths),
    identify: (instanceId, type) => invoke(CHANNELS.content.identify, instanceId, type),
    checkUpdates: (instanceId, type) => invoke(CHANNELS.content.checkUpdates, instanceId, type),
    setEnabledMany: (instanceId, type, files, enabled) => invoke(CHANNELS.content.setEnabledMany, instanceId, type, files, enabled),
    resolveSides: (instanceId) => invoke(CHANNELS.content.resolveSides, instanceId),
    checkCompatibility: (request) => invoke(CHANNELS.content.checkCompatibility, request),
    installDatapack: (request) => invoke(CHANNELS.content.installDatapack, request),
    optimize: (instanceId) => invoke(CHANNELS.content.optimize, instanceId),
    optimizeApply: (instanceId, choices) => invoke(CHANNELS.content.optimizeApply, instanceId, choices ?? {}),
    optimizeUndo: (instanceId) => invoke(CHANNELS.content.optimizeUndo, instanceId),
    scanLaunchers: () => invoke(CHANNELS.content.scanLaunchers),
    importFromLauncher: (request) => invoke(CHANNELS.content.importFromLauncher, request),
    installModpack: (request) => invoke(CHANNELS.content.installModpack, request),
    importModpack: (filePath, fields) => invoke(CHANNELS.content.importModpack, filePath, fields),
  },
  game: {
    play: (instanceId, options) => invoke(CHANNELS.game.play, instanceId ?? null, options ?? {}),
    stop: () => invoke(CHANNELS.game.stop),
    status: () => invoke(CHANNELS.game.status),
    logs: () => invoke(CHANNELS.game.logs),
  },
  skins: {
    get: (uuid) => invoke(CHANNELS.skins.get, uuid),
    save: (uuid, pngBase64, model) => invoke(CHANNELS.skins.save, uuid, pngBase64, model),
    remove: (uuid) => invoke(CHANNELS.skins.remove, uuid),
    setCape: (uuid, pngBase64) => invoke(CHANNELS.skins.setCape, uuid, pngBase64),
    exportPng: (pngBase64, suggestedName) => invoke(CHANNELS.skins.exportPng, pngBase64, suggestedName),
    byName: (name, source) => invoke(CHANNELS.skins.byName, name, source),
    accountSkin: (accountId) => invoke(CHANNELS.skins.accountSkin, accountId),
    uploadMicrosoft: (accountId, pngBase64, model) => invoke(CHANNELS.skins.uploadMicrosoft, accountId, pngBase64, model),
    library: {
      list: () => invoke(CHANNELS.skins.libraryList),
      save: (name, pngBase64, model) => invoke(CHANNELS.skins.librarySave, name, pngBase64, model),
      remove: (id) => invoke(CHANNELS.skins.libraryRemove, id),
      importFile: () => invoke(CHANNELS.skins.importFile),
    },
    openSite: (site) => invoke(CHANNELS.skins.openSite, site),
  },
  friends: {
    status: () => invoke(CHANNELS.friends.status),
    list: () => invoke(CHANNELS.friends.list),
    request: (ns, name) => invoke(CHANNELS.friends.request, ns, name),
    answer: (id, accept) => invoke(CHANNELS.friends.answer, id, accept),
    remove: (id) => invoke(CHANNELS.friends.remove, id),
    ping: () => invoke(CHANNELS.friends.ping),
    syncSkin: (accountId) => invoke(CHANNELS.friends.syncSkin, accountId),
    messages: (friendId, before) => invoke(CHANNELS.friends.messages, friendId, before),
    sendText: (friendId, text) => invoke(CHANNELS.friends.sendText, friendId, text),
    sendScreenshot: (friendId, instanceId, name, caption) => invoke(CHANNELS.friends.sendScreenshot, friendId, instanceId, name, caption),
    sendInvite: (friendId, invite) => invoke(CHANNELS.friends.sendInvite, friendId, invite),
    markRead: (friendId) => invoke(CHANNELS.friends.markRead, friendId),
    image: (imageId) => invoke(CHANNELS.friends.image, imageId),
    screenshots: () => invoke(CHANNELS.friends.screenshots),
    hostStatus: () => invoke(CHANNELS.friends.hostStatus),
  },
  java: {
    runtimes: () => invoke(CHANNELS.java.runtimes),
    install: (majorVersion, vendor) => invoke(CHANNELS.java.install, majorVersion, vendor),
    remove: (javaPath) => invoke(CHANNELS.java.remove, javaPath),
    vendors: () => invoke(CHANNELS.java.vendors),
  },
  server: {
    get: (instanceId) => invoke(CHANNELS.server.get, instanceId),
    create: (instanceId, options) => invoke(CHANNELS.server.create, instanceId, options ?? {}),
    start: (instanceId) => invoke(CHANNELS.server.start, instanceId),
    stop: (instanceId) => invoke(CHANNELS.server.stop, instanceId),
    command: (instanceId, text) => invoke(CHANNELS.server.command, instanceId, text),
    sync: (instanceId) => invoke(CHANNELS.server.sync, instanceId),
    remove: (instanceId) => invoke(CHANNELS.server.remove, instanceId),
  },
  share: {
    makeCode: (instanceId) => invoke(CHANNELS.share.makeCode, instanceId),
    parseCode: (code) => invoke(CHANNELS.share.parseCode, code),
    importCode: (code, fields) => invoke(CHANNELS.share.importCode, code, fields ?? {}),
    /** Asks where to save and writes a .mrpack; resolves with { path, linked, bundled } or null. */
    exportPack: (instanceId, options) => invoke(CHANNELS.share.exportPack, instanceId, options ?? {}),
  },
  updates: {
    status: () => invoke(CHANNELS.updates.status),
    check: () => invoke(CHANNELS.updates.check),
    download: () => invoke(CHANNELS.updates.download),
    install: () => invoke(CHANNELS.updates.install),
  },
  minecraft: {
    resources: () => invoke(CHANNELS.minecraft.resources),
    music: () => invoke(CHANNELS.minecraft.music),
    news: () => invoke(CHANNELS.minecraft.news),
  },
  events: {
    onTaskProgress: (listener) => subscribe(CHANNELS.events.taskProgress, listener),
    onGameState: (listener) => subscribe(CHANNELS.events.gameState, listener),
    onGameLog: (listener) => subscribe(CHANNELS.events.gameLog, listener),
    onMcResources: (listener) => subscribe(CHANNELS.events.mcResources, listener),
    onInstancesChanged: (listener) => subscribe(CHANNELS.events.instancesChanged, listener),
    onGameCrash: (listener) => subscribe(CHANNELS.events.gameCrash, listener),
    onServerLog: (listener) => subscribe(CHANNELS.events.serverLog, listener),
    onServerState: (listener) => subscribe(CHANNELS.events.serverState, listener),
    onUpdateStatus: (listener) => subscribe(CHANNELS.events.updateStatus, listener),
    onVersionsChanged: (listener) => subscribe(CHANNELS.events.versionsChanged, listener),
    onMinecraftReleased: (listener) => subscribe(CHANNELS.events.minecraftReleased, listener),
    onFriendEvent: (listener) => subscribe(CHANNELS.events.friendEvent, listener),
    onSkinImported: (listener) => subscribe(CHANNELS.events.skinImported, listener),
  },
};

contextBridge.exposeInMainWorld('amethyx', bridge);
