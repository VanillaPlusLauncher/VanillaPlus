import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { assetUrl } from '../core/assets.js';
import { blockIcon, getMcManifest, hasItem, mcUrl, onMcReady } from '../core/mc.js';
import { accountHead, headRevision } from '../core/skinHead.js';
import { sfx } from '../core/sound.js';
import { store } from '../state/appStore.js';

/** Sidebar entries: route, fallback icon, Minecraft item (or block) shown once textures are ready, label. */
const NAV_ITEMS = [
  { route: 'home', icon: 'home', item: 'map', label: 'Главная', short: 'Главная' },
  { route: 'builds', icon: 'cube', block: 'crafting_table', label: 'Сборки', short: 'Сборки' },
  { route: 'browse', icon: 'download', block: 'bookshelf', label: 'Библиотека', short: 'Библиотека' },
  { route: 'friends', icon: 'user', item: 'cake', label: 'Друзья', short: 'Друзья' },
  { route: 'settings', icon: 'gear', item: 'redstone', label: 'Настройки', short: 'Настройки' },
];
/** Pages without their own sidebar entry highlight their parent. */
const PARENT_ROUTES = { instance: 'builds' };
const ROUTE_TITLES = { ...Object.fromEntries(NAV_ITEMS.map((item) => [item.route, item.label])), instance: 'Сборка', java: 'Настройки' };
const ACCOUNT_TYPES = { microsoft: 'Microsoft', ely: 'Ely.by', offline: 'Офлайн' };

/**
 * Builds the app frame (sidebar, top bar) inside the existing #app-shell element.
 * Returns { setRoute(name) } which the router calls on every navigation.
 */
export function createShell({ onNavigate, onOpenAccounts }) {
  const sidebarNav = document.getElementById('sidebar-nav');
  const indicator = h('span', { class: 'sidebar__indicator', 'aria-hidden': 'true' });
  const tooltip = h('div', { class: 'nav-tooltip', role: 'tooltip' });
  document.body.append(tooltip);

  const buttons = NAV_ITEMS.map((item, index) => {
    const iconSlot = h('span', { class: 'nav-button__icon' }, icon(item.icon));
    const button = h(
      'button',
      {
        class: 'nav-button',
        type: 'button',
        'aria-label': item.label,
        'data-route': item.route,
        onclick: () => {
          sfx('navigate', index);
          onNavigate(item.route);
        },
        onpointerenter: () => document.documentElement.dataset.sidebar !== 'labels' && showTooltip(button, item.label),
        onpointerleave: hideTooltip,
      },
      iconSlot,
      h('span', { class: 'nav-button__label' }, item.short),
    );
    onMcReady(async () => {
      const src = item.block ? await blockIcon(item.block) : hasItem(item.item) ? mcUrl(`item/${item.item}.png`) : null;
      if (src) {
        iconSlot.replaceChildren(h('img', { class: `nav-button__img${item.block ? ' is-smooth' : ''}`, src, alt: '' }));
      }
    });
    return button;
  });
  sidebarNav.replaceChildren(indicator, ...buttons);

  function showTooltip(button, label) {
    const rect = button.getBoundingClientRect();
    tooltip.textContent = label;
    tooltip.style.left = `${rect.right + 14}px`;
    tooltip.style.top = `${rect.top + rect.height / 2 - 16}px`;
    tooltip.classList.add('nav-tooltip--visible');
  }

  function hideTooltip() {
    tooltip.classList.remove('nav-tooltip--visible');
  }

  const titleElement = document.getElementById('topbar-title');
  const accountName = document.getElementById('account-name');
  const accountType = document.getElementById('account-type');
  const accountAvatar = document.getElementById('account-avatar');
  document.getElementById('account-button').addEventListener('click', onOpenAccounts);
  document.getElementById('window-minimize').addEventListener('click', () => api.app.minimizeWindow());
  document.getElementById('window-close').addEventListener('click', () => api.app.closeWindow());
  // Full screen: the button, F11 to switch, Esc to leave. The icon shows what a click will do.
  const fullscreenButton = document.getElementById('window-fullscreen');
  const fullscreenIcon = fullscreenButton.querySelector('.icon');
  async function setFullscreen(value) {
    const on = await api.app.toggleFullscreen(value);
    fullscreenIcon.className = `icon icon--${on ? 'fullscreen-exit' : 'fullscreen'}`;
    const label = on ? 'Выйти из полноэкранного режима' : 'Во весь экран';
    fullscreenButton.setAttribute('aria-label', label);
    fullscreenButton.title = `${label} (F11)`;
    fullscreenButton.dataset.on = String(on);
  }
  fullscreenButton.addEventListener('click', () => setFullscreen());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'F11') {
      event.preventDefault();
      setFullscreen();
    } else if (event.key === 'Escape' && fullscreenButton.dataset.on === 'true' && !document.querySelector('.modal-layer--visible')) {
      setFullscreen(false);
    }
  });

  let currentIndex = 0;
  /** The selection follows the button's real position: each sidebar style has its own sizes. */
  function placeIndicator() {
    const button = buttons[currentIndex];
    // Pages opened from the account menu have no sidebar button: no selection then.
    indicator.style.visibility = button ? '' : 'hidden';
    if (!button) return;
    indicator.style.transform = `translateY(${button.offsetTop}px)`;
    indicator.style.height = `${button.offsetHeight}px`;
  }

  function setRoute(name) {
    const target = PARENT_ROUTES[name] ?? name;
    currentIndex = NAV_ITEMS.findIndex((item) => item.route === target);
    buttons.forEach((button, position) => {
      button.setAttribute('aria-current', position === currentIndex ? 'page' : 'false');
    });
    placeIndicator();
    titleElement.textContent = ROUTE_TITLES[name] ?? '';
  }

  // The sidebar style is a setting: re-measure when it changes.
  new MutationObserver(() => requestAnimationFrame(placeIndicator)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-sidebar'] });
  window.addEventListener('resize', placeIndicator);

  let renderedAccount = null;
  async function renderAccount() {
    const { accounts, selectedAccountId } = store.get();
    const selected = accounts.find((account) => account.id === selectedAccountId);
    accountName.textContent = selected ? selected.username : 'Войти';
    accountType.textContent = selected ? (ACCOUNT_TYPES[selected.type] ?? '') : 'Добавьте аккаунт';
    // Always a player head: the account's skin, or Steve's when it has none.
    const key = `${selected ? `${selected.id}:${selected.username}` : 'none'}:${headRevision()}:${Boolean(getMcManifest())}`;
    if (key === renderedAccount) {
      return;
    }
    renderedAccount = key;
    const head = await accountHead(selected ?? null);
    if (renderedAccount !== key) {
      return;
    }
    accountAvatar.classList.toggle('account-chip__avatar--head', Boolean(head));
    accountAvatar.replaceChildren(head ? h('img', { src: head, alt: '' }) : selected ? selected.username.charAt(0).toUpperCase() : icon('user'));
  }

  store.subscribe(['accounts', 'selectedAccountId'], renderAccount);
  onMcReady(() => renderAccount());
  renderAccount();

  const brandLogo = document.getElementById('brand-logo');
  brandLogo.src = assetUrl('branding/amethyx-mark.png');
  brandLogo.title = 'Главная';
  brandLogo.addEventListener('click', () => {
    sfx('navigate', 0);
    onNavigate('home');
  });
  api.app
    .info()
    .then((info) => {
      // Test builds are "1.7.0-beta.26": shown short, "v1.7.0 β26", the full one in the tooltip.
      const label = document.getElementById('brand-version');
      label.textContent = `v${info.version.replace(/-beta\.(\d+)$/, ' β$1')}`;
      label.title = `Amethyx ${info.version}`;
    })
    .catch(() => {});

  setupTaskIndicator();
  return { setRoute, refreshAccount: () => { renderedAccount = null; renderAccount(); } };
}

/**
 * Running downloads in the top bar: the first task's name and a thin bar, plus how many more run.
 * Updated in place on every progress event (no re-render, so nothing flickers).
 */
function setupTaskIndicator() {
  const host = document.getElementById('topbar-tasks');
  const label = h('span', { class: 'task-pill__label' });
  const percent = h('span', { class: 'task-pill__percent' });
  const bar = h('span', { class: 'task-pill__bar' });
  const more = h('span', { class: 'task-pill__more' });
  const instanceName = h('span', { class: 'task-pill__instance', 'data-i18n': 'off', hidden: true });
  const pill = h('div', { class: 'task-pill', hidden: true }, h('img', { class: 'task-pill__spinner loading-mark', src: assetUrl('branding/amethyx-mark.png'), alt: '', 'aria-hidden': 'true' }), instanceName, h('span', { class: 'task-pill__text' }, label, percent), more, h('span', { class: 'task-pill__track' }, bar));
  host.append(pill);

  store.subscribe(['tasks'], ({ tasks }) => {
    const running = Object.values(tasks).filter((task) => task.state === 'running');
    pill.hidden = running.length === 0;
    if (running.length === 0) {
      return;
    }
    const [first] = running;
    // Which instance it is for: the task goes on when you leave that instance's page.
    instanceName.textContent = first.instance ?? '';
    instanceName.hidden = !first.instance;
    // "Zoomify: Zoomify" says nothing new: the stage only when it differs from the name.
    label.textContent = first.stage && first.stage !== first.label ? `${first.label}: ${first.stage}` : first.label;
    percent.textContent = `${first.percent ?? 0}%`;
    bar.style.width = `${first.percent ?? 0}%`;
    more.textContent = running.length > 1 ? `+${running.length - 1}` : '';
    more.hidden = running.length < 2;
  });
}

export { ROUTE_TITLES };
