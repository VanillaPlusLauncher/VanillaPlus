'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { CHANNELS } = require('../../shared/channels');
const { saveSkin, loadSkin, deleteSkin, saveCape, loadCape, deleteCape } = require('../skins/skinStore');
const { publishSoon } = require('../cloud/cloudSkins');
const { assertSkinPng, MAX_SKIN_BYTES } = require('../skins/pngValidation');
const { openSkinSite, modelOf, nameOf } = require('../skins/skinSite');
const { skinByName, accountSkin, uploadMicrosoftSkin, resetMicrosoftSkin, listLibrary, saveToLibrary, removeFromLibrary, listSlots, saveToSlot, clearSlot } = require('../skins/skinSources');
const { loadAccountStore } = require('../accounts/accountStore');
const { getLaunchSession } = require('../accounts/accountService');

/** The Ely.by page where a skin file is uploaded (and put on with the tick). */
const ELY_ADD_SKIN_URL = 'https://ely.by/skins/add';

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

  async function findAccount(accountId) {
    const { accounts } = await loadAccountStore();
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error('Аккаунт не найден.');
    return account;
  }

  /**
   * "Надеть" in the Wardrobe. The launcher keeps the skin for every account (offline: the skin in
   * the game; Ely.by: the Amethyx skin, seen through CustomSkinLoader); a Microsoft account also
   * gets it on its real profile, so everyone on every server sees it. A failed upload keeps the
   * launcher's copy and is reported as `uploadError`.
   */
  handle(CHANNELS.skins.wear, async (_event, accountId, pngBase64, model) => {
    const account = await findAccount(accountId);
    const png = Buffer.from(String(pngBase64 ?? ''), 'base64');
    await saveSkin(account.uuid, png, model);
    publishSoon(account.uuid);
    if (account.type !== 'microsoft') return { uploaded: false };
    try {
      const session = await getLaunchSession(accountId);
      await uploadMicrosoftSkin(session.accessToken, png, model === 'slim' ? 'slim' : 'classic');
      return { uploaded: true };
    } catch (error) {
      return { uploaded: false, uploadError: error.message };
    }
  });

  /** "Сбросить": the launcher's skin is forgotten; a Microsoft profile gets its default skin back. */
  handle(CHANNELS.skins.reset, async (_event, accountId) => {
    const account = await findAccount(accountId);
    if (account.type === 'microsoft') {
      const session = await getLaunchSession(accountId);
      await resetMicrosoftSkin(session.accessToken);
    }
    await deleteSkin(account.uuid);
    publishSoon(account.uuid);
  });

  /**
   * Ely.by has no way for a launcher to change the skin: the PNG is put in a folder shown in
   * Explorer and the site's "add skin" page opens, the file is dropped there by hand.
   */
  handle(CHANNELS.skins.toEly, async (_event, pngBase64, name) => {
    const png = Buffer.from(String(pngBase64 ?? ''), 'base64');
    assertSkinPng(png);
    const directory = path.join(app.getPath('downloads'), 'Amethyx skins');
    await fsp.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${String(name || 'skin').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'skin'}.png`);
    await fsp.writeFile(file, png);
    shell.showItemInFolder(file);
    await shell.openExternal(ELY_ADD_SKIN_URL);
    return file;
  });

  handle(CHANNELS.skins.libraryList, () => listLibrary());
  handle(CHANNELS.skins.librarySave, (_event, name, pngBase64, model) => saveToLibrary(name, Buffer.from(String(pngBase64 ?? ''), 'base64'), model));
  handle(CHANNELS.skins.libraryRemove, (_event, id) => removeFromLibrary(String(id)));

  // The Wardrobe's slots 1…4 (slot 0, the main skin, is the account's own skin above).
  handle(CHANNELS.skins.slotsList, () => listSlots());
  handle(CHANNELS.skins.slotSave, (_event, slot, name, pngBase64, model) => saveToSlot(slot, name, Buffer.from(String(pngBase64 ?? ''), 'base64'), model));
  handle(CHANNELS.skins.slotClear, (_event, slot) => clearSlot(slot));

  // "Скины с сайта": a skin downloaded there goes into the Wardrobe slot that was open (`slot`)
  // and is reported to the window.
  handle(CHANNELS.skins.openSite, (event, site, slot) => {
    const sender = event.sender;
    const send = (payload) => {
      if (!sender.isDestroyed()) sender.send(CHANNELS.events.skinImported, payload);
    };
    openSkinSite(BrowserWindow.fromWebContents(sender), {
      onImported: (item) => send({ item }),
      onError: (error) => send({ error: error.message }),
      save: Number.isInteger(slot) ? (png, name, model) => saveToSlot(slot, name, png, model) : null,
    }, site === 'namemc' ? 'namemc' : 'skindex');
  });

  // "Загрузить PNG": a ready skin from the computer goes into the open Wardrobe slot (or the
  // library), the model found by itself.
  handle(CHANNELS.skins.importFile, async (event, slot) => {
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
    return Number.isInteger(slot) ? saveToSlot(slot, nameOf(path.basename(file)), png, modelOf(png)) : saveToLibrary(nameOf(path.basename(file)), png, modelOf(png));
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
