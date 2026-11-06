'use strict';

/*
 * The key combination that opens the panel over the game (main/overlay.js), as an Electron
 * accelerator: "Shift+Tab", "Ctrl+Alt+O", "F9". The player records any combination in the settings;
 * the same rules are checked there (renderer/js/core/hotkey.js), so keep both in step.
 * The keys are taken only while the game is in front, so a combination must not eat what the game
 * needs: a letter, digit or space alone or with Shift would stop working in the game's chat.
 */

const DEFAULT_OVERLAY_KEY = 'Shift+Tab';
const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];
/** Settings of earlier builds kept one of three presets. */
const PRESETS = { 'shift-tab': 'Shift+Tab', 'alt-x': 'Alt+X', f9: 'F9' };
/** Keys that type something in the chat: they need Ctrl or Alt. */
const TYPING = /^(?:[A-Z0-9]|Space|num[0-9]|numdec|numadd|numsub|nummult|numdiv|[`\-=[\]\\;',./])$/;
/** Keys the game does not use: they can open the panel alone. */
const FREE = /^(?:F(?:[1-9]|1[0-9]|2[0-4])|Insert|Delete|Home|End|PageUp|PageDown)$/;
const OTHER = /^(?:Tab|Enter|Backspace|Up|Down|Left|Right)$/;
/** Windows keeps these for itself. */
const RESERVED = new Set(['Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Alt+Space', 'Ctrl+Alt+Delete']);

/**
 * A valid accelerator in the launcher's order (Ctrl, Alt, Shift, key), or null.
 * Presets of earlier builds are turned into their accelerators.
 */
function normalizeOverlayKey(value) {
  if (typeof value !== 'string') return null;
  if (PRESETS[value]) return PRESETS[value];
  const parts = value.split('+');
  // "Ctrl++" is not used: the plus key is written "Plus" by Electron, and it types a character anyway.
  const key = parts.pop();
  const mods = new Set(parts);
  if (parts.length !== mods.size || parts.some((part) => !MODIFIERS.includes(part))) return null;
  if (!(TYPING.test(key) || FREE.test(key) || OTHER.test(key))) return null;
  if (TYPING.test(key) && !mods.has('Ctrl') && !mods.has('Alt')) return null;
  if (OTHER.test(key) && mods.size === 0) return null;
  const accelerator = [...MODIFIERS.filter((mod) => mods.has(mod)), key].join('+');
  return RESERVED.has(accelerator) ? null : accelerator;
}

module.exports = { DEFAULT_OVERLAY_KEY, normalizeOverlayKey };
