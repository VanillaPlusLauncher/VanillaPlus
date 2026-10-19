import { store } from '../state/appStore.js';

/** Navigation available to any module (pages and dialogs open each other). */
let navigator = () => {};
const dropHandlers = new Map();

export function setNavigator(navigate) {
  navigator = navigate;
}

export function go(route) {
  // Java lives in Settings now: old links to its page open that section.
  if (route === 'java') {
    store.set({ openSettingsSection: 'java' });
    navigator('settings');
    return;
  }
  navigator(route);
}

/** Opens the page of one instance (mods, worlds, settings). `tab` preselects a tab. */
export function openInstance(instanceId, tab = null) {
  store.set({ openInstanceId: instanceId, openInstanceTab: tab });
  navigator('instance');
}

/** Opens the catalog, installing into the given instance. */
export function browseFor(instanceId, type = 'mod') {
  store.set({ browseInstanceId: instanceId, browseType: type });
  navigator('browse');
}

/**
 * Pages register what dropping files on the window does while they are shown.
 * handler(paths) returns true when it took the files.
 */
export function setDropHandler(route, handler) {
  dropHandlers.set(route, handler);
}

export function dropHandlerFor(route) {
  return dropHandlers.get(route) ?? null;
}
