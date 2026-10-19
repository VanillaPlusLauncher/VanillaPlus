import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { openImportCodeDialog } from '../components/shareDialog.js';
import { openLauncherImportDialog } from '../components/launcherImportDialog.js';
import { changeInstanceIcon } from '../components/iconPicker.js';
import { errorMessage } from '../core/format.js';
import { formatAgo, formatPlayTime, LOADER_LABELS } from '../core/content.js';
import { iconImage } from '../core/mc.js';
import { openInstance } from '../core/nav.js';
import { pixelBurst } from '../core/effects.js';
import { store } from '../state/appStore.js';
import { playInstance, refreshInstances, saveSettings, stopGame, updateInstance } from '../state/actions.js';
import { openCreateInstanceModal, existingGroups } from '../components/createInstanceModal.js';
import { confirmDialog, openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { sfx } from '../core/sound.js';

const NO_GROUP = '';
const DRAG_TYPE = 'application/x-vanillaplus-instance';
const SORTS = [
  { value: 'recent', label: 'Недавние' },
  { value: 'name', label: 'По имени' },
  { value: 'version', label: 'По версии' },
];

/** Compares Minecraft versions like 1.20.1 / 26.1 numerically, newest first. */
function compareVersionsDesc(a, b) {
  const pa = String(a).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    if ((pa[index] ?? 0) !== (pb[index] ?? 0)) {
      return (pb[index] ?? 0) - (pa[index] ?? 0);
    }
  }
  return 0;
}

/**
 * Instances, grouped into collapsible sections like Prism Launcher. A card selects the instance,
 * double click plays it, the menu edits, copies, moves to a group or deletes it.
 */
export function createInstancesPage() {
  const state = { query: '', sort: 'recent', loaderFilter: '' };
  /** Rendered cards by instance id, for in-place status updates (no full re-render on progress). */
  let cards = new Map();
  let renderedKey = '';

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Поиск сборки',
    oninput: (event) => {
      state.query = event.target.value.trim().toLowerCase();
      render();
    },
  });
  const sortSelect = h('select', { class: 'select select--compact', onchange: (event) => { state.sort = event.target.value; render(); } }, SORTS.map((sort) => h('option', { value: sort.value }, sort.label)));
  const loaderSelect = h(
    'select',
    { class: 'select select--compact', onchange: (event) => { state.loaderFilter = event.target.value; render(); } },
    h('option', { value: '' }, 'Все загрузчики'),
    Object.entries(LOADER_LABELS).map(([value, label]) => h('option', { value }, label)),
  );
  const viewButtons = ['grid', 'list'].map((view) =>
    h('button', { class: 'icon-button view-toggle', type: 'button', title: view === 'grid' ? 'Плитка' : 'Список', 'data-view': view, onclick: () => saveSettings({ instanceView: view }).catch(() => {}) }, h('span', { class: `view-icon view-icon--${view}` })),
  );
  const content = h('div', { class: 'instance-groups' });

  const element = h(
    'section',
    { class: 'page', 'aria-label': 'Сборки' },
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', { class: 'page-title' }, 'Сборки'), h('p', { class: 'page-subtitle' }, 'У каждой сборки свои моды, миры и настройки. Группы — как папки, их можно сворачивать.')),
      h(
        'div',
        { class: 'page-header__actions' },
        h('button', { class: 'btn btn--ghost btn--compact', type: 'button', title: 'Prism, Modrinth App, CurseForge, Millida, TLauncher и другие', onclick: () => openLauncherImportDialog() }, icon('download'), 'Из других лаунчеров'),
        h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => importPack() }, icon('folder'), 'Импорт'),
        h('button', { class: 'btn btn--ghost btn--compact', type: 'button', title: 'Собрать сборку по коду от друга', onclick: () => openImportCodeDialog() }, 'Вставить код'),
        h('button', { class: 'btn btn--ghost btn--compact', type: 'button', title: 'Группа — как папка: сборки перетаскиваются в неё мышкой', onclick: () => createGroup() }, icon('folder'), 'Новая группа'),
        h('button', { class: 'btn btn--primary', type: 'button', onclick: (event) => { pixelBurst(event.currentTarget, { count: 10 }); openCreateInstanceModal(); } }, h('span', { class: 'plus' }, '+'), 'Новая сборка'),
      ),
    ),
    h('div', { class: 'toolbar' }, h('div', { class: 'input-with-icon toolbar__search' }, icon('search'), searchInput), loaderSelect, sortSelect, h('div', { class: 'view-switch' }, viewButtons)),
    content,
  );

  async function importPack() {
    const paths = await api.app.pickFiles({ title: 'Файл модпака', filters: [{ name: 'Модпаки', extensions: ['mrpack', 'zip'] }] });
    if (paths.length > 0) {
      const { importModpackFiles } = await import('../components/createInstanceModal.js');
      importModpackFiles(paths);
    }
  }

  function filtered() {
    const { instances } = store.get();
    const list = instances.filter((instance) => {
      if (state.loaderFilter && instance.loader.type !== state.loaderFilter) {
        return false;
      }
      if (!state.query) {
        return true;
      }
      return [instance.name, instance.minecraft, instance.group, LOADER_LABELS[instance.loader.type]].some((value) => String(value ?? '').toLowerCase().includes(state.query));
    });
    const sorters = {
      recent: (a, b) => (b.lastPlayedAt ?? b.createdAt ?? '').localeCompare(a.lastPlayedAt ?? a.createdAt ?? ''),
      name: (a, b) => a.name.localeCompare(b.name, 'ru'),
      version: (a, b) => compareVersionsDesc(a.minecraft, b.minecraft) || a.name.localeCompare(b.name, 'ru'),
    };
    return list.sort(sorters[state.sort]);
  }

  function statusOf(instance) {
    const { game, tasks } = store.get();
    if (game.instanceId === instance.id && game.state === 'running') {
      return { kind: 'running', text: 'Запущена' };
    }
    if (game.instanceId === instance.id && game.state === 'launching') {
      return { kind: 'busy', text: 'Запуск…' };
    }
    const task = tasks[`instance:${instance.id}`] ?? tasks[`version:${instance.minecraft}`];
    if (task?.state === 'running' || instance.installing) {
      return { kind: 'busy', text: task ? `${task.stage ?? 'Установка'} · ${task.percent ?? 0}%` : 'Установка…', percent: task?.percent ?? 0 };
    }
    if (!instance.installed) {
      return { kind: 'idle', text: 'Скачается при запуске' };
    }
    return { kind: 'ready', text: instance.lastPlayedAt ? `Играли ${formatAgo(instance.lastPlayedAt)}` : 'Готова к игре' };
  }

  function card(instance, index, view) {
    const selected = store.get().settings?.selectedInstanceId === instance.id;
    const status = statusOf(instance);
    const statusText = h('span', { class: 'instance-card__status-text' }, status.text);
    const statusDot = h('span', { class: `status-dot status-dot--${status.kind === 'ready' ? 'ok' : status.kind}` });
    const bar = h('span', { class: 'instance-card__bar' });
    const progress = h('div', { class: 'instance-card__progress', hidden: status.kind !== 'busy' }, bar);
    bar.style.width = `${status.percent ?? 0}%`;
    const playButton = h('button', {
      class: 'instance-card__play',
      type: 'button',
      title: status.kind === 'running' ? 'Остановить' : 'Играть',
      'aria-label': `Играть в ${instance.name}`,
      onclick: (event) => {
        event.stopPropagation();
        if (store.get().game.instanceId === instance.id && store.get().game.state === 'running') {
          stopGame();
          return;
        }
        pixelBurst(event.currentTarget);
        playInstance(instance.id);
      },
    }, icon(status.kind === 'running' ? 'close' : 'play'));
    const menuButton = h('button', { class: 'icon-button instance-card__menu', type: 'button', title: 'Действия', onclick: (event) => { event.stopPropagation(); openMenu(instance, event.currentTarget); } }, h('span', { class: 'dots' }, '⋯'));

    const element = h(
      'article',
      {
        class: `instance-card instance-card--${view}${selected ? ' instance-card--selected' : ''} rise`,
        style: { '--delay': `${Math.min(index, 16) * 30}ms` },
        tabindex: '0',
        'data-id': instance.id,
        // Cards are dragged onto group headers or other groups' cards to move them between groups.
        draggable: 'true',
        ondragstart: (event) => {
          event.dataTransfer.setData(DRAG_TYPE, instance.id);
          event.dataTransfer.effectAllowed = 'move';
          event.currentTarget.classList.add('instance-card--dragging');
          content.classList.add('instance-groups--dragging');
        },
        ondragend: (event) => {
          event.currentTarget.classList.remove('instance-card--dragging');
          content.classList.remove('instance-groups--dragging');
          content.querySelectorAll('.instance-group--drop').forEach((group) => group.classList.remove('instance-group--drop'));
        },
        // One click opens the instance (header, tabs, content); it also becomes the selected one.
        onclick: () => {
          select(instance.id);
          openInstance(instance.id);
        },
        onkeydown: (event) => {
          if (event.key === 'Enter') openInstance(instance.id);
        },
        oncontextmenu: (event) => {
          event.preventDefault();
          openMenu(instance, event.currentTarget, event);
        },
      },
      h('div', { class: 'instance-card__art' }, iconImage(instance.icon, 'instance-card__icon'), playButton),
      h(
        'div',
        { class: 'instance-card__body' },
        h('div', { class: 'instance-card__name', title: instance.name }, instance.name),
        h('div', { class: 'instance-card__meta' }, h('span', { class: `loader-tag loader-tag--${instance.loader.type}` }, LOADER_LABELS[instance.loader.type]), h('span', null, instance.minecraft)),
        h('div', { class: 'instance-card__status' }, statusDot, statusText),
        view === 'list' ? h('div', { class: 'instance-card__extra' }, `В игре: ${formatPlayTime(instance.playTimeMs)}`) : null,
        progress,
      ),
      menuButton,
    );
    cards.set(instance.id, { instance, statusText, statusDot, progress, bar, playButton });
    return element;
  }

  function select(instanceId) {
    if (store.get().settings?.selectedInstanceId !== instanceId) {
      saveSettings({ selectedInstanceId: instanceId }).catch((error) => toast(errorMessage(error), 'error'));
    }
  }

  function groupSection(name, instances, collapsed, view, startIndex) {
    const label = name || 'Без группы';
    const body = instances.length
      ? h('div', { class: `instance-grid instance-grid--${view}` }, instances.map((instance, index) => card(instance, startIndex + index, view)))
      : h('div', { class: 'instance-group__empty' }, 'Перетащите сюда сборки');
    const header = h(
      'button',
      {
        class: 'group-header',
        type: 'button',
        'aria-expanded': String(!collapsed),
        onclick: () => toggleGroup(name),
        oncontextmenu: (event) => {
          if (!name) return;
          event.preventDefault();
          openGroupMenu(name, event);
        },
      },
      h('span', { class: 'group-header__chevron' }, icon('chevron')),
      h('span', { class: 'group-header__title', 'data-i18n': name ? 'off' : null }, label),
      h('span', { class: 'group-header__count' }, String(instances.length)),
      h('span', { class: 'group-header__line' }),
    );
    const section = h('section', { class: `instance-group${collapsed ? ' instance-group--collapsed' : ''}${!name && !instances.length ? ' instance-group--drag-only' : ''}`, 'data-group': name }, header, h('div', { class: 'instance-group__body' }, body));
    // A whole group is a drop target: drop a card anywhere on it to move the instance there.
    const accepts = (event) => [...(event.dataTransfer?.types ?? [])].includes(DRAG_TYPE);
    section.addEventListener('dragover', (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      section.classList.add('instance-group--drop');
    });
    section.addEventListener('dragleave', (event) => {
      if (!section.contains(event.relatedTarget)) section.classList.remove('instance-group--drop');
    });
    section.addEventListener('drop', (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      section.classList.remove('instance-group--drop');
      const instance = store.get().instances.find((candidate) => candidate.id === event.dataTransfer.getData(DRAG_TYPE));
      if (instance && (instance.group || NO_GROUP) !== name) {
        sfx('page');
        updateInstance(instance.id, { group: name }).catch((error) => toast(errorMessage(error), 'error'));
      }
    });
    return section;
  }

  /** "Новая группа": an empty group that stays until it is deleted, ready for cards to be dropped in. */
  async function createGroup() {
    const name = await promptText({ title: 'Новая группа', label: 'Название группы', value: '', confirmLabel: 'Создать' });
    if (!name) return;
    const groups = store.get().settings?.instanceGroups ?? [];
    if (groups.includes(name) || store.get().instances.some((instance) => instance.group === name)) {
      toast('Такая группа уже есть', 'info');
      return;
    }
    saveSettings({ instanceGroups: [...groups, name] }).catch((error) => toast(errorMessage(error), 'error'));
  }

  function openGroupMenu(name, pointerEvent) {
    document.querySelector('.context-menu')?.remove();
    const item = (label, action, danger = false) => h('button', { class: `context-menu__item${danger ? ' context-menu__item--danger' : ''}`, type: 'button', onclick: () => { menu.remove(); action(); } }, label);
    const menu = h('div', { class: 'context-menu', role: 'menu' }, item('Переименовать группу', () => renameGroup(name)), item('Удалить группу', () => deleteGroup(name), true));
    document.body.append(menu);
    menu.style.left = `${Math.min(pointerEvent.clientX, window.innerWidth - menu.offsetWidth - 12)}px`;
    menu.style.top = `${Math.min(pointerEvent.clientY, window.innerHeight - menu.offsetHeight - 12)}px`;
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  async function renameGroup(name) {
    const next = await promptText({ title: 'Переименовать группу', label: 'Название группы', value: name, confirmLabel: 'Сохранить' });
    if (!next || next === name) return;
    const groups = store.get().settings?.instanceGroups ?? [];
    await saveSettings({ instanceGroups: groups.includes(name) ? groups.map((group) => (group === name ? next : group)) : [...groups, next] }).catch(() => {});
    for (const instance of store.get().instances.filter((candidate) => candidate.group === name)) {
      await api.instances.update(instance.id, { group: next }).catch(() => {});
    }
    await refreshInstances();
  }

  /** Deleting a group keeps its instances: they move to "Без группы". */
  async function deleteGroup(name) {
    const inside = store.get().instances.filter((instance) => instance.group === name);
    if (inside.length) {
      const confirmed = await confirmDialog({ title: `Удалить группу «${name}»?`, message: `Сборки из неё (${inside.length}) останутся и перейдут в «Без группы».`, confirmLabel: 'Удалить группу' });
      if (!confirmed) return;
    }
    await saveSettings({ instanceGroups: (store.get().settings?.instanceGroups ?? []).filter((group) => group !== name) }).catch(() => {});
    for (const instance of inside) {
      await api.instances.update(instance.id, { group: '' }).catch(() => {});
    }
    await refreshInstances();
  }
  function toggleGroup(name) {
    const collapsed = new Set(store.get().settings?.collapsedGroups ?? []);
    if (collapsed.has(name)) {
      collapsed.delete(name);
      sfx('page');
    } else {
      collapsed.add(name);
    }
    saveSettings({ collapsedGroups: [...collapsed] }).catch(() => {});
  }

  /** What the page shows, apart from progress: a full render only when this changes. */
  function structureKey() {
    const { instances, settings, instancesStatus, game } = store.get();
    return JSON.stringify([
      instancesStatus,
      instances.map((instance) => [instance.id, instance.name, instance.group, instance.icon, instance.minecraft, instance.loader, instance.installed, instance.lastPlayedAt]),
      settings?.selectedInstanceId,
      settings?.collapsedGroups,
      settings?.instanceGroups,
      settings?.instanceView,
      game.instanceId,
      game.state,
      state,
    ]);
  }

  function render() {
    const key = structureKey();
    if (key === renderedKey) {
      updateStatuses();
      return;
    }
    const firstRender = renderedKey === '';
    renderedKey = key;
    cards = new Map();
    const { instancesStatus, instances, settings } = store.get();
    const view = settings?.instanceView ?? 'grid';
    viewButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
    content.classList.toggle('instance-groups--static', !firstRender);
    if (instancesStatus !== 'ready' && instances.length === 0) {
      content.replaceChildren(h('div', { class: 'instance-grid instance-grid--grid' }, Array.from({ length: 4 }, () => h('div', { class: 'skeleton', style: { height: '200px' } }))));
      return;
    }
    if (instances.length === 0) {
      content.replaceChildren(
        h(
          'div',
          { class: 'empty-state surface empty-state--big' },
          iconImage('block:crafting_table', 'empty-state__block'),
          h('h2', null, 'Пока нет ни одной сборки'),
          h('p', { class: 'text-muted' }, 'Создайте свою: выберите версию Minecraft и загрузчик модов. Или установите готовый модпак с Modrinth или CurseForge.'),
          h('button', { class: 'btn btn--primary', type: 'button', onclick: () => openCreateInstanceModal() }, 'Создать сборку'),
        ),
      );
      return;
    }
    const list = filtered();
    if (list.length === 0) {
      content.replaceChildren(h('div', { class: 'empty-state' }, icon('search'), h('p', null, 'Ничего не найдено.')));
      return;
    }
    const groups = new Map();
    for (const instance of list) {
      const name = instance.group || NO_GROUP;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(instance);
    }
    // Groups made by the user stay even when empty (unless a search or filter is on); their order is the list's.
    const own = settings?.instanceGroups ?? [];
    if (!state.query && !state.loaderFilter) {
      for (const name of own) if (!groups.has(name)) groups.set(name, []);
      // An empty "Без группы" appears only while a card is dragged, to take it out of a group.
      if (!groups.has(NO_GROUP)) groups.set(NO_GROUP, []);
    }
    // The user's groups in their order, then other named groups alphabetically, ungrouped last.
    const rank = (name) => (name === NO_GROUP ? 2 : own.includes(name) ? 0 : 1);
    const names = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? own.indexOf(a) - own.indexOf(b) : a.localeCompare(b, 'ru')));
    const collapsed = new Set(settings?.collapsedGroups ?? []);
    let index = 0;
    content.replaceChildren(
      ...names.map((name) => {
        const section = groupSection(name, groups.get(name), collapsed.has(name), view, index);
        index += groups.get(name).length;
        return section;
      }),
    );
  }

  /** Progress and status text in place: called on every task event. */
  function updateStatuses() {
    for (const { instance, statusText, statusDot, progress, bar, playButton } of cards.values()) {
      const status = statusOf(instance);
      statusText.textContent = status.text;
      statusDot.className = `status-dot status-dot--${status.kind === 'ready' ? 'ok' : status.kind}`;
      progress.hidden = status.kind !== 'busy';
      bar.style.width = `${status.percent ?? 0}%`;
      playButton.disabled = status.kind === 'busy';
    }
  }

  // --- Menu ---------------------------------------------------------------------
  function openMenu(instance, anchor, pointerEvent = null) {
    document.querySelector('.context-menu')?.remove();
    const rect = anchor.getBoundingClientRect();
    const item = (label, action, danger = false) => h('button', { class: `context-menu__item${danger ? ' context-menu__item--danger' : ''}`, type: 'button', onclick: () => { menu.remove(); action(); } }, label);
    const menu = h(
      'div',
      { class: 'context-menu', role: 'menu' },
      item('Играть', () => playInstance(instance.id)),
      item('Открыть', () => openInstance(instance.id)),
      item('Моды', () => openInstance(instance.id, 'mod')),
      item('Папка сборки', () => api.app.openFolder(instance.directory).catch((error) => toast(errorMessage(error), 'error'))),
      h('div', { class: 'context-menu__divider' }),
      item('Переименовать', () => rename(instance)),
      item('Сменить картинку…', () => changeInstanceIcon(instance)),
      item('Переместить в группу…', () => moveToGroup(instance)),
      item('Копировать сборку', () => duplicate(instance)),
      h('div', { class: 'context-menu__divider' }),
      item('Удалить', () => remove(instance), true),
    );
    document.body.append(menu);
    const x = pointerEvent ? pointerEvent.clientX : rect.right - 200;
    const y = pointerEvent ? pointerEvent.clientY : rect.bottom + 6;
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 12)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 12)}px`;
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  function promptText({ title, label, value, confirmLabel, suggestions = [] }) {
    return new Promise((resolve) => {
      let result = null;
      const listId = `prompt-${Math.random().toString(36).slice(2)}`;
      const input = h('input', { class: 'input', type: 'text', value, maxlength: '64', list: listId, onkeydown: (event) => event.key === 'Enter' && done() });
      const done = () => {
        result = input.value.trim();
        modal.close();
      };
      const modal = openModal({
        title,
        content: h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input, h('datalist', { id: listId }, suggestions.map((option) => h('option', { value: option })))),
        footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: done }, confirmLabel)],
        onClose: () => resolve(result),
      });
      requestAnimationFrame(() => input.select());
    });
  }

  async function rename(instance) {
    const name = await promptText({ title: 'Переименовать сборку', label: 'Название', value: instance.name, confirmLabel: 'Сохранить' });
    if (name && name !== instance.name) {
      await updateInstance(instance.id, { name }).catch((error) => toast(errorMessage(error), 'error'));
    }
  }

  async function moveToGroup(instance) {
    const group = await promptText({ title: 'Группа сборки', label: 'Название группы (пусто — без группы)', value: instance.group, confirmLabel: 'Переместить', suggestions: existingGroups() });
    if (group !== null && group !== instance.group) {
      await updateInstance(instance.id, { group }).catch((error) => toast(errorMessage(error), 'error'));
    }
  }

  async function duplicate(instance) {
    const name = await promptText({ title: 'Копия сборки', label: 'Название копии', value: `${instance.name} (копия)`, confirmLabel: 'Копировать' });
    if (name) {
      try {
        await api.instances.duplicate(instance.id, name);
        await refreshInstances();
        toast('Сборка скопирована вместе с мирами и модами', 'success');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }
  }

  async function remove(instance) {
    const confirmed = await confirmDialog({
      title: `Удалить «${instance.name}»?`,
      message: 'Папка сборки будет удалена целиком: миры, моды, скриншоты и настройки. Это нельзя отменить.',
      confirmLabel: 'Удалить навсегда',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    try {
      await api.instances.remove(instance.id);
      sfx('delete');
      await refreshInstances();
      toast(`Сборка «${instance.name}» удалена`, 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  store.subscribe(['instances', 'instancesStatus', 'settings', 'game'], render);
  store.subscribe(['tasks'], updateStatuses);

  return {
    element,
    onShow: () => {
      render();
      refreshInstances().catch(() => {});
    },
  };
}
