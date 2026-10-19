'use strict';

const { ipcMain } = require('electron');
const { createLogger } = require('../core/logger');

const log = createLogger('ipc');

/**
 * Registers a request handler. Replies with { ok, data } or { ok: false, error },
 * so the renderer receives readable messages instead of Electron's wrapped errors.
 */
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await handler(event, ...args);
      return { ok: true, data: data ?? null };
    } catch (error) {
      log.error(`${channel}: ${error.stack ?? error.message}`);
      return { ok: false, error: error.message || 'Неизвестная ошибка' };
    }
  });
}

module.exports = { handle };
