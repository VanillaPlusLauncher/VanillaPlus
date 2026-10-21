'use strict';

const { CHANNELS } = require('../../shared/channels');
const { getSettings } = require('../settings/settingsService');
const { serverUrl } = require('../cloud/cloudClient');
const friends = require('../cloud/cloudFriends');
const messages = require('../cloud/cloudMessages');
const { followAccount } = require('../cloud/cloudLive');
const { syncAccount } = require('../cloud/cloudSkins');
const worldShare = require('../minecraft/worldShare');

/** Friends, messages and Amethyx skins on the Amethyx server. */
function registerFriendsHandlers(handle) {
  handle(CHANNELS.friends.status, async () => {
    const settings = await getSettings();
    return { available: Boolean(serverUrl(settings)), enabled: settings.social?.online !== false };
  });
  handle(CHANNELS.friends.list, () => friends.listFriends());
  handle(CHANNELS.friends.request, (_event, ns, name) => friends.requestFriend(String(ns), String(name ?? '')));
  handle(CHANNELS.friends.answer, (_event, id, accept) => friends.answerFriend(String(id), accept === true));
  handle(CHANNELS.friends.remove, (_event, id) => friends.removeFriend(String(id)));
  // The selected account changed: status and live connection follow it.
  handle(CHANNELS.friends.ping, async () => {
    await friends.reportPresence();
    await followAccount();
  });
  handle(CHANNELS.friends.syncSkin, (_event, accountId) => syncAccount(String(accountId)));
  handle(CHANNELS.friends.messages, (_event, friendId, before) => messages.listMessages(String(friendId), Number(before) || null));
  handle(CHANNELS.friends.sendText, (_event, friendId, text) => messages.sendText(String(friendId), String(text ?? '')));
  handle(CHANNELS.friends.sendScreenshot, (_event, friendId, instanceId, name, caption) => messages.sendScreenshot(String(friendId), String(instanceId), String(name), String(caption ?? '')));
  handle(CHANNELS.friends.sendInvite, (_event, friendId, invite) =>
    messages.sendInvite(String(friendId), {
      instanceId: String(invite?.instanceId ?? ''),
      server: String(invite?.server ?? ''),
      withPack: invite?.withPack !== false,
      upload: invite?.upload === true,
      world: invite?.world === true,
      // The code from the export dialog, when it already carries the author's files.
      code: typeof invite?.code === 'string' ? invite.code.slice(0, 60000) : null,
    }),
  );
  handle(CHANNELS.friends.hostStatus, () => worldShare.hostStatus());
  handle(CHANNELS.friends.markRead, (_event, friendId) => messages.markRead(String(friendId)));
  handle(CHANNELS.friends.image, (_event, imageId) => messages.imageData(String(imageId)));
  handle(CHANNELS.friends.screenshots, () => messages.recentScreenshots());
}

module.exports = { registerFriendsHandlers };
