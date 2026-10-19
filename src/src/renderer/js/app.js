import { api } from './services/api.js';
import { LANGUAGES, setLanguage } from './core/i18n.js';
import { askLanguageOnce } from './components/languagePicker.js';
import { store } from './state/appStore.js';
import { applyGameState, applyTaskEvent, appendLogLine, loadCatalog, loadInitialData, refreshInstances } from './state/actions.js';
import { createRouter } from './router/router.js';
import { createShell } from './layout/shell.js';
import { createHomePage } from './pages/homePage.js';
import { createInstancesPage } from './pages/instancesPage.js';
import { createInstancePage } from './pages/instancePage.js';
import { createBrowsePage } from './pages/browsePage.js';
import { createJavaPage } from './pages/javaPage.js';
import { createFriendsPage } from './pages/friendsPage.js';
import { createSettingsPage } from './pages/settingsPage.js';
import { openAccountsModal } from './components/accountsModal.js';
import { openLogModal } from './components/logModal.js';
import { createBackground } from './components/background.js';
import { importModpackFiles, openCreateInstanceModal } from './components/createInstanceModal.js';
import { toast } from './components/toast.js';
import { installDropdowns } from './components/dropdown.js';
import { showCrashDialog } from './components/crashDialog.js';
import { errorMessage } from './core/format.js';
import { initMc, onMcReady } from './core/mc.js';
import { configureSound, installGlobalSounds } from './core/sound.js';
import { dropHandlerFor, setNavigator } from './core/nav.js';

const MAX_PARALLAX_PX = { x: 18, y: 12 };

/**
 * Moves picture backgrounds slightly with the pointer for depth: at most once per frame, and not
 * for the panorama (it moves by itself). Disabled for reduced motion.
 */
function setupParallax() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const background = document.getElementById('app-background');
  let frame = 0;
  let pointer = null;
  const apply = () => {
    frame = 0;
    const x = (pointer.clientX / window.innerWidth - 0.5) * -MAX_PARALLAX_PX.x;
    const y = (pointer.clientY / window.innerHeight - 0.5) * -MAX_PARALLAX_PX.y;
    background.style.setProperty('--parallax-x', `${x.toFixed(1)}px`);
    background.style.setProperty('--parallax-y', `${y.toFixed(1)}px`);
  };
  window.addEventListener(
    'pointermove',
    (event) => {
      const root = document.documentElement;
      if (root.dataset.animations === 'off' || root.dataset.bg === 'panorama' || root.dataset.bg === 'dirt') {
        return;
      }
      pointer = event;
      frame ||= requestAnimationFrame(apply);
    },
    { passive: true },
  );
}

/** The log button in the top bar appears only while a game is running or after one ran. */
function setupLogsButton() {
  const button = document.getElementById('logs-button');
  button.addEventListener('click', () => openLogModal());
  let wasRunning = false;
  store.subscribe(['game', 'logCount'], (state) => {
    button.hidden = state.game.state !== 'running' && state.logCount === 0;
    const running = state.game.state === 'running';
    if (running && !wasRunning && state.settings?.showLogOnLaunch) {
      openLogModal();
    }
    wasRunning = running;
  });
}

/** Appearance settings: theme colour, font, blur, animations, zoom and background. */
/** The chosen language, or the system's when none was chosen yet (Russian for ru/uk/be/kk, else English). */
function resolveLanguage(chosen) {
  if (chosen) return chosen;
  const system = (navigator.language || 'en').slice(0, 2).toLowerCase();
  if (['ru', 'uk', 'be', 'kk'].includes(system)) return 'ru';
  return LANGUAGES.some((entry) => entry.code === system) ? system : 'en';
}

function setupAppearance() {
  const background = createBackground(document.getElementById('app-background'));
  let lastZoom = null;
  const apply = ({ settings }) => {
    if (!settings) {
      return;
    }
    const root = document.documentElement;
    const ui = settings.ui;
    root.dataset.accent = ui.accent;
    root.dataset.font = ui.font;
    root.dataset.sidebar = ui.sidebar ?? 'labels';
    root.dataset.cards = ui.cards ?? 'tile';
    root.dataset.blur = ui.blur ? 'on' : 'off';
    // Every background is a panorama now (of the latest version, a chosen one, or a random one).
    root.dataset.bg = 'panorama';
    root.dataset.animations = ui.animations ? 'on' : 'off';
    background.setKind(ui.background);
    if (ui.scale !== lastZoom) {
      lastZoom = ui.scale;
      api.app.setZoom(ui.scale).catch(() => {});
    }
    configureSound(settings.sounds);
    setLanguage(resolveLanguage(ui.language));
  };
  store.subscribe(['settings'], apply);
}

/**
 * Dropping files on the window: the shown page may take them (mods on an instance page),
 * otherwise modpacks become new instances.
 */
function setupDragAndDrop(router) {
  const overlay = document.getElementById('drop-overlay');
  const overlayText = document.getElementById('drop-overlay-text');
  let depth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) {
      return;
    }
    depth += 1;
    const handler = dropHandlerFor(router.current());
    overlayText.textContent = handler?.hint ?? 'Модпаки (.mrpack, .zip) станут новыми сборками';
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      overlay.hidden = true;
    }
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const paths = [...(event.dataTransfer?.files ?? [])].map((file) => api.app.pathForFile(file)).filter(Boolean);
    if (paths.length === 0) {
      return;
    }
    const handler = dropHandlerFor(router.current());
    if (handler && (await handler(paths))) {
      return;
    }
    const packs = paths.filter((path) => /\.(mrpack|zip)$/i.test(path));
    if (packs.length > 0) {
      importModpackFiles(packs);
    } else {
      toast('Перетащите модпак (.mrpack или .zip) или откройте сборку, чтобы добавить в неё моды.', 'info');
    }
  });
}

/**
 * First start only: a short loading screen while the game's look (panorama, textures, sounds)
 * is fetched from Mojang, instead of showing the plain fallback look. Never blocks for long.
 */
const FIRST_RUN_LOADER_MAX_MS = 12000;

function showFirstRunLoader() {
  const bar = document.createElement('span');
  bar.className = 'first-run__bar';
  const status = document.createElement('span');
  status.className = 'first-run__status';
  status.textContent = 'Загрузка…';
  const box = document.createElement('div');
  box.className = 'first-run__box';
  const logo = document.createElement('img');
  logo.className = 'first-run__logo';
  logo.src = new URL('../../../assets/branding/vanillaplus-mark.png', import.meta.url).href;
  const track = document.createElement('span');
  track.className = 'first-run__track';
  track.append(bar);
  box.append(logo, status, track);
  const overlay = document.createElement('div');
  overlay.className = 'first-run';
  overlay.append(box);
  document.body.append(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    stopReady();
    overlay.classList.add('first-run--leaving');
    setTimeout(() => overlay.remove(), 450);
  };
  const unsubscribe = store.subscribe(['tasks'], ({ tasks }) => {
    const task = tasks['mc-resources'];
    if (task?.state === 'running') {
      bar.style.width = `${task.percent}%`;
    } else if (task?.state === 'error') {
      close();
    }
  });
  const stopReady = onMcReady(() => setTimeout(close, 250));
  setTimeout(close, FIRST_RUN_LOADER_MAX_MS);
}

async function start() {
  let router;
  const shell = createShell({
    onNavigate: (route) => router.navigate(route),
    onOpenAccounts: () => openAccountsModal(),
  });
  router = createRouter({
    host: document.getElementById('page-host'),
    routes: {
      home: createHomePage,
      builds: createInstancesPage,
      instance: createInstancePage,
      browse: createBrowsePage,
      friends: createFriendsPage,
      java: createJavaPage,
      settings: createSettingsPage,
    },
    onChange: (route) => shell.setRoute(route),
  });
  setNavigator((route) => router.navigate(route));

  api.events.onTaskProgress(applyTaskEvent);
  api.events.onGameState(applyGameState);
  api.events.onGameLog(appendLogLine);
  api.events.onInstancesChanged(() => refreshInstances().catch(() => {}));
  api.events.onGameCrash((report) => showCrashDialog(report));
  // The world opened to LAN, and the address e4mc gives it for friends (main/minecraft/worldShare.js).
  api.events.onFriendEvent((event) => {
    if (event.type === 'lan-open' && !event.shared) toast('Мир открыт для сети. В сборке без модов друг зайдёт, только если вы в одной сети (Wi-Fi, Radmin VPN).', 'info', 8000);
    else if (event.type === 'world-shared') toast('Мир доступен друзьям. Позвать: «Друзья» → ▶ в чате.', 'success', 7000);
    else if (event.type === 'world-closed') toast('Мир больше не открыт для друзей.', 'info', 5000);
  });
  // New Minecraft versions: the list refreshes by itself, a new release is announced.
  api.events.onVersionsChanged(() => loadCatalog({ quiet: true }).catch(() => {}));
  api.events.onMinecraftReleased((version) => {
    toast(`Вышел Minecraft ${version.id}${version.type === 'snapshot' ? ' (снапшот)' : ''}`, 'info', 15000, {
      title: 'Новая версия',
      icon: 'nether_star',
      action: { label: 'Создать сборку', onClick: () => { router.navigate('builds'); openCreateInstanceModal({ minecraft: version.id, type: version.type }); } },
    });
  });
  // A downloaded update is announced once; Settings → Updates installs it.
  let announcedUpdate = null;
  api.events.onUpdateStatus((status) => {
    if (status.state === 'ready' && status.latest?.version !== announcedUpdate) {
      announcedUpdate = status.latest.version;
      toast(`Версия ${status.latest.version} скачана и готова к установке`, 'info', 12000, {
        title: 'Обновление лаунчера',
        icon: 'clock_00',
        action: { label: 'Обновить', onClick: () => { store.set({ openSettingsSection: 'updates' }); router.navigate('settings'); } },
      });
    }
  });

  setupAppearance();
  setupParallax();
  setupLogsButton();
  setupDragAndDrop(router);
  installGlobalSounds();
  installDropdowns();
  initMc().then((ready) => {
    if (!ready) {
      showFirstRunLoader();
    }
  });

  // Home is shown at once and fills in as data arrives; a page the user opens meanwhile stays open.
  router.navigate('home');
  try {
    await loadInitialData();
  } catch (error) {
    toast(errorMessage(error), 'error', 8000);
  }
  // The very first start: which language (Windows' one is offered first).
  askLanguageOnce(resolveLanguage(null));
}

start();
