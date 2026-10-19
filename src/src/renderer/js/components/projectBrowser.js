import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { formatAgo, formatCount, LOADER_LABELS, PLATFORM_LABELS, SORTS } from '../core/content.js';
import { go } from '../core/nav.js';
import { openProjectModal } from './projectModal.js';
import { toast } from './toast.js';
import { loadingState } from './controls.js';

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 350;

/**
 * Search over Modrinth or CurseForge with infinite scrolling.
 * options: {
 *   type: 'mod' | 'modpack' | 'resourcepack' | 'shader',
 *   platform, getInstance() -> instance or null (filters by its version and loader),
 *   installedProjects() -> Set of project ids already in the instance,
 *   onInstall(hit, versionId) -> Promise, onPlatformChange(platform)
 * }
 * Returns { element, setType(type), setPlatform(platform), refresh(), markInstalled() }.
 */
export function createProjectBrowser(options) {
  const state = {
    type: options.type ?? 'mod',
    platform: options.platform ?? 'modrinth',
    query: '',
    sort: 'relevance',
    gameVersion: '',
    loader: '',
    // Which instance and type the filters were last filled from: a new one fills them again.
    filtersKey: null,
    offset: 0,
    total: 0,
    loading: false,
    token: 0,
    hits: [],
  };
  let searchTimer = null;

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Поиск…',
    autocomplete: 'off',
    oninput: (event) => {
      state.query = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => reload(), SEARCH_DELAY_MS);
    },
  });
  const sortSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Сортировка', onchange: (event) => { state.sort = event.target.value; reload(); } },
    SORTS.map((sort) => h('option', { value: sort.value }, sort.label)),
  );
  const versionInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Версия MC',
    'aria-label': 'Версия Minecraft',
    onchange: (event) => { state.gameVersion = event.target.value.trim(); reload(); },
  });
  const loaderSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Загрузчик', onchange: (event) => { state.loader = event.target.value; reload(); } },
    h('option', { value: '' }, 'Любой загрузчик'),
    ['fabric', 'forge', 'neoforge', 'quilt'].map((loader) => h('option', { value: loader }, LOADER_LABELS[loader])),
  );
  const resetFilters = h('button', { class: 'btn btn--ghost btn--compact browser-toolbar__reset', type: 'button', hidden: true, title: 'Вернуть версию и загрузчик сборки', onclick: () => { state.filtersKey = null; reload(); } }, 'Как у сборки');
  const platformButtons = ['modrinth', 'curseforge'].map((platform) =>
    h(
      'button',
      { class: `platform-button platform-button--${platform}`, type: 'button', 'aria-pressed': String(platform === state.platform), onclick: () => setPlatform(platform, true) },
      h('span', { class: `platform-logo platform-logo--${platform}` }),
      PLATFORM_LABELS[platform],
    ),
  );
  // "Загрузка…" until the first page of the catalogue is in (it can take a while the first time).
  const results = h('div', { class: 'project-grid' }, loadingState('Загружаем каталог…'));
  const footer = h('div', { class: 'browser-footer' });
  const sentinel = h('div', { class: 'browser-sentinel' });
  const element = h(
    'div',
    { class: 'project-browser' },
    h(
      'div',
      { class: 'browser-toolbar' },
      h('div', { class: 'platform-switch' }, platformButtons),
      h('div', { class: 'input-with-icon browser-toolbar__search' }, icon('search'), searchInput),
      h('div', { class: 'browser-toolbar__filters' }, resetFilters, versionInput, loaderSelect, sortSelect),
    ),
    results,
    footer,
    sentinel,
  );

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && !state.loading && state.hits.length < state.total) {
      loadMore();
    }
  }, { rootMargin: '400px' });
  observer.observe(sentinel);

  /**
   * Version and loader to search for. They start as the instance's, and stay editable: Fabric mods
   * for a Forge pack with Sinytra Connector, or another Minecraft version.
   */
  function instanceFilters() {
    const instance = state.type === 'modpack' ? null : options.getInstance?.() ?? null;
    const own = instance ? { gameVersion: instance.minecraft, loader: state.type === 'mod' && instance.loader.type !== 'vanilla' ? instance.loader.type : '' } : null;
    const key = instance ? `${instance.id}|${instance.minecraft}|${instance.loader.type}|${state.type}` : `none|${state.type}`;
    if (key !== state.filtersKey) {
      state.filtersKey = key;
      if (own) {
        state.gameVersion = own.gameVersion;
        state.loader = own.loader;
      }
      versionInput.value = state.gameVersion;
      loaderSelect.value = state.loader;
    }
    loaderSelect.disabled = state.type !== 'mod' && state.type !== 'modpack';
    resetFilters.hidden = !own || (state.gameVersion === own.gameVersion && state.loader === own.loader);
    return { gameVersion: state.gameVersion || null, loader: loaderSelect.disabled ? null : state.loader || null, instance };
  }

  /** What an install should look for: the catalog's filters, not only the instance's. */
  function installFilters() {
    const filters = instanceFilters();
    return { gameVersion: filters.gameVersion, loader: filters.loader };
  }

  function cardFor(hit, index) {
    const installed = options.installedProjects?.().has(hit.id);
    const installButton = h(
      'button',
      { class: `btn ${installed ? 'btn--ghost' : 'btn--secondary'} btn--compact project-card__install`, type: 'button', disabled: installed },
      installed ? 'Установлено' : h('span', { class: 'project-card__install-label' }, icon('download'), state.type === 'modpack' ? 'Установить' : 'Добавить'),
    );
    installButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      installButton.disabled = true;
      installButton.replaceChildren('Установка…');
      try {
        await options.onInstall(hit, null, installFilters());
        installButton.className = 'btn btn--ghost btn--compact project-card__install';
        installButton.replaceChildren('Установлено');
      } catch (error) {
        installButton.disabled = false;
        installButton.replaceChildren(icon('download'), 'Повторить');
        toast(errorMessage(error), 'error');
      }
    });
    return h(
      'article',
      {
        class: 'project-card rise',
        style: { '--delay': `${Math.min(index, 12) * 35}ms` },
        tabindex: '0',
        onclick: () => openProjectModal(hit, { instance: instanceFilters().instance, type: state.type, filters: installFilters(), onInstall: (versionId) => options.onInstall(hit, versionId, installFilters()) }),
        onkeydown: (event) => {
          if (event.key === 'Enter') {
            event.currentTarget.click();
          }
        },
      },
      hit.iconUrl ? h('img', { class: 'project-card__icon', src: hit.iconUrl, alt: '', loading: 'lazy' }) : h('div', { class: 'project-card__icon project-card__icon--empty' }, icon('cube')),
      h(
        'div',
        { class: 'project-card__body' },
        h('div', { class: 'project-card__title' }, h('span', { class: 'project-card__name' }, hit.title), hit.author ? h('span', { class: 'project-card__author' }, `от ${hit.author}`) : null),
        h('p', { class: 'project-card__description' }, hit.description),
        h(
          'div',
          { class: 'project-card__meta' },
          h('span', { title: 'Загрузки' }, icon('download'), formatCount(hit.downloads)),
          hit.updatedAt ? h('span', { title: 'Обновлён' }, formatAgo(hit.updatedAt)) : null,
          ...(hit.categories ?? []).slice(0, 3).map((category) => h('span', { class: 'project-card__tag' }, category)),
        ),
      ),
      installButton,
    );
  }

  async function load(reset) {
    const token = ++state.token;
    state.loading = true;
    const filters = instanceFilters();
    if (reset) {
      state.offset = 0;
      state.hits = [];
      results.replaceChildren(loadingState(state.hits.length || state.total ? 'Ищем…' : 'Загружаем каталог…'), ...Array.from({ length: 6 }, () => h('div', { class: 'skeleton project-card-skeleton' })));
      footer.replaceChildren();
    } else {
      footer.replaceChildren(h('div', { class: 'loading-dots' }, h('span'), h('span'), h('span')));
    }
    try {
      const page = await api.content.search({
        platform: state.platform,
        type: state.type,
        query: state.query,
        sort: state.sort,
        gameVersion: filters.gameVersion,
        loader: filters.loader,
        offset: state.offset,
        limit: PAGE_SIZE,
      });
      if (token !== state.token) {
        return;
      }
      state.total = page.total;
      const start = state.hits.length;
      state.hits.push(...page.hits);
      state.offset += page.hits.length;
      if (reset) {
        results.replaceChildren();
      }
      results.append(...page.hits.map((hit, index) => cardFor(hit, start === 0 ? index : 0)));
      if (state.hits.length === 0) {
        results.replaceChildren(h('div', { class: 'empty-state' }, icon('search'), h('p', null, 'Ничего не найдено. Попробуйте другой запрос.')));
      }
      footer.replaceChildren(state.hits.length > 0 && state.hits.length >= state.total ? h('p', { class: 'text-muted' }, `Это всё: ${state.total}`) : '');
    } catch (error) {
      if (token !== state.token) {
        return;
      }
      const missingKey = /ключ/i.test(error.message);
      results.replaceChildren(
        h(
          'div',
          { class: 'empty-state surface' },
          icon(missingKey ? 'gear' : 'download'),
          h('p', null, errorMessage(error)),
          missingKey
            ? h('div', { class: 'settings-row', style: { justifyContent: 'center' } },
                h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => go('settings') }, 'Открыть настройки'),
                h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => api.app.openExternal('https://console.curseforge.com/') }, 'console.curseforge.com'),
              )
            : h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => reload() }, 'Повторить'),
        ),
      );
      footer.replaceChildren();
    } finally {
      if (token === state.token) {
        state.loading = false;
      }
    }
  }

  function reload() {
    return load(true);
  }

  function loadMore() {
    return load(false);
  }

  function setType(type) {
    if (type !== state.type) {
      state.type = type;
      reload();
    }
  }

  function setPlatform(platform, fromUser = false) {
    if (platform === state.platform) {
      return;
    }
    state.platform = platform;
    platformButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(['modrinth', 'curseforge'][index] === platform)));
    if (fromUser) {
      options.onPlatformChange?.(platform);
    }
    reload();
  }

  /** Marks cards of projects that are now in the instance. */
  function markInstalled() {
    const installed = options.installedProjects?.() ?? new Set();
    [...results.children].forEach((card, index) => {
      const hit = state.hits[index];
      const button = card.querySelector('.project-card__install');
      if (hit && button && installed.has(hit.id)) {
        button.disabled = true;
        button.className = 'btn btn--ghost btn--compact project-card__install';
        button.replaceChildren('Установлено');
      }
    });
  }

  return { element, setType, setPlatform, refresh: reload, markInstalled, state };
}
