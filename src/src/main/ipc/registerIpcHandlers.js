'use strict';

const { handle } = require('./ipcHandle');
const { registerAppHandlers } = require('./appIpc');
const { registerDomainHandlers } = require('./domainIpc');
const { registerSkinHandlers } = require('./skinIpc');
const { registerFriendsHandlers } = require('./friendsIpc');

/** Registers every IPC handler. Called once from the main entry point. */
function registerIpcHandlers() {
  registerAppHandlers(handle);
  registerDomainHandlers(handle);
  registerSkinHandlers(handle);
  registerFriendsHandlers(handle);
}

module.exports = { registerIpcHandlers };
