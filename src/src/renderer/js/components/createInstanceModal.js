import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage, formatReleaseDate, VERSION_TYPE_LABELS } from '../core/format.js';
import { LOADER_LABELS } from '../core/content.js';
import { iconImage } from '../core/mc.js';
import { openInstance } from '../core/nav.js';
import { morph, pixelBurst } from '../core/effects.js';
import { store } from '../state/appStore.js';
import { loadCatalog, refreshInstances, saveSettings } from '../state/actions.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { pickIcon } from './iconPicker.js';
import { createProjectBrowser } from './projectBrowser.js';

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const VERSION_FILTERS = ['release', 'snapshot', 'old_beta', 'old_alpha'];

/** Groups already used by instances, for the group field's suggestions. */
export function existingGroups() {
  return [...new Set(store.get().instances.map((instance) => instance.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
}

function groupInput(value = '') {
  const listId = `groups-${Math.random().toString(36).slice(2)}`;
  const input = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'Без группы', list: listId, value });
  return { input, element: h('div', null, input, h('datalist', { id: listId }, existingGroups().map((group) => h('option', { value: group })))) };
}

/** Imports modpack files (dropped on the window or picked) as new instances. */
export async function importModpackFiles(paths, fields = {}) {
  for (const path of paths) {
    toast(`Импорт модпака ${path.split(/[\\/]/).pop()}…`, 'info', 3000, { silent: true });
    try {
      const instance = await api.content.importModpack(path, fields);
      await refreshInstances();
      toast(`Сборка «${instance.name}» готова`, 'success', 5000, { title: 'Модпак установлен', icon: 'enchanted_book' });
      if (instance.failed?.length) {
        toast(`Не скачались: ${instance.failed.join(', ')}. Их автор запретил загрузку вне сайта CurseForge.`, 'error', 9000);
      }
    } catch (error) {
      toast(errorMessage(error), 'error', 7000);
    }
  }
}

/**
 * "New instance" dialog, as in Prism Launcher: a custom instance (Minecraft version + loader),
 * a modpack from Modrinth or CurseForge, or a pack file from disk.
 */
/** `minecraft` preselects a version: the "new Minecraft is out" notice opens the dialog with it. */
export function openCreateInstanceModal({ group: initialGroup = '', minecraft: preferredMinecraft = null, type: preferredType = null } = {}) {
  const state = {
    tab: 'custom',
    minecraft: null,
    loader: 'vanilla',
    loaderVersion: null,
    icon: 'block:grass_block',
    query: '',
    filters: { ...(store.get().settings?.versionFilters ?? { release: true }), ...(preferredType ? { [preferredType]: true } : {}) },
    nameTouched: false,
    loaderToken: 0,
  };

  // --- Custom instance -----------------------------------------------------------
  const nameInput = h('input', { class: 'input', type: 'text', maxlength: '64', placeholder: 'Название сборки', oninput: () => { state.nameTouched = true; } });
  const group = groupInput(initialGroup);
  const iconButton = h('button', { class: 'icon-choice', type: 'button', title: 'Выбрать иконку', onclick: () => chooseIcon() }, iconImage(state.icon, 'icon-choice__img'));
  const versionSearch = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Поиск версии',
    oninput: (event) => {
      state.query = event.target.value.trim().toLowerCase();
      renderVersions();
    },
  });
  const filterChips = h('div', { class: 'toolbar__chips' });
  const versionList = h('div', { class: 'version-picker', role: 'listbox', 'aria-label': 'Версии Minecraft' });
  const loaderButtons = LOADERS.map((loader) =>
    h('button', { class: `loader-button loader-button--${loader}`, type: 'button', 'aria-pressed': String(loader === state.loader), onclick: () => setLoader(loader) }, LOADER_LABELS[loader]),
  );
  const loaderVersionSelect = h('select', { class: 'select', 'aria-label': 'Версия загрузчика', onchange: (event) => { state.loaderVersion = event.target.value || null; } });
  const loaderVersionField = h('label', { class: 'field', hidden: true }, h('span', { class: 'field__label' }, 'Версия загрузчика'), loaderVersionSelect);
  const installNow = h('input', { type: 'checkbox', checked: true });
  const createButton = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => createCustom() }, icon('play'), 'Создать сборку');

  const customPanel = h(
    'div',
    { class: 'create-custom' },
    h(
      'div',
      { class: 'create-custom__side' },
      h('div', { class: 'create-custom__identity' }, iconButton, h('div', { class: 'field', style: { flex: '1' } }, h('span', { class: 'field__label' }, 'Название'), nameInput)),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Группа'), group.element),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Загрузчик модов'), h('div', { class: 'loader-grid' }, loaderButtons)),
      loaderVersionField,
      h('label', { class: 'check-row' }, installNow, 'Сразу скачать игру и загрузчик'),
    ),
    h(
      'div',
      { class: 'create-custom__versions' },
      h('div', { class: 'create-custom__version-tools' }, h('div', { class: 'input-with-icon', style: { flex: '1' } }, icon('search'), versionSearch), filterChips),
      versionList,
    ),
  );

  // --- Modpacks ------------------------------------------------------------------------
  const packBrowsers = {};
  function packBrowser(platform) {
    if (!packBrowsers[platform]) {
      packBrowsers[platform] = createProjectBrowser({
        type: 'modpack',
        platform,
        getInstance: () => null,
        onInstall: async (hit, versionId) => {
          const groupName = group.input.value.trim();
          toast(`Устанавливаем «${hit.title}». Прогресс — вверху окна.`, 'info', 4000, { silent: true });
          modal.close();
          const instance = await api.content.installModpack({
            platform: hit.platform,
            projectId: hit.id,
            versionId,
            title: hit.title,
            iconUrl: hit.iconUrl,
            group: groupName,
          });
          await refreshInstances();
          toast(`Сборка «${instance.name}» готова к игре`, 'success', 5000, { title: 'Модпак установлен', icon: 'enchanted_book' });
        },
      });
      packBrowsers[platform].refresh();
    }
    return packBrowsers[platform].element;
  }

  // --- From file -----------------------------------------------------------------------
  const filePanel = h(
    'div',
    { class: 'create-file' },
    h('div', { class: 'create-file__drop' }, icon('download'), h('p', null, 'Перетащите файл модпака в окно лаунчера или выберите его'), h('p', { class: 'text-muted' }, 'Modrinth (.mrpack), CurseForge (.zip) и архивы сборок Prism Launcher и Amethyx (.zip)'),
      h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => pickPackFile() }, icon('folder'), 'Выбрать файл…')),
  );

  async function pickPackFile() {
    const paths = await api.app.pickFiles({ title: 'Файл модпака', filters: [{ name: 'Модпаки', extensions: ['mrpack', 'zip'] }] });
    if (paths.length > 0) {
      modal.close();
      importModpackFiles(paths, { group: group.input.value.trim() });
    }
  }

  // --- Tabs ------------------------------------------------------------------------
  const tabs = [
    ['custom', 'Своя сборка', () => customPanel],
    ['modrinth', 'Modrinth', () => packBrowser('modrinth')],
    ['curseforge', 'CurseForge', () => packBrowser('curseforge')],
    ['file', 'Из файла', () => filePanel],
  ];
  const tabHost = h('div', { class: 'create-tab-host' });
  const tabButtons = tabs.map(([key, label]) => h('button', { class: 'tabs__button', type: 'button', role: 'tab', 'aria-selected': String(key === state.tab), onclick: () => showTab(key) }, label));
  const footer = h('div', { class: 'create-footer' }, createButton);

  function showTab(key) {
    if (key !== state.tab && tabHost.isConnected) {
      morph(() => openTab(key), { panel: tabHost.closest('.modal') });
      return;
    }
    openTab(key);
  }

  function openTab(key) {
    state.tab = key;
    tabs.forEach(([tabKey], index) => tabButtons[index].setAttribute('aria-selected', String(tabKey === key)));
    tabHost.replaceChildren(tabs.find(([tabKey]) => tabKey === key)[2]());
    footer.hidden = key !== 'custom';
  }

  // --- Custom instance logic ---------------------------------------------------------------
  function autoName() {
    if (state.nameTouched || !state.minecraft) {
      return;
    }
    nameInput.value = state.loader === 'vanilla' ? `Minecraft ${state.minecraft}` : `${LOADER_LABELS[state.loader]} ${state.minecraft}`;
  }

  function renderChips() {
    filterChips.replaceChildren(
      ...VERSION_FILTERS.map((type) =>
        h('button', {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(Boolean(state.filters[type])),
          onclick: () => {
            state.filters[type] = !state.filters[type];
            saveSettings({ versionFilters: state.filters }).catch(() => {});
            renderChips();
            renderVersions();
          },
        }, VERSION_TYPE_LABELS[type]),
      ),
    );
  }

  function renderVersions() {
    const { catalog, catalogStatus } = store.get();
    if (catalog.length === 0) {
      versionList.replaceChildren(catalogStatus === 'error' ? h('p', { class: 'text-danger' }, 'Не удалось загрузить версии Minecraft.') : h('div', { class: 'skeleton', style: { height: '240px' } }));
      return;
    }
    const versions = catalog.filter((version) => state.filters[version.type] && (!state.query || version.id.toLowerCase().includes(state.query))).slice(0, 400);
    if (!state.minecraft && versions[0]) {
      const preferred = preferredMinecraft && versions.find((version) => version.id === preferredMinecraft);
      selectVersion((preferred ?? versions[0]).id, false);
    }
    versionList.replaceChildren(
      ...versions.map((version) =>
        h(
          'button',
          {
            class: 'version-picker__item',
            type: 'button',
            role: 'option',
            'aria-selected': String(version.id === state.minecraft),
            'data-version': version.id,
            onclick: () => selectVersion(version.id),
          },
          h('span', { class: 'version-picker__id' }, version.id),
          h('span', { class: 'version-picker__type' }, VERSION_TYPE_LABELS[version.type] ?? version.type),
          version.installed ? h('span', { class: 'badge' }, 'Скачана') : null,
          h('span', { class: 'version-picker__date' }, formatReleaseDate(version.releaseTime)),
        ),
      ),
    );
  }

  function selectVersion(id, rerender = true) {
    state.minecraft = id;
    if (rerender) {
      for (const item of versionList.children) {
        item.setAttribute('aria-selected', String(item.dataset.version === id));
      }
    }
    autoName();
    loadLoaderVersions();
  }

  function setLoader(loader) {
    state.loader = loader;
    state.loaderVersion = null;
    loaderButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(LOADERS[index] === loader)));
    autoName();
    loadLoaderVersions();
  }

  async function loadLoaderVersions() {
    const token = ++state.loaderToken;
    if (state.loader === 'vanilla' || !state.minecraft) {
      loaderVersionField.hidden = true;
      createButton.disabled = !state.minecraft;
      return;
    }
    loaderVersionField.hidden = false;
    loaderVersionSelect.replaceChildren(h('option', { value: '' }, 'Загрузка…'));
    loaderVersionSelect.disabled = true;
    try {
      const versions = await api.versions.loaders(state.loader, state.minecraft);
      if (token !== state.loaderToken) {
        return;
      }
      if (versions.length === 0) {
        loaderVersionSelect.replaceChildren(h('option', { value: '' }, `${LOADER_LABELS[state.loader]} нет для ${state.minecraft}`));
        createButton.disabled = true;
        return;
      }
      const recommended = versions.find((version) => version.stable) ?? versions[0];
      loaderVersionSelect.replaceChildren(
        ...versions.slice(0, 150).map((version) =>
          h('option', { value: version.version }, `${version.label}${version === recommended ? ' — рекомендуется' : version.stable ? '' : ' (бета)'}`),
        ),
      );
      loaderVersionSelect.value = recommended.version;
      state.loaderVersion = recommended.version;
      loaderVersionSelect.disabled = false;
      createButton.disabled = false;
    } catch (error) {
      if (token === state.loaderToken) {
        loaderVersionSelect.replaceChildren(h('option', { value: '' }, errorMessage(error)));
        createButton.disabled = true;
      }
    }
  }

  async function chooseIcon() {
    const chosen = await pickIcon(state.icon);
    if (chosen) {
      state.icon = chosen;
      iconButton.replaceChildren(iconImage(chosen, 'icon-choice__img'));
    }
  }

  async function createCustom() {
    if (!state.minecraft) {
      toast('Выберите версию Minecraft.', 'error');
      return;
    }
    createButton.disabled = true;
    try {
      const instance = await api.instances.create({
        name: nameInput.value.trim(),
        group: group.input.value.trim(),
        icon: state.icon,
        minecraft: state.minecraft,
        loader: { type: state.loader, version: state.loader === 'vanilla' ? null : state.loaderVersion },
      });
      pixelBurst(createButton);
      await refreshInstances();
      if (!store.get().settings?.selectedInstanceId) {
        await saveSettings({ selectedInstanceId: instance.id });
      }
      modal.close();
      toast(`Сборка «${instance.name}» создана`, 'success', 4200, { title: 'Новая сборка', icon: 'diamond' });
      if (installNow.checked) {
        api.instances.install(instance.id).then(() => refreshInstances()).catch((error) => toast(errorMessage(error), 'error', 7000));
      }
      openInstance(instance.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
      createButton.disabled = false;
    }
  }

  const unsubscribe = store.subscribe(['catalog', 'catalogStatus'], renderVersions);
  if (store.get().catalogStatus === 'idle' || store.get().catalogStatus === 'error') {
    loadCatalog().catch(() => {});
  }
  renderChips();
  renderVersions();
  const modal = openModal({
    title: 'Новая сборка',
    size: 'xl',
    content: h('div', { class: 'create-instance' }, h('div', { class: 'tabs', role: 'tablist' }, tabButtons), tabHost),
    footer: [footer],
    onClose: unsubscribe,
  });
  showTab('custom');
}
