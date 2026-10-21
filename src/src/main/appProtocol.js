'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const { createLogger } = require('./core/logger');

const APP_SCHEME = 'app';
const PROJECT_ROOT = path.join(__dirname, '..', '..');
/** Only these project folders may be served to the renderer. */
const SERVED_FOLDERS = ['src/renderer', 'assets'];
const log = createLogger('protocol');

/** URL of a renderer page or asset, for example appUrl('src/renderer/index.html'). */
function appUrl(relativePath) {
  return `${APP_SCHEME}://app/${relativePath}`;
}

/**
 * app://mc/<path> serves the textures and sounds the launcher took from Minecraft (see mcResources.js)
 * from its data folder; nothing outside that folder can be reached. app://mc is another origin for
 * the page (app://app): the CORS header lets it draw these textures on canvases (block icons) and
 * fetch the sounds.
 */
function minecraftResource(relativePath) {
  const root = path.join(app.getPath('userData'), 'mc-ui');
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`) || !/\.(png|ogg|json)$/i.test(absolutePath)) return null;
  return { path: absolutePath, headers: { 'Access-Control-Allow-Origin': '*' } };
}

/**
 * app://instance/<instance id>/screenshots/<file> serves an instance's screenshots to the page
 * (the Screenshots tab). Only image files in that one folder can be reached.
 */
async function screenshot(relativePath) {
  // Loaded here: these modules need the app to be ready, the protocol is registered earlier.
  const { getSettings } = require('./settings/settingsService');
  const instanceService = require('./minecraft/instanceService');
  const { screenshotPath } = require('./minecraft/instanceFiles');
  const [id, folder, name, ...rest] = relativePath.split('/');
  if (folder !== 'screenshots' || !name || rest.length > 0) return null;
  try {
    const instance = await instanceService.getInstance(await getSettings(), id);
    const filePath = screenshotPath(instance.directory, name);
    return filePath ? { path: filePath } : null;
  } catch {
    return null;
  }
}

/**
 * The file an app:// request may get ({ path, headers? }), or null. Project files are served from
 * the whitelisted folders only; requests that escape the project root get nothing.
 */
async function resolveRequest(requestUrl) {
  const url = new URL(requestUrl);
  let relativePath;
  try {
    relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (url.host === 'mc') return minecraftResource(relativePath);
  if (url.host === 'instance') return screenshot(relativePath);
  const absolutePath = path.join(PROJECT_ROOT, relativePath);
  // Checked after normalisation, so "src/renderer/../main/..." cannot leave the served folders.
  const normalized = path.relative(PROJECT_ROOT, absolutePath).split(path.sep).join('/');
  if (!SERVED_FOLDERS.some((folder) => normalized.startsWith(`${folder}/`))) {
    log.warn(`Запрещённый путь: ${relativePath}`);
    return null;
  }
  return { path: absolutePath };
}

/**
 * Serves app:// requests. Electron 25+ answers with protocol.handle and net.fetch; the build for
 * Windows 7 and 8 runs on Electron 22, which has neither and serves files with
 * registerFileProtocol (the same files, the same checks).
 */
function registerAppProtocol(protocol, net) {
  if (typeof protocol.handle === 'function' && typeof net?.fetch === 'function') {
    protocol.handle(APP_SCHEME, async (request) => {
      const found = await resolveRequest(request.url);
      if (!found) return new Response('Not found', { status: 404 });
      try {
        const response = await net.fetch(pathToFileURL(found.path).toString());
        if (!found.headers) return response;
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(found.headers)) headers.set(name, value);
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    return;
  }
  protocol.registerFileProtocol(APP_SCHEME, (request, callback) => {
    resolveRequest(request.url)
      .then((found) => callback(found ? { path: found.path, headers: found.headers } : { error: -6 /* FILE_NOT_FOUND */ }))
      .catch(() => callback({ error: -6 }));
  });
}

module.exports = { registerAppProtocol, appUrl, APP_SCHEME };
