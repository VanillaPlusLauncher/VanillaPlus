'use strict';

/*
 * e4mc (MIT, by skye), when a player has it in an instance: it gives a world opened to LAN a public
 * address such as "abc.e4mc.link". Friends join the world through the Amethyx tunnel
 * (cloud/tunnel.js), which needs no mod and works for vanilla too, so the launcher no longer puts
 * e4mc in by itself; when the mod is there anyway, its address goes into the invite as well (for
 * friends on older launchers or with another launcher). It is picked up from the game log
 * ("Local game hosted on domain [abc.e4mc.link]").
 */

/** e4mc's address, whatever the language of its chat message. */
const DOMAIN = /\b((?:[a-z0-9-]+\.)+e4mc\.link)\b/i;
const CLOSED = /no longer publicly hosted/i;

/** A game log line: { address } when e4mc gave the world an address, { closed: true } when it stopped. */
function parseLogLine(line) {
  const domain = DOMAIN.exec(line);
  if (domain) return { address: domain[1].toLowerCase() };
  if (CLOSED.test(line)) return { closed: true };
  return null;
}

/** e4mc's address of the world now: { kind: 'ready', address }, { kind: 'closed' }, or null — no game is running. */
function hostStatus() {
  const activity = require('./gameService').getActivity();
  if (!activity) return null;
  if (activity.worldAddress) return { kind: 'ready', address: activity.worldAddress };
  return { kind: 'closed' };
}

module.exports = { parseLogLine, hostStatus };
