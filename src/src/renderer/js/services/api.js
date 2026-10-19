/**
 * The main-process API exposed by src/preload/preload.js.
 * Renderer code must go through this object and never touch Node or Electron directly.
 */
if (!window.vanillaplus) {
  throw new Error('Мост лаунчера не найден: проверьте preload-скрипт.');
}

export const api = window.vanillaplus;
