/*
 * Key combinations for the panel over the game, as Electron accelerators ("Ctrl+Alt+O").
 * The rules match main/settings/hotkeys.js, which checks them again when the setting is saved.
 * Keys are read by their place on the keyboard (event.code), so a Russian layout gives the same
 * combination as an English one, as Windows' global keys do.
 */

export const DEFAULT_OVERLAY_KEY = 'Shift+Tab';

const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);
const NAMED = {
  Tab: 'Tab', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadDecimal: 'numdec', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
};
const TYPING = /^(?:[A-Z0-9]|Space|num[0-9]|numdec|numadd|numsub|nummult|numdiv|[`\-=[\]\\;',./])$/;
const FREE = /^(?:F(?:[1-9]|1[0-9]|2[0-4])|Insert|Delete|Home|End|PageUp|PageDown)$/;
const RESERVED = new Set(['Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Alt+Space', 'Ctrl+Alt+Delete']);
const LABELS = {
  Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Пробел', Backspace: 'Backspace', PageUp: 'PgUp', PageDown: 'PgDn',
  numdec: 'Num .', numadd: 'Num +', numsub: 'Num −', nummult: 'Num *', numdiv: 'Num /',
};

function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/** The modifiers held in a keyboard event, in the launcher's order. */
export function heldModifiers(event) {
  return MODIFIERS.filter((mod) => (mod === 'Ctrl' ? event.ctrlKey : mod === 'Alt' ? event.altKey : event.shiftKey));
}

/**
 * A key press while recording: { done: accelerator } for a full combination,
 * { held: [modifiers] } while only modifiers are down, { error } for one that cannot be used.
 */
export function readCombination(event) {
  if (MODIFIER_KEYS.has(event.key)) {
    return event.key === 'Meta' || event.key === 'OS' ? { error: 'Клавиша Windows не подходит' } : { held: heldModifiers(event) };
  }
  if (event.metaKey) return { error: 'Клавиша Windows не подходит' };
  const key = keyName(event.code);
  if (!key) return { error: 'Эта клавиша не подходит' };
  const mods = heldModifiers(event);
  const accelerator = [...mods, key].join('+');
  if (RESERVED.has(accelerator)) return { error: 'Это сочетание занято Windows' };
  if (TYPING.test(key) && !mods.includes('Ctrl') && !mods.includes('Alt')) {
    return { error: 'Добавьте Ctrl или Alt: иначе клавиша перестанет печатать в чате игры' };
  }
  if (!TYPING.test(key) && !FREE.test(key) && mods.length === 0) {
    return { error: 'Добавьте Ctrl, Alt или Shift: эту клавишу использует игра' };
  }
  return { done: accelerator };
}

/** "Ctrl+Shift+O" → ["Ctrl", "Shift", "O"] for the key caps on screen. */
export function hotkeyParts(accelerator) {
  return String(accelerator || DEFAULT_OVERLAY_KEY)
    .split('+')
    .map((part) => LABELS[part] ?? (/^num[0-9]$/.test(part) ? `Num ${part.slice(3)}` : part));
}

/** "Ctrl + Shift + O": for texts. */
export function hotkeyLabel(accelerator) {
  return hotkeyParts(accelerator).join(' + ');
}
