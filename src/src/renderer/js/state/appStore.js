import { createStore } from './store.js';

/** Single source of UI state. Mutated only through functions in actions.js. */
export const store = createStore({
  info: null,
  settings: null,
  accounts: [],
  selectedAccountId: null,
  catalog: [],
  catalogStatus: 'idle',
  catalogError: '',
  installedIds: new Set(),
  instances: [],
  instancesStatus: 'idle',
  /** Instance shown on the instance page. */
  openInstanceId: null,
  openInstanceTab: null,
  /** Log the journal tab opens first (a crash report after a crash). */
  openInstanceLog: null,
  /** Instance the catalog installs into, and the content type it shows. */
  browseInstanceId: null,
  browseType: 'mod',
  tasks: {},
  game: { state: 'idle', instanceId: null, versionId: null, startedAt: null, exitCode: null },
  launching: false,
  javaRuntimes: null,
  logs: [],
  logCount: 0,
});

export const MAX_LOG_LINES = 4000;
