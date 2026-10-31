import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage, formatGigabytes, formatReleaseDate, VERSION_TYPE_LABELS } from '../core/format.js';
import { sfx } from '../core/sound.js';
import { describeInstance, formatAgo, formatPlayTime, LOADER_LABELS } from '../core/content.js';
import { iconImage } from '../core/mc.js';
import { go, setDropHandler } from '../core/nav.js';
import { pixelBurst } from '../core/effects.js';
import { store } from '../state/appStore.js';
import { playInstance, refreshInstances, refreshJavaRuntimes, stopGame, updateInstance } from '../state/actions.js';
import { createContentList } from '../components/contentList.js';
import { createFilesTab, createLogTab, createNotesTab, createScreenshotsTab, createServersTab, openBackupsDialog } from '../components/instanceTabs.js';
import { changeInstanceIcon } from '../components/iconPicker.js';
import { openShareDialog } from '../components/shareDialog.js';
import { existingGroups } from '../components/createInstanceModal.js';
import { confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { createToggle } from '../components/controls.js';
import { closeAssistant, createAssistantButton } from '../components/assistant.js';

const TABS = [
  { key: 'mod', label: 'Моды' },
  { key: 'resourcepack', label: 'Ресурспаки' },
  { key: 'shader', label: 'Шейдеры' },
  { key: 'worlds', label: 'Миры' },
  { key: 'servers', label: 'Серверы' },
  { key: 'screenshots', label: 'Скриншоты' },
  { key: 'log', label: 'Журнал' },
];

/** A setting is saved this long after the typing stops. */
const AUTOSAVE_MS = 600;

/** Less used parts live behind the Settings button, with their own menu. */
const SETTINGS_SECTIONS = [
  { key: 'settings', label: 'Основное' },
  { key: 'version', label: 'Версия' },
  { key: 'java', label: 'Java' },
  { key: 'files', label: 'Файлы' },
  { key: 'notes', label: 'Заметки' },
];
const ALL_KEYS = [...TABS, ...SETTINGS_SECTIONS].map((entry) => entry.key);

/** Where a problem found in the journal is fixed. */
const ACTION_TABS = { java: 'java', memory: 'java', 'jvm-args': 'java', mods: 'mod', version: 'version' };

/** One instance, like Prism's "Edit instance": header, tabs, and the open tab below. */
export function createInstancePage() {
  let tab = 'mod';
  let instanceId = null;
  const instance = () => store.get().instances.find((candidate) => candidate.id === instanceId) ?? null;

  const lists = Object.fromEntries(['mod', 'resourcepack', 'shader'].map((type) => [type, createContentList(instance, type)]));
  const screenshotsTab = createScreenshotsTab(instance);
  const filesTab = createFilesTab(instance);
  const logTab = createLogTab(instance, { onAction: (action) => showTab(ACTION_TABS[action] ?? 'settings') });
  const serversTab = createServersTab(instance, {
    // "Другие серверы" → "Играть": the instance starts and joins that server.
    onPlay: (address) => playInstance(instanceId, { server: address }),
  });
  const notesTab = createNotesTab(instance, { save: (notes) => updateInstance(instanceId, { notes }) });
  const worldsGrid = h('div', { class: 'world-grid' });
  const backupAllButton = h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => backupAllWorlds() }, 'Копии всех миров');
  const worldsHost = h(
    'div',
    { class: 'instance-panel' },
    h('div', { class: 'content-toolbar' }, h('span', { class: 'text-muted' }, 'Копии миров делаются сами перед обновлением модов и сменой версии.'), h('span', { class: 'content-toolbar__spacer' }), backupAllButton),
    worldsGrid,
  );
  const formHost = h('div', { class: 'instance-settings' });

  const iconHost = h('button', {
    class: 'instance-hero__icon',
    type: 'button',
    title: 'Сменить картинку',
    onclick: () => changeIcon(),
    oncontextmenu: (event) => {
      event.preventDefault();
      changeIcon();
    },
  });
  const nameElement = h('h1', { class: 'page-title instance-hero__name' });
  const metaElement = h('div', { class: 'instance-hero__meta' });
  const statsElement = h('div', { class: 'instance-hero__stats' });
  const playButton = h('button', { class: 'btn btn--primary btn--play instance-hero__play', type: 'button' });
  const tabButtons = TABS.map((entry) => h('button', { class: 'tabs__button', type: 'button', role: 'tab', 'data-tab': entry.key, onclick: () => showTab(entry.key) }, entry.label));
  // The Settings button reopens the section shown last.
  let lastSection = 'settings';
  const settingsButton = h('button', { class: 'tabs__button instance-tabs__settings', type: 'button', role: 'tab', 'data-tab': 'settings', title: 'Основное, версия, Java, файлы, заметки', onclick: () => showTab(lastSection) }, icon('gear'), 'Настройки');
  const sectionButtons = SETTINGS_SECTIONS.map((entry) => h('button', { class: 'settings-nav__item', type: 'button', onclick: () => showTab(entry.key) }, entry.label));
  const sectionHost = h('div', { class: 'instance-settings-body' });
  const settingsView = h('div', { class: 'settings-layout instance-settings-layout' }, h('nav', { class: 'settings-nav surface' }, sectionButtons), sectionHost);
  const tabHost = h('div', { class: 'instance-tab-host' });

  const element = h(
    'section',
    { class: 'page page--instance', 'aria-label': 'Сборка' },
    h('button', { class: 'btn btn--ghost btn--compact back-button', type: 'button', onclick: () => go('builds') }, h('span', { class: 'back-button__arrow' }, '‹'), 'Все сборки'),
    h(
      'header',
      { class: 'instance-hero surface' },
      iconHost,
      h('div', { class: 'instance-hero__text' }, nameElement, metaElement, statsElement),
      h(
        'div',
        { class: 'instance-hero__actions' },
        playButton,
        h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => openFolder() }, icon('folder'), 'Папка'),
        h('button', { class: 'btn btn--secondary btn--compact', type: 'button', title: 'Код сборки или файл: Modrinth, CurseForge или .zip', onclick: () => openShareDialog(instance()) }, icon('export'), 'Экспортировать'),
        // Fixes and installs made by the helper show in the mod list at once.
        createAssistantButton({ getInstance: instance, onChanged: (id) => id === instanceId && lists.mod.load({ quiet: true }) }),
      ),
    ),
    h('div', { class: 'tabs instance-tabs', role: 'tablist' }, tabButtons, settingsButton),
    tabHost,
  );

  // Right-click on the header: the same quick actions as on the instance's card in the list.
  element.querySelector('.instance-hero').addEventListener('contextmenu', (event) => {
    if (event.target.closest('.instance-hero__icon')) return;
    event.preventDefault();
    document.querySelector('.context-menu')?.remove();
    const current = instance();
    const item = (label, action) => h('button', { class: 'context-menu__item', type: 'button', onclick: () => { menu.remove(); action(); } }, label);
    const menu = h(
      'div',
      { class: 'context-menu', role: 'menu' },
      item('Играть', () => playButton.click()),
      item('Папка сборки', () => openFolder()),
      item('Сменить картинку…', () => changeIcon()),
      h('div', { class: 'context-menu__divider' }),
      item('Экспорт…', () => openShareDialog(current)),
    );
    document.body.append(menu);
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 12)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 12)}px`;
    const close = (pointer) => {
      if (!menu.contains(pointer.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  });

  function renderHeader() {
    const current = instance();
    if (!current) {
      return;
    }
    iconHost.replaceChildren(iconImage(current.icon, 'instance-hero__img'));
    nameElement.textContent = current.name;
    metaElement.replaceChildren(
      ...[
        h('span', { class: `loader-tag loader-tag--${current.loader.type}` }, LOADER_LABELS[current.loader.type]),
        h('span', null, describeInstance(current)),
        current.group ? h('span', { class: 'badge badge--muted' }, current.group) : null,
        current.source?.platform ? h('span', { class: `badge badge--${current.source.platform}` }, `Модпак ${current.source.versionNumber ?? ''}`) : null,
      ].filter(Boolean),
    );
    statsElement.replaceChildren(
      h('span', null, h('b', null, formatPlayTime(current.playTimeMs)), ' в игре'),
      h('span', null, 'Последний запуск: ', h('b', null, formatAgo(current.lastPlayedAt))),
      h('span', null, current.installed ? 'Игра скачана' : 'Скачается при первом запуске'),
    );
    renderPlayButton();
  }

  function renderPlayButton() {
    const current = instance();
    const { game, launching, tasks } = store.get();
    const running = game.state === 'running' && game.instanceId === current?.id;
    const installing = Boolean(tasks[`instance:${current?.id}`]?.state === 'running');
    playButton.replaceChildren(icon(running ? 'close' : 'play'), running ? 'Остановить' : launching ? 'Запуск…' : installing ? 'Установка…' : 'Играть');
    playButton.disabled = !running && (launching || installing || game.state === 'running');
    playButton.onclick = () => {
      if (running) {
        stopGame();
      } else {
        pixelBurst(playButton, { count: 30 });
        playInstance(current.id);
      }
    };
  }

  function showTab(key, options = {}) {
    if (tab === 'log' && key !== 'log') {
      logTab.hide();
    }
    if (tab === 'notes' && key !== 'notes') {
      notesTab.hide();
    }
    tab = ALL_KEYS.includes(key) ? key : 'mod';
    const inSettings = SETTINGS_SECTIONS.some((entry) => entry.key === tab);
    TABS.forEach((entry, index) => tabButtons[index].setAttribute('aria-selected', String(entry.key === tab)));
    settingsButton.setAttribute('aria-selected', String(inSettings));
    SETTINGS_SECTIONS.forEach((entry, index) => sectionButtons[index].setAttribute('aria-current', String(entry.key === tab)));
    if (inSettings) {
      lastSection = tab;
      tabHost.replaceChildren(settingsView);
    }
    if (lists[tab]) {
      tabHost.replaceChildren(lists[tab].element);
      lists[tab].load();
    } else if (tab === 'worlds') {
      tabHost.replaceChildren(worldsHost);
      loadWorlds();
    } else if (tab === 'screenshots') {
      tabHost.replaceChildren(screenshotsTab.element);
      screenshotsTab.load();
    } else if (tab === 'files') {
      sectionHost.replaceChildren(filesTab.element);
      filesTab.load();
    } else if (tab === 'servers') {
      tabHost.replaceChildren(serversTab.element);
      serversTab.load();
    } else if (tab === 'notes') {
      sectionHost.replaceChildren(notesTab.element);
      notesTab.load();
    } else if (tab === 'log') {
      tabHost.replaceChildren(logTab.element);
      logTab.load(options.logId ?? null);
    } else {
      sectionHost.replaceChildren(formHost);
      const renderers = { version: renderVersion, java: renderJava, settings: renderSettings };
      renderers[tab]();
    }
  }

  async function loadWorlds() {
    worldsGrid.replaceChildren(h('div', { class: 'skeleton', style: { height: '90px' } }));
    try {
      const [worlds, backups] = await Promise.all([api.instances.worlds(instanceId), api.instances.backups(instanceId).catch(() => [])]);
      backupAllButton.hidden = worlds.length === 0;
      if (worlds.length === 0) {
        worldsGrid.replaceChildren(h('div', { class: 'empty-state' }, icon('cube'), h('p', null, 'Миров пока нет. Они появятся после первой игры.')));
        return;
      }
      worldsGrid.replaceChildren(
        ...worlds.map((world, index) =>
          h(
            'div',
            { class: 'world-card rise', style: { '--delay': `${index * 40}ms` } },
            world.icon ? h('img', { class: 'world-card__icon', src: world.icon, alt: '' }) : h('div', { class: 'world-card__icon world-card__icon--empty' }, iconImage('block:grass_block', 'world-card__placeholder')),
            h('div', { class: 'world-card__meta' }, h('span', { class: 'world-card__name' }, world.folder), h('span', { class: 'text-muted' }, `Играли ${formatAgo(world.lastPlayedAt)}`)),
            h('button', { class: 'btn btn--ghost btn--compact world-card__backups', type: 'button', title: 'Копии мира и восстановление', onclick: () => openBackupsDialog(instance(), world.folder, () => loadWorlds()) }, `Копии ${backups.filter((backup) => backup.world === world.folder).length || ''}`.trim()),
            h('button', { class: 'icon-button', type: 'button', title: 'Открыть папку мира', onclick: () => api.app.openFolder(world.path).catch((error) => toast(errorMessage(error), 'error')) }, icon('folder')),
          ),
        ),
      );
    } catch (error) {
      worldsGrid.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  async function backupAllWorlds() {
    backupAllButton.disabled = true;
    backupAllButton.textContent = 'Копируем…';
    try {
      const count = await api.instances.backupAll(instanceId, 'Вручную');
      toast(`Сделаны копии миров: ${count}`, 'success');
      loadWorlds();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      backupAllButton.disabled = false;
      backupAllButton.textContent = 'Копии всех миров';
    }
  }

  // --- Forms -----------------------------------------------------------------------------

  const card = (title, description, ...children) =>
    h('div', { class: 'surface settings-card settings-card--static' }, h('div', null, h('div', { class: 'settings-card__title' }, title), description ? h('div', { class: 'settings-card__desc' }, description) : null), ...children);
  const field = (label, control, hint = null) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), control, hint ? h('span', { class: 'field__hint' }, hint) : null);
  /**
   * Settings save themselves, quietly: a change is written a moment after the typing stops (a list
   * or a tick at once, a field when it loses the focus). Only an error says something.
   */
  function autoSave(save, ...controls) {
    let timer = 0;
    const now = () => {
      clearTimeout(timer);
      save();
    };
    for (const control of controls) {
      control.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(now, AUTOSAVE_MS);
      });
      control.addEventListener('change', now);
    }
    return now;
  }

  /** Saves a part of the overrides; the others stay as they are (read fresh: another part may have just saved). */
  async function saveOverrides(current, patch, extra = {}) {
    const fresh = instance() ?? current;
    try {
      await updateInstance(fresh.id, { ...extra, overrides: { ...(fresh.overrides ?? {}), ...patch } });
      renderHeader();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  // "Настройки": name, group, notes, window, server, launch.
  function renderSettings() {
    const current = instance();
    if (!current) return;
    const settings = store.get().settings;
    const overrides = { ...current.overrides };

    const nameInput = h('input', { class: 'input', type: 'text', maxlength: '64', value: current.name });
    const groupList = `groups-${current.id.length}`;
    const groupInput = h('input', { class: 'input', type: 'text', maxlength: '40', value: current.group, placeholder: 'Без группы', list: groupList });
    const widthInput = h('input', { class: 'input', type: 'number', min: '320', placeholder: settings.gameWidth ? String(settings.gameWidth) : 'авто', value: overrides.gameWidth ?? '' });
    const heightInput = h('input', { class: 'input', type: 'number', min: '240', placeholder: settings.gameHeight ? String(settings.gameHeight) : 'авто', value: overrides.gameHeight ?? '' });
    const fullscreenSelect = h(
      'select',
      { class: 'select' },
      h('option', { value: '' }, `Как в общих настройках (${settings.fullscreen ? 'да' : 'нет'})`),
      h('option', { value: 'true' }, 'Полный экран'),
      h('option', { value: 'false' }, 'В окне'),
    );
    fullscreenSelect.value = overrides.fullscreen === undefined || overrides.fullscreen === null ? '' : String(overrides.fullscreen);
    const serverInput = h('input', { class: 'input', type: 'text', placeholder: 'mc.example.com:25565', value: overrides.joinServer ?? '' });
    const afterLaunchLabels = { keep: 'оставлять', minimize: 'сворачивать', hide: 'прятать' };
    const afterLaunchSelect = h(
      'select',
      { class: 'select' },
      h('option', { value: '' }, `Как в общих настройках (${afterLaunchLabels[settings.afterLaunch] ?? settings.afterLaunch})`),
      h('option', { value: 'keep' }, 'Оставлять окно лаунчера'),
      h('option', { value: 'minimize' }, 'Сворачивать лаунчер'),
      h('option', { value: 'hide' }, 'Прятать до выхода из игры'),
    );
    afterLaunchSelect.value = overrides.afterLaunch ?? '';
    const preLaunchInput = h('input', { class: 'input mono', type: 'text', placeholder: 'например: backup.bat', value: overrides.preLaunchCommand ?? '' });
    const postExitInput = h('input', { class: 'input mono', type: 'text', placeholder: 'например: explorer screenshots', value: overrides.postExitCommand ?? '' });

    function save() {
      const width = Number(widthInput.value);
      const height = Number(heightInput.value);
      saveOverrides(
        current,
        {
          gameWidth: width > 0 ? width : null,
          gameHeight: height > 0 ? height : null,
          fullscreen: fullscreenSelect.value === '' ? null : fullscreenSelect.value === 'true',
          joinServer: serverInput.value.trim() || null,
          afterLaunch: afterLaunchSelect.value || null,
          preLaunchCommand: preLaunchInput.value.trim() || null,
          postExitCommand: postExitInput.value.trim() || null,
        },
        { name: nameInput.value.trim() || current.name, group: groupInput.value.trim() },
      );
    }

    formHost.replaceChildren(
      card('Основное', null,
        h('div', { class: 'field-row' }, field('Название', nameInput), h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Группа'), groupInput, h('datalist', { id: groupList }, existingGroups().map((group) => h('option', { value: group }))))),
      ),
      card('Окно игры', 'Пустые поля — как в общих настройках.',
        h('div', { class: 'field-row field-row--3' }, field('Ширина', widthInput), field('Высота', heightInput), field('Режим', fullscreenSelect)),
      ),
      card('Сервер при запуске', 'Игра сразу подключится к этому серверу.', serverInput),
      card('Запуск', 'Что делать с лаунчером и какие команды выполнить. Команды запускаются в папке сборки.',
        field('Окно лаунчера во время игры', afterLaunchSelect),
        h('div', { class: 'field-row' }, field('Команда перед запуском', preLaunchInput), field('Команда после выхода из игры', postExitInput)),
        h('span', { class: 'field__hint' }, 'Если команда перед запуском завершится с ошибкой, игра не запустится. Доступны переменные INST_NAME, INST_ID, INST_DIR, INST_MC_VERSION.'),
      ),
      h('div', { class: 'instance-settings__actions' }, h('button', { class: 'btn btn--secondary btn--compact btn--danger', type: 'button', onclick: () => removeInstance() }, 'Удалить сборку')),
    );
    autoSave(save, nameInput, groupInput, widthInput, heightInput, fullscreenSelect, serverInput, afterLaunchSelect, preLaunchInput, postExitInput);
  }

  // "Java": memory, which Java, JVM and game arguments.
  function renderJava() {
    const current = instance();
    if (!current) return;
    const settings = store.get().settings;
    const overrides = { ...current.overrides };

    // The slider always moves: moving it turns "Своё значение" on by itself; turning that off puts
    // the general value back.
    let ramOn = Number.isFinite(overrides.ramMb);
    const ramSlider = h('input', { class: 'range', type: 'range', min: '512', max: String(settings.maxRamMb), step: '256', value: String(overrides.ramMb ?? settings.ramMb) });
    const ramValue = h('span', { class: 'ram-value' }, formatGigabytes(Number(ramSlider.value)));
    const paintRam = () => {
      ramValue.textContent = formatGigabytes(Number(ramSlider.value));
      ramSlider.style.setProperty('--range-fill', `${((Number(ramSlider.value) - 512) / (settings.maxRamMb - 512)) * 100}%`);
      ramSlider.classList.toggle('range--inherited', !ramOn);
    };
    const ramToggle = createToggle({
      checked: ramOn,
      label: 'Своя память',
      onChange: (value) => {
        ramOn = value;
        if (!value) ramSlider.value = String(settings.ramMb);
        paintRam();
      },
    });
    ramSlider.addEventListener('input', () => {
      if (!ramOn) {
        ramOn = true;
        ramToggle.querySelector('input').checked = true;
      }
      paintRam();
    });
    paintRam();

    // Java: automatic (as in the Java page), one of the found runtimes, or a file picked by hand.
    // The list names the Java only; its path is plain text under it, to select or copy.
    const javaSelect = h('select', { class: 'select' });
    const javaPathText = h('span', { class: 'java-path__text mono', 'data-i18n': 'off' });
    const javaCopy = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => navigator.clipboard.writeText(javaSelect.value).then(() => toast('Путь скопирован', 'success')) }, 'Копировать');
    const javaPath = h('div', { class: 'java-path' }, javaPathText, javaCopy);
    const showJavaPath = () => {
      javaPathText.textContent = javaSelect.value || 'Лаунчер подберёт Java сам при запуске.';
      javaPathText.classList.toggle('text-muted', !javaSelect.value);
      javaCopy.hidden = !javaSelect.value;
    };
    javaSelect.addEventListener('change', showJavaPath);
    const fillJava = () => {
      const runtimes = store.get().javaRuntimes ?? [];
      const options = [h('option', { value: '' }, 'Как в общих настройках (подбирается сама)')];
      for (const runtime of runtimes) {
        options.push(h('option', { value: runtime.path }, `Java ${runtime.majorVersion} · ${runtime.vendor ?? ''} ${runtime.version}`));
      }
      if (overrides.javaPath && !runtimes.some((runtime) => runtime.path === overrides.javaPath)) {
        options.push(h('option', { value: overrides.javaPath }, `Свой файл · ${overrides.javaPath.split(/[\\/]/).slice(-3).join('\\')}`));
      }
      javaSelect.replaceChildren(...options);
      javaSelect.value = overrides.javaPath ?? '';
      showJavaPath();
    };
    fillJava();
    if (!store.get().javaRuntimes) {
      refreshJavaRuntimes().then(fillJava).catch(() => {});
    }
    async function pickJava() {
      const path = await api.app.pickJavaExecutable();
      if (path) {
        overrides.javaPath = path;
        fillJava();
        save();
      }
    }

    const jvmInput = h('textarea', { class: 'textarea mono', rows: '3', placeholder: `Как в общих настройках: ${settings.extraJvmArgs || 'нет'}` });
    jvmInput.value = overrides.extraJvmArgs ?? '';
    const presets = [
      ['Aikar (G1GC)', '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1'],
      ['ZGC (Java 21+)', '-XX:+UseZGC -XX:+ZGenerational'],
      ['Без аргументов', ''],
    ];
    const gameArgsInput = h('input', { class: 'input mono', type: 'text', placeholder: 'Например --demo', value: overrides.extraGameArgs ?? '' });

    function save() {
      saveOverrides(current, {
        ramMb: ramOn ? Number(ramSlider.value) : null,
        javaPath: javaSelect.value || null,
        extraJvmArgs: jvmInput.value.trim() ? jvmInput.value.trim() : null,
        extraGameArgs: gameArgsInput.value.trim() || null,
      });
    }

    formHost.replaceChildren(
      card('Память', `По умолчанию — как в общих настройках (${formatGigabytes(settings.ramMb)}).`,
        h('div', { class: 'settings-row' }, h('div', { class: 'settings-row__text' }, h('span', null, 'Своё значение для этой сборки')), ramToggle),
        h('div', { class: 'settings-row' }, h('div', { style: { flex: '1' } }, ramSlider), ramValue),
      ),
      card('Java', 'Обычно лаунчер сам берёт нужную Java. Своя Java пригодится, если нужна особая сборка.',
        h('div', { class: 'path-row' }, javaSelect, h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: pickJava }, 'Файл…')),
        javaPath,
      ),
      card('Аргументы JVM', 'Заменяют общие аргументы для этой сборки. Память задаётся выше, не здесь.',
        jvmInput,
        h('div', { class: 'chip-row' }, h('span', { class: 'text-muted' }, 'Готовые:'), ...presets.map(([label, value]) => h('button', { class: 'chip chip--small', type: 'button', onclick: () => { jvmInput.value = value; saveNow(); } }, label))),
      ),
      card('Аргументы игры', 'Добавляются к запуску Minecraft.', gameArgsInput),
    );
    const saveNow = autoSave(save, ramSlider, javaSelect, jvmInput, gameArgsInput);
    ramToggle.querySelector('input').addEventListener('change', saveNow);
  }

  // "Версия": Minecraft version, loader and its version, repair.
  function renderVersion() {
    const current = instance();
    if (!current) return;
    // The same picker as in "Новая сборка": a searchable list of versions and the loaders as cards.
    const minecraftSelect = { value: current.minecraft };
    const loaderSelect = { value: current.loader.type };
    let query = '';
    const versionList = h('div', { class: 'version-picker version-picker--page', role: 'listbox', 'aria-label': 'Версии Minecraft' });
    const versionSearch = h('input', { class: 'input', type: 'search', placeholder: 'Поиск версии', oninput: (event) => { query = event.target.value.trim().toLowerCase(); fillMinecraft(); } });
    const showSnapshots = createToggle({ checked: false, label: 'Снапшоты', onChange: () => fillMinecraft() });
    function fillMinecraft() {
      const withSnapshots = showSnapshots.querySelector('input').checked;
      const versions = store.get().catalog
        .filter((version) => version.type === 'release' || (withSnapshots && version.type === 'snapshot') || version.id === current.minecraft)
        .filter((version) => !query || version.id.toLowerCase().includes(query))
        .slice(0, 400);
      versionList.replaceChildren(
        ...versions.map((version) =>
          h(
            'button',
            { class: 'version-picker__item', type: 'button', role: 'option', 'aria-selected': String(version.id === minecraftSelect.value), 'data-version': version.id, onclick: () => pickMinecraft(version.id) },
            h('span', { class: 'version-picker__id' }, version.id),
            h('span', { class: 'version-picker__type' }, version.id === current.minecraft ? 'Сейчас' : VERSION_TYPE_LABELS[version.type] ?? version.type),
            version.installed ? h('span', { class: 'badge' }, 'Скачана') : null,
            h('span', { class: 'version-picker__date' }, formatReleaseDate(version.releaseTime)),
          ),
        ),
      );
      versionList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
    function pickMinecraft(id) {
      minecraftSelect.value = id;
      for (const item of versionList.children) item.setAttribute('aria-selected', String(item.dataset.version === id));
      sfx('click');
      loadLoaderVersions();
    }
    const loaderButtons = Object.entries(LOADER_LABELS).map(([value, label]) =>
      h('button', { class: `loader-button loader-button--${value}`, type: 'button', 'aria-pressed': String(value === loaderSelect.value), 'data-loader': value, onclick: () => pickLoader(value) }, label),
    );
    function pickLoader(value) {
      loaderSelect.value = value;
      loaderButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.loader === value)));
      loadLoaderVersions();
    }
    fillMinecraft();
    const loaderVersionSelect = h('select', { class: 'select', onchange: () => showChoice() });
    let token = 0;

    // "Применить" sits on top of the card, next to what the instance is now and what it would become:
    // under the long list of versions it was out of sight. Nothing changes until it is pressed.
    const applyButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: true, onclick: () => apply() }, 'Применить');
    const applyText = h('span', { class: 'card-action__text' });
    const applyBar = h('div', { class: 'card-action' }, applyText, applyButton);
    const describe = (minecraft, type, version) => `Minecraft ${minecraft}, ${LOADER_LABELS[type]}${version ? ` ${version}` : ''}`;
    function showChoice() {
      const loaderVersion = loaderSelect.value === 'vanilla' ? null : loaderVersionSelect.value || null;
      const changed =
        minecraftSelect.value !== current.minecraft ||
        loaderSelect.value !== current.loader.type ||
        (loaderSelect.value !== 'vanilla' && Boolean(loaderVersion) && loaderVersion !== current.loader.version);
      applyBar.classList.toggle('card-action--changed', changed);
      applyButton.disabled = !changed;
      applyText.replaceChildren(
        h('span', null, changed ? 'Станет:' : 'Сейчас:'),
        ' ',
        h('b', { 'data-i18n': 'off' }, changed ? describe(minecraftSelect.value, loaderSelect.value, loaderVersion) : describe(current.minecraft, current.loader.type, current.loader.version)),
      );
    }

    async function loadLoaderVersions() {
      const mine = ++token;
      if (loaderSelect.value === 'vanilla') {
        loaderVersionSelect.replaceChildren(h('option', { value: '' }, '—'));
        loaderVersionSelect.disabled = true;
        showChoice();
        return;
      }
      loaderVersionSelect.disabled = true;
      loaderVersionSelect.replaceChildren(h('option', { value: '' }, 'Загрузка…'));
      try {
        const versions = await api.versions.loaders(loaderSelect.value, minecraftSelect.value);
        if (mine !== token) return;
        const recommended = versions.find((version) => version.stable) ?? versions[0];
        loaderVersionSelect.replaceChildren(
          ...versions.slice(0, 200).map((version) => h('option', { value: version.version }, `${version.label}${version === recommended ? ' — рекомендуется' : version.stable ? '' : ' (бета)'}`)),
        );
        const keep = versions.find((version) => version.version === current.loader.version && loaderSelect.value === current.loader.type && minecraftSelect.value === current.minecraft);
        loaderVersionSelect.value = keep?.version ?? recommended?.version ?? '';
        loaderVersionSelect.disabled = versions.length === 0;
        if (versions.length === 0) {
          loaderVersionSelect.replaceChildren(h('option', { value: '' }, `Нет ${LOADER_LABELS[loaderSelect.value]} для ${minecraftSelect.value}`));
        }
      } catch (error) {
        loaderVersionSelect.replaceChildren(h('option', { value: '' }, errorMessage(error)));
      }
      showChoice();
    }

    loadLoaderVersions();
    showChoice();

    async function apply() {
      const loader = { type: loaderSelect.value, version: loaderSelect.value === 'vanilla' ? null : loaderVersionSelect.value || null };
      if (loader.type !== 'vanilla' && !loader.version) {
        toast('Для этой версии Minecraft нет выбранного загрузчика', 'error');
        return;
      }
      if (minecraftSelect.value === current.minecraft && loader.type === current.loader.type && loader.version === current.loader.version) {
        toast('Версия не изменилась', 'info');
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Сменить версию сборки?',
        // One template with plain values, so the interface language can translate the whole sentence.
        message: `Станет: ${`Minecraft ${minecraftSelect.value}, ${LOADER_LABELS[loader.type]}${loader.version ? ` ${loader.version}` : ''}`}. Новая версия скачается сейчас или при запуске. Моды могут не подойти к другой версии, а миры новой версии нельзя открыть в старой — сделайте копию сборки, если сомневаетесь.`,
        confirmLabel: 'Сменить',
      });
      if (!confirmed) return;
      try {
        await updateInstance(current.id, { minecraft: minecraftSelect.value, loader, versionId: loader.type === 'vanilla' ? minecraftSelect.value : null });
        toast('Версия изменена, устанавливаем…', 'success');
        renderHeader();
        renderVersion();
        await api.instances.install(current.id);
        await refreshInstances();
        renderHeader();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }

    async function repair() {
      const confirmed = await confirmDialog({
        title: 'Починить файлы игры?',
        message: 'Лаунчер заново проверит Minecraft и загрузчик и докачает повреждённые или пропавшие файлы. Моды, миры и настройки не тронет.',
        confirmLabel: 'Починить',
      });
      if (!confirmed) return;
      try {
        await api.instances.install(current.id, { repair: true });
        await refreshInstances();
        toast('Файлы игры проверены и починены', 'success');
        renderHeader();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }

    const installedText = current.installed ? `Установлено: ${current.versionId}` : 'Ещё не установлена — скачается при запуске.';
    formHost.replaceChildren(
      card('Версия и загрузчик', 'Перейти на другую версию Minecraft или поменять загрузчик модов. Если загрузчик не ставится — попробуйте другую его версию.',
        applyBar,
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Загрузчик модов'), h('div', { class: 'loader-grid' }, loaderButtons)),
        field('Версия загрузчика', loaderVersionSelect),
        h('div', { class: 'field' },
          h('span', { class: 'field__label' }, 'Minecraft'),
          h('div', { class: 'create-custom__version-tools' }, h('div', { class: 'input-with-icon', style: { flex: '1' } }, icon('search'), versionSearch), h('div', { class: 'settings-row' }, h('span', { class: 'text-muted' }, 'Снапшоты'), showSnapshots)),
          versionList,
        ),
      ),
      card('Файлы игры', installedText,
        h('div', { class: 'instance-settings__actions' },
          h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: repair }, 'Починить файлы'),
          h('span', { class: 'field__hint' }, 'Помогает, если игра пишет о повреждённых файлах или не находит библиотеки.'),
        ),
      ),
    );
  }

  /** The picture changes by a click on it (or right click on the instance in the list). */
  async function changeIcon() {
    if (await changeInstanceIcon(instance())) renderHeader();
  }

  function openFolder() {
    const current = instance();
    api.app.openFolder(current.directory).catch((error) => toast(errorMessage(error), 'error'));
  }

  async function removeInstance() {
    const current = instance();
    const confirmed = await confirmDialog({ title: `Удалить «${current.name}»?`, message: 'Папка сборки будет удалена целиком: миры, моды и настройки. Это нельзя отменить.', confirmLabel: 'Удалить навсегда', danger: true });
    if (!confirmed) return;
    try {
      await api.instances.remove(current.id);
      await refreshInstances();
      toast(`Сборка «${current.name}» удалена`, 'success');
      go('builds');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const dropHandler = async (paths) => {
    const type = lists[tab] ? tab : 'mod';
    const accepted = paths.filter((path) => (type === 'mod' ? /\.(jar|zip)$/i : /\.zip$/i).test(path));
    if (accepted.length === 0 || /\.mrpack$/i.test(paths[0])) {
      return false;
    }
    if (!lists[tab]) {
      showTab('mod');
    }
    await lists[type].addFiles(accepted);
    return true;
  };
  dropHandler.hint = 'Файлы добавятся в эту сборку';
  setDropHandler('instance', dropHandler);

  const isActive = () => element.classList.contains('page--active');

  /** Opens an instance and a tab: from the router or while the page is already shown. */
  function open() {
    const { openInstanceId, openInstanceTab, openInstanceLog } = store.get();
    const changed = openInstanceId !== instanceId;
    instanceId = openInstanceId;
    if (!instance()) {
      go('builds');
      return;
    }
    if (changed) {
      Object.values(lists).forEach((list) => list.reset());
      filesTab.reset();
    }
    renderHeader();
    showTab(openInstanceTab ?? (changed ? 'mod' : tab), { logId: openInstanceLog ?? null });
    store.set({ openInstanceTab: null, openInstanceLog: null });
  }

  store.subscribe(['instances'], () => {
    if (isActive()) {
      renderHeader();
    }
  });
  store.subscribe(['game', 'launching', 'tasks'], () => {
    if (isActive() && instance()) {
      renderPlayButton();
    }
  });
  return {
    element,
    onShow: open,
    onHide: () => {
      logTab.hide();
      notesTab.hide();
      closeAssistant();
    },
  };
}
