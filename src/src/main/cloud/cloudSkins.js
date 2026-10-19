'use strict';

const crypto = require('node:crypto');
const { createLogger } = require('../core/logger');
const { loadSkin, loadCape } = require('../skins/skinStore');

/*
 * Keeps the Amethyx server in step with the skins and capes saved in the launcher, so other
 * Amethyx players see them (CustomSkinLoader asks the server by player name). What was sent last
 * is remembered in cloud.json, so an unchanged skin is not uploaded again.
 */

const DELAY_MS = 1500;
const log = createLogger('cloud-skins');
const timers = new Map();

const hashOf = (buffer) => (buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null);
const sameUuid = (a, b) => String(a ?? '').replace(/-/g, '').toLowerCase() === String(b ?? '').replace(/-/g, '').toLowerCase();

/** Sends the account's skin and cape when they differ from what the server has. */
async function syncAccount(accountId) {
  // Lazy: cloudClient reads settings and accounts, which skinIpc must not load at startup.
  const { callAs, findAccount, readStore, updateStore, serverUrl } = require('./cloudClient');
  const { getSettings } = require('../settings/settingsService');
  if (!serverUrl(await getSettings())) return false;
  const account = await findAccount(accountId);
  const [skin, cape] = await Promise.all([loadSkin(account.uuid), loadCape(account.uuid)]);
  const wanted = { skin: hashOf(skin?.png), model: skin?.model ?? null, cape: hashOf(cape) };
  const sent = (await readStore()).published[accountId] ?? { skin: null, model: null, cape: null };
  if (wanted.skin !== sent.skin || wanted.model !== sent.model) {
    await (skin ? callAs(accountId, 'PUT', '/v1/me/skin', { png: skin.png.toString('base64'), model: skin.model }) : callAs(accountId, 'DELETE', '/v1/me/skin'));
  }
  if (wanted.cape !== sent.cape) {
    await (cape ? callAs(accountId, 'PUT', '/v1/me/cape', { png: cape.toString('base64') }) : callAs(accountId, 'DELETE', '/v1/me/cape'));
  }
  await updateStore((store) => {
    store.published[accountId] = wanted;
  });
  return true;
}

/** After a skin or cape is saved: sends it a moment later (several changes in a row go as one). */
function publishSoon(uuid) {
  clearTimeout(timers.get(uuid));
  timers.set(
    uuid,
    setTimeout(async () => {
      timers.delete(uuid);
      try {
        const { loadAccountStore } = require('../accounts/accountStore');
        const { accounts } = await loadAccountStore();
        for (const account of accounts.filter((candidate) => sameUuid(candidate.uuid, uuid))) {
          await syncAccount(account.id);
        }
      } catch (error) {
        log.warn(`Скин не отправлен на сервер Amethyx: ${error.message}`);
      }
    }, DELAY_MS),
  );
}

module.exports = { syncAccount, publishSoon };
