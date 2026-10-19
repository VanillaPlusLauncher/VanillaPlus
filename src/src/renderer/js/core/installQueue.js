import { sfx } from './sound.js';

/*
 * Sounds of installing mods, resource packs and shaders as one queue: a quiet sound when the first
 * install starts, a simple one when the last of them is done — not a sound for every mod when
 * several are installed one after another. The toasts in between are silent.
 */

let active = 0;

/** Call when an install starts; call the returned function when it ends (done or failed). */
export function beginInstall() {
  if (active === 0) sfx('installStart');
  active += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
    if (active === 0) sfx('installEnd');
  };
}
