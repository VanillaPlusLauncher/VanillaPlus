'use strict';

const { CHANNELS } = require('../../shared/channels');
const { getSettings } = require('../settings/settingsService');
const { serverUrl } = require('../cloud/cloudClient');
const friends = require('../cloud/cloudFriends');
const messages = require('../cloud/cloudMessages');
const { followAccount } = require('../cloud/cloudLive');
const { syncAccount } = require('../cloud/cloudSkins');
const worldShare = require('../minecraft/worldShare');
const tunnel = require('../cloud/tunnel');

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
      // An own server of that instance, through its tunnel.
      ownServer: invite?.ownServer === true,
      // The code from the export dialog, when it already carries the author's files.
      code: typeof invite?.code === 'string' ? invite.code.slice(0, 60000) : null,
    }),
  );
  // The world opened to LAN (the Amethyx tunnel takes it), and e4mc's public address when that mod is there.
  handle(CHANNELS.friends.hostStatus, () => {
    const world = tunnel.worldStatus();
    if (!world) return null;
    const e4mc = worldShare.hostStatus();
    return { ...world, address: e4mc?.kind === 'ready' ? e4mc.address : null };
  });
  handle(CHANNELS.friends.joinTunnel, (_event, tunnelId, name) => tunnel.joinTunnel(String(tunnelId), { name: String(name ?? '').slice(0, 64) }));

  // The panel over the game (main/overlay.js): what is being played and what can be shared now.
  handle(CHANNELS.overlay.state, async () => {
    const settings = await getSettings();
    const gameService = require('../minecraft/gameService');
    const status = gameService.getStatus();
    const activity = gameService.getActivity();
    let ownServer = null;
    if (status.instanceId) {
      const server = await require('../minecraft/serverService').getServer(settings, status.instanceId).catch(() => null);
      if (server?.exists) ownServer = { running: server.running, tunnel: server.tunnel };
    }
    return {
      instanceId: status.state === 'running' ? status.instanceId : null,
      activity,
      world: tunnel.worldStatus(),
      ownServer,
      key: require('../overlay').overlayKey(),
      ui: { language: settings.ui?.language ?? null, accent: settings.ui?.accent ?? 'amethyst', font: settings.ui?.font ?? 'pixel', style: settings.ui?.style ?? 'pixel', icons: settings.ui?.icons ?? 'color', animations: settings.ui?.animations !== false },
      social: { inviteWithPack: settings.social?.inviteWithPack !== false, inviteUpload: settings.social?.inviteUpload ?? 'always' },
    };
  });
  handle(CHANNELS.overlay.close, () => require('../overlay').hide());
  handle(CHANNELS.friends.markRead, (_event, friendId) => messages.markRead(String(friendId)));
  handle(CHANNELS.friends.image, (_event, imageId) => messages.imageData(String(imageId)));
  handle(CHANNELS.friends.screenshots, () => messages.recentScreenshots());
}

module.exports = { registerFriendsHandlers };
