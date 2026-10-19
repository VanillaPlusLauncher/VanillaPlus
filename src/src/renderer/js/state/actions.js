import { api } from '../services/api.js';
import { store, MAX_LOG_LINES } from './appStore.js';
import { toast } from '../components/toast.js';
import { errorMessage } from '../core/format.js';
import { setGameRunning, sfx } from '../core/sound.js';

const FINISHED_TASK_VISIBLE_MS = 3500;

/** Loads everything the UI needs at startup. */
export async function loadInitialData() {
  const [info, settings, accounts, installed, game, logs] = await Promise.all([
    api.app.info(),
    api.settings.get(),
    api.accounts.list(),
    api.versions.installed(),
    api.game.status(),
    api.game.logs(),
  ]);
  store.set({
    info,
    settings,
    accounts: accounts.accounts,
    selectedAccountId: accounts.selectedId,
    installedIds: new Set(installed.map((version) => version.id)),
    game,
    logs,
    logCount: logs.length,
  });
  await refreshInstances();
  const { instances } = store.get();
  if (!settings.selectedInstanceId && instances.length > 0) {
    // Builds made before instances existed: keep the version that was selected, else the last played.
    const previous = instances.find((instance) => instance.id === settings.selectedVersionId);
    const recent = [...instances].sort((a, b) => (b.lastPlayedAt ?? b.createdAt ?? '').localeCompare(a.lastPlayedAt ?? a.createdAt ?? ''))[0];
    await saveSettings({ selectedInstanceId: (previous ?? recent).id });
  }
  loadCatalog().catch(() => {});
}

/** `quiet`: a background refresh keeps the current list on screen instead of a loading state. */
export async function loadCatalog({ force = false, quiet = false } = {}) {
  if (!quiet) {
    store.set({ catalogStatus: 'loading', catalogError: '' });
  }
  try {
    const { versions } = await api.versions.catalog({ force });
    store.set({ catalog: versions, catalogStatus: 'ready' });
  } catch (error) {
    store.set({ catalogStatus: 'error', catalogError: errorMessage(error) });
  }
}

export async function refreshInstalled() {
  const installed = await api.versions.installed();
  store.set({ installedIds: new Set(installed.map((version) => version.id)) });
}

export async function refreshInstances() {
  if (store.get().instancesStatus === 'idle') {
    store.set({ instancesStatus: 'loading' });
  }
  try {
    store.set({ instances: await api.instances.list(), instancesStatus: 'ready' });
  } catch (error) {
    store.set({ instancesStatus: 'error' });
    throw error;
  }
}

export async function refreshAccounts() {
  const { accounts, selectedId } = await api.accounts.list();
  store.set({ accounts, selectedAccountId: selectedId });
}

export async function refreshJavaRuntimes() {
  store.set({ javaRuntimes: await api.java.runtimes() });
}

export async function saveSettings(patch) {
  const settings = await api.settings.update(patch);
  store.set({ settings });
  return settings;
}

export function selectedInstance() {
  const { instances, settings } = store.get();
  return instances.find((instance) => instance.id === settings?.selectedInstanceId) ?? null;
}

export async function selectInstance(instanceId) {
  await saveSettings({ selectedInstanceId: instanceId });
}

export async function updateInstance(instanceId, patch) {
  const instance = await api.instances.update(instanceId, patch);
  await refreshInstances();
  return instance;
}

/** options.server: join this server right after the game starts (this launch only). */
export async function playInstance(instanceId = null, options = {}) {
  store.set({ launching: true });
  sfx('launch');
  try {
    await api.game.play(instanceId, options);
    sfx('gameStarted');
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    store.set({ launching: false });
    refreshInstances().catch(() => {});
  }
}

export async function stopGame() {
  try {
    await api.game.stop();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

/** Applies a progress event pushed from the main process. */
export function applyTaskEvent(event) {
  const previous = store.get().tasks[event.taskId];
  const tasks = { ...store.get().tasks, [event.taskId]: event };
  store.set({ tasks });

  if (event.state !== 'running') {
    setTimeout(() => {
      const current = { ...store.get().tasks };
      if (current[event.taskId] === event) {
        delete current[event.taskId];
        store.set({ tasks: current });
      }
    }, FINISHED_TASK_VISIBLE_MS);
  }
  if (event.state === 'done' && previous?.state === 'running' && ['instance', 'modpack', 'version'].includes(event.kind)) {
    sfx('installed');
  }
  if (event.state === 'done' && event.kind === 'version') {
    refreshInstalled().catch(() => {});
  }
  if (event.state === 'done' && ['version', 'instance', 'modpack', 'content'].includes(event.kind)) {
    refreshInstances().catch(() => {});
  }
  if (event.state === 'done' && event.kind === 'java') {
    refreshJavaRuntimes().catch(() => {});
  }
}

export function applyGameState(game) {
  store.set({ game });
  // Launching or playing: the launcher's music is quiet.
  setGameRunning(game.state === 'running' || game.state === 'launching');
  // A crash the main process is analysing gets its own dialog (crashDialog.js) instead of a toast.
  if (game.state === 'idle' && !game.analyzing && game.exitCode !== undefined && game.exitCode !== null && game.exitCode !== 0) {
    toast(`Игра завершилась с ошибкой (код ${game.exitCode}). Откройте журнал игры.`, 'error', 7000);
  }
}

export function appendLogLine(line) {
  const logs = store.get().logs;
  logs.push(line);
  if (logs.length > MAX_LOG_LINES) {
    logs.splice(0, logs.length - MAX_LOG_LINES);
  }
  store.set({ logCount: store.get().logCount + 1 });
}
