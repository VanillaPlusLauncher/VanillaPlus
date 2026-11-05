import { h, icon } from '../core/dom.js';
import { formatReleaseDate, VERSION_TYPE_LABELS } from '../core/format.js';
import { store } from '../state/appStore.js';
import { loadCatalog } from '../state/actions.js';
import { openModal } from './modal.js';

/*
 * Minecraft version for the Library's filters: a button like the loader's dropdown, and a window of
 * its own with every version of the game — releases, snapshots, the old betas and alphas — to search
 * and pick from, instead of typing the number by hand.
 */

const GROUPS = [
  { key: 'release', label: 'Релизы', types: ['release'] },
  { key: 'snapshot', label: 'Снапшоты', types: ['snapshot'] },
  { key: 'old', label: 'Бета и альфа', types: ['old_beta', 'old_alpha'] },
  { key: 'all', label: 'Все', types: null },
];
const MAX_ROWS = 600;

const groupOf = (type) => GROUPS.find((group) => group.types?.includes(type))?.key ?? 'release';

/**
 * The button. `onPick(id)` gets the chosen version ('' = any). Returns { element, setValue(id),
 * setDisabled(bool) }; `getInstanceVersion()` marks the instance's own version in the list.
 */
export function createGameVersionButton({ onPick, getInstanceVersion = () => null }) {
  let value = '';
  const label = h('span', { class: 'dropdown__label' });
  const element = h(
    'button',
    { class: 'select dropdown__button version-filter', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Версия Minecraft', 'data-sound': 'none', onclick: () => choose() },
    label,
    h('span', { class: 'dropdown__chevron', 'aria-hidden': 'true' }),
  );

  function setValue(id) {
    value = id || '';
    label.textContent = value || 'Любая версия';
    element.title = value ? `Minecraft ${value}` : 'Любая версия Minecraft';
  }

  async function choose() {
    const picked = await pickGameVersion({ current: value, instanceVersion: getInstanceVersion() });
    if (picked === null || picked === value) return;
    setValue(picked);
    onPick(picked);
  }

  setValue('');
  return { element, setValue, setDisabled: (disabled) => { element.disabled = disabled; } };
}

/** Opens the window. Resolves with the chosen version id, '' for "any version", or null when closed. */
export function pickGameVersion({ current = '', instanceVersion = null } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (id) => {
      if (answered) return;
      answered = true;
      resolve(id);
      modal.close();
    };

    const known = store.get().catalog.find((version) => version.id === current);
    let group = known ? groupOf(known.type) : 'release';
    let query = '';

    const search = h('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Поиск: 1.21, 24w14a, b1.7…',
      spellcheck: 'false',
      oninput: (event) => {
        query = event.target.value.trim().toLowerCase();
        render();
      },
      onkeydown: (event) => {
        // Enter takes the first version found.
        if (event.key === 'Enter') list.querySelector('.version-picker__item[data-version]:not([data-version=""])')?.click();
      },
    });
    const tabs = GROUPS.map((entry) =>
      h('button', { class: 'tabs__button', type: 'button', role: 'tab', 'aria-selected': String(entry.key === group), onclick: () => setGroup(entry.key) }, entry.label),
    );
    const list = h('div', { class: 'version-picker version-picker--dialog', role: 'listbox', 'aria-label': 'Версии Minecraft' });
    const counter = h('span', { class: 'version-dialog__count text-muted' });

    function setGroup(key) {
      group = key;
      tabs.forEach((tab, index) => tab.setAttribute('aria-selected', String(GROUPS[index].key === key)));
      render();
    }

    // Four columns in every row (see .version-picker__item): an empty mark keeps them in line.
    function item(id, title, type, date, extra = h('span')) {
      return h(
        'button',
        { class: 'version-picker__item', type: 'button', role: 'option', 'aria-selected': String(id === current), 'data-version': id, onclick: () => answer(id) },
        h('span', { class: 'version-picker__id' }, title),
        h('span', { class: 'version-picker__type' }, type),
        extra,
        h('span', { class: 'version-picker__date' }, date),
      );
    }

    function render() {
      const { catalog, catalogStatus } = store.get();
      if (catalog.length === 0) {
        counter.textContent = '';
        list.replaceChildren(
          catalogStatus === 'error'
            ? h('div', { class: 'empty-state' }, h('p', { class: 'text-danger' }, 'Не удалось загрузить список версий.'), h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => loadCatalog({ force: true }) }, 'Повторить'))
            : h('div', { class: 'skeleton', style: { height: '100%' } }),
        );
        return;
      }
      const types = GROUPS.find((entry) => entry.key === group)?.types;
      // A search looks through every kind of version: "b1.7" finds the old beta from any tab.
      const versions = catalog.filter((version) => (query ? version.id.toLowerCase().includes(query) : !types || types.includes(version.type)));
      counter.textContent = versions.length > MAX_ROWS ? `Показаны ${MAX_ROWS} из ${versions.length}: уточните поиск` : `Версий: ${versions.length}`;
      list.replaceChildren(
        query ? '' : item('', 'Любая версия', 'Без фильтра', ''),
        ...versions.slice(0, MAX_ROWS).map((version) =>
          item(
            version.id,
            version.id,
            VERSION_TYPE_LABELS[version.type] ?? version.type,
            formatReleaseDate(version.releaseTime),
            version.id === instanceVersion ? h('span', { class: 'badge' }, 'Сборка') : version.installed ? h('span', { class: 'badge badge--muted' }, 'Скачана') : undefined,
          ),
        ),
        versions.length === 0 ? h('p', { class: 'version-dialog__empty text-muted' }, 'Такой версии нет.') : '',
      );
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    }

    const content = h(
      'div',
      { class: 'version-dialog' },
      h('div', { class: 'version-dialog__tools' }, h('div', { class: 'input-with-icon version-dialog__search' }, icon('search'), search), h('div', { class: 'tabs version-dialog__tabs', role: 'tablist' }, tabs)),
      list,
      counter,
    );
    const footer = [
      instanceVersion ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => answer(instanceVersion) }, `Как у сборки: ${instanceVersion}`) : null,
      h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => answer('') }, 'Любая версия'),
    ].filter(Boolean);

    const modal = openModal({ title: 'Версия Minecraft', content, footer, wide: true, onClose: () => { unsubscribe(); answer(null); } });
    const unsubscribe = store.subscribe(['catalog', 'catalogStatus'], render);
    if (['idle', 'error'].includes(store.get().catalogStatus)) loadCatalog();
    render();
  });
}
