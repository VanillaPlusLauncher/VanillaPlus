import { api } from '../services/api.js';
import { h } from '../core/dom.js';
import { confirmCompatibility } from '../components/compatDialog.js';
import { CONTENT_TYPES, describeInstance } from '../core/content.js';
import { iconImage } from '../core/mc.js';
import { openInstance } from '../core/nav.js';
import { store } from '../state/appStore.js';
import { refreshInstances, selectedInstance } from '../state/actions.js';
import { createProjectBrowser } from '../components/projectBrowser.js';
import { openCreateInstanceModal } from '../components/createInstanceModal.js';
import { toast } from '../components/toast.js';
import { beginInstall } from '../core/installQueue.js';

/**
 * Library: modpacks, mods, resource packs, shaders and data packs from Modrinth and CurseForge, and
 * maps from CurseForge and Minecraft Inside. Everything except modpacks goes into the chosen instance
 * (data packs into one of its worlds, maps as new worlds).
 */
export function createBrowsePage() {
  let type = 'mod';
  let targetId = null;
  let installed = new Set();

  const typeButtons = CONTENT_TYPES.map((entry) =>
    h('button', { class: 'tabs__button', type: 'button', role: 'tab', 'aria-selected': String(entry.type === type), onclick: () => setType(entry.type) }, entry.label),
  );
  const targetSelect = h('select', { class: 'select', 'aria-label': 'Сборка', onchange: (event) => setTarget(event.target.value) });
  const targetIcon = h('span', { class: 'target-picker__icon' });
  const targetMeta = h('span', { class: 'target-picker__meta' });
  const worldSelect = h('select', { class: 'select', 'aria-label': 'Мир' });
  const worldField = h('div', { class: 'target-picker__text', hidden: true }, h('span', { class: 'target-picker__label' }, 'В мир'), worldSelect);
  const targetPicker = h(
    'div',
    { class: 'target-picker surface' },
    targetIcon,
    h('div', { class: 'target-picker__text' }, h('span', { class: 'target-picker__label' }, 'Устанавливать в сборку'), targetSelect, targetMeta),
    worldField,
    h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => targetId && openInstance(targetId, type === 'modpack' ? 'mod' : type === 'datapack' || type === 'world' ? 'worlds' : type) }, 'Открыть сборку'),
  );
  const noInstances = h(
    'div',
    { class: 'surface target-picker target-picker--empty', hidden: true },
    h('span', null, 'Чтобы ставить моды, нужна сборка с загрузчиком (Fabric, Forge, NeoForge или Quilt).'),
    h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => openCreateInstanceModal() }, 'Создать сборку'),
  );

  const browser = createProjectBrowser({
    type,
    // Modrinth first: the best catalog; CurseForge is one click away.
    platform: 'modrinth',
    getInstance: () => (type === 'modpack' ? null : target()),
    installedProjects: () => installed,
    onInstall: (hit, versionId, filters) => install(hit, versionId, filters),
  });

  const element = h(
    'section',
    { class: 'page', 'aria-label': 'Библиотека' },
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', { class: 'page-title' }, 'Библиотека'), h('p', { class: 'page-subtitle' }, 'Модпаки, моды, ресурспаки, шейдеры и датапаки с Modrinth и CurseForge, карты с CurseForge и Minecraft Inside.')),
    ),
    h('div', { class: 'tabs browse-tabs', role: 'tablist' }, typeButtons),
    targetPicker,
    noInstances,
    browser.element,
  );

  function target() {
    return store.get().instances.find((instance) => instance.id === targetId) ?? null;
  }

  function renderTargets() {
    const { instances } = store.get();
    const modpack = type === 'modpack';
    targetPicker.hidden = modpack || instances.length === 0;
    noInstances.hidden = modpack || instances.length > 0;
    if (!instances.some((instance) => instance.id === targetId)) {
      targetId = store.get().browseInstanceId ?? selectedInstance()?.id ?? instances[0]?.id ?? null;
    }
    targetSelect.replaceChildren(...instances.map((instance) => h('option', { value: instance.id }, `${instance.name} — ${describeInstance(instance)}`)));
    targetSelect.value = targetId ?? '';
    const current = target();
    targetIcon.replaceChildren(current ? iconImage(current.icon, 'target-picker__img') : '');
    targetMeta.textContent = current && type === 'mod' && current.loader.type === 'vanilla' ? 'В этой сборке нет загрузчика модов: моды не заработают. Выберите другую сборку.' : '';
    targetMeta.classList.toggle('text-danger', Boolean(targetMeta.textContent));
    renderWorlds();
  }

  /** Data packs: the worlds of the chosen instance. */
  async function renderWorlds() {
    worldField.hidden = type !== 'datapack';
    const current = target();
    if (type !== 'datapack' || !current) return;
    const keep = worldSelect.value;
    const worlds = await api.instances.worlds(current.id).catch(() => []);
    worldSelect.replaceChildren(...(worlds.length ? worlds.map((world) => h('option', { value: world.folder }, world.folder)) : [h('option', { value: '' }, 'Миров пока нет')]));
    worldSelect.disabled = worlds.length === 0;
    worldSelect.value = worlds.some((world) => world.folder === keep) ? keep : worlds[0]?.folder ?? '';
  }

  /** What the chosen instance has now; an answer for an instance no longer chosen is dropped. */
  let installedAsk = 0;
  async function loadInstalled() {
    const ask = ++installedAsk;
    const current = target();
    installed = new Set();
    if (!current || type === 'modpack' || type === 'datapack' || type === 'world') {
      browser.markInstalled();
      return;
    }
    try {
      const items = await api.content.list(current.id, type);
      if (ask !== installedAsk) return;
      installed = new Set(items.map((item) => item.projectId).filter(Boolean));
      browser.markInstalled();
    } catch {
      // The marks are a convenience only.
    }
  }

  function setType(next) {
    type = next;
    typeButtons.forEach((button, index) => button.setAttribute('aria-selected', String(CONTENT_TYPES[index].type === next)));
    renderTargets();
    loadInstalled().then(() => browser.setType(next));
  }

  function setTarget(id) {
    targetId = id;
    store.set({ browseInstanceId: id });
    renderTargets();
    loadInstalled().then(() => browser.refresh());
  }

  async function install(hit, versionId, filters = null) {
    if (type === 'modpack') {
      toast(`Устанавливаем модпак «${hit.title}». Прогресс — вверху окна.`, 'info', 4000, { silent: true });
      const instance = await api.content.installModpack({ platform: hit.platform, projectId: hit.id, versionId, title: hit.title, iconUrl: hit.iconUrl });
      await refreshInstances();
      toast(`Сборка «${instance.name}» готова к игре`, 'success', 6000, { title: 'Модпак установлен', icon: 'enchanted_book', group: 'instances' });
      return;
    }
    const current = target();
    if (!current) {
      throw new Error('Сначала создайте сборку.');
    }
    if (type === 'datapack') {
      if (!worldSelect.value) {
        throw new Error('В этой сборке ещё нет миров: создайте мир в игре, и датапак можно будет поставить в него.');
      }
      const result = await api.content.installDatapack({ instanceId: current.id, world: worldSelect.value, platform: hit.platform, projectId: hit.id, versionId, gameVersion: filters?.gameVersion ?? null });
      toast(`«${hit.title}» → мир «${result.world}»`, 'success', 4800, { title: 'Датапак установлен', icon: 'map', group: 'mods' });
      return;
    }
    if (type === 'world') {
      // From Minecraft Inside: its page opens, and the map comes in once the player downloads it there.
      if (hit.platform === 'mcinside') toast('Нажмите «Скачать» на странице карты — лаунчер сам поставит её в сборку.', 'info', 6000, { silent: true });
      const result = await api.content.installWorld({ instanceId: current.id, platform: hit.platform, projectId: hit.id, versionId, gameVersion: filters?.gameVersion ?? null, title: hit.title });
      if (result.cancelled) throw new Error('Окно сайта закрыто — карта не скачана.');
      toast(`«${hit.title}» → ${current.name}`, 'success', 5200, { title: 'Карта добавлена', icon: 'map', group: 'mods' });
      return;
    }
    const request = { instanceId: current.id, platform: hit.platform, projectId: hit.id, versionId, type, title: hit.title, iconUrl: hit.iconUrl, filters };
    if (!(await confirmCompatibility(request))) {
      return;
    }
    // One sound when the queue starts and one when it is done (core/installQueue.js), silent toasts.
    const done = beginInstall();
    try {
      const result = await api.content.install(request);
      installed.add(hit.id);
      const extra = result.installed.length > 1 ? ` и зависимости: ${result.installed.slice(1).join(', ')}` : '';
      toast(`«${hit.title}»${extra} → ${current.name}`, 'success', 4800, { title: 'Установлено', icon: type === 'shader' ? 'ender_eye' : type === 'resourcepack' ? 'map' : 'enchanted_book', silent: true, group: 'mods' });
      if (result.skipped.length > 0) {
        toast(`Не найдены подходящие версии зависимостей: ${result.skipped.join(', ')}`, 'error', 7000);
      }
      loadInstalled();
    } finally {
      done();
    }
  }

  store.subscribe(['instances'], () => renderTargets());

  let started = false;
  return {
    element,
    onShow: () => {
      const { browseInstanceId, browseType } = store.get();
      // "Найти моды" in another instance: that one is the target now, with its own marks and its own
      // version and loader in the search (the page kept the last instance's before).
      const targetChanged = Boolean(browseInstanceId && browseInstanceId !== targetId);
      if (targetChanged) {
        targetId = browseInstanceId;
      }
      if (browseType && browseType !== type) {
        setType(browseType);
        started = true;
        return;
      }
      renderTargets();
      if (!started || targetChanged) {
        started = true;
        loadInstalled().then(() => browser.refresh());
      } else {
        // The same instance: mods may have been added or removed there since.
        loadInstalled();
      }
    },
  };
}
