import { h, icon } from '../core/dom.js';
import { formatBytes } from '../core/content.js';

/*
 * A folder as a tree with ticks, like Prism Launcher's export dialog: a ticked folder goes in whole;
 * open it and untick what should stay out (the folder's tick then shows "part of it"). Folders open
 * one level at a time, as they are needed; their sizes come in by themselves.
 *
 * createFileTree({ load(relativeDir) → [{ name, path, dir, size? }], sizes(paths) → { path: bytes },
 *                  ticked(entry) → whether a top-level entry starts ticked })
 * → { element, selectedPaths(), retick(ticked) }
 */
export function createFileTree({ load, sizes, ticked }) {
  const element = h('div', { class: 'file-tree', role: 'tree' }, h('div', { class: 'file-tree__empty text-muted' }, 'Загрузка…'));
  let roots = [];

  function makeNode(entry, depth, parent, state) {
    const node = { entry, depth, parent, state, children: null, open: false };
    const box = h('button', { class: 'pixel-check', type: 'button', role: 'checkbox', 'aria-label': entry.name, onclick: (event) => { event.stopPropagation(); toggle(node); } });
    const chevron = entry.dir
      ? h('button', { class: 'file-tree__chevron', type: 'button', 'aria-label': 'Открыть', onclick: (event) => { event.stopPropagation(); openNode(node); } }, icon('chevron'))
      : h('span', { class: 'file-tree__chevron file-tree__chevron--none' });
    node.size = h('span', { class: 'file-tree__size' }, entry.dir ? '' : formatBytes(entry.size ?? 0));
    node.row = h(
      'div',
      { class: 'file-tree__row', role: 'treeitem', style: { paddingLeft: `${8 + depth * 22}px` }, onclick: () => (entry.dir ? openNode(node) : toggle(node)) },
      chevron,
      box,
      icon(entry.dir ? 'folder' : 'file'),
      h('span', { class: 'file-tree__name', 'data-i18n': 'off', title: entry.path }, entry.name),
      node.size,
    );
    node.box = box;
    node.childBox = h('div', { class: 'file-tree__children', hidden: true });
    node.element = h('div', { class: 'file-tree__node' }, node.row, node.childBox);
    paint(node);
    return node;
  }

  function paint(node) {
    node.box.dataset.state = node.state;
    node.box.setAttribute('aria-checked', node.state === 'partial' ? 'mixed' : String(node.state === 'on'));
    node.row.classList.toggle('file-tree__row--off', node.state === 'off');
  }

  function setState(node, state) {
    node.state = state;
    paint(node);
    node.children?.forEach((child) => setState(child, state));
  }

  /** A folder's tick from its children: all in, none, or part of it. */
  function refreshUp(node) {
    for (let current = node.parent; current; current = current.parent) {
      const states = new Set(current.children.map((child) => child.state));
      current.state = states.size === 1 ? [...states][0] : 'partial';
      paint(current);
    }
  }

  function toggle(node) {
    setState(node, node.state === 'on' ? 'off' : 'on');
    refreshUp(node);
  }

  async function openNode(node) {
    node.open = !node.open;
    node.row.classList.toggle('file-tree__row--open', node.open);
    node.childBox.hidden = !node.open;
    if (!node.open || node.children) return;
    node.childBox.replaceChildren(h('div', { class: 'file-tree__empty text-muted', style: { paddingLeft: `${30 + node.depth * 22}px` } }, 'Загрузка…'));
    const entries = await load(node.entry.path).catch(() => []);
    // A folder that was "part of it" has its children already; a whole one passes its tick down.
    node.children = entries.map((entry) => makeNode(entry, node.depth + 1, node, node.state === 'partial' ? 'off' : node.state));
    node.childBox.replaceChildren(...(node.children.length ? node.children.map((child) => child.element) : [h('div', { class: 'file-tree__empty text-muted', style: { paddingLeft: `${30 + node.depth * 22}px` } }, 'Папка пуста')]));
    fillSizes(node.children);
  }

  function fillSizes(nodes) {
    const folders = nodes.filter((node) => node.entry.dir);
    if (!folders.length) return;
    sizes(folders.map((node) => node.entry.path))
      .then((result) => folders.forEach((node) => { node.size.textContent = formatBytes(result[node.entry.path] ?? 0); }))
      .catch(() => {});
  }

  function collect(node) {
    if (node.state === 'on') return [node.entry.path];
    if (node.state === 'off' || !node.children) return [];
    return node.children.flatMap(collect);
  }

  load('')
    .then((entries) => {
      roots = entries.map((entry) => makeNode(entry, 0, null, ticked(entry) ? 'on' : 'off'));
      element.replaceChildren(...(roots.length ? roots.map((node) => node.element) : [h('div', { class: 'file-tree__empty text-muted' }, 'Папка пуста')]));
      fillSizes(roots);
    })
    .catch(() => element.replaceChildren(h('div', { class: 'file-tree__empty text-muted' }, 'Не удалось прочитать папку сборки.')));

  return {
    element,
    selectedPaths: () => roots.flatMap(collect),
    /** Ticks the top level again (another format has other usual contents). */
    retick(nextTicked) {
      roots.forEach((node) => setState(node, nextTicked(node.entry) ? 'on' : 'off'));
    },
  };
}
