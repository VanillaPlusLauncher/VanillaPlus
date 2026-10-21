'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { getAppPaths } = require('../core/paths');
const { SerialQueue } = require('../core/serialQueue');
const { createLogger } = require('../core/logger');
const { createOfflineProfile } = require('./offlineAccount');
const { signInWithMicrosoft, refreshMicrosoftSession } = require('./microsoftAuth');
const { signInWithEly, validateElyToken, refreshElyToken, invalidateElyToken, ElyTwoFactorRequired } = require('./elyAuth');
const { signInWithElyBrowser, refreshElyOAuth, elyOAuthAvailable } = require('./elyOAuth');
const { loadAccountStore, saveAccountStore, encryptSecret, decryptSecret } = require('./accountStore');

const SESSION_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const OFFLINE_ACCESS_TOKEN = '0';
const writeQueue = new SerialQueue();
const log = createLogger('accounts');

/** Strips secrets so that account data can be sent to the renderer. */
function toPublicAccount(account, selectedId) {
  return {
    id: account.id,
    type: account.type,
    username: account.username,
    uuid: account.uuid,
    selected: account.id === selectedId,
  };
}

async function listAccounts() {
  const { accounts, selectedId } = await loadAccountStore();
  return { accounts: accounts.map((account) => toPublicAccount(account, selectedId)), selectedId };
}

function withSelection(store, account) {
  return { selectedId: account.id, accounts: store.accounts };
}

function addOrReplace(accounts, account) {
  const index = accounts.findIndex((existing) => existing.id === account.id);
  if (index >= 0) {
    accounts[index] = account;
  } else {
    accounts.push(account);
  }
}

function addOfflineAccount(rawUsername) {
  return writeQueue.run(async () => {
    const profile = createOfflineProfile(rawUsername);
    const store = await loadAccountStore();
    const existing = store.accounts.find((account) => account.type === 'offline' && account.uuid === profile.uuid);
    const account = existing ?? {
      id: crypto.randomUUID(),
      type: 'offline',
      username: profile.username,
      uuid: profile.uuid,
      createdAt: new Date().toISOString(),
    };
    addOrReplace(store.accounts, account);
    await saveAccountStore(withSelection(store, account));
    log.info(`Офлайн-аккаунт ${account.username} выбран`);
    return toPublicAccount(account, account.id);
  });
}

const DEFAULT_USERNAME = 'Steve';

/**
 * First start (no accounts file yet): an offline profile "Steve" is created and selected, so the
 * game can be played right away. Once the file exists nothing is added again, even if the user
 * removes every account.
 */
async function ensureDefaultAccount() {
  try {
    await fsp.access(getAppPaths().accountsFile);
    return;
  } catch {
    // No accounts file: first start.
  }
  await addOfflineAccount(DEFAULT_USERNAME);
  log.info(`Создан офлайн-профиль по умолчанию ${DEFAULT_USERNAME}`);
}

async function addMicrosoftAccount(parentWindow) {
  // The sign-in window may stay open for minutes: only the file update waits in the queue,
  // so launching the game with another account is not blocked meanwhile.
  const session = await signInWithMicrosoft(parentWindow);
  return writeQueue.run(async () => {
    const store = await loadAccountStore();
    const existing = store.accounts.find((account) => account.type === 'microsoft' && account.uuid === session.profile.id);
    const account = {
      id: existing?.id ?? crypto.randomUUID(),
      type: 'microsoft',
      username: session.profile.username,
      uuid: session.profile.id,
      xuid: session.xuid,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      expiresAt: session.expiresAt,
      secrets: {
        refreshToken: encryptSecret(session.refreshToken),
        minecraftToken: encryptSecret(session.minecraftToken),
      },
    };
    addOrReplace(store.accounts, account);
    await saveAccountStore(withSelection(store, account));
    log.info(`Аккаунт Microsoft ${account.username} добавлен`);
    return toPublicAccount(account, account.id);
  });
}

/**
 * Signs in to Ely.by and stores the account. Returns { twoFactorRequired: true } instead of an
 * account when the password was right but the account needs a code from an authenticator app.
 */
async function addElyAccount({ username, password, totp } = {}) {
  const clientToken = crypto.randomUUID();
  let session;
  try {
    session = await signInWithEly({ username, password, totp, clientToken });
  } catch (error) {
    if (error instanceof ElyTwoFactorRequired) {
      return { twoFactorRequired: true };
    }
    throw error;
  }
  return writeQueue.run(async () => {
    const store = await loadAccountStore();
    const existing = store.accounts.find((account) => account.type === 'ely' && account.uuid === session.profile.id);
    const account = {
      id: existing?.id ?? crypto.randomUUID(),
      type: 'ely',
      username: session.profile.username,
      uuid: session.profile.id,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      secrets: {
        accessToken: encryptSecret(session.accessToken),
        clientToken: encryptSecret(session.clientToken ?? clientToken),
      },
    };
    addOrReplace(store.accounts, account);
    await saveAccountStore(withSelection(store, account));
    log.info(`Аккаунт Ely.by ${account.username} добавлен`);
    return { account: toPublicAccount(account, account.id) };
  });
}

/** Signs in on the Ely.by site in the browser (OAuth) and stores the account. */
async function addElyBrowserAccount() {
  const session = await signInWithElyBrowser();
  return writeQueue.run(async () => {
    const store = await loadAccountStore();
    const existing = store.accounts.find((account) => account.type === 'ely' && account.uuid === session.profile.id);
    const account = {
      id: existing?.id ?? crypto.randomUUID(),
      type: 'ely',
      auth: 'oauth',
      username: session.profile.username,
      uuid: session.profile.id,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      expiresAt: session.expiresAt,
      secrets: {
        accessToken: encryptSecret(session.accessToken),
        ...(session.refreshToken ? { refreshToken: encryptSecret(session.refreshToken) } : {}),
      },
    };
    addOrReplace(store.accounts, account);
    await saveAccountStore(withSelection(store, account));
    log.info(`Аккаунт Ely.by ${account.username} добавлен через сайт`);
    return { account: toPublicAccount(account, account.id) };
  });
}

/** Ely.by account signed in on the site: the token, refreshed with the refresh token when it ran out. */
async function elyOAuthLaunchSession(store, account) {
  let accessToken = decryptSecret(account.secrets?.accessToken);
  if (!accessToken || (account.expiresAt ?? 0) - SESSION_REFRESH_MARGIN_MS < Date.now()) {
    log.info(`Обновляем вход Ely.by ${account.username}`);
    let session;
    try {
      session = await refreshElyOAuth(decryptSecret(account.secrets?.refreshToken), { id: account.uuid, username: account.username });
    } catch (error) {
      if (error.unavailable) throw error;
      throw new Error(`Вход Ely.by аккаунта ${account.username} устарел (${error.message}). Войдите заново.`);
    }
    accessToken = session.accessToken;
    addOrReplace(store.accounts, {
      ...account,
      expiresAt: session.expiresAt,
      secrets: { ...account.secrets, accessToken: encryptSecret(session.accessToken) },
    });
    await saveAccountStore(store);
  }
  return { username: account.username, uuid: account.uuid, accessToken, userType: 'mojang', xuid: '', provider: 'ely' };
}

/** Ely.by session for a launch: the stored token when Ely.by still accepts it, otherwise a refreshed one. */
async function elyLaunchSession(store, account) {
  if (account.auth === 'oauth') {
    return elyOAuthLaunchSession(store, account);
  }
  const accessToken = decryptSecret(account.secrets?.accessToken);
  const clientToken = decryptSecret(account.secrets?.clientToken);
  if (!accessToken || !clientToken) {
    throw new Error(`Сессия Ely.by аккаунта ${account.username} потеряна. Войдите в аккаунт заново.`);
  }
  let session = { accessToken, profile: { id: account.uuid, username: account.username } };
  if (!(await validateElyToken(accessToken))) {
    log.info(`Обновляем сессию Ely.by ${account.username}`);
    try {
      session = await refreshElyToken({ accessToken, clientToken });
    } catch (error) {
      // Ely.by itself is down: its message says so; the account and its token stay.
      if (error.unavailable) throw error;
      throw new Error(`Сессия Ely.by аккаунта ${account.username} устарела (${error.message}). Удалите аккаунт и войдите заново.`);
    }
    const updated = {
      ...account,
      username: session.profile.username,
      uuid: session.profile.id,
      secrets: { accessToken: encryptSecret(session.accessToken), clientToken: account.secrets.clientToken },
    };
    addOrReplace(store.accounts, updated);
    await saveAccountStore(store);
  }
  return {
    username: session.profile.username,
    uuid: session.profile.id,
    accessToken: session.accessToken,
    userType: 'mojang',
    xuid: '',
    provider: 'ely',
  };
}

function removeAccount(accountId) {
  return writeQueue.run(async () => {
    const store = await loadAccountStore();
    const removed = store.accounts.find((account) => account.id === accountId);
    if (removed?.type === 'ely' && removed.auth !== 'oauth') {
      const accessToken = decryptSecret(removed.secrets?.accessToken);
      const clientToken = decryptSecret(removed.secrets?.clientToken);
      if (accessToken && clientToken) {
        await invalidateElyToken({ accessToken, clientToken });
      }
    }
    const accounts = store.accounts.filter((account) => account.id !== accountId);
    const selectedId = store.selectedId === accountId ? (accounts[0]?.id ?? null) : store.selectedId;
    await saveAccountStore({ selectedId, accounts });
    // Lazy: the cloud client loads settings; its session for this account is no longer needed.
    require('../cloud/cloudClient').forgetAccount(accountId).catch(() => {});
    return listAccounts();
  });
}

function selectAccount(accountId) {
  return writeQueue.run(async () => {
    const store = await loadAccountStore();
    if (!store.accounts.some((account) => account.id === accountId)) {
      throw new Error('Аккаунт не найден.');
    }
    await saveAccountStore({ ...store, selectedId: accountId });
    return listAccounts();
  });
}

/**
 * Returns what the game needs to start: name, UUID, access token and user type.
 * Microsoft tokens are renewed when they are close to expiry.
 */
function getLaunchSession(accountId) {
  return writeQueue.run(async () => {
    const store = await loadAccountStore();
    const account = store.accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      throw new Error('Выберите аккаунт в правом верхнем углу или добавьте новый.');
    }
    if (account.type === 'offline') {
      return { username: account.username, uuid: account.uuid, accessToken: OFFLINE_ACCESS_TOKEN, userType: 'legacy', xuid: '', provider: 'offline' };
    }
    if (account.type === 'ely') {
      return elyLaunchSession(store, account);
    }

    const cachedToken = decryptSecret(account.secrets?.minecraftToken);
    if (cachedToken && account.expiresAt - SESSION_REFRESH_MARGIN_MS > Date.now()) {
      return { username: account.username, uuid: account.uuid, accessToken: cachedToken, userType: 'msa', xuid: account.xuid ?? '', provider: 'microsoft' };
    }

    const refreshToken = decryptSecret(account.secrets?.refreshToken);
    if (!refreshToken) {
      throw new Error(`Сессия аккаунта ${account.username} устарела. Добавьте аккаунт Microsoft заново.`);
    }
    log.info(`Обновляем сессию аккаунта ${account.username}`);
    const session = await refreshMicrosoftSession(refreshToken);
    const updated = {
      ...account,
      username: session.profile.username,
      uuid: session.profile.id,
      xuid: session.xuid ?? account.xuid,
      expiresAt: session.expiresAt,
      secrets: {
        refreshToken: encryptSecret(session.refreshToken),
        minecraftToken: encryptSecret(session.minecraftToken),
      },
    };
    addOrReplace(store.accounts, updated);
    await saveAccountStore(store);
    return { username: updated.username, uuid: updated.uuid, accessToken: session.minecraftToken, userType: 'msa', xuid: updated.xuid ?? '', provider: 'microsoft' };
  });
}

module.exports = {
  listAccounts,
  addOfflineAccount,
  addMicrosoftAccount,
  addElyAccount,
  addElyBrowserAccount,
  elyOAuthAvailable,
  ensureDefaultAccount,
  removeAccount,
  selectAccount,
  getLaunchSession,
};
