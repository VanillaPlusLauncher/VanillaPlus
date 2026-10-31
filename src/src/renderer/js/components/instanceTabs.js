import { api } from '../services/api.js';
import { locale } from '../core/i18n.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { formatBytes } from '../core/content.js';
import { morph } from '../core/effects.js';
import { store } from '../state/appStore.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { createSegmented, loadingState } from './controls.js';
import { askUnknownMods } from './unknownModsDialog.js';
import { openServerSettings, setServerIconFromInstance } from './serverSettingsDialog.js';
import { openFriendPicker } from './friendPicker.js';

/*
 * Instance page tabs that show the instance folder: Screenshots, Files and the Journal (logs with
 * explanations of known errors). Each factory returns { element, load } and reads the instance
 * through getInstance() so it always works on the open one.
 */

const formatDate = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function emptyState(text, iconName = 'cube') {
  return h('div', { class: 'empty-state' }, icon(iconName), h('p', null, text));
}

function screenshotUrl(instance, name) {
  return `app://instance/${encodeURIComponent(instance.id)}/screenshots/${encodeURIComponent(name)}`;
}

// --- Screenshots -------------------------------------------------------------------------

export function createScreenshotsTab(getInstance) {
  const grid = h('div', { class: 'shot-grid' });
  const countLabel = h('span', { class: 'text-muted' });
  const element = h(
    'div',
    { class: 'instance-panel' },
    h(
      'div',
      { class: 'content-toolbar' },
      countLabel,
      h('span', { class: 'content-toolbar__spacer' }),
      h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => openFolder() }, icon('folder'), 'Папка скриншотов'),
    ),
    grid,
  );
  let shots = [];

  function openFolder() {
    const instance = getInstance();
    api.app.openFolder(`${instance.directory}\\screenshots`).catch((error) => toast(errorMessage(error), 'error'));
  }

  async function load() {
    const instance = getInstance();
    grid.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'skeleton shot-grid__skeleton' })));
    try {
      shots = await api.instances.screenshots(instance.id);
    } catch (error) {
      grid.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
      return;
    }
    countLabel.textContent = shots.length ? `Скриншотов: ${shots.length}` : '';
    if (shots.length === 0) {
      grid.replaceChildren(emptyState('Скриншотов пока нет. В игре нажмите F2 — снимок появится здесь.', 'cube'));
      return;
    }
    grid.replaceChildren(
      ...shots.map((shot, index) =>
        h(
          'button',
          { class: 'shot-card rise', type: 'button', style: { '--delay': `${Math.min(index, 20) * 25}ms` }, title: shot.name, onclick: () => openViewer(index) },
          h('img', { class: 'shot-card__img', src: screenshotUrl(instance, shot.name), alt: shot.name, loading: 'lazy', decoding: 'async' }),
          h('span', { class: 'shot-card__date' }, formatDate(shot.modifiedAt)),
        ),
      ),
    );
  }

  function openViewer(startIndex) {
    const instance = getInstance();
    let index = startIndex;
    const image = h('img', { class: 'shot-viewer__img', alt: '' });
    const caption = h('div', { class: 'shot-viewer__caption' });
    const show = (next) => {
      index = (next + shots.length) % shots.length;
      const shot = shots[index];
      image.src = screenshotUrl(instance, shot.name);
      caption.textContent = `${shot.name} · ${formatDate(shot.modifiedAt)} · ${formatBytes(shot.size)} · ${index + 1} из ${shots.length}`;
    };
    const arrow = (direction) =>
      h('button', { class: `shot-viewer__arrow shot-viewer__arrow--${direction < 0 ? 'prev' : 'next'}`, type: 'button', 'aria-label': direction < 0 ? 'Предыдущий' : 'Следующий', onclick: () => show(index + direction) }, direction < 0 ? '‹' : '›');
    const onKey = (event) => {
      if (event.key === 'ArrowLeft') show(index - 1);
      if (event.key === 'ArrowRight') show(index + 1);
    };
    document.addEventListener('keydown', onKey);

    async function copy() {
      try {
        const blob = await (await fetch(image.src)).blob();
        const png = blob.type === 'image/png' ? blob : await toPng(image);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        toast('Скриншот скопирован', 'success');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }

    async function remove() {
      const shot = shots[index];
      const confirmed = await confirmDialog({ title: 'Удалить скриншот?', message: `«${shot.name}» попадёт в корзину, оттуда его можно вернуть.`, confirmLabel: 'В корзину', danger: true });
      if (!confirmed) return;
      try {
        await api.instances.deleteScreenshot(instance.id, shot.name);
        shots.splice(index, 1);
        load();
        if (shots.length === 0) {
          modal.close();
        } else {
          show(index);
        }
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }

    const modal = openModal({
      title: 'Скриншот',
      size: 'xl',
      content: h('div', { class: 'shot-viewer' }, h('div', { class: 'shot-viewer__stage' }, image, shots.length > 1 ? arrow(-1) : null, shots.length > 1 ? arrow(1) : null), caption),
      footer: [
        h('button', { class: 'btn btn--ghost btn--danger', type: 'button', onclick: remove }, 'Удалить'),
        h('span', { class: 'content-toolbar__spacer' }),
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => api.instances.openEntry(instance.id, `screenshots/${shots[index].name}`, { reveal: true }).catch((error) => toast(errorMessage(error), 'error')) }, 'Показать в папке'),
        h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: copy }, 'Копировать'),
        h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => api.instances.openEntry(instance.id, `screenshots/${shots[index].name}`).catch((error) => toast(errorMessage(error), 'error')) }, 'Открыть'),
      ],
      onClose: () => document.removeEventListener('keydown', onKey),
    });
    show(index);
  }

  return { element, load };
}

function toPng(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// --- Files -------------------------------------------------------------------------------

const QUICK_FOLDERS = [
  ['mods', 'Моды'],
  ['config', 'Конфиги'],
  ['saves', 'Миры'],
  ['resourcepacks', 'Ресурспаки'],
  ['shaderpacks', 'Шейдеры'],
  ['screenshots', 'Скриншоты'],
  ['logs', 'Логи'],
  ['crash-reports', 'Вылеты'],
];

const FILE_KINDS = [
  [/\.(jar)$/i, 'JAR'],
  [/\.(zip|mrpack)$/i, 'ZIP'],
  [/\.(json|json5|toml|cfg|properties|txt|ini|yml|yaml|conf|snbt)$/i, 'CFG'],
  [/\.(png|jpe?g|gif|webp)$/i, 'IMG'],
  [/\.(log|gz)$/i, 'LOG'],
  [/\.(dat|dat_old|mca|nbt)$/i, 'DAT'],
];

function fileKind(name) {
  return FILE_KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'FILE';
}

export function createFilesTab(getInstance) {
  let currentPath = '';
  const crumbs = h('nav', { class: 'file-crumbs', 'aria-label': 'Путь' });
  const quick = h('div', { class: 'chip-row' });
  const list = h('div', { class: 'file-list' });
  const element = h(
    'div',
    { class: 'instance-panel' },
    h(
      'div',
      { class: 'content-toolbar' },
      crumbs,
      h('span', { class: 'content-toolbar__spacer' }),
      h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => openCurrentFolder() }, icon('folder'), 'Открыть в проводнике'),
    ),
    quick,
    list,
  );

  function openCurrentFolder() {
    const instance = getInstance();
    const folder = currentPath ? `${instance.directory}\\${currentPath.replace(/\//g, '\\')}` : instance.directory;
    api.app.openFolder(folder).catch((error) => toast(errorMessage(error), 'error'));
  }

  function renderCrumbs() {
    const parts = currentPath ? currentPath.split('/') : [];
    crumbs.replaceChildren(
      h('button', { class: 'file-crumbs__item', type: 'button', onclick: () => go('') }, getInstance()?.name ?? 'Сборка'),
      ...parts.flatMap((part, index) => [
        h('span', { class: 'file-crumbs__sep' }, '/'),
        h('button', { class: 'file-crumbs__item', type: 'button', onclick: () => go(parts.slice(0, index + 1).join('/')) }, part),
      ]),
    );
  }

  function go(path) {
    currentPath = path;
    load();
  }

  async function load() {
    const instance = getInstance();
    renderCrumbs();
    quick.replaceChildren(
      ...QUICK_FOLDERS.map(([folder, label]) =>
        h('button', { class: 'chip chip--small', type: 'button', 'aria-pressed': String(currentPath === folder), onclick: () => go(folder) }, label),
      ),
    );
    list.replaceChildren(h('div', { class: 'skeleton', style: { height: '160px' } }));
    let result;
    try {
      result = await api.instances.files(instance.id, currentPath);
    } catch (error) {
      list.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
      return;
    }
    const rows = [];
    if (currentPath) {
      rows.push(
        h('button', { class: 'file-row file-row--up', type: 'button', onclick: () => go(currentPath.split('/').slice(0, -1).join('/')) }, h('span', { class: 'file-row__icon file-row__icon--dir' }), h('span', { class: 'file-row__name' }, '..'), h('span'), h('span')),
      );
    }
    for (const entry of result.entries) {
      const relative = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      rows.push(
        h(
          'div',
          {
            class: `file-row${entry.dir ? ' file-row--dir' : ''}`,
            role: 'button',
            tabindex: '0',
            title: entry.dir ? 'Открыть папку' : 'Открыть файл',
            onclick: () => (entry.dir ? go(relative) : openFile(relative)),
            onkeydown: (event) => event.key === 'Enter' && (entry.dir ? go(relative) : openFile(relative)),
          },
          h('span', { class: `file-row__icon${entry.dir ? ' file-row__icon--dir' : ''}` }, entry.dir ? '' : fileKind(entry.name)),
          h('span', { class: 'file-row__name' }, entry.name),
          h('span', { class: 'file-row__meta' }, entry.dir ? '' : formatBytes(entry.size)),
          h('span', { class: 'file-row__meta' }, formatDate(entry.modifiedAt)),
          h(
            'button',
            {
              class: 'icon-button file-row__reveal',
              type: 'button',
              title: 'Показать в проводнике',
              onclick: (event) => {
                event.stopPropagation();
                api.instances.openEntry(instance.id, relative, { reveal: true }).catch((error) => toast(errorMessage(error), 'error'));
              },
            },
            icon('folder'),
          ),
        ),
      );
    }
    if (result.entries.length === 0) {
      rows.push(h('p', { class: 'text-muted file-list__empty' }, 'Папка пуста'));
    }
    list.replaceChildren(...rows);
  }

  async function openFile(relative) {
    try {
      const { revealed } = await api.instances.openEntry(getInstance().id, relative);
      if (revealed) {
        toast('Этот файл — программа или скрипт: показан в проводнике, а не запущен', 'info');
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return {
    element,
    load,
    reset: () => {
      currentPath = '';
    },
  };
}

// --- "Серверы" tab -------------------------------------------------------------------------------

/**
 * "Серверы": three parts, switched on top; the list comes first, as that is what most open the tab for —
 *  "Серверы"       the game's own multiplayer list: status, players, ping, Play, add / edit;
 *  "Свой сервер"   a server made from the instance, run by the launcher;
 *  "Для хостинга"  the instance as a server pack (zip or folder) with what you tick.
 */
export function createServersTab(getInstance, { onPlay } = {}) {
  const own = createOwnServerCard(getInstance, { onChange: () => own.load() });
  const exporter = createServerExportCard(getInstance);
  const others = createServerListCard(getInstance, { onPlay });
  const parts = { own, export: exporter, list: others };
  let current = 'list';
  const host = h('div', { class: 'servers-tab__part' });
  const switcher = createSegmented({
    options: [
      { value: 'list', label: 'Серверы' },
      { value: 'own', label: 'Свой сервер' },
      { value: 'export', label: 'Для хостинга' },
    ],
    value: current,
    // The box grows or shrinks to the part shown while the old part fades into it.
    onChange: (value) => morph(() => show(value), { panel: host }),
  });
  function show(value) {
    current = value;
    host.replaceChildren(parts[value].element);
    host.classList.remove('servers-tab__part--in');
    void host.offsetWidth;
    host.classList.add('servers-tab__part--in');
    parts[value].load();
  }
  host.append(others.element);
  return {
    element: h('div', { class: 'instance-panel servers-tab' }, h('div', { class: 'servers-tab__switch' }, switcher.element), host),
    load: () => parts[current].load(),
  };
}

// --- "Для хостинга": the instance as a server pack --------------------------------------------

const SIDE_LABELS = { client: 'Клиент', server: 'Сервер', both: 'Оба', unknown: 'Неизвестный' };

function createServerExportCard(getInstance) {
  const element = h('div', { class: 'surface server-export' });
  let mods = [];
  let chosen = new Set();
  let worlds = [];
  const options = { format: 'zip', configs: true, resourcepacks: false, datapacks: false, world: '', core: false, onlineMode: false, ramMb: 4096, port: 25565, acceptEula: false };

  async function load() {
    const instance = getInstance();
    if (!instance) return;
    element.replaceChildren(loadingState('Смотрим, какие моды нужны серверу…'));
    try {
      [mods, worlds] = await Promise.all([api.server.modsForServer(instance.id), api.instances.worlds(instance.id).catch(() => [])]);
    } catch (error) {
      element.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
      return;
    }
    chosen = new Set(mods.filter((mod) => mod.enabled && mod.side !== 'client' && mod.side !== 'unknown').map((mod) => mod.file));
    render();
  }

  const check = (label, hint, key, onChange) => {
    const input = h('input', { type: 'checkbox', checked: Boolean(options[key]) });
    input.addEventListener('change', () => {
      options[key] = input.checked;
      onChange?.();
    });
    return h('label', { class: 'server-export__check' }, input, h('span', null, h('b', null, label), hint ? h('small', { class: 'text-muted' }, hint) : null));
  };

  function render() {
    const counter = h('span', { class: 'server-export__count' });
    const paint = () => {
      const client = mods.filter((mod) => mod.side === 'client').length;
      counter.textContent = `На сервер: ${chosen.size} из ${mods.length}${client ? ` · клиентских: ${client}` : ''}`;
    };
    paint();
    const rows = mods.map((mod) => {
      const box = h('input', { type: 'checkbox', checked: chosen.has(mod.file) });
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(mod.file);
        else chosen.delete(mod.file);
        row.classList.toggle('server-mod--off', !box.checked);
        paint();
      });
      const row = h(
        'label',
        { class: `server-mod${chosen.has(mod.file) ? '' : ' server-mod--off'}` },
        box,
        mod.icon ? h('img', { class: 'server-mod__icon', src: mod.icon, alt: '', loading: 'lazy' }) : h('span', { class: 'server-mod__icon server-mod__icon--empty' }, icon('cube')),
        h('span', { class: 'server-mod__name', 'data-i18n': 'off' }, mod.title),
        mod.side
          ? h('span', { class: `server-mod__side server-mod__side--${mod.side}`, title: mod.side === 'unknown' ? 'Мода нет на Modrinth и CurseForge: ответьте, нужен ли он серверу' : '' }, SIDE_LABELS[mod.side] ?? mod.side)
          : h('span', { class: 'server-mod__side', title: 'Не удалось узнать: мод не с Modrinth и сам не сообщает' }, '?'),
        mod.enabled ? null : h('span', { class: 'text-muted server-mod__off' }, 'выключен'),
      );
      return row;
    });
    const worldSelect = h('select', { class: 'select select--compact' }, h('option', { value: '' }, 'Без мира'), ...worlds.map((world) => h('option', { value: world.folder ?? world.name }, world.name ?? world.folder)));
    worldSelect.value = options.world;
    worldSelect.addEventListener('change', () => {
      options.world = worldSelect.value;
    });
    const coreFields = h(
      'div',
      { class: 'server-export__core', hidden: !options.core },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Порт'), Object.assign(h('input', { class: 'input', type: 'number', min: '1024', max: '65535', value: String(options.port) }), { onchange: (event) => { options.port = Number(event.target.value) || 25565; } })),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Память'), Object.assign(h('select', { class: 'select' }, RAM_CHOICES.map((mb) => h('option', { value: String(mb), selected: mb === options.ramMb }, formatGigabytesShort(mb)))), { onchange: (event) => { options.ramMb = Number(event.target.value); } })),
      check('Только лицензия', 'online-mode: без этого заходят и офлайн-аккаунты', 'onlineMode'),
      h('label', { class: 'server-export__check' }, Object.assign(h('input', { type: 'checkbox', checked: options.acceptEula }), { onchange: (event) => { options.acceptEula = event.target.checked; } }), h('span', null, h('b', null, 'Принимаю EULA Minecraft'), h('small', { class: 'text-muted' }, 'тогда eula.txt будет готов; иначе его нужно поправить самому'))),
    );
    const format = createSegmented({ options: [{ value: 'zip', label: 'ZIP-архив' }, { value: 'folder', label: 'Папка' }], value: options.format, onChange: (value) => { options.format = value; } });
    const exportButton = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => exportPack(exportButton) }, icon('download'), 'Экспортировать');
    const allButton = (label, pick) => h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => { chosen = new Set(mods.filter(pick).map((mod) => mod.file)); render(); } }, label);
    element.replaceChildren(
      h('div', { class: 'server-export__head' },
        h('div', null, h('b', null, 'Сервер для хостинга'), h('p', { class: 'text-muted' }, 'Готовые файлы, чтобы залить сервер на любой хостинг или запустить у себя. Отметьте, что положить; клиентские моды (миникарты, шейдеры, меню) сняты сами.')),
      ),
      h('div', { class: 'server-export__grid' },
        h('div', { class: 'server-export__what' },
          h('h3', { class: 'section-title' }, 'Что положить'),
          check('Настройки модов', 'config, defaultconfigs, kubejs', 'configs'),
          check('Ресурспаки', 'папка resourcepacks', 'resourcepacks'),
          check('Датапаки', 'общие датапаки (datapacks, global_packs, openloader)', 'datapacks'),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Мир'), worldSelect),
          check('Готовый сервер', 'ядро сервера, server.properties и start.bat / start.sh', 'core', () => { coreFields.hidden = !options.core; }),
          coreFields,
          h('h3', { class: 'section-title' }, 'Как сохранить'),
          format.element,
          h('div', { class: 'server-export__actions' },
            exportButton,
            h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => exportList() }, 'Список модов сервера'),
          ),
        ),
        h('div', { class: 'server-export__mods' },
          h('div', { class: 'server-export__mods-head' }, h('h3', { class: 'section-title' }, 'Моды на сервер'), counter),
          h('div', { class: 'chip-row' }, allButton('Как советует лаунчер', (mod) => mod.enabled && mod.side !== 'client' && mod.side !== 'unknown'), allButton('Все', () => true), allButton('Ничего', () => false)),
          unknownNote(),
          mods.length ? h('div', { class: 'server-export__list' }, rows) : h('p', { class: 'text-muted' }, 'В сборке нет модов.'),
        ),
      ),
    );
  }

  /** Mods the launcher does not know: the same question as before a server of one's own. */
  function unknownNote() {
    const count = mods.filter((mod) => mod.side === 'unknown' && mod.enabled).length;
    if (!count) return null;
    return h(
      'div',
      { class: 'share-upload server-export__unknown' },
      h('span', null, `Незнакомых модов: ${count}. Их нет на Modrinth и CurseForge — скажите, нужны ли они серверу.`),
      h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: async () => { if (await askUnknownMods(getInstance())) load(); } }, 'Ответить'),
    );
  }

  async function exportPack(button) {
    button.disabled = true;
    const label = button.lastChild.textContent;
    button.lastChild.textContent = 'Готовим… (прогресс вверху)';
    try {
      const result = await api.server.exportPack(getInstance().id, { ...options, mods: [...chosen] });
      if (result) {
        toast(`Сервер сохранён: ${result.mods} модов${result.format === 'folder' ? ' (папка)' : ''}`, 'success', 6000, { action: { label: 'Показать', onClick: () => api.app.openFolder(result.format === 'folder' ? result.path : result.path.replace(/[\\/][^\\/]+$/, '')).catch(() => {}) } });
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
      button.lastChild.textContent = label;
    }
  }

  async function exportList() {
    try {
      const result = await api.server.exportModList(getInstance().id, [...chosen]);
      if (result) toast(`Список сохранён: ${result.mods} модов`, 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return { element, load };
}

// --- "Другие серверы": the game's multiplayer list -------------------------------------------

/** Signal bars like the game's server list: 0 (offline) to 5. */
function signalLevel(ping) {
  if (!ping?.online) return 0;
  const ms = ping.latencyMs ?? 999;
  return ms < 150 ? 5 : ms < 300 ? 4 : ms < 600 ? 3 : ms < 1000 ? 2 : 1;
}

/**
 * The instance's multiplayer servers (servers.dat, the same list as in the game's "Multiplayer"):
 * the servers you play on, with status, players and ping; Play joins one straight away; add, edit,
 * reorder and remove.
 */
function createServerListCard(getInstance, { onPlay } = {}) {
  let servers = [];
  const pings = new Map();
  let token = 0;
  const list = h('div', { class: 'server-list' });
  const element = h(
    'div',
    { class: 'server-others' },
    h(
      'div',
      { class: 'content-toolbar' },
      h('span', { class: 'text-muted' }, 'Серверы, где вы играете: тот же список, что в игре в «Сетевой игре».'),
      h('span', { class: 'content-toolbar__spacer' }),
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => pingAll() }, 'Обновить'),
      h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => edit(null) }, h('span', { class: 'plus' }, '+'), 'Добавить сервер'),
    ),
    list,
  );

  async function load() {
    list.replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'skeleton', style: { height: '76px' } })));
    try {
      servers = await api.server.list(getInstance().id);
    } catch (error) {
      list.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
      return;
    }
    render();
    pingAll();
  }

  function pingAll() {
    const mine = ++token;
    for (const server of servers) {
      pings.set(server.address, { pending: true });
      api.server
        .ping(server.address)
        .then((result) => {
          if (mine === token) {
            pings.set(server.address, result);
            render();
          }
        })
        .catch(() => {});
    }
    render();
  }

  function render() {
    if (servers.length === 0) {
      list.replaceChildren(emptyState('Серверов пока нет. Добавьте адрес — сервер появится и в игре.', 'cube'));
      return;
    }
    list.replaceChildren(
      ...servers.map((server, index) => {
        const ping = pings.get(server.address);
        const level = signalLevel(ping);
        const iconSrc = ping?.favicon ?? server.icon;
        const status = ping?.pending
          ? h('span', { class: 'text-muted' }, 'Проверяем…')
          : ping?.online
            ? h('span', { class: 'server-row__players' }, h('b', null, `${ping.players.online}`), ` / ${ping.players.max}`)
            : h('span', { class: 'server-row__offline' }, ping?.error ?? 'Нет связи');
        return h(
          'div',
          { class: `server-row${ping && !ping.pending && !ping.online ? ' server-row--offline' : ''}`, style: { '--delay': `${index * 50}ms` } },
          iconSrc ? h('img', { class: 'server-row__icon', src: iconSrc, alt: '' }) : h('div', { class: 'server-row__icon server-row__icon--empty' }, icon('cube')),
          h(
            'div',
            { class: 'server-row__text' },
            h('div', { class: 'server-row__name', 'data-i18n': 'off' }, server.name),
            h('div', { class: 'server-row__motd', 'data-i18n': 'off' }, ping?.online ? ping.motd || ' ' : server.address),
            h('div', { class: 'server-row__address text-muted', 'data-i18n': 'off' }, [server.address, ping?.online ? ping.version : null].filter(Boolean).join(' · ')),
          ),
          h(
            'div',
            { class: 'server-row__status' },
            status,
            h('span', { class: `signal signal--${level}`, title: ping?.latencyMs != null ? `${ping.latencyMs} мс` : '' }, ...[1, 2, 3, 4, 5].map((bar) => h('i', { class: bar <= level ? 'on' : '' }))),
            ping?.latencyMs != null ? h('span', { class: 'text-muted server-row__ms' }, `${ping.latencyMs} мс`) : null,
          ),
          h(
            'div',
            { class: 'server-row__actions' },
            h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => onPlay?.(server.address) }, icon('play'), 'Играть'),
            h('button', { class: 'icon-button', type: 'button', title: 'Выше', disabled: index === 0, onclick: () => move(index, -1) }, '▲'),
            h('button', { class: 'icon-button', type: 'button', title: 'Ниже', disabled: index === servers.length - 1, onclick: () => move(index, 1) }, '▼'),
            h('button', { class: 'icon-button', type: 'button', title: 'Изменить', onclick: () => edit(index) }, icon('pencil')),
            h('button', { class: 'icon-button', type: 'button', title: 'Удалить', onclick: () => remove(index) }, icon('close')),
          ),
        );
      }),
    );
  }

  async function save(next) {
    try {
      servers = await api.server.saveList(getInstance().id, next.map((server) => ({ key: server.key, name: server.name, address: server.address })));
      render();
      return true;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return false;
    }
  }

  function move(index, step) {
    const next = [...servers];
    const [item] = next.splice(index, 1);
    next.splice(index + step, 0, item);
    save(next);
  }

  async function remove(index) {
    const server = servers[index];
    const confirmed = await confirmDialog({ title: `Удалить «${server.name}»?`, message: `${server.address} пропадёт из списка серверов этой сборки (и в игре).`, confirmLabel: 'Удалить', danger: true });
    if (confirmed) save(servers.filter((_, position) => position !== index));
  }

  function edit(index) {
    const server = index === null ? { name: '', address: '' } : servers[index];
    const nameInput = h('input', { class: 'input', type: 'text', maxlength: '80', placeholder: 'Сервер Minecraft', value: server.name });
    const addressInput = h('input', { class: 'input mono', type: 'text', maxlength: '255', placeholder: 'play.example.com или 1.2.3.4:25565', value: server.address });
    const checkLine = h('div', { class: 'server-edit__check text-muted' });
    let checkToken = 0;
    const test = async () => {
      const address = addressInput.value.trim();
      if (!address) return;
      const mine = ++checkToken;
      checkLine.textContent = 'Проверяем…';
      const result = await api.server.ping(address).catch(() => null);
      if (mine !== checkToken) return;
      checkLine.textContent = result?.online ? `В сети: ${result.players.online} / ${result.players.max}, ${result.version ?? ''}, ${result.latencyMs ?? '?'} мс` : `Не отвечает: ${result?.error ?? 'нет связи'}`;
      if (result?.online && !nameInput.value.trim() && result.motd) nameInput.placeholder = result.motd.split('\n')[0].slice(0, 60);
    };
    addressInput.addEventListener('change', test);
    const done = async () => {
      const address = addressInput.value.trim();
      if (!address) {
        toast('Укажите адрес сервера', 'error');
        return;
      }
      const entry = { key: server.key, name: nameInput.value.trim() || nameInput.placeholder || address, address };
      const next = index === null ? [...servers, entry] : servers.map((item, position) => (position === index ? entry : item));
      if (await save(next)) {
        modal.close();
        pingAll();
      }
    };
    const modal = openModal({
      title: index === null ? 'Новый сервер' : 'Сервер',
      content: h('div', { class: 'server-edit' }, h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Адрес'), addressInput), h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Название'), nameInput), checkLine),
      footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: done }, index === null ? 'Добавить' : 'Сохранить')],
    });
    if (server.address) test();
  }

  return { element, load };
}

// --- Own server (one click) ----------------------------------------------------------------

const RAM_CHOICES = [2048, 3072, 4096, 6144, 8192];
// How invites go (Settings → "Друзья и скины"): with the instance's code, and with the author's own mods.
const social = () => store.get().settings?.social ?? {};
const inviteWithPack = () => social().inviteWithPack !== false;
const inviteUpload = () => social().inviteUpload !== 'never';
const serverLogListeners = new Set();
const serverStateListeners = new Set();
let serverEventsReady = false;

function listenServerEvents() {
  if (serverEventsReady) return;
  serverEventsReady = true;
  api.events.onServerLog((event) => serverLogListeners.forEach((listener) => listener(event)));
  api.events.onServerState((event) => serverStateListeners.forEach((listener) => listener(event)));
}

/** "Свой сервер": make a server from the instance, start/stop it, console, addresses for friends. */
function createOwnServerCard(getInstance, { onChange } = {}) {
  listenServerEvents();
  const element = h('div', { class: 'surface own-server' });
  let state = null;

  async function load() {
    const instance = getInstance();
    if (!instance) return;
    try {
      state = await api.server.get(instance.id);
    } catch (error) {
      element.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
      return;
    }
    render();
  }

  function render() {
    const instance = getInstance();
    if (!state?.exists) {
      // Where the server runs: on this computer (works now) or in Amethyx's cloud (being prepared).
      element.replaceChildren(
        h('div', { class: 'own-server__text' },
          h('b', null, 'Свой сервер'),
          h('span', { class: 'text-muted' }, 'Сервер из этой сборки для игры с друзьями: те же версия, загрузчик и моды. Клиентские моды (миникарты, шейдеры, меню) на сервер не попадут.'),
        ),
        h('div', { class: 'server-place' },
          h('button', { class: 'server-place__card', type: 'button', onclick: () => openCreate() },
            h('span', { class: 'server-place__title' }, icon('home'), 'На этом компьютере'),
            h('span', { class: 'server-place__text' }, 'Бесплатно. Сервер работает, пока включён компьютер и открыт лаунчер. Друзья в одной сети заходят сразу, из интернета — напрямую, через «Доступ из интернета».'),
            h('span', { class: 'server-place__action' }, 'Создать сервер'),
          ),
          h('div', { class: 'server-place__card server-place__card--soon', 'aria-disabled': 'true' },
            h('span', { class: 'server-place__title' }, icon('cloud'), 'В облаке Amethyx', h('span', { class: 'badge' }, 'Скоро')),
            h('span', { class: 'server-place__text' }, 'Сервер работает круглосуточно, даже когда компьютер выключен. Свой адрес для друзей, защита от атак, копии мира. По подписке.'),
            h('span', { class: 'server-place__action' }, 'Пока недоступно'),
          ),
        ),
      );
      return;
    }
    const port = state.port === 25565 ? '' : `:${state.port}`;
    element.replaceChildren(
      h('div', { class: 'own-server__text' },
        h('b', null, h('span', { class: `status-dot${state.running ? ' status-dot--ok' : ''}` }), state.running ? ' Сервер запущен' : ' Сервер остановлен'),
        h('span', { class: 'text-muted' }, `Этот компьютер: localhost${port}${state.lan ? ` · Домашняя сеть: ${state.lan}:${state.port}` : ''}`),
      ),
      state.running
        ? h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: (event) => stop(event.currentTarget) }, 'Остановить')
        : h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => start() }, icon('play'), 'Запустить'),
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => openConsole(instance, state) }, 'Консоль'),
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => openServerSettings(instance, { onRestart: () => restart() }) }, icon('gear'), 'Настройки'),
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', disabled: state.running, title: 'Перенести на сервер текущие моды и настройки сборки', onclick: () => sync() }, 'Обновить моды'),
      h('button', { class: 'icon-button', type: 'button', title: 'Папка сервера', onclick: () => api.app.openFolder(state.directory).catch((error) => toast(errorMessage(error), 'error')) }, icon('folder')),
      h('button', { class: 'icon-button', type: 'button', title: 'Удалить сервер', disabled: state.running, onclick: () => remove() }, icon('close')),
      tunnelBlock(),
    );
  }

  /**
   * "Доступ из интернета": the server's port opened on the home router (cloud/tunnel.js), so friends
   * join it directly by an invite in the chat. It opens whenever the server runs.
   */
  function tunnelBlock() {
    const instance = getInstance();
    const tunnel = state.tunnel ?? {};
    let text;
    if (!tunnel.enabled) text = 'Включите — лаунчер откроет порт сервера на роутере, и друзья зайдут к вам напрямую по приглашению в чате. Нужен роутер с UPnP и «белый» адрес от провайдера.';
    else if (state.running && tunnel.hosting) text = `Открыт${tunnel.address ? `: ${tunnel.address}` : ''}. Друзья заходят по приглашению — позовите их кнопкой справа.`;
    else if (state.running) text = 'Открывается…';
    else text = 'Откроется вместе с сервером. Приглашение можно отправить заранее: друг зайдёт, как только сервер запустится.';
    const invite = () =>
      openFriendPicker({
        title: `Позвать на сервер «${instance.name}»`,
        intro: 'Друг получит в чате карточку сборки: одна кнопка — и сборка соберётся, запустится и зайдёт к вам на сервер.',
        send: (friendId) => api.friends.sendInvite(friendId, { instanceId: instance.id, ownServer: true, withPack: inviteWithPack(), upload: inviteUpload() }),
      });
    return h(
      'div',
      { class: `own-server__tunnel${tunnel.enabled ? ' own-server__tunnel--on' : ''}` },
      h('div', { class: 'own-server__text' },
        h('b', null, icon('globe'), ' Доступ из интернета ', tunnel.enabled ? h('span', { class: `badge${state.running && tunnel.hosting ? ' badge--ok' : ''}` }, state.running && tunnel.hosting ? 'открыт' : 'включён') : null),
        h('span', { class: 'text-muted' }, text),
      ),
      tunnel.enabled ? h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: invite }, icon('play'), 'Пригласить друга') : null,
      h('button', { class: `btn ${tunnel.enabled ? 'btn--ghost' : 'btn--primary'} btn--compact`, type: 'button', onclick: (event) => setTunnel(!tunnel.enabled, event.currentTarget) }, tunnel.enabled ? 'Выключить' : 'Включить'),
    );
  }

  async function setTunnel(enabled, button) {
    button.disabled = true;
    try {
      state = await api.server.setTunnel(getInstance().id, enabled);
      render();
    } catch (error) {
      toast(errorMessage(error), 'error', 8000);
      button.disabled = false;
    }
  }

  async function restart() {
    await api.server.stop(getInstance().id).catch(() => {});
    await start();
  }

  async function start() {
    try {
      state = await api.server.start(getInstance().id);
      render();
      openConsole(getInstance(), state);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function stop(button) {
    button.disabled = true;
    button.textContent = 'Сохраняем мир…';
    await api.server.stop(getInstance().id).catch((error) => toast(errorMessage(error), 'error'));
    load();
  }

  async function sync() {
    try {
      if (!(await askUnknownMods(getInstance()))) return;
      const result = await api.server.sync(getInstance().id);
      toast(`На сервер перенесено модов: ${result.copied.length}${result.skipped.length ? `, клиентских пропущено: ${result.skipped.length}` : ''}`, 'success', 6000);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function remove() {
    const confirmed = await confirmDialog({ title: 'Удалить сервер?', message: 'Папка сервера вместе с его миром попадёт в корзину. Сборку это не затронет.', confirmLabel: 'Удалить', danger: true });
    if (!confirmed) return;
    try {
      await api.server.remove(getInstance().id);
      load();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function openCreate() {
    const instance = getInstance();
    const portInput = h('input', { class: 'input', type: 'number', min: '1024', max: '65535', value: '25565' });
    const motdInput = h('input', { class: 'input', type: 'text', maxlength: '59', value: `Сервер ${instance.name}`.slice(0, 59) });
    const ramSelect = h('select', { class: 'select' }, RAM_CHOICES.map((mb) => h('option', { value: String(mb) }, formatGigabytesShort(mb))));
    ramSelect.value = '4096';
    const online = h('input', { type: 'checkbox' });
    const eula = h('input', { type: 'checkbox' });
    const createButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: true, onclick: () => create() }, 'Создать сервер');
    eula.addEventListener('change', () => {
      createButton.disabled = !eula.checked;
    });

    async function create() {
      createButton.disabled = true;
      createButton.textContent = 'Смотрим моды…';
      try {
        // Mods the launcher does not know: the player says whether the server needs them.
        if (!(await askUnknownMods(instance))) {
          createButton.disabled = !eula.checked;
          createButton.textContent = 'Создать сервер';
          return;
        }
        createButton.textContent = 'Создаём… (прогресс вверху)';
        const result = await api.server.create(instance.id, { port: Number(portInput.value), motd: motdInput.value, ramMb: Number(ramSelect.value), onlineMode: online.checked, acceptEula: eula.checked });
        modal.close();
        await setServerIconFromInstance(instance);
        toast(`Сервер готов. Модов на сервере: ${result.copied}${result.skipped.length ? `, не для сервера: ${result.skipped.length}` : ''}`, 'success', 7000);
        onChange?.();
      } catch (error) {
        toast(errorMessage(error), 'error');
        createButton.disabled = !eula.checked;
        createButton.textContent = 'Создать сервер';
      }
    }

    const modal = openModal({
      title: `Сервер из «${instance.name}»`,
      wide: true,
      content: h(
        'div',
        { class: 'server-create' },
        h('div', { class: 'field-row field-row--3' },
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Порт'), portInput),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Память'), ramSelect),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Описание в списке серверов'), motdInput),
        ),
        h('label', { class: 'compat-dialog__remember' }, online, h('span', null, 'Только лицензия (online-mode): без этого заходят и офлайн-аккаунты')),
        h('label', { class: 'compat-dialog__remember' }, eula, h('span', null, 'Я принимаю ', h('button', { class: 'link-button', type: 'button', onclick: (event) => { event.preventDefault(); api.app.openExternal('https://aka.ms/MinecraftEULA'); } }, 'EULA Minecraft'), ' (без этого сервер Mojang не запускается)')),
        h('p', { class: 'text-muted server-create__hint' }, 'Друзья в той же сети заходят по адресу из карточки сервера, из интернета — через «Доступ из интернета» (лаунчер откроет порт на роутере). Остальные настройки — кнопкой «Настройки» после создания.'),
      ),
      footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), createButton],
    });
  }

  serverStateListeners.add((event) => {
    if (event.instanceId === getInstance()?.id) load();
  });

  return { element, load };
}

function formatGigabytesShort(mb) {
  return `${(mb / 1024).toString().replace('.', ',')} ГБ`;
}

/** Live server console with a command line. */
function openConsole(instance, state) {
  const view = h('div', { class: 'log-view server-console' });
  const lineClass = (line) => (/\bERROR\b|Exception/.test(line) ? ' log-view__line--error' : /\bWARN/.test(line) ? ' log-view__line--warn' : line.startsWith('---') || line.startsWith('> ') ? ' log-view__line--meta' : '');
  const add = (line) => {
    const stick = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    view.append(h('div', { class: `log-view__line${lineClass(line)}` }, line));
    while (view.childElementCount > 3000) view.firstElementChild.remove();
    if (stick) view.scrollTop = view.scrollHeight;
  };
  (state.lines ?? []).forEach(add);
  const input = h('input', { class: 'input mono', type: 'text', placeholder: 'Команда: say привет, op ник, time set day, stop…' });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await api.server.command(instance.id, text).catch((error) => toast(errorMessage(error), 'error'));
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') send();
  });
  const listener = (event) => {
    if (event.instanceId === instance.id) add(event.line);
  };
  serverLogListeners.add(listener);
  const nickname = store.get().accounts.find((account) => account.id === store.get().selectedAccountId)?.username;
  const modal = openModal({
    title: `Консоль сервера «${instance.name}»`,
    size: 'xl',
    content: h('div', { class: 'server-console__wrap' }, view, h('div', { class: 'path-row' }, input, h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: send }, 'Отправить'))),
    footer: [
      nickname ? h('button', { class: 'btn btn--ghost', type: 'button', title: 'Права администратора на сервере', onclick: () => api.server.command(instance.id, `op ${nickname}`).catch(() => {}) }, `Сделать ${nickname} оператором`) : null,
      h('span', { class: 'content-toolbar__spacer' }),
      h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => modal.close() }, 'Закрыть'),
    ].filter(Boolean),
    onClose: () => serverLogListeners.delete(listener),
  });
  requestAnimationFrame(() => {
    view.scrollTop = view.scrollHeight;
    input.focus();
  });
  return modal;
}

// --- World backups -------------------------------------------------------------------------

/** Backups of one world: restore in one click, delete, or make a new one. `onChange` refreshes the tab. */
export function openBackupsDialog(instance, world, onChange) {
  const list = h('div', { class: 'backup-list' }, h('div', { class: 'skeleton', style: { height: '120px' } }));

  async function render() {
    let backups;
    try {
      backups = (await api.instances.backups(instance.id)).filter((backup) => backup.world === world);
    } catch (error) {
      list.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
      return;
    }
    if (backups.length === 0) {
      list.replaceChildren(h('p', { class: 'text-muted backup-list__empty' }, 'Копий этого мира пока нет. Они делаются сами перед обновлением модов и сменой версии — или кнопкой ниже.'));
      return;
    }
    list.replaceChildren(
      ...backups.map((backup) =>
        h(
          'div',
          { class: 'backup-row' },
          h('div', { class: 'backup-row__text' }, h('b', null, formatDate(backup.createdAt)), h('span', { class: 'text-muted' }, `${backup.reason} · ${formatBytes(backup.size)}`)),
          h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => restore(backup) }, 'Восстановить'),
          h('button', { class: 'icon-button', type: 'button', title: 'Удалить копию', onclick: () => remove(backup) }, icon('close')),
        ),
      ),
    );
  }

  async function restore(backup) {
    const confirmed = await confirmDialog({
      title: `Вернуть «${world}» к ${formatDate(backup.createdAt)}?`,
      message: 'Мир станет таким, каким был в этой копии. Текущее состояние сохранится отдельной копией — откат можно отменить.',
      confirmLabel: 'Восстановить',
    });
    if (!confirmed) return;
    try {
      await api.instances.restoreBackup(instance.id, backup.id);
      toast(`Мир «${world}» восстановлен`, 'success');
      render();
      onChange?.();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function remove(backup) {
    const confirmed = await confirmDialog({ title: 'Удалить копию?', message: `Копия от ${formatDate(backup.createdAt)} будет удалена навсегда.`, confirmLabel: 'Удалить', danger: true });
    if (!confirmed) return;
    await api.instances.deleteBackup(instance.id, backup.id).catch((error) => toast(errorMessage(error), 'error'));
    render();
    onChange?.();
  }

  async function makeNow(button) {
    button.disabled = true;
    button.textContent = 'Копируем…';
    try {
      await api.instances.createBackup(instance.id, world);
      toast('Копия мира сделана', 'success');
      render();
      onChange?.();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Сделать копию сейчас';
    }
  }

  const makeButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: (event) => makeNow(event.currentTarget) }, 'Сделать копию сейчас');
  const modal = openModal({
    title: `Копии мира «${world}»`,
    wide: true,
    content: list,
    footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Закрыть'), makeButton],
  });
  render();
  return modal;
}

// --- Notes ---------------------------------------------------------------------------------

/** Free notes for an instance (server, seed, what the mods are for): saved as you type. */
export function createNotesTab(getInstance, { save }) {
  const area = h('textarea', { class: 'textarea notes-area', placeholder: 'Заметки: адрес сервера, сид мира, зачем стоят моды, что не забыть…', spellcheck: 'true' });
  const state = h('span', { class: 'text-muted notes-state' });
  let timer = 0;
  let saved = '';
  const flush = async () => {
    clearTimeout(timer);
    if (area.value === saved) return;
    const value = area.value;
    try {
      await save(value);
      saved = value;
      state.textContent = 'Сохранено';
    } catch (error) {
      state.textContent = errorMessage(error);
    }
  };
  area.addEventListener('input', () => {
    state.textContent = 'Изменено…';
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  });
  area.addEventListener('blur', flush);
  const element = h('div', { class: 'instance-panel notes-panel' }, area, state);
  return {
    element,
    load: () => {
      saved = getInstance()?.notes ?? '';
      area.value = saved;
      state.textContent = saved ? '' : 'Заметки видны только вам и хранятся в папке сборки.';
    },
    hide: flush,
  };
}

// --- Problems (journal and crash dialog) -----------------------------------------------

const ACTION_LABELS = { java: 'Открыть Java', memory: 'Настроить память', mods: 'Открыть моды', version: 'Открыть версию', 'jvm-args': 'Аргументы JVM' };

/** Cards for the problems found in a log. onAction(action) opens the right tab. */
export function renderProblems(problems, onAction) {
  return h(
    'div',
    { class: 'problem-list' },
    problems.map((problem) =>
      h(
        'div',
        { class: 'problem-card' },
        h('div', { class: 'problem-card__icon', 'aria-hidden': 'true' }, '!'),
        h(
          'div',
          { class: 'problem-card__body' },
          h('div', { class: 'problem-card__title' }, problem.title),
          problem.detail ? h('div', { class: 'problem-card__detail' }, problem.detail) : null,
          problem.fix ? h('div', { class: 'problem-card__fix' }, h('b', null, 'Что сделать: '), problem.fix) : null,
        ),
        problem.action && onAction && ACTION_LABELS[problem.action]
          ? h('button', { class: 'btn btn--secondary btn--compact problem-card__action', type: 'button', onclick: () => onAction(problem.action) }, ACTION_LABELS[problem.action])
          : null,
      ),
    ),
  );
}

// --- Journal -----------------------------------------------------------------------------

const LIVE_SOURCE = '__live__';
const MAX_RENDERED_LINES = 6000;

function lineLevel(line) {
  if (/^---/.test(line)) return 'meta';
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception\b|^\s*Caused by:|^\s+at [\w.$]+\(/.test(line)) return 'error';
  if (/\bWARN(ING)?\b/.test(line)) return 'warn';
  return 'info';
}

export function createLogTab(getInstance, { onAction } = {}) {
  let sources = [];
  let source = LIVE_SOURCE;
  let level = 'all';
  let query = '';
  let lines = [];
  let filePath = null;
  let unsubscribe = null;

  const sourceSelect = h('select', { class: 'select log-tab__source', 'aria-label': 'Журнал', onchange: () => select(sourceSelect.value) });
  const searchInput = h('input', { class: 'input log-tab__search', type: 'search', placeholder: 'Поиск в журнале…', oninput: () => { query = searchInput.value.trim().toLowerCase(); renderLines(); } });
  const levels = createSegmented({
    options: [
      { value: 'all', label: 'Все' },
      { value: 'warn', label: 'Предупреждения' },
      { value: 'error', label: 'Ошибки' },
    ],
    value: level,
    onChange: (value) => {
      level = value;
      renderLines();
    },
  });
  const problemsHost = h('div', { class: 'log-tab__problems' });
  const view = h('div', { class: 'log-view log-tab__view', role: 'log' });
  const note = h('div', { class: 'log-tab__note text-muted' });
  const openButton = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => openFile() }, 'Открыть файл');

  const element = h(
    'div',
    { class: 'instance-panel log-tab' },
    h(
      'div',
      { class: 'content-toolbar log-tab__toolbar' },
      sourceSelect,
      searchInput,
      levels.element,
      h('span', { class: 'content-toolbar__spacer' }),
      openButton,
      h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => copy() }, 'Копировать'),
    ),
    problemsHost,
    view,
    note,
  );

  function renderSources() {
    sourceSelect.replaceChildren(
      h('option', { value: LIVE_SOURCE }, 'Сейчас (вывод лаунчера и игры)'),
      ...sources.map((entry) => h('option', { value: entry.id }, `${entry.label} · ${formatDate(entry.modifiedAt)}`)),
    );
    sourceSelect.value = sources.some((entry) => entry.id === source) || source === LIVE_SOURCE ? source : LIVE_SOURCE;
  }

  function renderLines() {
    const matching = lines.filter((line) => (level === 'all' || (level === 'warn' ? lineLevel(line) !== 'info' : lineLevel(line) === 'error')) && (!query || line.toLowerCase().includes(query)));
    const shown = matching.slice(-MAX_RENDERED_LINES);
    const fragment = document.createDocumentFragment();
    for (const line of shown) {
      const kind = lineLevel(line);
      fragment.append(h('div', { class: `log-view__line${kind === 'info' ? '' : ` log-view__line--${kind}`}` }, line || ' '));
    }
    view.replaceChildren(fragment);
    if (matching.length === 0) {
      view.append(h('div', { class: 'log-view__line log-view__line--meta' }, lines.length === 0 ? 'Журнал пуст. Запустите игру — её вывод появится здесь.' : 'Ничего не найдено.'));
    }
    note.textContent = matching.length > shown.length ? `Показаны последние ${shown.length} строк из ${matching.length}. Весь журнал — кнопкой «Открыть файл».` : '';
    view.scrollTop = view.scrollHeight;
  }

  function renderAnalysis(problems, crash) {
    const parts = [];
    if (crash?.description) {
      parts.push(h('div', { class: 'log-tab__crash' }, h('b', null, 'Отчёт о вылете: '), crash.description, crash.exception ? h('div', { class: 'mono text-muted' }, crash.exception) : null));
    }
    if (problems?.length) {
      parts.push(h('div', { class: 'log-tab__problems-title' }, problems.length === 1 ? 'Лаунчер нашёл причину:' : `Лаунчер нашёл возможные причины (${problems.length}):`), renderProblems(problems, onAction));
    }
    problemsHost.replaceChildren(...parts);
  }

  function liveLines() {
    return [...store.get().logs];
  }

  async function select(id) {
    source = id;
    unsubscribe?.();
    unsubscribe = null;
    if (id === LIVE_SOURCE) {
      filePath = null;
      openButton.hidden = true;
      lines = liveLines();
      renderAnalysis([], null);
      renderLines();
      unsubscribe = store.subscribe(['logCount'], () => {
        lines = liveLines();
        renderLines();
      });
      return;
    }
    openButton.hidden = false;
    view.replaceChildren(h('div', { class: 'log-view__line log-view__line--meta' }, 'Загрузка…'));
    try {
      const result = await api.instances.readLog(getInstance().id, id);
      if (source !== id) return;
      filePath = id;
      lines = result.text.split(/\r?\n/);
      renderAnalysis(result.problems, result.crash);
      renderLines();
      if (result.truncated) {
        note.textContent = 'Файл очень большой: загружен его конец.';
      }
    } catch (error) {
      view.replaceChildren(h('div', { class: 'log-view__line log-view__line--error' }, errorMessage(error)));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('Журнал скопирован', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function openFile() {
    if (filePath) {
      api.instances.openEntry(getInstance().id, filePath).catch((error) => toast(errorMessage(error), 'error'));
    }
  }

  /** Opens the journal; `preferred` picks a source (a crash report after a crash). */
  async function load(preferred = null) {
    // The filter was built before the tab was on screen: place its highlight now.
    requestAnimationFrame(() => levels.setValue(level));
    try {
      sources = await api.instances.logs(getInstance().id);
    } catch {
      sources = [];
    }
    const running = store.get().game.instanceId === getInstance().id && store.get().game.state !== 'idle';
    const target = preferred ?? (running ? LIVE_SOURCE : sources.find((entry) => entry.kind === 'run')?.id ?? (sources[0]?.id || LIVE_SOURCE));
    source = target;
    renderSources();
    await select(sourceSelect.value);
  }

  return {
    element,
    load,
    hide: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
