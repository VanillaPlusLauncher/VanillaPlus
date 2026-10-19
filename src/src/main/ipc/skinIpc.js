'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { BrowserWindow, dialog } = require('electron');
const { CHANNELS } = require('../../shared/channels');
const { saveSkin, loadSkin, deleteSkin, saveCape, loadCape, deleteCape } = require('../skins/skinStore');
const { publishSoon } = require('../cloud/cloudSkins');
const { assertSkinPng, MAX_SKIN_BYTES } = require('../skins/pngValidation');
const { openSkinSite, modelOf, nameOf } = require('../skins/skinSite');
const { skinByName, accountSkin, uploadMicrosoftSkin, listLibrary, saveToLibrary, removeFromLibrary } = require('../skins/skinSources');
const { loadAccountStore } = require('../accounts/accountStore');
const { getLaunchSession } = require('../accounts/accountService');

/** Skin editor storage and PNG export. */
function registerSkinHandlers(handle) {
  // The skin the launcher keeps for a profile (offline: the skin in the game; Microsoft and Ely.by:
  // the Amethyx skin) with its cape. Either part can be missing.
  handle(CHANNELS.skins.get, async (_event, uuid) => {
    const [skin, cape] = await Promise.all([loadSkin(uuid), loadCape(uuid)]);
    if (!skin && !cape) {
      return null;
    }
    return { pngBase64: skin?.png.toString('base64') ?? null, model: skin?.model ?? 'classic', capeBase64: cape?.toString('base64') ?? null };
  });

  handle(CHANNELS.skins.save, async (_event, uuid, pngBase64, model) => {
    await saveSkin(uuid, Buffer.from(String(pngBase64 ?? ''), 'base64'), model);
    publishSoon(uuid);
  });

  handle(CHANNELS.skins.remove, async (_event, uuid) => {
    await deleteSkin(uuid);
    publishSoon(uuid);
  });

  handle(CHANNELS.skins.setCape, async (_event, uuid, pngBase64) => {
    if (pngBase64) {
      await saveCape(uuid, Buffer.from(String(pngBase64), 'base64'));
    } else {
      await deleteCape(uuid);
    }
    publishSoon(uuid);
  });

  handle(CHANNELS.skins.byName, (_event, name, source) => skinByName(name, source === 'ely' ? 'ely' : 'mojang'));

  handle(CHANNELS.skins.accountSkin, async (_event, accountId) => {
    const { accounts } = await loadAccountStore();
    const account = accounts.find((candidate) => candidate.id === accountId);
    return account ? accountSkin(account) : null;
  });

  handle(CHANNELS.skins.uploadMicrosoft, async (_event, accountId, pngBase64, model) => {
    const { accounts } = await loadAccountStore();
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account?.type !== 'microsoft') {
      throw new Error('Загрузить скин в профиль можно только для аккаунта Microsoft.');
    }
    const session = await getLaunchSession(accountId);
    await uploadMicrosoftSkin(session.accessToken, Buffer.from(String(pngBase64 ?? ''), 'base64'), model);
  });

  handle(CHANNELS.skins.libraryList, () => listLibrary());
  handle(CHANNELS.skins.librarySave, (_event, name, pngBase64, model) => saveToLibrary(name, Buffer.from(String(pngBase64 ?? ''), 'base64'), model));
  handle(CHANNELS.skins.libraryRemove, (_event, id) => removeFromLibrary(String(id)));

  // "Скины с сайта": every skin downloaded there lands in the library and is reported to the window.
  handle(CHANNELS.skins.openSite, (event, site) => {
    const sender = event.sender;
    const send = (payload) => {
      if (!sender.isDestroyed()) sender.send(CHANNELS.events.skinImported, payload);
    };
    openSkinSite(BrowserWindow.fromWebContents(sender), {
      onImported: (item) => send({ item }),
      onError: (error) => send({ error: error.message }),
    }, site === 'namemc' ? 'namemc' : 'skindex');
  });

  // "Загрузить PNG": a ready skin from the computer goes into the library (model found by itself).
  handle(CHANNELS.skins.importFile, async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Загрузить скин',
      filters: [{ name: 'PNG', extensions: ['png'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const file = result.filePaths[0];
    const stat = await fsp.stat(file);
    if (stat.size > MAX_SKIN_BYTES) {
      throw new Error('Файл слишком большой для скина.');
    }
    const png = await fsp.readFile(file);
    assertSkinPng(png);
    return saveToLibrary(nameOf(path.basename(file)), png, modelOf(png));
  });

  handle(CHANNELS.skins.exportPng, async (event, pngBase64, suggestedName) => {
    const png = Buffer.from(String(pngBase64 ?? ''), 'base64');
    assertSkinPng(png);
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Сохранить скин',
      defaultPath: path.basename(String(suggestedName || 'skin.png')),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    await fsp.writeFile(result.filePath, png);
    return result.filePath;
  });
}

module.exports = { registerSkinHandlers };
