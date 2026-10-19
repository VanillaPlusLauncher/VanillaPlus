/**
 * Tiny observable store. Subscribers name the keys they care about, so a progress
 * update does not re-render pages that only show account data.
 */
export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  return {
    get: () => state,
    set(patch) {
      const changedKeys = Object.keys(patch).filter((key) => !Object.is(state[key], patch[key]));
      if (changedKeys.length === 0) {
        return;
      }
      state = { ...state, ...patch };
      for (const listener of [...listeners]) {
        if (!listener.keys || listener.keys.some((key) => changedKeys.includes(key))) {
          listener.callback(state, changedKeys);
        }
      }
    },
    /** Calls `callback(state, changedKeys)` when any of `keys` changes. Returns an unsubscribe function. */
    subscribe(keys, callback) {
      const listener = { keys: keys ? [...keys] : null, callback };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
