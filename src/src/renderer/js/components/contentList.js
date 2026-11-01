import { api } from '../services/api.js';
import { locale } from '../core/i18n.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { formatBytes, PLATFORM_LABELS } from '../core/content.js';
import { browseFor } from '../core/nav.js';
import { sfx } from '../core/sound.js';
import { fadeChange, morph } from '../core/effects.js';
import { confirmDialog, openModal } from './modal.js';
import { createSegmented } from './controls.js';
import { confirmCompatibility } from './compatDialog.js';
import { openOptimizeDialog } from './optimizeDialog.js';
import { openShaderDialog } from './shaderDialog.js';
import { toast } from './toast.js';
import { updateInstance } from '../state/actions.js';
import { projectIcon } from '../core/projectIcon.js';

/** Mods: where they are needed (Modrinth data or the mod's own file). */
const SIDE_LABELS = { client: 'Клиент', server: 'Сервер', both: 'Везде' };
const SIDE_FILTERS = [
  { value: '', label: 'Все моды' },
  { value: 'client', label: 'Только для клиента' },
  { value: 'server', label: 'Только для сервера' },
  { value: 'both', label: 'Нужны везде' },
  { value: 'unknown', label: 'Неизвестно где' },
];

/** Folder of each content type inside an instance. */
const FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const VERSION_TYPE_LABELS = { release: 'релиз', beta: 'бета', alpha: 'альфа' };

function projectPage(item) {
  if (item.platform === 'modrinth') return `https://modrinth.com/project/${encodeURIComponent(item.projectId)}`;
  if (item.platform === 'curseforge') return `https://www.curseforge.com/projects/${encodeURIComponent(item.projectId)}`;
  return null;
}

/** How the list looks and is ordered: the viewer's own choice, remembered on this computer. */
const VIEWS = [
  { value: 'list', title: 'Подробно' },
  { value: 'compact', title: 'Компактно' },
  { value: 'grid', title: 'Плитка' },
];
const SORTS = [
  { value: 'az', label: 'По имени А–Я' },
  { value: 'za', label: 'По имени Я–А' },
  { value: 'new', label: 'Сначала новые' },
  { value: 'enabled', label: 'Сначала включённые' },
  { value: 'size', label: 'Сначала большие' },
];
/** From this many rows a change fades in instead of every card gliding (see passage()). */
const MANY_ROWS = 60;
const VIEW_KEY = 'content.view';
const SORT_KEY = 'content.sort';
const remembered = (key, fallback, allowed) => {
  try {
    const value = localStorage.getItem(key);
    return allowed.some((entry) => entry.value === value) ? value : fallback;
  } catch {
    return fallback;
  }
};
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered: the default comes back next time.
  }
};

const LABELS = {
  mod: { title: 'Моды', empty: 'Модов пока нет.', add: 'Найти моды', picker: [{ name: 'Моды', extensions: ['jar', 'zip'] }] },
  resourcepack: { title: 'Ресурспаки', empty: 'Ресурспаков пока нет.', add: 'Найти ресурспаки', picker: [{ name: 'Ресурспаки', extensions: ['zip'] }] },
  shader: { title: 'Шейдеры', empty: 'Шейдеров пока нет. Для них нужен Iris или OptiFine.', add: 'Найти шейдеры', picker: [{ name: 'Шейдеры', extensions: ['zip'] }] },
};

/**
 * Installed mods / resource packs / shaders of an instance, like Prism's "Mods" tab:
 * enable/disable, delete, updates, add from the catalog or from files.
 */
export function createContentList(getInstance, type) {
  const labels = LABELS[type];
  const state = {
    items: [],
    updates: new Map(),
    selected: new Set(),
    query: '',
    side: '',
    identified: false,
    sidesResolved: false,
    loading: false,
    token: 0,
    view: remembered(VIEW_KEY, 'list', VIEWS),
    sort: remembered(SORT_KEY, 'az', SORTS),
  };
  const sortSelect = h('select', { class: 'select select--compact', 'aria-label': 'Порядок', onchange: (event) => { state.sort = event.target.value; remember(SORT_KEY, state.sort); relayout(); } }, SORTS.map((entry) => h('option', { value: entry.value }, entry.label)));
  sortSelect.value = state.sort;
  const viewButtons = VIEWS.map((entry) =>
    h('button', { class: 'icon-button view-toggle', type: 'button', title: entry.title, 'data-view': entry.value, 'aria-pressed': String(entry.value === state.view), onclick: () => setView(entry.value) }, h('span', { class: `view-icon view-icon--${entry.value}` })),
  );
  function setView(view) {
    state.view = view;
    remember(VIEW_KEY, view);
    viewButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
    rows.classList.remove('content-rows--enter');
    // The same rows in another look: only the list's class changes (drawing ~150 rows again with their
    // pictures stalled every switch).
    passage(() => showView());
  }

  function showView() {
    rows.classList.remove('content-rows--list', 'content-rows--compact', 'content-rows--grid');
    rows.classList.add(`content-rows--${state.view}`);
  }

  /** The list drawn again with every card gliding from where it was to its new place and shape. */
  function relayout() {
    passage(() => renderRows());
  }

  /** A change of the list: the cards glide (morph); a long list fades into its new look instead, as a
   *  glide made the browser restyle every row twice and stall. */
  function passage(change) {
    if (rows.childElementCount > MANY_ROWS) fadeChange(rows, change);
    else morph(change, { cards: () => rows.querySelectorAll('.content-row') });
  }

  // Typing filters a moment after the last letter, so the cards glide once instead of at every key.
  let filterTimer = 0;

  const filterInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Фильтр',
    oninput: (event) => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        state.query = event.target.value.trim().toLowerCase();
        relayout();
      }, 160);
    },
  });
  const counter = h('span', { class: 'content-counter' });
  const updatesButton = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => checkUpdates() }, 'Проверить обновления');
  const updateAllButton = h('button', { class: 'btn btn--secondary btn--compact', type: 'button', hidden: true, onclick: () => updateAll() }, 'Обновить все');
  const rows = h('div', { class: 'content-rows' });
  // Selection (Prism-style): tick rows, then act on all of them at once.
  const selectAll = h('input', { type: 'checkbox', class: 'content-check', title: 'Выбрать все', onchange: (event) => toggleAll(event.target.checked) });
  const selectionText = h('span', { class: 'selection-bar__text' });
  // The bar slides open over the list and shut again (features/instance.css .selection-slot), never jumps.
  const selectionSlot = h(
    'div',
    { class: 'selection-slot' },
    h(
      'div',
      { class: 'selection-slot__inner' },
      h(
        'div',
        { class: 'selection-bar' },
        selectionText,
        h('span', { class: 'content-toolbar__spacer' }),
        h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => bulkEnable(true) }, 'Включить'),
        h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => bulkEnable(false) }, 'Выключить'),
        h('button', { class: 'btn btn--secondary btn--compact btn--danger', type: 'button', onclick: () => bulkRemove() }, 'Удалить'),
        h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => { state.selected.clear(); syncSelection(); } }, 'Снять выбор'),
      ),
    ),
  );
  const isMods = type === 'mod';
  const sideSelect = isMods
    ? h('select', { class: 'select select--compact', 'aria-label': 'Где нужны моды', onchange: () => { state.side = sideSelect.value; relayout(); } }, SIDE_FILTERS.map((entry) => h('option', { value: entry.value }, entry.label)))
    : null;
  const serverButton = isMods ? h('button', { class: 'btn btn--ghost btn--compact', type: 'button', title: 'Включить или выключить моды по стороне', onclick: (event) => openSideMenu(event.currentTarget) }, 'Клиент / сервер ▾') : null;
  const autoUpdateInput = h('input', { type: 'checkbox', onchange: (event) => setAutoUpdate(event.target.checked) });
  const autoUpdateToggle = isMods
    ? h('label', { class: 'auto-update', title: 'Перед каждым запуском лаунчер ставит новые версии модов для этой версии игры' }, h('span', { class: 'toggle toggle--small' }, autoUpdateInput, h('span', { class: 'toggle__track' }), h('span', { class: 'toggle__thumb' })), h('span', null, 'Автообновление'))
    : null;
  const element = h(
    'div',
    { class: 'content-list' },
    h(
      'div',
      { class: 'content-toolbar' },
      h('div', { class: 'input-with-icon content-toolbar__filter' }, icon('search'), filterInput),
      sideSelect,
      sortSelect,
      h('div', { class: 'view-switch view-switch--inline' }, viewButtons),
      h('span', { class: 'content-toolbar__spacer' }),
      // On top, where there is room: at the end of the second row it wrapped onto a line of its own.
      updateAllButton,
      updatesButton,
      h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => browseFor(getInstance().id, type) }, icon('download'), labels.add),
    ),
    h(
      'div',
      { class: 'content-toolbar content-toolbar--secondary' },
      h('label', { class: 'select-all' }, selectAll, h('span', null, 'Все')),
      counter,
      autoUpdateToggle,
      h('span', { class: 'content-toolbar__spacer' }),
      isMods ? h('button', { class: 'btn btn--ghost btn--compact', type: 'button', title: 'Память и моды для скорости под этот компьютер', onclick: () => openOptimizeDialog(getInstance(), () => load({ quiet: true })) }, icon('bolt'), 'Оптимизация') : null,
      type === 'shader' ? h('button', { class: 'btn btn--ghost btn--compact', type: 'button', title: 'Включить шейдеры и подобрать их под этот компьютер', onclick: () => openShaderDialog(getInstance(), () => load({ quiet: true })) }, icon('bolt'), 'Оптимизация') : null,
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => addFiles() }, icon('file'), 'Из файла'),
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', title: 'Открыть папку в проводнике', onclick: () => openFolder(FOLDERS[type]) }, icon('folder'), 'Папка'),
      serverButton,
      // The rarer actions in a menu, so the row fits on one line.
      h('button', { class: 'icon-button content-toolbar__more', type: 'button', title: 'Ещё', onclick: (event) => openMoreMenu(event.currentTarget) }, h('span', { class: 'dots' }, '⋯')),
    ),
    selectionSlot,
    rows,
    h('p', { class: 'content-hint' }, 'Файлы можно перетащить прямо в окно. Выключенные остаются в папке, но игра их не загружает.'),
  );

  /** What a row shows of a file: rows of files that look the same are kept when the list is read again. */
  const rowKey = (item) => JSON.stringify([item.file, item.enabled, item.folder, item.title, item.version, item.authors?.slice(0, 2), item.size, item.icon, item.side, item.platform]);

  async function load({ quiet = false } = {}) {
    const instance = getInstance();
    if (!instance) {
      return;
    }
    const token = ++state.token;
    autoUpdateInput.checked = Boolean(instance.overrides?.autoUpdateMods);
    // Placeholders only before the first list: read again, the drawn list stays until the new one is in.
    if (!quiet && state.items.length === 0) {
      rows.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'skeleton', style: { height: '58px' } })));
    }
    try {
      const items = await api.content.list(instance.id, type);
      if (token !== state.token) {
        return;
      }
      // A file that has not changed keeps its item, and so its row (renderRows draws only new ones):
      // coming back to the tab no longer builds ~150 cards with their pictures again.
      const before = new Map(state.items.map((item) => [rowKey(item), item]));
      state.items = items.map((item) => before.get(rowKey(item)) ?? item);
      renderRows();
      // Files added by hand get their names and icons from Modrinth or CurseForge, once per visit.
      if (!state.identified && items.some((item) => !item.platform && !item.folder)) {
        state.identified = true;
        api.content.identify(instance.id, type).then((count) => count > 0 && load({ quiet: true })).catch(() => {});
      }
      // Client/server sides of mods installed before sides were stored (Modrinth and CurseForge).
      if (isMods && !state.sidesResolved && items.some((item) => (item.platform === 'modrinth' || item.platform === 'curseforge') && !item.side)) {
        state.sidesResolved = true;
        api.content.resolveSides(instance.id).then((count) => count > 0 && load({ quiet: true })).catch(() => {});
      }
    } catch (error) {
      rows.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  /** Rows on screen by file: ticking changes them in place instead of drawing the whole list again. */
  const rowElements = new Map();
  const itemOfRow = new WeakMap();
  /** Rows drawn for items, kept as long as the items are: a new order or a filter uses them again. */
  let drawn = new WeakMap();
  /** The mod last chosen by a click or its tick: Shift+click chooses every row between it and the new one. */
  let anchor = null;

  function choose(item, range) {
    const order = [...rows.querySelectorAll('.content-row')].map((element) => itemOfRow.get(element));
    const from = range ? order.indexOf(anchor) : -1;
    if (from >= 0) {
      const to = order.indexOf(item);
      for (const other of order.slice(Math.min(from, to), Math.max(from, to) + 1)) state.selected.add(other.file);
    } else if (!state.selected.delete(item.file)) {
      state.selected.add(item.file);
    }
    anchor = item;
    syncSelection();
  }

  /** The selection shown: the bar, "select all" and each row's tick and highlight (no re-render). */
  function syncSelection() {
    const open = state.selected.size > 0;
    selectionSlot.classList.toggle('is-open', open);
    // While it slides shut it keeps the last number instead of showing "0".
    if (open) selectionText.textContent = `Выбрано: ${state.selected.size}`;
    selectAll.checked = state.items.length > 0 && state.selected.size === state.items.length;
    selectAll.indeterminate = state.selected.size > 0 && state.selected.size < state.items.length;
    for (const [file, entry] of rowElements) {
      const selected = state.selected.has(file);
      entry.check.checked = selected;
      entry.element.classList.toggle('content-row--selected', selected);
    }
  }

  function showCounter() {
    const enabled = state.items.filter((item) => item.enabled).length;
    counter.textContent = state.items.length ? `${enabled} из ${state.items.length} включено` : '';
  }

  function renderRows() {
    // Files that are gone (deleted, renamed by enabling) leave the selection.
    const files = new Set(state.items.map((item) => item.file));
    for (const file of [...state.selected]) {
      if (!files.has(file)) state.selected.delete(file);
    }
    rowElements.clear();
    showCounter();
    const byName = (a, b) => a.title.localeCompare(b.title, locale());
    const sorters = {
      az: byName,
      za: (a, b) => byName(b, a),
      new: (a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')) || byName(a, b),
      enabled: (a, b) => Number(b.enabled) - Number(a.enabled) || byName(a, b),
      size: (a, b) => (b.size ?? 0) - (a.size ?? 0) || byName(a, b),
    };
    const visible = state.items
      .filter(
        (item) =>
          (!state.query || [item.title, item.file, item.description].some((value) => String(value ?? '').toLowerCase().includes(state.query))) &&
          (!state.side || (state.side === 'unknown' ? !item.side : item.side === state.side)),
      )
      .sort(sorters[state.sort] ?? byName);
    showView();
    if (state.items.length === 0) {
      rows.replaceChildren(
        h('div', { class: 'empty-state' }, icon('cube'), h('p', null, labels.empty), h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => browseFor(getInstance().id, type) }, labels.add)),
      );
      syncSelection();
      return;
    }
    // Rows come in one after another only when the list appears, not on every small change.
    rows.classList.toggle('content-rows--enter', !rows.querySelector('.content-row'));
    rows.replaceChildren(
      ...visible.map((item) => {
        const entry = drawn.get(item);
        if (!entry) return row(item);
        entry.element.style.setProperty('--row', String(Math.min(rowElements.size, 14)));
        rowElements.set(item.file, entry);
        return entry.element;
      }),
    );
    syncSelection();
  }

  function row(item) {
    const update = state.updates.get(item.file);
    const toggle = h('label', { class: 'toggle toggle--small', title: item.enabled ? 'Выключить' : 'Включить' },
      h('input', { type: 'checkbox', checked: item.enabled, disabled: item.folder, onchange: (event) => setEnabled(item, event.target.checked) }),
      h('span', { class: 'toggle__track' }),
      h('span', { class: 'toggle__thumb' }),
    );
    const selected = state.selected.has(item.file);
    const check = h('input', { type: 'checkbox', class: 'content-check', checked: selected, title: 'Выбрать', onchange: (event) => { if (event.target.checked) state.selected.add(item.file); else state.selected.delete(item.file); anchor = item; syncSelection(); } });
    // A row: the tick, the switch, the picture, the name with the version and a line of who made it and
    // what file it is, where it is needed, where it comes from, then the update and the actions.
    // A click anywhere else on it chooses it, like in Prism Launcher.
    const element = h(
      'div',
      {
        class: `content-row${item.enabled ? '' : ' content-row--disabled'}${selected ? ' content-row--selected' : ''}`,
        style: { '--row': String(Math.min(rowElements.size, 14)) },
        'data-id': item.file.replace(/\.disabled$/, ''),
        onclick: (event) => { if (!event.target.closest('button, label, input, a')) choose(item, event.shiftKey); },
      },
      check,
      toggle,
      // Folders (unpacked packs) are only named on disk; everything else may find its picture elsewhere.
      item.folder ? h('div', { class: 'content-row__icon content-row__icon--empty' }, icon('cube')) : projectIcon({ iconUrl: item.icon, title: item.title, type }, 'content-row__icon'),
      h(
        'div',
        { class: 'content-row__meta' },
        h('div', { class: 'content-row__title' }, h('span', { class: 'content-row__name', title: item.title }, item.title), item.version ? h('span', { class: 'content-row__version' }, item.version) : null),
        h('div', { class: 'content-row__sub' }, [item.authors?.length ? item.authors.slice(0, 2).join(', ') : null, item.file, item.folder ? 'папка' : formatBytes(item.size)].filter(Boolean).join(' · ')),
      ),
      item.side && item.side !== 'both' ? h('span', { class: `side-tag side-tag--${item.side}`, title: item.side === 'client' ? 'Нужен только в игре: на сервер ставить не надо' : 'Нужен только на сервере' }, SIDE_LABELS[item.side]) : null,
      item.platform ? h('span', { class: `badge badge--${item.platform}` }, h('span', { class: `platform-logo platform-logo--${item.platform}` }), PLATFORM_LABELS[item.platform]) : null,
      update
        ? h('button', { class: 'btn btn--secondary btn--compact content-row__update', type: 'button', title: `Обновить до ${update.version.versionNumber}`, onclick: (event) => applyUpdate(item, update, event.currentTarget) }, '↑ ', update.version.versionNumber)
        : null,
      h(
        'div',
        { class: 'content-row__actions' },
        h('button', { class: 'icon-button content-row__more', type: 'button', title: 'Действия', onclick: (event) => openRowMenu(item, event.currentTarget) }, h('span', { class: 'dots' }, '⋯')),
        h('button', { class: 'icon-button content-row__remove', type: 'button', title: 'Удалить', onclick: () => remove(item) }, icon('close')),
      ),
    );
    const entry = { element, check, toggle };
    rowElements.set(item.file, entry);
    drawn.set(item, entry);
    itemOfRow.set(element, item);
    return element;
  }

  async function setEnabled(item, enabled) {
    const before = item.file;
    try {
      const file = await api.content.setEnabled(getInstance().id, type, item.file, enabled);
      item.file = file;
      item.enabled = enabled;
      // The switch has slid over already: the row changes in place, the list is not drawn again
      // (that made every switch jump). Only the order "enabled first" needs the whole list.
      const entry = rowElements.get(before);
      if (!entry || state.sort === 'enabled') {
        relayout();
        return;
      }
      rowElements.delete(before);
      rowElements.set(file, entry);
      if (state.selected.delete(before)) state.selected.add(file);
      if (state.updates.has(before)) {
        state.updates.set(file, state.updates.get(before));
        state.updates.delete(before);
      }
      entry.element.classList.toggle('content-row--disabled', !enabled);
      entry.toggle.title = enabled ? 'Выключить' : 'Включить';
      showCounter();
    } catch (error) {
      toast(errorMessage(error), 'error');
      load({ quiet: true });
    }
  }

  async function remove(item) {
    const confirmed = await confirmDialog({ title: `Удалить «${item.title}»?`, message: `Файл ${item.file} будет удалён из сборки.`, confirmLabel: 'Удалить', danger: true });
    if (!confirmed) {
      return;
    }
    try {
      await api.content.remove(getInstance().id, type, item.file);
      sfx('delete');
      state.items = state.items.filter((candidate) => candidate !== item);
      renderRows();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function addFiles(paths = null) {
    const files = paths ?? (await api.app.pickFiles({ title: `Добавить: ${labels.title.toLowerCase()}`, filters: labels.picker }));
    if (files.length === 0) {
      return;
    }
    try {
      const added = await api.content.addFiles(getInstance().id, type, files);
      toast(`Добавлено: ${added.join(', ')}`, 'success', 4200, { group: 'mods' });
      state.identified = false;
      await load({ quiet: true });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  // The answer shows where the button is: "Обновить все (N)" appears beside it, or the button itself
  // says "Всё обновлено" for a moment (no card popping up in another corner).
  let updatesLabelTimer = 0;
  async function checkUpdates() {
    clearTimeout(updatesLabelTimer);
    updatesButton.disabled = true;
    updatesButton.textContent = 'Проверяем…';
    let label = 'Проверить обновления';
    try {
      const updates = await api.content.checkUpdates(getInstance().id, type);
      state.updates = new Map(updates.map((update) => [update.file, update]));
      updateAllButton.hidden = updates.length === 0;
      updateAllButton.textContent = `Обновить все (${updates.length})`;
      if (updates.length === 0) label = 'Всё обновлено';
      // The rows show the update buttons: drawn anew.
      drawn = new WeakMap();
      renderRows();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      updatesButton.disabled = false;
      updatesButton.textContent = label;
      if (label !== 'Проверить обновления') updatesLabelTimer = setTimeout(() => (updatesButton.textContent = 'Проверить обновления'), 3000);
    }
  }

  async function applyUpdate(item, update, button) {
    if (button) {
      button.disabled = true;
      button.textContent = '…';
    }
    try {
      await api.content.install({
        instanceId: getInstance().id,
        platform: update.platform,
        projectId: update.projectId,
        versionId: update.version.id,
        type,
        title: item.title,
        iconUrl: item.icon?.startsWith('https://') ? item.icon : null,
        replaceFile: item.file,
      });
      state.updates.delete(item.file);
      await load({ quiet: true });
    } catch (error) {
      toast(errorMessage(error), 'error');
      if (button) button.disabled = false;
    }
  }

  /**
   * Every update at once: the launcher downloads them in parallel (Settings → "Загрузки") under one
   * task in the top bar, and the list is read again once at the end, not after every mod.
   */
  async function updateAll() {
    updateAllButton.disabled = true;
    updateAllButton.textContent = 'Обновляем…';
    const instanceId = getInstance().id;
    try {
      // New mod versions can break a world: every world is backed up first.
      if (type === 'mod') {
        updateAllButton.textContent = 'Копия миров…';
        await api.instances.backupAll(instanceId, 'Перед обновлением модов').catch(() => 0);
        updateAllButton.textContent = 'Обновляем…';
      }
      const updates = [...state.updates.entries()].map(([file, update]) => {
        const item = state.items.find((candidate) => candidate.file === file);
        return { ...update, file, title: item?.title ?? update.title, icon: item?.icon ?? update.icon };
      });
      const { updated, failed } = await api.content.updateMany(instanceId, type, updates);
      for (const update of updates) {
        if (!failed.some((entry) => entry.title === update.title)) state.updates.delete(update.file);
      }
      await load({ quiet: true });
      if (failed.length) {
        toast(`Обновлено: ${updated.length}, не удалось: ${failed.length} (${failed.map((entry) => entry.title).slice(0, 3).join(', ')})`, 'error', 7000);
      } else {
        toast(`Обновлено: ${updated.length}`, 'success', 4200, { group: 'mods' });
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      updateAllButton.disabled = false;
      updateAllButton.hidden = state.updates.size === 0;
      updateAllButton.textContent = `Обновить все (${state.updates.size})`;
    }
  }

  // --- Selection and actions on many files ----------------------------------------------

  function toggleAll(checked) {
    state.selected = new Set(checked ? state.items.map((item) => item.file) : []);
    // A wave down the list: each row lights up a moment after the one above it.
    rows.classList.remove('content-rows--wave');
    void rows.offsetWidth;
    rows.classList.add('content-rows--wave');
    syncSelection();
  }

  function selectedItems() {
    return state.items.filter((item) => state.selected.has(item.file) && !item.folder);
  }

  async function bulkEnable(enabled) {
    const targets = selectedItems().filter((item) => item.enabled !== enabled);
    if (targets.length === 0) {
      toast(enabled ? 'Выбранные уже включены' : 'Выбранные уже выключены', 'info');
      return;
    }
    try {
      const { changed, files } = await api.content.setEnabledMany(getInstance().id, type, targets.map((item) => item.file), enabled);
      // Enabling renames files (.disabled): the selection follows the new names.
      targets.forEach((item) => state.selected.delete(item.file));
      files.forEach((file) => state.selected.add(file));
      toast(`${enabled ? 'Включено' : 'Выключено'}: ${changed}`, 'success');
      await load({ quiet: true });
    } catch (error) {
      toast(errorMessage(error), 'error');
      load({ quiet: true });
    }
  }

  async function bulkRemove() {
    const targets = selectedItems();
    if (targets.length === 0) return;
    const confirmed = await confirmDialog({
      title: `Удалить выбранные (${targets.length})?`,
      message: `${targets.slice(0, 10).map((item) => item.title).join(', ')}${targets.length > 10 ? '…' : ''} — файлы будут удалены из сборки.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) return;
    let removed = 0;
    for (const item of targets) {
      try {
        await api.content.remove(getInstance().id, type, item.file);
        removed += 1;
      } catch (error) {
        toast(`${item.title}: ${errorMessage(error)}`, 'error');
      }
    }
    sfx('delete');
    state.selected.clear();
    toast(`Удалено: ${removed}`, 'success');
    await load({ quiet: true });
  }

  function openFolder(folder) {
    const instance = getInstance();
    api.app.openFolder(`${instance.directory}\\${folder}`).catch((error) => toast(errorMessage(error), 'error'));
  }

  // --- One file: menu, version, page ------------------------------------------------------

  function openRowMenu(item, anchor) {
    document.querySelector('.context-menu')?.remove();
    const page = projectPage(item);
    const entry = (label, action, disabled = false, danger = false) =>
      h('button', { class: `context-menu__item${danger ? ' context-menu__item--danger' : ''}`, type: 'button', disabled, onclick: () => { menu.remove(); action(); } }, label);
    const menu = h(
      'div',
      { class: 'context-menu', role: 'menu' },
      entry('Сменить версию…', () => changeVersion(item), !item.platform),
      entry('Открыть страницу', () => api.app.openExternal(page), !page),
      entry('Показать в папке', () => api.instances.openEntry(getInstance().id, `${FOLDERS[type]}/${item.file}`, { reveal: true }).catch((error) => toast(errorMessage(error), 'error'))),
      h('div', { class: 'context-menu__divider' }),
      entry(item.enabled ? 'Выключить' : 'Включить', () => setEnabled(item, !item.enabled), item.folder),
      entry('Удалить', () => remove(item), false, true),
    );
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(12, rect.right - menu.offsetWidth)}px`;
    const below = rect.bottom + 6 + menu.offsetHeight < window.innerHeight;
    menu.style.top = `${below ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6}px`;
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  /** Another version of an installed project (older, newer, a beta), like Prism's "Change version". */
  function changeVersion(item) {
    const instance = getInstance();
    const list = h('div', { class: 'version-choice' }, h('div', { class: 'skeleton', style: { height: '200px' } }));
    let all = false;
    const scope = createSegmented({
      options: [
        { value: 'fit', label: `Для ${instance.minecraft}${type === 'mod' && instance.loader.type !== 'vanilla' ? ` · ${instance.loader.type}` : ''}` },
        { value: 'all', label: 'Все версии' },
      ],
      value: 'fit',
      onChange: (value) => {
        all = value === 'all';
        loadVersions();
      },
    });

    async function loadVersions() {
      list.replaceChildren(h('div', { class: 'skeleton', style: { height: '200px' } }));
      try {
        const filters = all ? { type } : { gameVersion: instance.minecraft, loader: type === 'mod' ? instance.loader.type : null, type };
        const versions = await api.content.versions(item.platform, item.projectId, filters);
        if (versions.length === 0) {
          list.replaceChildren(h('p', { class: 'text-muted' }, 'Подходящих версий нет. Попробуйте «Все версии».'));
          return;
        }
        list.replaceChildren(
          ...versions.slice(0, 120).map((version) => {
            const current = version.id === item.versionId;
            return h(
              'div',
              { class: `version-choice__row${current ? ' version-choice__row--current' : ''}` },
              h('div', { class: 'version-choice__main' },
                h('span', { class: 'version-choice__number' }, version.versionNumber),
                h('span', { class: `version-choice__type version-choice__type--${version.type}` }, VERSION_TYPE_LABELS[version.type] ?? version.type),
              ),
              h('span', { class: 'version-choice__meta text-muted' }, [(version.gameVersions ?? []).slice(-3).join(', '), version.date ? new Date(version.date).toLocaleDateString(locale()) : null].filter(Boolean).join(' · ')),
              current
                ? h('span', { class: 'badge badge--muted' }, 'Установлена')
                : h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: (event) => install(version, event.currentTarget) }, 'Установить'),
            );
          }),
        );
      } catch (error) {
        list.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
      }
    }

    async function install(version, button) {
      if (!(await confirmCompatibility({ instanceId: instance.id, platform: item.platform, projectId: item.projectId, versionId: version.id, type, title: item.title }))) {
        return;
      }
      button.disabled = true;
      button.textContent = '…';
      try {
        await api.content.install({
          instanceId: instance.id,
          platform: item.platform,
          projectId: item.projectId,
          versionId: version.id,
          type,
          title: item.title,
          iconUrl: item.icon?.startsWith('https://') ? item.icon : null,
          replaceFile: item.file,
        });
        toast(`${item.title}: установлена ${version.versionNumber}`, 'success', 4200, { group: 'mods' });
        state.updates.delete(item.file);
        modal.close();
        await load({ quiet: true });
      } catch (error) {
        toast(errorMessage(error), 'error');
        button.disabled = false;
        button.textContent = 'Установить';
      }
    }

    const modal = openModal({
      title: `Версия: ${item.title}`,
      wide: true,
      content: h('div', { class: 'version-choice__wrap' }, scope.element, list),
    });
    requestAnimationFrame(() => scope.setValue('fit'));
    loadVersions();
  }

  /** The installed list as Markdown, plain text or CSV: copied or saved to a file. */
  function exportList() {
    const instance = getInstance();
    const items = state.items.filter((item) => !item.folder);
    if (items.length === 0) {
      toast('Список пуст', 'info');
      return;
    }
    const formats = {
      markdown: {
        label: 'Markdown',
        ext: 'md',
        make: () =>
          [`# ${instance.name} — ${labels.title.toLowerCase()}`, '', `Minecraft ${instance.minecraft}${instance.loader.type !== 'vanilla' ? `, ${instance.loader.type} ${instance.loader.version ?? ''}` : ''}`, '',
            ...items.map((item) => {
              const page = projectPage(item);
              const name = page ? `[${item.title}](${page})` : item.title;
              return `- ${name}${item.version ? ` ${item.version}` : ''}${item.enabled ? '' : ' (выключен)'}`;
            })].join('\n'),
      },
      text: {
        label: 'Текст',
        ext: 'txt',
        make: () => items.map((item) => `${item.title}${item.version ? ` ${item.version}` : ''}${item.enabled ? '' : ' (выключен)'}`).join('\n'),
      },
      csv: {
        label: 'CSV',
        ext: 'csv',
        make: () => {
          const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
          return ['Название;Версия;Файл;Включён;Источник;Страница', ...items.map((item) => [item.title, item.version, item.file, item.enabled ? 'да' : 'нет', item.platform ?? '', projectPage(item) ?? ''].map(cell).join(';'))].join('\n');
        },
      },
    };
    let format = 'markdown';
    const preview = h('textarea', { class: 'textarea mono export-preview', rows: '14', readonly: true });
    const refresh = () => {
      preview.value = formats[format].make();
    };
    const picker = createSegmented({
      options: Object.entries(formats).map(([value, entry]) => ({ value, label: entry.label })),
      value: format,
      onChange: (value) => {
        format = value;
        refresh();
      },
    });
    refresh();
    const modal = openModal({
      title: `Экспорт: ${labels.title.toLowerCase()} (${items.length})`,
      wide: true,
      content: h('div', { class: 'export-dialog' }, picker.element, preview),
      footer: [
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: async () => { await navigator.clipboard.writeText(preview.value); toast('Список скопирован', 'success'); } }, 'Копировать'),
        h('button', {
          class: 'btn btn--primary btn--compact',
          type: 'button',
          onclick: async () => {
            try {
              const saved = await api.app.saveText({ title: 'Сохранить список', defaultName: `${instance.name} — ${labels.title.toLowerCase()}.${formats[format].ext}`, content: preview.value, filters: [{ name: formats[format].label, extensions: [formats[format].ext] }] });
              if (saved) {
                toast('Список сохранён', 'success');
                modal.close();
              }
            } catch (error) {
              toast(errorMessage(error), 'error');
            }
          },
        }, 'Сохранить файл'),
      ],
    });
    requestAnimationFrame(() => picker.setValue(format));
  }

  async function setAutoUpdate(enabled) {
    const instance = getInstance();
    try {
      await updateInstance(instance.id, { overrides: { ...(instance.overrides ?? {}), autoUpdateMods: enabled || null } });
      toast(enabled ? 'Моды будут обновляться перед каждым запуском' : 'Автообновление модов выключено', 'success');
    } catch (error) {
      autoUpdateInput.checked = !enabled;
      toast(errorMessage(error), 'error');
    }
  }

  /** Server preparation: switch mods on or off by where they are needed. */
  function openMoreMenu(anchor) {
    document.querySelector('.context-menu')?.remove();
    const entry = (label, action) => h('button', { class: 'context-menu__item', type: 'button', onclick: () => { menu.remove(); action(); } }, label);
    const menu = h(
      'div',
      { class: 'context-menu', role: 'menu' },
      isMods ? entry('Конфиги модов', () => openFolder('config')) : null,
      entry('Экспорт списка', () => exportList()),
    );
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(12, rect.right - menu.offsetWidth)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  function openSideMenu(anchor) {
    document.querySelector('.context-menu')?.remove();
    const count = (side, enabled) => state.items.filter((item) => item.side === side && item.enabled === enabled).length;
    const disabledCount = state.items.filter((item) => !item.enabled).length;
    const item = (label, hint, action, disabled) =>
      h('button', { class: 'context-menu__item', type: 'button', disabled, onclick: () => { menu.remove(); action(); } }, h('span', { class: 'context-menu__text' }, h('span', null, label), h('small', null, hint)));
    const menu = h(
      'div',
      { class: 'context-menu context-menu--wide', role: 'menu' },
      item('Выключить клиентские моды', `Для сервера: ${count('client', true)} шт. (миникарты, шейдеры, меню…)`, () => bulk((entry) => entry.side === 'client', false, 'клиентские'), count('client', true) === 0),
      item('Выключить серверные моды', `Для игры без сервера: ${count('server', true)} шт.`, () => bulk((entry) => entry.side === 'server', false, 'серверные'), count('server', true) === 0),
      h('div', { class: 'context-menu__divider' }),
      item('Включить все моды', `Выключено сейчас: ${disabledCount}`, () => bulk(() => true, true, 'все'), disabledCount === 0),
      h('div', { class: 'context-menu__note' }, 'Сторона берётся с Modrinth или из файла мода. Моды с неизвестной стороной не трогаются.'),
    );
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  async function bulk(match, enabled, label) {
    const targets = state.items.filter((item) => !item.folder && match(item) && item.enabled !== enabled);
    if (targets.length === 0) {
      return;
    }
    if (!enabled) {
      const confirmed = await confirmDialog({
        title: `Выключить ${label} моды?`,
        message: `Будет выключено: ${targets.length}. Файлы останутся в папке, включить обратно можно в любой момент.\n\n${targets.slice(0, 12).map((item) => item.title).join(', ')}${targets.length > 12 ? '…' : ''}`,
        confirmLabel: 'Выключить',
      });
      if (!confirmed) return;
    }
    try {
      const { changed } = await api.content.setEnabledMany(getInstance().id, type, targets.map((item) => item.file), enabled);
      toast(`${enabled ? 'Включено' : 'Выключено'}: ${changed}`, 'success');
      await load({ quiet: true });
    } catch (error) {
      toast(errorMessage(error), 'error');
      load({ quiet: true });
    }
  }

  /** Another instance is opened: nothing of the last one's list is kept. */
  function reset() {
    state.token += 1;
    state.items = [];
    state.selected.clear();
    state.updates = new Map();
    state.identified = false;
    state.sidesResolved = false;
    state.side = '';
    if (sideSelect) sideSelect.value = '';
    updateAllButton.hidden = true;
    drawn = new WeakMap();
    rowElements.clear();
    rows.replaceChildren();
  }

  return { element, load, addFiles, reset };
}
