'use strict';

const fsp = require('node:fs/promises');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { CHANNELS } = require('../../shared/channels');
const { getAppPaths, getDefaultGameDirectory } = require('../core/paths');

/** Window controls, native dialogs and shell helpers. */
function registerAppHandlers(handle) {
  handle(CHANNELS.app.getInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    defaultGameDirectory: getDefaultGameDirectory(),
    dataDirectory: getAppPaths().root,
  }));

  handle(CHANNELS.app.minimizeWindow, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  // Full screen without the taskbar; alue forces it on or off (Esc only leaves). Returns the new state.
  handle(CHANNELS.app.toggleFullscreen, (event, value) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    window.setFullScreen(typeof value === 'boolean' ? value : !window.isFullScreen());
    return window.isFullScreen();
  });

  // Panoramas of other Minecraft versions for the background (minecraft/panoramas.js).
  handle(CHANNELS.app.panoramas, () => require('../minecraft/panoramas').listPanoramas());
  handle(CHANNELS.app.panoramaThumb, (_event, id) => require('../minecraft/panoramas').thumbnail(String(id)));
  handle(CHANNELS.app.panoramaFaces, (_event, id) => require('../minecraft/panoramas').faces(String(id)));

  handle(CHANNELS.app.closeWindow, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  handle(CHANNELS.app.openExternal, async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error('Можно открывать только защищённые (https) ссылки.');
    }
    await shell.openExternal(parsed.toString());
  });

  handle(CHANNELS.app.openFolder, async (_event, folder) => {
    // Only folders may be opened: shell.openPath would launch a file that happens to be passed in.
    await fsp.mkdir(folder, { recursive: true });
    const stats = await fsp.stat(folder);
    if (!stats.isDirectory()) {
      throw new Error('Можно открыть только папку.');
    }
    const error = await shell.openPath(folder);
    if (error) {
      throw new Error(`Не удалось открыть папку: ${error}`);
    }
  });

  handle(CHANNELS.app.pickDirectory, async (event, title) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: title || 'Выберите папку',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  /** options: { title, filters: [{ name, extensions }], multiple } — resolves with paths (empty when cancelled). */
  handle(CHANNELS.app.pickFiles, async (event, options = {}) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: String(options.title || 'Выберите файлы'),
      properties: options.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: Array.isArray(options.filters) ? options.filters : [],
    });
    return result.canceled ? [] : result.filePaths;
  });

  // Text the page made (an exported mod list): the user picks where it goes, nothing else is written.
  handle(CHANNELS.app.saveText, async (event, options = {}) => {
    const content = String(options.content ?? '');
    if (content.length > 5 * 1024 * 1024) {
      throw new Error('Слишком большой файл.');
    }
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: String(options.title || 'Сохранить'),
      defaultPath: String(options.defaultName || 'export.txt').replace(/[\\/:*?"<>|]/g, '_'),
      filters: Array.isArray(options.filters) ? options.filters : [],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    await fsp.writeFile(result.filePath, content, 'utf8');
    return result.filePath;
  });

  handle(CHANNELS.app.setZoom, (event, percent) => {
    const value = Number(percent);
    if (Number.isFinite(value) && value >= 50 && value <= 200) {
      event.sender.setZoomFactor(value / 100);
    }
  });

  handle(CHANNELS.app.pickJavaExecutable, async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Выберите java.exe',
      properties: ['openFile'],
      filters: [{ name: 'Java', extensions: ['exe'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

module.exports = { registerAppHandlers };
