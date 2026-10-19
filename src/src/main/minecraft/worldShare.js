'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

/*
 * "Позвать в мой мир" without a server of our own: e4mc (MIT, by skye; downloaded from Modrinth like
 * any other mod, never bundled) gives a world opened to LAN a public address such as
 * "abc.e4mc.link", through the e4mc relay. The launcher puts the mod into modded instances before a
 * launch and picks the address up from the game log ("Local game hosted on domain [abc.e4mc.link]");
 * an invite in the chat carries it, and the friend's game simply joins that address.
 * Vanilla instances cannot load mods: their worlds stay open to the local network only.
 */

const MODRINTH_PROJECT = 'qANg5Jrr';
const MOD_FILE = /^e4mc/i;
/** e4mc's address, whatever the language of its chat message. */
const DOMAIN = /\b((?:[a-z0-9-]+\.)+e4mc\.link)\b/i;
const CLOSED = /no longer publicly hosted/i;

/** Is e4mc in the mods folder? 'enabled', 'disabled' (turned off by the player) or null. */
async function modState(modsDirectory) {
  let names = [];
  try {
    names = await fsp.readdir(modsDirectory);
  } catch {
    return null;
  }
  const files = names.filter((name) => MOD_FILE.test(name));
  if (files.some((name) => name.toLowerCase().endsWith('.jar'))) return 'enabled';
  return files.length ? 'disabled' : null;
}

/**
 * Before a launch: a modded instance gets e4mc (it only does something once the world is opened to
 * LAN). Never blocks the launch: a failure is written to the game log.
 */
async function prepareWorldSharing({ instance, gameDirectory, installMod, onLog = () => {} }) {
  if (instance.loader.type === 'vanilla') return;
  try {
    const state = await modState(path.join(gameDirectory, 'mods'));
    if (state === 'disabled') {
      onLog('Игра с друзьями: мод e4mc выключен в этой сборке');
      return;
    }
    if (state) return;
    onLog('Игра с друзьями: ставим мод e4mc…');
    await installMod(MODRINTH_PROJECT);
  } catch (error) {
    onLog(`Игра с друзьями: e4mc не поставлен (${error.message})`);
  }
}

/** A game log line: { address } when e4mc gave the world an address, { closed: true } when it stopped. */
function parseLogLine(line) {
  const domain = DOMAIN.exec(line);
  if (domain) return { address: domain[1].toLowerCase() };
  if (CLOSED.test(line)) return { closed: true };
  return null;
}

/**
 * What the invite dialog can offer now: { kind: 'ready', address } — the world has an e4mc address;
 * 'vanilla' — a vanilla instance (no mods, so no e4mc); 'closed' — the world is not open yet;
 * null — no game is running.
 */
function hostStatus() {
  const activity = require('./gameService').getActivity();
  if (!activity) return null;
  if (activity.worldAddress) return { kind: 'ready', address: activity.worldAddress };
  if (activity.loader === 'vanilla') return { kind: 'vanilla' };
  return { kind: 'closed' };
}

module.exports = { prepareWorldSharing, parseLogLine, hostStatus, MODRINTH_PROJECT };
