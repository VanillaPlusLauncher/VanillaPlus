'use strict';

const { request, HttpError } = require('../core/http');
const { createLogger } = require('../core/logger');

/*
 * Ely.by sign-in. Ely.by runs a Yggdrasil-compatible auth server (the protocol of the old Mojang
 * accounts): a login and password give an access token bound to a client token. The game then
 * talks to Ely.by instead of Mojang through authlib-injector (see skinAgent.js), so skins and
 * servers that check Ely.by sessions work.
 * Docs: https://docs.ely.by/en/minecraft-auth.html
 */
const AUTH_SERVER = 'https://authserver.ely.by/auth';
/** authlib-injector resolves this name to Ely.by's API root (the form Ely.by itself documents). */
const ELY_INJECTOR_TARGET = 'ely.by';
const TWO_FACTOR_MESSAGE = 'Account protected with two factor auth.';
const log = createLogger('ely-auth');

class ElyTwoFactorRequired extends Error {
  constructor() {
    super('Аккаунт Ely.by защищён двухфакторной аутентификацией. Введите код из приложения.');
    this.name = 'ElyTwoFactorRequired';
    this.code = 'ELY_2FA_REQUIRED';
  }
}

/** POSTs JSON to the auth server and returns the parsed answer (empty answers become null). */
async function post(endpoint, payload) {
  try {
    const response = await request(`${AUTH_SERVER}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      retries: 1,
    });
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof HttpError) {
      let body = {};
      try {
        body = JSON.parse(error.body || '{}');
      } catch {
        // Not JSON: keep the HTTP error.
      }
      if (body.errorMessage === TWO_FACTOR_MESSAGE) {
        throw new ElyTwoFactorRequired();
      }
      // A real answer of the auth server (an errorMessage, or 401/403) says the token or password is
      // wrong. Anything else (5xx, an empty 404 while Ely.by is down) means the service is not there
      // right now: the account stays as it is and nobody is told to delete it.
      if (!body.errorMessage && error.status !== 401 && error.status !== 403) {
        const down = new Error('Ely.by сейчас не отвечает. Попробуйте чуть позже: аккаунт удалять не нужно.');
        down.unavailable = true;
        throw down;
      }
      const rejected = new Error(body.errorMessage ? translateError(body.errorMessage) : error.message);
      rejected.rejectedByServer = true;
      throw rejected;
    }
    throw error;
  }
}

function translateError(message) {
  if (/invalid credentials/i.test(message)) {
    return 'Неверный логин, пароль или код двухфакторной аутентификации.';
  }
  if (/invalid token/i.test(message) || /token expired/i.test(message)) {
    return 'Сессия Ely.by устарела. Войдите в аккаунт заново.';
  }
  if (/account.*(banned|deleted)/i.test(message)) {
    return 'Аккаунт Ely.by заблокирован или удалён.';
  }
  return `Ely.by: ${message}`;
}

function toSession(answer) {
  const profile = answer?.selectedProfile;
  if (!answer?.accessToken || !profile?.id) {
    throw new Error('На аккаунте Ely.by нет игрового профиля.');
  }
  return { accessToken: answer.accessToken, clientToken: answer.clientToken, profile: { id: profile.id, username: profile.name } };
}

/**
 * Signs in with a login (nickname or e-mail) and password. `totp` is the two-factor code, if the
 * account has it enabled: Ely.by expects it appended to the password as "password:code".
 * Throws ElyTwoFactorRequired when a code is needed.
 */
async function signInWithEly({ username, password, totp, clientToken }) {
  const login = String(username ?? '').trim();
  if (!login || !password) {
    throw new Error('Введите логин и пароль Ely.by.');
  }
  const code = String(totp ?? '').replace(/\s+/g, '');
  log.info(`Вход в Ely.by: ${login.includes('@') ? 'по e-mail' : login}`);
  const answer = await post('authenticate', {
    username: login,
    password: code ? `${password}:${code}` : password,
    clientToken,
    requestUser: true,
  });
  return toSession(answer);
}

/** True while the access token is still accepted by Ely.by. Network errors count as "unknown" (true). */
async function validateElyToken(accessToken) {
  try {
    await post('validate', { accessToken });
    return true;
  } catch (error) {
    if (error.rejectedByServer) {
      return false;
    }
    log.warn(`Не удалось проверить токен Ely.by: ${error.message}`);
    return true; // Offline: let the game try; the server will tell if the session is gone.
  }
}

/** Exchanges a token for a fresh one. */
async function refreshElyToken({ accessToken, clientToken }) {
  return toSession(await post('refresh', { accessToken, clientToken, requestUser: true }));
}

/** Ends the session on Ely.by. Errors are ignored: the account is removed locally anyway. */
async function invalidateElyToken({ accessToken, clientToken }) {
  try {
    await post('invalidate', { accessToken, clientToken });
  } catch (error) {
    log.warn(`Не удалось завершить сессию Ely.by: ${error.message}`);
  }
}

module.exports = {
  signInWithEly,
  validateElyToken,
  refreshElyToken,
  invalidateElyToken,
  ElyTwoFactorRequired,
  ELY_INJECTOR_TARGET,
};
