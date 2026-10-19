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
 * Serves project files as app://app/<path>. Requests outside the whitelisted
 * folders, or that escape the project root, are answered with 404.
 */
/**
 * app://mc/<path> serves the textures and sounds the launcher took from Minecraft (see mcResources.js)
 * from its data folder; nothing outside that folder can be reached.
 */
function serveMinecraftResource(relativePath, net) {
  const root = path.join(app.getPath('userData'), 'mc-ui');
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`) || !/\.(png|ogg|json)$/i.test(absolutePath)) {
    return new Response('Not found', { status: 404 });
  }
  // app://mc is another origin for the page (app://app): the CORS header lets it draw these
  // textures on canvases (block icons) and fetch the sounds.
  return net
    .fetch(pathToFileURL(absolutePath).toString())
    .then((response) => {
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, { status: response.status, headers });
    })
    .catch(() => new Response('Not found', { status: 404 }));
}

/**
 * app://instance/<instance id>/screenshots/<file> serves an instance's screenshots to the page
 * (the Screenshots tab). Only image files in that one folder can be reached.
 */
async function serveScreenshot(relativePath, net) {
  // Loaded here: these modules need the app to be ready, the protocol is registered earlier.
  const { getSettings } = require('./settings/settingsService');
  const instanceService = require('./minecraft/instanceService');
  const { screenshotPath } = require('./minecraft/instanceFiles');
  const [id, folder, name, ...rest] = relativePath.split('/');
  if (folder !== 'screenshots' || !name || rest.length > 0) {
    return new Response('Not found', { status: 404 });
  }
  try {
    const instance = await instanceService.getInstance(await getSettings(), id);
    const filePath = screenshotPath(instance.directory, name);
    return filePath ? await net.fetch(pathToFileURL(filePath).toString()) : new Response('Not found', { status: 404 });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function registerAppProtocol(protocol, net) {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let relativePath;
    try {
      relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (url.host === 'mc') {
      return serveMinecraftResource(relativePath, net);
    }
    if (url.host === 'instance') {
      return serveScreenshot(relativePath, net);
    }
    const absolutePath = path.join(PROJECT_ROOT, relativePath);
    // Checked after normalisation, so "src/renderer/../main/..." cannot leave the served folders.
    const normalized = path.relative(PROJECT_ROOT, absolutePath).split(path.sep).join('/');
    const allowed = SERVED_FOLDERS.some((folder) => normalized.startsWith(`${folder}/`));
    if (!allowed) {
      log.warn(`Запрещённый путь: ${relativePath}`);
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(absolutePath).toString());
  });
}

module.exports = { registerAppProtocol, appUrl, APP_SCHEME };
