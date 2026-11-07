import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { iconImage } from '../core/mc.js';
import { errorMessage } from '../core/format.js';
import { morph } from '../core/effects.js';
import { store } from '../state/appStore.js';
import { refreshInstances } from '../state/actions.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { createFileTree } from './fileTree.js';
import { existingGroups } from './createInstanceModal.js';

/*
 * "Копировать сборку", as Prism Launcher's "Копирование экземпляра": the copy's name and group, what
 * goes along (play time, worlds, game settings, packs, screenshots, shaders, servers, mods), and under
 * "Отдельные файлы" the instance folder as a tree, like Export, to tick single files. The ticks above
 * and the tree are one choice: ticking "Моды" ticks the mods folder, unticking one mod in the tree
 * shows "Моды" as partly chosen.
 */

const OPTIONS = [
  { key: 'playTime', label: 'Время в игре' },
  { key: 'saves', label: 'Миры', paths: ['saves'] },
  { key: 'options', label: 'Настройки игры', paths: ['options.txt', 'optionsof.txt', 'optionsshaders.txt'] },
  { key: 'resourcepacks', label: 'Ресурспаки', paths: ['resourcepacks'] },
  { key: 'screenshots', label: 'Скриншоты', paths: ['screenshots'] },
  { key: 'shaderpacks', label: 'Шейдеры', paths: ['shaderpacks'] },
  { key: 'servers', label: 'Список серверов', paths: ['servers.dat', 'servers.dat_old'] },
  { key: 'mods', label: 'Моды', paths: ['mods'] },
];
/** Left out unless ticked in the tree: what the game writes for itself. */
const LEFT_OUT = new Set(['logs', 'crash-reports']);

/** "Name (2)", "Name (3)"…: the first that no instance has (a copy is never named like the original). */
export function uniqueCopyName(name, takenNames) {
  const taken = new Set([...takenNames].map((entry) => entry.toLowerCase()));
  const match = /^(.*?) \((\d+)\)$/.exec(name);
  const base = match ? match[1] : name;
  for (let number = match ? Number(match[2]) + 1 : 2; ; number += 1) {
    const candidate = `${base} (${number})`.slice(0, 64);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function openCopyInstanceDialog(instance) {
  const names = store.get().instances.map((entry) => entry.name);
  const nameInput = h('input', { class: 'input', type: 'text', maxlength: '64', value: uniqueCopyName(instance.name, names), 'data-i18n': 'off', onkeydown: (event) => event.key === 'Enter' && copy() });
  const groups = [...new Set([...existingGroups(), ...(store.get().settings?.instanceGroups ?? [])])];
  const groupSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Группа' },
    h('option', { value: '' }, 'Без группы'),
    groups.map((group) => h('option', { value: group, 'data-i18n': 'off' }, group)),
  );
  groupSelect.value = instance.group || '';
  let playTime = true;

  const tree = createFileTree({
    load: (relative) => api.share.listFiles(instance.id, relative),
    sizes: (paths) => api.share.folderSizes(instance.id, paths),
    ticked: (entry) => !LEFT_OUT.has(entry.name),
    onChange: () => paint(),
  });

  const box = () => h('span', { class: 'pixel-check', 'aria-hidden': 'true' });
  const rows = OPTIONS.map((option) => {
    const check = box();
    const row = h('button', { class: 'copy-option', type: 'button', role: 'checkbox', onclick: () => toggle(option) }, check, h('span', null, option.label));
    return { option, row, check };
  });
  const allCheck = box();
  const allRow = h('button', { class: 'copy-option copy-option--all', type: 'button', role: 'checkbox', onclick: () => toggleAll() }, allCheck, h('span', null, 'Выбрать всё'));

  /** 'on', 'off', 'partial', or null when the instance has nothing of the kind. */
  function stateOf(option) {
    if (option.key === 'playTime') return playTime ? 'on' : 'off';
    const states = option.paths.map((path) => tree.stateOf(path)).filter(Boolean);
    if (!states.length) return null;
    if (states.every((state) => state === 'on')) return 'on';
    if (states.every((state) => state === 'off')) return 'off';
    return 'partial';
  }

  function show(row, check, state) {
    check.dataset.state = state ?? 'off';
    row.setAttribute('aria-checked', state === 'partial' ? 'mixed' : String(state === 'on'));
  }

  function paint() {
    const states = rows.map(({ option, row, check }) => {
      const state = stateOf(option);
      row.disabled = state === null;
      show(row, check, state);
      return state;
    });
    const present = states.filter(Boolean);
    show(allRow, allCheck, present.every((state) => state === 'on') ? 'on' : present.every((state) => state === 'off') ? 'off' : 'partial');
  }

  function setOption(option, on) {
    if (option.key === 'playTime') playTime = on;
    else option.paths.forEach((path) => tree.setTicked(path, on));
  }

  function toggle(option) {
    setOption(option, stateOf(option) !== 'on');
    paint();
  }

  function toggleAll() {
    const on = allCheck.dataset.state !== 'on';
    OPTIONS.forEach((option) => setOption(option, on));
    paint();
  }

  paint();
  tree.ready.then(paint);

  // Single files: the tree, folded until asked for.
  const filesBox = h('div', { class: 'copy-files', hidden: true }, tree.element);
  const filesToggle = h(
    'button',
    {
      class: 'copy-files__toggle',
      type: 'button',
      'aria-expanded': 'false',
      onclick: () => {
        const open = filesBox.hidden;
        morph(() => {
          filesBox.hidden = !open;
          filesToggle.setAttribute('aria-expanded', String(open));
        }, { panel: filesToggle.closest('.modal') });
      },
    },
    icon('chevron'),
    h('span', null, 'Отдельные файлы'),
  );

  const copyButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => copy() }, 'Копировать');

  async function copy() {
    const name = nameInput.value.trim() || uniqueCopyName(instance.name, names);
    const paths = tree.selectedPaths();
    copyButton.disabled = true;
    try {
      const made = await api.instances.duplicate(instance.id, { name, group: groupSelect.value, playTime, paths });
      modal.close();
      await refreshInstances();
      // One message when the files are in (the card shows the progress meanwhile). A small instance
      // can be copied before this line runs, so the task is looked at right away too.
      let stop = null;
      let told = false;
      const check = ({ tasks }) => {
        const task = tasks?.[`instance:${made.id}`];
        if (told || (task?.state !== 'done' && task?.state !== 'error')) return;
        told = true;
        stop?.();
        if (task.state === 'done') toast(`Сборка «${made.name}» скопирована`, 'success', 4800, { group: 'instances' });
        else toast(`Не удалось скопировать «${made.name}»: ${task.detail || ''}`, 'error', 8000);
      };
      stop = store.subscribe(['tasks'], check);
      check(store.get());
      if (told) stop();
    } catch (error) {
      copyButton.disabled = false;
      toast(errorMessage(error), 'error');
    }
  }

  const modal = openModal({
    title: 'Копировать сборку',
    wide: true,
    content: h(
      'div',
      { class: 'copy-dialog' },
      h(
        'div',
        { class: 'copy-dialog__head' },
        h('div', { class: 'copy-dialog__icon' }, iconImage(instance.icon, 'copy-dialog__img')),
        h(
          'div',
          { class: 'copy-dialog__fields' },
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Название'), nameInput),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Группа'), groupSelect),
        ),
      ),
      h('div', { class: 'field__label copy-dialog__label' }, 'Что скопировать'),
      h('div', { class: 'copy-options' }, rows.map(({ row }) => row), allRow),
      filesToggle,
      filesBox,
    ),
    footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), copyButton],
  });
  requestAnimationFrame(() => nameInput.select());
  return modal;
}
