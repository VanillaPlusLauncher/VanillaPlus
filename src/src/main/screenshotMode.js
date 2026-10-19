'use strict';

const fsp = require('node:fs/promises');
const { app } = require('electron');
const { createLogger } = require('./core/logger');

const log = createLogger('screenshot');

/**
 * Developer aid: when AMETHYX_SCREENSHOT is set to a file path, the window
 * is captured after the first render and the app exits. Used for visual checks.
 * AMETHYX_SCREENSHOT_ROUTE clicks a sidebar route before capturing.
 * AMETHYX_SCREENSHOT_SCRIPT runs renderer JavaScript (async allowed) before capturing.
 */
function setupScreenshotMode(window) {
  setupMainScript(window);
  const target = process.env.AMETHYX_SCREENSHOT;
  if (!target) {
    return;
  }
  // Renderer errors and warnings go to the launcher log while checking screens.
  window.webContents.on('console-message', (details) => {
    const level = details.level ?? '';
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) {
      log.warn(`renderer: ${details.message} (${details.sourceId ?? ''}:${details.lineNumber ?? ''})`);
    }
  });
  const route = process.env.AMETHYX_SCREENSHOT_ROUTE;
  // A covered window stops painting and capturePage returns an old frame: keep it on top.
  window.webContents.setBackgroundThrottling(false);
  window.setAlwaysOnTop(true, 'screen-saver');
  window.once('ready-to-show', () => window.showInactive());
  window.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (route) {
        await window.webContents.executeJavaScript(`document.querySelector('[data-route="${route}"]')?.click()`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      const script = process.env.AMETHYX_SCREENSHOT_SCRIPT;
      if (script) {
        await window.webContents.executeJavaScript(`(async () => { ${script} })()`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const image = await window.webContents.capturePage();
      await fsp.writeFile(target, image.toPNG());
      log.info(`Скриншот сохранён: ${target}`);
      app.quit();
    }, 2200);
  });
}

/**
 * Developer aid: AMETHYX_MAIN_SCRIPT names a CommonJS file exporting async (context) => {},
 * run in the main process once the window has loaded; the app exits afterwards. The context gives
 * `load(modulePath)` for the launcher's own modules (relative to src/main) and `log(text)`.
 */
function setupMainScript(window) {
  const script = process.env.AMETHYX_MAIN_SCRIPT;
  if (!script) {
    return;
  }
  window.webContents.once('did-finish-load', async () => {
    const path = require('node:path');
    const output = [];
    const context = {
      load: (modulePath) => require(path.join(__dirname, modulePath)),
      log: (text) => output.push(String(text)),
      window,
    };
    try {
      await require(script)(context);
      output.push('MAIN SCRIPT OK');
    } catch (error) {
      output.push(`MAIN SCRIPT FAILED: ${error.stack ?? error.message}`);
    }
    await fsp.writeFile(`${script}.out.txt`, output.join('\n'));
    app.quit();
  });
}

module.exports = { setupScreenshotMode };
