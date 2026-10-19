'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { shell } = require('electron');
const { request, HttpError } = require('../core/http');
const { createLogger } = require('../core/logger');

/*
 * Sign-in on the Ely.by site (OAuth 2): the browser opens Ely.by, the player signs in there (and
 * can register right away), Ely.by sends the browser back to a page this launcher serves on
 * localhost. The password never passes through the launcher. The token has the
 * minecraft_server_session scope, so the game uses it like a password sign-in token.
 * The launcher's Ely.by application (client id and secret) comes with the build
 * (installer/build.ps1 → build-keys.json); without it only the password form is offered.
 * Docs: https://docs.ely.by/en/oauth.html
 */

const AUTHORIZE_URL = 'https://account.ely.by/oauth2/v1';
const TOKEN_URL = 'https://account.ely.by/api/oauth2/v1/token';
const INFO_URL = 'https://account.ely.by/api/account/v1/info';
// Registered with the application on Ely.by: the address must stay exactly this.
const PORT = 29071;
const REDIRECT_URI = `http://localhost:${PORT}/ely`;
const SCOPES = 'account_info minecraft_server_session offline_access';
const WAIT_MS = 5 * 60 * 1000;
const log = createLogger('ely-oauth');

let keys;
function appKeys() {
  if (keys === undefined) {
    try {
      const file = require('../../build-keys.json');
      keys = file.elyClientId && file.elyClientSecret ? { clientId: String(file.elyClientId), clientSecret: String(file.elyClientSecret) } : null;
    } catch {
      keys = null;
    }
  }
  return keys;
}

/** True when this build can sign in on the Ely.by site. */
function elyOAuthAvailable() {
  return Boolean(appKeys());
}

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>Amethyx</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#110e19;color:#f4f0fb;font:16px system-ui,sans-serif"><div style="text-align:center"><h1 style="font-size:24px">${title}</h1><p style="opacity:.8">${text}</p></div></body>`;

/** Waits for Ely.by to send the browser back with a code. Resolves with the code. */
function waitForCode(state, signal) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== '/ely') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const ok = code && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? page('Готово!', 'Аккаунт Ely.by добавлен в Amethyx. Эту вкладку можно закрыть.') : page('Вход не завершён', 'Вернитесь в Amethyx и попробуйте ещё раз.'));
      finish(ok ? null : new Error(url.searchParams.get('error_message') || 'Ely.by не подтвердил вход.'), code);
    });
    const timer = setTimeout(() => finish(new Error('Вход на сайте Ely.by не завершён за 5 минут.')), WAIT_MS);
    signal?.addEventListener('abort', () => finish(new Error('Вход отменён.')));
    let done = false;
    function finish(error, code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (error) reject(error);
      else resolve(code);
    }
    server.on('error', (error) => finish(error.code === 'EADDRINUSE' ? new Error(`Порт ${PORT} занят другой программой: войдите по логину и паролю.`) : error));
    server.listen(PORT, '127.0.0.1');
  });
}

async function tokenRequest(fields) {
  try {
    const response = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      retries: 1,
    });
    return await response.json();
  } catch (error) {
    if (error instanceof HttpError) {
      let message = '';
      try {
        message = JSON.parse(error.body).message ?? '';
      } catch {
        // Not JSON.
      }
      throw new Error(`Ely.by не выдал доступ${message ? `: ${message}` : ''}.`);
    }
    throw error;
  }
}

function toSession(answer, profile, previousRefresh) {
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? previousRefresh ?? null,
    expiresAt: Date.now() + Number(answer.expires_in ?? 3600) * 1000,
    profile,
  };
}

async function accountInfo(accessToken) {
  const response = await request(INFO_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, retries: 1 });
  const info = await response.json();
  if (!info?.uuid || !info?.username) throw new Error('Ely.by не вернул игровой профиль.');
  return { id: String(info.uuid).replace(/-/g, '').toLowerCase(), username: info.username };
}

/** Opens Ely.by in the browser and waits for the player to sign in there. */
async function signInWithElyBrowser({ signal } = {}) {
  const app = appKeys();
  if (!app) throw new Error('В этой сборке вход через сайт Ely.by не настроен.');
  const state = crypto.randomBytes(16).toString('hex');
  const waiting = waitForCode(state, signal);
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({ client_id: app.clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES, state, description: 'Amethyx Launcher' })}`;
  await shell.openExternal(url);
  log.info('Открыт вход на сайте Ely.by');
  const code = await waiting;
  const answer = await tokenRequest({ client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code', code });
  return toSession(answer, await accountInfo(answer.access_token));
}

/** A fresh token from the refresh token (the scopes must stay the same). */
async function refreshElyOAuth(refreshToken, profile) {
  const app = appKeys();
  if (!app || !refreshToken) throw new Error('Войдите в аккаунт Ely.by заново.');
  const answer = await tokenRequest({ client_id: app.clientId, client_secret: app.clientSecret, scope: SCOPES, refresh_token: refreshToken, grant_type: 'refresh_token' });
  return toSession(answer, profile, refreshToken);
}

module.exports = { signInWithElyBrowser, refreshElyOAuth, elyOAuthAvailable };
