'use strict';

const crypto = require('node:crypto');
const { BrowserWindow, session } = require('electron');
const { fetchJson, postForm, postJson, HttpError } = require('../core/http');
const { createLogger } = require('../core/logger');

/*
 * Microsoft sign-in flow used by the official Minecraft launcher:
 *   Microsoft account (OAuth code) -> Xbox Live token -> XSTS token
 *   -> Minecraft services token -> profile and license check.
 * The client id and scope are the ones the official launcher uses.
 */
const CLIENT_ID = '00000000402b5328';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const LIVE_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const LIVE_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_AUTHENTICATE_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTHORIZE_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MINECRAFT_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';
const XBOX_CONTRACT_HEADERS = { 'x-xbl-contract-version': '1' };

const XSTS_ERROR_MESSAGES = {
  2148916233: 'У аккаунта Microsoft нет профиля Xbox. Создайте его на xbox.com и попробуйте снова.',
  2148916235: 'Xbox Live недоступен в вашей стране.',
  2148916236: 'Требуется подтверждение возраста аккаунта Microsoft.',
  2148916238: 'Аккаунт является детским. Добавьте его в семейную группу Microsoft.',
};

const log = createLogger('microsoft-auth');

/** Opens the Microsoft sign-in page in an isolated window and resolves with the OAuth code. */
function requestAuthorizationCode(parentWindow) {
  const authSession = session.fromPartition(`ms-auth-${crypto.randomUUID()}`);
  const authWindow = new BrowserWindow({
    parent: parentWindow ?? undefined,
    modal: Boolean(parentWindow),
    width: 480,
    height: 680,
    title: 'Вход в Microsoft',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: { session: authSession, contextIsolation: true, nodeIntegration: false },
  });

  const authorizeUrl = `${LIVE_AUTHORIZE_URL}?${new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    prompt: 'select_account',
  })}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
    };

    const handleNavigation = (event, url) => {
      if (!url.startsWith(REDIRECT_URI)) {
        return;
      }
      event.preventDefault();
      const params = new URL(url).searchParams;
      const code = params.get('code');
      if (code) {
        settle(resolve, code);
      } else {
        settle(reject, new Error(params.get('error_description') || 'Вход в Microsoft отменён.'));
      }
    };

    authWindow.webContents.on('will-redirect', handleNavigation);
    authWindow.webContents.on('will-navigate', handleNavigation);
    authWindow.on('closed', () => settle(reject, new Error('Окно входа закрыто до завершения.')));
    authWindow.loadURL(authorizeUrl).catch((error) => settle(reject, error));
  }).finally(() => {
    authSession.clearStorageData().catch(() => {});
  });
}

async function exchangeCodeForLiveTokens(code) {
  return postForm(LIVE_TOKEN_URL, {
    client_id: CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });
}

async function refreshLiveTokens(refreshToken) {
  return postForm(LIVE_TOKEN_URL, {
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });
}

async function authenticateXboxLive(liveAccessToken) {
  return postJson(
    XBL_AUTHENTICATE_URL,
    {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${liveAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    XBOX_CONTRACT_HEADERS,
  );
}

async function authorizeXsts(xboxToken) {
  try {
    return await postJson(
      XSTS_AUTHORIZE_URL,
      {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xboxToken] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      },
      XBOX_CONTRACT_HEADERS,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      let xErr = NaN;
      try {
        xErr = Number(JSON.parse(error.body || '{}').XErr);
      } catch {
        // Not JSON: report the HTTP error itself.
      }
      if (XSTS_ERROR_MESSAGES[xErr]) {
        throw new Error(XSTS_ERROR_MESSAGES[xErr]);
      }
    }
    throw error;
  }
}

async function loginMinecraftWithXbox(userHash, xstsToken) {
  return postJson(MINECRAFT_LOGIN_URL, { identityToken: `XBL3.0 x=${userHash};${xstsToken}` });
}

async function assertOwnsJavaEdition(minecraftToken) {
  const entitlements = await fetchJson(MINECRAFT_ENTITLEMENTS_URL, {
    headers: { Authorization: `Bearer ${minecraftToken}` },
  });
  const owned = (entitlements.items ?? []).some((item) => item.name === 'game_minecraft' || item.name === 'product_minecraft');
  if (!owned) {
    throw new Error('На этом аккаунте Microsoft нет лицензии Minecraft Java Edition.');
  }
}

async function fetchMinecraftProfile(minecraftToken) {
  try {
    return await fetchJson(MINECRAFT_PROFILE_URL, { headers: { Authorization: `Bearer ${minecraftToken}` } });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new Error('У аккаунта нет профиля Minecraft. Запустите игру один раз и выберите ник.');
    }
    throw error;
  }
}

/**
 * Turns live tokens into a Minecraft session.
 * Returns { profile, xuid, minecraftToken, expiresAt }.
 */
async function signInWithLiveAccessToken(liveAccessToken) {
  const xbox = await authenticateXboxLive(liveAccessToken);
  const xsts = await authorizeXsts(xbox.Token);
  const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (!userHash) {
    throw new Error('Microsoft не вернул данные пользователя Xbox.');
  }
  const minecraft = await loginMinecraftWithXbox(userHash, xsts.Token);
  await assertOwnsJavaEdition(minecraft.access_token);
  const profile = await fetchMinecraftProfile(minecraft.access_token);
  return {
    profile: { id: profile.id, username: profile.name },
    xuid: xsts.DisplayClaims?.xui?.[0]?.xid ?? null,
    minecraftToken: minecraft.access_token,
    expiresAt: Date.now() + (minecraft.expires_in ?? 86400) * 1000,
  };
}

/** Full interactive sign-in. Returns the stored account fields plus the refresh token. */
async function signInWithMicrosoft(parentWindow) {
  log.info('Начат вход через Microsoft');
  const code = await requestAuthorizationCode(parentWindow);
  const live = await exchangeCodeForLiveTokens(code);
  const minecraftSession = await signInWithLiveAccessToken(live.access_token);
  return { ...minecraftSession, refreshToken: live.refresh_token };
}

/** Renews a Minecraft session from a stored Microsoft refresh token. */
async function refreshMicrosoftSession(refreshToken) {
  const live = await refreshLiveTokens(refreshToken);
  const minecraftSession = await signInWithLiveAccessToken(live.access_token);
  return { ...minecraftSession, refreshToken: live.refresh_token ?? refreshToken };
}

module.exports = { signInWithMicrosoft, refreshMicrosoftSession };
