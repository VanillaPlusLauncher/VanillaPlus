import { api } from '../services/api.js';
import { locale } from '../core/i18n.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { formatBytes } from '../core/content.js';
import { store } from '../state/appStore.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { createSegmented } from './controls.js';

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

// --- Own server tab -------------------------------------------------------------------------

/** The "Свой сервер" tab: a server made from the instance (other servers are added in the game). */
export function createServersTab(getInstance) {
  const own = createOwnServerCard(getInstance, { onChange: () => own.load() });
  return { element: h('div', { class: 'instance-panel' }, own.element), load: () => own.load() };
}

// --- Own server (one click) ----------------------------------------------------------------

const RAM_CHOICES = [2048, 3072, 4096, 6144, 8192];
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
      element.replaceChildren(
        h('div', { class: 'own-server__text' },
          h('b', null, 'Свой сервер'),
          h('span', { class: 'text-muted' }, 'Сервер из этой сборки для игры с друзьями: те же версия, загрузчик и моды. Клиентские моды (миникарты, шейдеры, меню) на сервер не попадут.'),
        ),
        h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => openCreate() }, 'Создать сервер'),
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
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', disabled: state.running, title: 'Перенести на сервер текущие моды и настройки сборки', onclick: () => sync() }, 'Обновить моды'),
      h('button', { class: 'icon-button', type: 'button', title: 'Папка сервера', onclick: () => api.app.openFolder(state.directory).catch((error) => toast(errorMessage(error), 'error')) }, icon('folder')),
      h('button', { class: 'icon-button', type: 'button', title: 'Удалить сервер', disabled: state.running, onclick: () => remove() }, icon('close')),
    );
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
      createButton.textContent = 'Создаём… (прогресс вверху)';
      try {
        const result = await api.server.create(instance.id, { port: Number(portInput.value), motd: motdInput.value, ramMb: Number(ramSelect.value), onlineMode: online.checked, acceptEula: eula.checked });
        modal.close();
        toast(`Сервер готов. Модов на сервере: ${result.copied}${result.skipped.length ? `, клиентских пропущено: ${result.skipped.length}` : ''}`, 'success', 7000);
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
        h('p', { class: 'text-muted server-create__hint' }, 'Друзья в той же сети заходят по адресу из карточки сервера. Чтобы зашли из интернета, нужно открыть порт на роутере или использовать сервис-туннель.'),
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
