import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage, formatGigabytes } from '../core/format.js';
import { getMcManifest, iconImage, mcUrl, onMcReady } from '../core/mc.js';
import { configureSound, presetFor, previewSound, SOUND_ACTIONS, SOUND_PRESETS } from '../core/sound.js';
import { store } from '../state/appStore.js';
import { saveSettings } from '../state/actions.js';
import { toast } from '../components/toast.js';
import { createSegmented, createToggle, loadingMark } from '../components/controls.js';
import { confirmDialog } from '../components/modal.js';
import { startTour } from '../components/tour.js';
import { createJavaPage } from './javaPage.js';
import { currentLanguage, LANGUAGES, locale } from '../core/i18n.js';

const RAM_STEP_MB = 256;
const MIN_RAM_MB = 512;
const SECTIONS = [
  { key: 'game', label: 'Игра', icon: 'block:grass_block' },
  { key: 'java', label: 'Java', icon: 'item:lava_bucket' },
  { key: 'appearance', label: 'Оформление', icon: 'item:amethyst_shard' },
  { key: 'sounds', label: 'Звуки', icon: 'block:note_block' },
  { key: 'content', label: 'Библиотека', icon: 'block:bookshelf' },
  { key: 'online', label: 'Друзья и скины', icon: 'item:cake' },
  { key: 'launcher', label: 'Лаунчер', icon: 'item:redstone' },
  { key: 'updates', label: 'Обновления', icon: 'item:clock_00' },
];
const ACCENTS = [
  { value: 'amethyst', label: 'Аметист', block: 'amethyst_block' },
  { value: 'vanilla', label: 'Ваниль', block: 'honeycomb_block' },
  { value: 'berry', label: 'Ягода', block: 'cherry_planks' },
  { value: 'lavender', label: 'Лаванда', block: 'purpur_block' },
  { value: 'diamond', label: 'Алмаз', block: 'diamond_block' },
  { value: 'gold', label: 'Золото', block: 'gold_block' },
  { value: 'redstone', label: 'Редстоун', block: 'redstone_block' },
  { value: 'lapis', label: 'Лазурит', block: 'lapis_block' },
  { value: 'copper', label: 'Медь', block: 'copper_block' },
];
// Panoramas of other versions: the list and the previews are fetched once per session.
let panoramaList = null;
const panoramaThumbs = new Map();
/** Settings, in sections. Every change is saved immediately; text fields save on blur. */
export function createSettingsPage() {
  let section = 'game';
  const navButtons = SECTIONS.map((entry) =>
    h('button', { class: 'settings-nav__item', type: 'button', onclick: () => showSection(entry.key) }, iconImage(entry.icon, 'settings-nav__icon'), entry.label),
  );
  const sectionHost = h('div', { class: 'settings-sections' });
  const element = h(
    'section',
    { class: 'page', 'aria-label': 'Настройки' },
    h('header', { class: 'page-header' }, h('div', null, h('h1', { class: 'page-title' }, 'Настройки'), h('p', { class: 'page-subtitle' }, 'Изменения сохраняются сразу. Сборки могут переопределять игровые настройки на своей странице.'))),
    h('div', { class: 'settings-layout' }, h('nav', { class: 'settings-nav surface' }, navButtons), sectionHost),
  );

  async function save(patch, quiet = true) {
    try {
      await saveSettings(patch);
      if (!quiet) {
        toast('Настройки сохранены', 'success', 2200);
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const card = (title, description, ...children) =>
    h('div', { class: 'surface settings-card settings-card--static' }, h('div', null, h('div', { class: 'settings-card__title' }, title), description ? h('div', { class: 'settings-card__desc' }, description) : null), ...children);
  const row = (title, description, control) =>
    h('div', { class: 'settings-row' }, h('div', { class: 'settings-row__text' }, h('span', { class: 'settings-row__title' }, title), description ? h('span', { class: 'settings-card__desc' }, description) : null), control);
  const toggle = (checked, onChange, label) => createToggle({ checked, label, onChange });
  const slider = ({ min, max, step, value, format, onCommit, onInput }) => {
    const output = h('span', { class: 'ram-value' });
    const input = h('input', { class: 'range', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const paint = () => {
      output.textContent = format(Number(input.value));
      input.style.setProperty('--range-fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('input', () => {
      paint();
      onInput?.(Number(input.value));
    });
    input.addEventListener('change', () => onCommit(Number(input.value)));
    paint();
    return h('div', { class: 'settings-row' }, h('div', { style: { flex: '1' } }, input), output);
  };

  // --- Sections ------------------------------------------------------------------------
  function gameSection(settings) {
    const dir = h('input', { class: 'input input--readonly', readonly: true, value: settings.gameDirectory });
    const jvm = h('textarea', { class: 'textarea', rows: '3', spellcheck: 'false', placeholder: '-XX:+UseG1GC -XX:MaxGCPauseMillis=50' });
    jvm.value = settings.extraJvmArgs;
    jvm.addEventListener('blur', () => jvm.value !== settings.extraJvmArgs && save({ extraJvmArgs: jvm.value }, false));
    const width = h('input', { class: 'input', type: 'number', min: '320', placeholder: 'авто', value: settings.gameWidth ?? '' });
    const height = h('input', { class: 'input', type: 'number', min: '240', placeholder: 'авто', value: settings.gameHeight ?? '' });
    const saveSize = () => save({ gameWidth: Number(width.value) > 0 ? Number(width.value) : null, gameHeight: Number(height.value) > 0 ? Number(height.value) : null }, false);
    width.addEventListener('change', saveSize);
    height.addEventListener('change', saveSize);
    const presets = [[854, 480], [1280, 720], [1600, 900], [1920, 1080]].map(([w, hgt]) =>
      h('button', { class: 'chip', type: 'button', onclick: () => { width.value = w; height.value = hgt; saveSize(); } }, `${w}×${hgt}`),
    );
    return [
      card('Оперативная память', `Сколько памяти получит Minecraft. Установлено ${formatGigabytes(settings.maxRamMb)}. Для модпаков — 6–8 ГБ.`,
        slider({ min: MIN_RAM_MB, max: settings.maxRamMb, step: RAM_STEP_MB, value: settings.ramMb, format: formatGigabytes, onCommit: (value) => save({ ramMb: value }, false) })),
      card('Окно игры', 'Размер окна при запуске. Пусто — как решит игра.',
        h('div', { class: 'field-row field-row--3' }, h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Ширина'), width), h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Высота'), height), h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Полный экран'), toggle(settings.fullscreen, (value) => save({ fullscreen: value }), 'Полный экран'))),
        h('div', { class: 'toolbar__chips' }, presets),
      ),
      card('Папка игры', 'Версии, библиотеки и ресурсы. Сборки лежат в её папке instances.',
        h('div', { class: 'path-row' }, dir,
          h('button', { class: 'icon-button', type: 'button', title: 'Выбрать папку', onclick: async () => { const folder = await api.app.pickDirectory('Папка для игры'); if (folder) save({ gameDirectory: folder }, false); } }, icon('folder')),
          h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => api.app.openFolder(settings.gameDirectory).catch((error) => toast(errorMessage(error), 'error')) }, 'Открыть')),
        h('div', null, h('button', { class: 'btn btn--ghost btn--compact', type: 'button', disabled: settings.gameDirectory === settings.defaultGameDirectory, onclick: () => save({ gameDirectory: null }, false) }, 'Вернуть папку по умолчанию')),
      ),
      card('Java', settings.javaMode === 'custom' ? `Вручную: ${settings.javaPath || 'не выбрана'}` : 'Автоматически: лаунчер сам подберёт и скачает нужную Java.',
        h('div', null, h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => showSection('java') }, 'Открыть раздел Java'))),
      card('Аргументы JVM', 'Добавляются ко всем сборкам. Сохраняются при уходе из поля.', jvm),
    ];
  }

  // Java: the former Java page, built once and kept (it follows the store by itself).
  let javaPage = null;
  function javaSection() {
    javaPage ??= createJavaPage({ embedded: true });
    javaPage.onShow();
    return [javaPage.element];
  }

  function appearanceSection(settings) {
    const ui = settings.ui;
    const accentGrid = h(
      'div',
      { class: 'accent-grid' },
      ACCENTS.map((accent) =>
        h(
          'button',
          {
            class: `accent-option accent-option--${accent.value}`,
            type: 'button',
            'aria-pressed': String(ui.accent === accent.value),
            onclick: () => save({ ui: { accent: accent.value } }),
          },
          iconImage(`block:${accent.block}`, 'accent-option__block'),
          h('span', null, accent.label),
        ),
      ),
    );
    // Background: Minecraft panoramas only — the latest, a random one, or one of any version.
    const option = (value, label, preview) => {
      const image = h('span', { class: 'background-option__preview' });
      if (preview) image.style.backgroundImage = `url("${preview}")`;
      return {
        image,
        element: h('button', { class: 'background-option', type: 'button', 'aria-pressed': String(ui.background === value), onclick: () => save({ ui: { background: value } }) }, image, h('span', { class: 'background-option__label' }, label)),
      };
    };
    const latest = getMcManifest()?.textures.panorama[0];
    const random = option('panorama:random', 'Случайная при каждом запуске', null);
    random.image.classList.add('background-option__preview--random');
    random.image.append(iconImage('item:compass_16', 'background-option__random-icon'));
    const backgroundGrid = h('div', { class: 'background-grid' }, random.element, option('panorama', 'Последняя версия', latest ? mcUrl(latest) : null).element);
    const fillPanoramas = (list) => {
      for (const entry of list) {
        const item = option(`panorama:${entry.id}`, `${entry.label} · ${entry.version}`, panoramaThumbs.get(entry.id) ?? null);
        backgroundGrid.append(item.element);
        if (!panoramaThumbs.has(entry.id)) {
          api.app.panoramaThumb(entry.id).then((thumb) => {
            panoramaThumbs.set(entry.id, mcUrl(thumb));
            item.image.style.backgroundImage = `url("${mcUrl(thumb)}")`;
          }).catch(() => item.image.classList.add('background-option__preview--missing'));
        }
      }
    };
    if (panoramaList) fillPanoramas(panoramaList);
    else api.app.panoramas().then((list) => { panoramaList = list; fillPanoramas(list); }).catch(() => {});
    const font = createSegmented({ options: [{ value: 'pixel', label: 'Пиксельный' }, { value: 'clean', label: 'Обычный' }], value: ui.font, onChange: (value) => save({ ui: { font: value } }) });
    const sidebar = createSegmented({
      options: [{ value: 'labels', label: 'С подписями' }, { value: 'hotbar', label: 'Хотбар' }, { value: 'icons', label: 'Только иконки' }],
      value: ui.sidebar ?? 'labels',
      onChange: (value) => save({ ui: { sidebar: value } }),
    });
    const cards = createSegmented({
      options: [{ value: 'tile', label: 'Плитка' }, { value: 'card', label: 'Карточка' }, { value: 'slot', label: 'Слот' }],
      value: ui.cards ?? 'tile',
      onChange: (value) => save({ ui: { cards: value } }),
    });
    const scale = createSegmented({ options: [80, 90, 100, 110, 125].map((value) => ({ value, label: `${value}%` })), value: ui.scale, onChange: (value) => save({ ui: { scale: value } }) });
    // Language names stay in their own language (data-i18n=off), whatever the interface language is.
    const languageSelect = h('select', { class: 'select', 'data-i18n': 'off', 'aria-label': 'Язык · Language', onchange: (event) => save({ ui: { language: event.target.value } }) }, LANGUAGES.map((entry) => h('option', { value: entry.code }, entry.label)));
    languageSelect.value = currentLanguage();
    return [
      card('Язык · Language', null, row('Язык интерфейса', null, languageSelect)),
      card('Цвет темы', 'Цвет кнопок, выделения и подсветки.', accentGrid),
      card('Панорама', 'Фон как в главном меню Minecraft разных версий. Панорама скачивается один раз, когда её выбирают.', backgroundGrid),
      card('Интерфейс', null,
        row('Шрифт заголовков и кнопок', 'Пиксельный похож на шрифт Minecraft.', font.element),
        row('Боковая панель', '«Хотбар» — как панель предметов в игре.', sidebar.element),
        row('Карточки сборок', 'Как выглядят сборки в сетке.', cards.element),
        row('Масштаб', 'Размер всего интерфейса.', scale.element),
        row('Анимации', 'Плавные переходы, частицы, вращение панорамы.', toggle(ui.animations, (value) => save({ ui: { animations: value } }), 'Анимации')),
        row('Искры при нажатии', 'Пиксельные искры вылетают из кнопки, когда её нажимаешь.', toggle(ui.sparks !== false, (value) => save({ ui: { sparks: value } }), 'Искры при нажатии')),
        row('Размытие под панелями', 'Выключите, если лаунчер тормозит на слабом ПК.', toggle(ui.blur, (value) => save({ ui: { blur: value } }), 'Размытие')),
      ),
    ];
  }

  function soundsSection(settings) {
    const sounds = settings.sounds;
    // A sound for every action: a list of the game's sounds, with ▶ to hear one.
    const presetOptions = Object.entries(SOUND_PRESETS).map(([value, preset]) => ({ value, label: preset.label }));
    const actionRows = SOUND_ACTIONS.map((action) => {
      const select = h('select', { class: 'select select--compact sound-action__select' }, presetOptions.map((preset) => h('option', { value: preset.value }, preset.label)));
      select.value = presetFor(action.key);
      select.addEventListener('change', () => {
        const actions = { ...(sounds.actions ?? {}), [action.key]: select.value };
        configureSound({ ...sounds, actions });
        previewSound(select.value);
        save({ sounds: { actions } });
      });
      return h('div', { class: 'sound-action' },
        h('span', { class: 'sound-action__label' }, action.label),
        select,
        h('button', { class: 'icon-button sound-action__play', type: 'button', 'data-sound': 'none', title: 'Послушать', onclick: () => previewSound(select.value) }, icon('play')));
    });
    return [
      card('Звуки интерфейса', 'Все звуки — из самого Minecraft.',
        row('Звук включён', null, toggle(sounds.enabled, (value) => save({ sounds: { enabled: value } }), 'Звук')),
        slider({ min: 0, max: 100, step: 5, value: sounds.volume, format: (value) => `${value}%`, onCommit: (value) => save({ sounds: { volume: value } }) }),
        row('Кнопки и переходы', null, toggle(sounds.clicks, (value) => save({ sounds: { clicks: value } }), 'Кнопки')),
        row('Наведение на карточки', null, toggle(sounds.hover, (value) => save({ sounds: { hover: value } }), 'Наведение')),
        row('События', 'Окна, уведомления, установка, запуск игры.', toggle(sounds.events, (value) => save({ sounds: { events: value } }), 'События')),
      ),
      card('Звук для каждого действия', null,
        h('div', { class: 'sound-actions' }, actionRows),
        h('div', null, h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => save({ sounds: { actions: {}, navSound: 'click' } }) }, 'Вернуть звуки по умолчанию')),
      ),
      card('Музыка меню', 'Музыка C418 из главного меню игры: Mutation, Moog City 2, Beginning 2, Floating Trees. Играет по очереди с паузами, как в игре.',
        row('Играть музыку', null, toggle(sounds.music, (value) => save({ sounds: { music: value } }), 'Музыка')),
        slider({ min: 0, max: 100, step: 5, value: sounds.musicVolume, format: (value) => `${value}%`, onCommit: (value) => save({ sounds: { musicVolume: value } }) }),
      ),
    ];
  }

  function contentSection(settings) {
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: '$2a$10$…', value: settings.curseforgeApiKey, autocomplete: 'off', spellcheck: 'false' });
    const showButton = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, 'Показать');
    keyInput.addEventListener('change', () => save({ curseforgeApiKey: keyInput.value.trim() }, false));
    return [
      card('Ключ CurseForge API', settings.curseforgeBuiltIn
        ? 'CurseForge уже работает: в лаунчер встроен свой ключ. Поле ниже — только если хотите пользоваться собственным ключом с console.curseforge.com.'
        : 'CurseForge выдаёт доступ к каталогу только по ключу. Он бесплатный: войдите на console.curseforge.com, создайте ключ (API keys) и вставьте сюда. Ключ хранится только на этом компьютере.',
        h('div', { class: 'path-row' }, keyInput, showButton),
        h('div', { class: 'settings-row', style: { justifyContent: 'flex-start' } },
          h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => api.app.openExternal('https://console.curseforge.com/') }, 'Получить ключ'),
          h('span', { class: settings.curseforgeApiKey || settings.curseforgeBuiltIn ? 'text-accent' : 'text-muted' }, settings.curseforgeApiKey ? 'свой ключ указан' : settings.curseforgeBuiltIn ? 'работает через ключ лаунчера' : 'ключ не указан'),
        ),
      ),
      card('Загрузки', 'Сколько файлов качать одновременно (моды, сборки, файлы игры) и на сколько частей делить большой файл — как в браузере: каждая часть идёт своим соединением, это заметно быстрее. Если интернет слабый или сайт ругается, уменьшите.',
        h('span', { class: 'settings-row__title' }, 'Файлов одновременно'),
        slider({ min: 1, max: 32, step: 1, value: settings.downloads?.parallel ?? 8, format: (value) => String(value), onCommit: (value) => save({ downloads: { parallel: value } }, false) }),
        h('span', { class: 'settings-row__title' }, 'Частей у файла (от 1 МБ)'),
        slider({ min: 1, max: 16, step: 1, value: settings.downloads?.segments ?? 4, format: (value) => (value === 1 ? 'целиком' : String(value)), onCommit: (value) => save({ downloads: { segments: value } }, false) }),
      ),
      card('Совместимость модов', 'Перед установкой лаунчер предупреждает о возможных конфликтах: мод для другого загрузчика или версии, несовместимость, указанная авторами, известные пары вроде Sodium и Embeddium.',
        row('Предупреждать о конфликтах', 'Предупреждение не мешает установить мод.', toggle(settings.compat?.warn !== false, (value) => save({ compat: { ...settings.compat, warn: value } }), 'Предупреждать')),
        h('div', { class: 'settings-row', style: { justifyContent: 'flex-start' } },
          h('button', {
            class: 'btn btn--ghost btn--compact',
            type: 'button',
            disabled: !(settings.compat?.ignored ?? []).length,
            onclick: () => save({ compat: { ...settings.compat, ignored: [] } }, false),
          }, `Вернуть скрытые предупреждения (${(settings.compat?.ignored ?? []).length})`),
        ),
      ),
    ];
  }

  function onlineSection(settings) {
    const social = settings.social ?? {};
    // Switches whose labels must stay on one line.
    const nowrap = (element) => {
      element.classList.add('segmented--nowrap');
      return element;
    };
    const update = (patch) => save({ social: { ...social, ...patch } });
    const serverInput = h('input', { class: 'input', type: 'text', placeholder: 'https://… (пусто — сервер Amethyx)', value: social.serverUrl ?? '', spellcheck: 'false', 'data-i18n': 'off' });
    serverInput.addEventListener('change', () => {
      const value = serverInput.value.trim();
      if (value && !/^(https:\/\/\S+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/i.test(value)) {
        toast('Адрес сервера должен начинаться с https://', 'error');
        return;
      }
      save({ social: { ...social, serverUrl: value } }, false);
    });
    return [
      card('Скины и плащи в игре', 'В сборках с модами (Fabric, Forge, NeoForge, Quilt) лаунчер ставит мод CustomSkinLoader: в игре видны ваш скин и плащ Amethyx и скины других игроков Amethyx. В сборках без модов так нельзя — там офлайн-аккаунты получают свой скин и плащ, а Microsoft и Ely.by остаются со своими.',
        row('Скины Amethyx в сборках с модами', 'Если выключить, мод больше не будет ставиться сам. Уже поставленный можно выключить на вкладке «Моды» сборки.', toggle(social.skinsInMods !== false, (value) => update({ skinsInMods: value }), 'Скины Amethyx')),
      ),
      card('Онлайн-функции', 'Друзья, статус «в сети» и скины, которые видят другие игроки Amethyx, работают через сервер Amethyx. На него уходят только ник, скин, плащ и (если разрешено) во что вы играете. Пароли и ключи входа туда не попадают.',
        row('Друзья и общие скины', null, toggle(social.online !== false, (value) => update({ online: value }), 'Онлайн-функции')),
        row('Показывать друзьям, во что я играю', 'Сборку, версию игры и сервер.', toggle(social.shareActivity !== false, (value) => update({ shareActivity: value }), 'Показывать активность')),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Свой сервер Amethyx (необязательно)'), serverInput),
      ),
      // How invites go out and what a click on a friend's invite does.
      card('Приглашения друзей', 'Друг заходит в ваш мир или на ваш сервер через туннель Amethyx: без белого IP, настройки роутера и модов. Вместе с приглашением уходит сборка — друг соберёт её одной кнопкой.',
        row('Отправлять сборку с приглашением', 'Друг получит те же версию, загрузчик и моды. Если сборка у него уже есть, она не собирается заново.', toggle(social.inviteWithPack !== false, (value) => update({ inviteWithPack: value }), 'Сборка с приглашением')),
        row('Моды не с Modrinth и CurseForge', 'Свои моды и моды из файлов загружаются на сервер Amethyx, чтобы друг их получил.', nowrap(createSegmented({
          options: [{ value: 'always', label: 'Загружать' }, { value: 'ask', label: 'Спрашивать' }, { value: 'never', label: 'Нет' }],
          value: social.inviteUpload ?? 'always',
          onChange: (value) => update({ inviteUpload: value }),
        }).element)),
        row('Когда друг зовёт', 'Что делает главная кнопка в приглашении: собирает сборку и сразу заходит к другу, или только собирает.', nowrap(createSegmented({
          options: [{ value: 'join', label: 'Сразу зайти' }, { value: 'build', label: 'Только собрать' }],
          value: social.acceptInvite ?? 'join',
          onChange: (value) => update({ acceptInvite: value }),
        }).element)),
      ),
    ];
  }

  function launcherSection(settings, info) {
    const after = createSegmented({
      options: [
        { value: 'keep', label: 'Оставлять' },
        { value: 'minimize', label: 'Сворачивать' },
        { value: 'hide', label: 'Прятать' },
      ],
      value: settings.afterLaunch,
      onChange: (value) => save({ afterLaunch: value }, false),
    });
    return [
      card('При запуске игры', 'Что делать с окном лаунчера, пока вы играете. «Прятать» — окно вернётся, когда игра закроется.', after.element,
        row('Открывать журнал игры', 'Удобно, если игра вылетает и нужно понять почему.', toggle(settings.showLogOnLaunch, (value) => save({ showLogOnLaunch: value }), 'Журнал'))),
      card('При закрытии окна', null,
        row('Сворачивать в трей', 'Крестик прячет лаунчер к часам: сообщения друзей и загрузки продолжаются. Открыть — кликом по значку, выйти совсем — правой кнопкой по значку → «Выйти». Если выключить, крестик закрывает лаунчер.', toggle(settings.closeToTray !== false, (value) => save({ closeToTray: value }, false), 'Трей'))),
      card('Обучение', 'Короткая экскурсия по лаунчеру: что где находится и зачем.',
        h('div', { class: 'settings-row', style: { justifyContent: 'flex-start' } },
          h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => startTour() }, 'Показать обучение'))),
      card('Данные лаунчера', 'Настройки, аккаунты, скины, журналы и загруженная Java.',
        h('span', { class: 'mono text-muted', style: { fontSize: '12px', overflowWrap: 'anywhere' } }, info?.dataDirectory ?? ''),
        h('div', { class: 'settings-row', style: { justifyContent: 'flex-start' } },
          h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => api.app.openFolder(info.dataDirectory).catch((error) => toast(errorMessage(error), 'error')) }, icon('folder'), 'Открыть папку данных'),
          h('button', { class: 'btn btn--secondary btn--compact btn--danger', type: 'button', onclick: resetAll }, 'Сбросить настройки'),
        ),
      ),
      card('О лаунчере', null, h('p', { class: 'text-soft' }, `Amethyx Launcher ${info?.version ?? ''}. Звуки, текстуры и панорама загружаются из Minecraft с серверов Mojang. 3D-просмотр скинов — skinview3d (MIT).`)),
    ];
  }

  // --- Updates -------------------------------------------------------------------------
  let updateStatus = null;

  function updatesSection(settings, info) {
    const updates = settings.updates ?? {};
    const current = info?.version ?? '';
    const statusBox = h('div', { class: 'update-status' });
    const status = updateStatus ?? { state: 'idle' };
    const latest = status.latest;
    const when = status.checkedAt ? new Date(status.checkedAt).toLocaleString(locale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;

    const lines = {
      idle: ['Ещё не проверяли', null],
      checking: ['Проверяем…', null],
      latest: ['У вас последняя версия', when ? `Проверено ${when}` : null],
      available: [`Доступна версия ${latest?.version}`, 'Загрузка начнётся сама или по кнопке.'],
      downloading: [`Скачиваем ${latest?.version}… ${status.progress ?? 0}%`, null],
      ready: [
        `Версия ${latest?.version} готова к установке`,
        status.postponed
          ? 'Установится при следующем запуске лаунчера или по кнопке.'
          : status.autoRestart
            ? 'Лаунчер обновится сам, когда закроется игра и закончатся загрузки.'
            : 'Лаунчер закроется, обновится и откроется снова. Сборки, миры и настройки останутся.',
      ],
      restarting: [`Ставим версию ${latest?.version}…`, 'Лаунчер закроется на несколько секунд и откроется снова.'],
      error: ['Не получилось обновиться', status.error],
      disabled: ['Обновления выключены', 'Это сборка для разработки: она не обновляет себя.'],
    };
    const [title, hint] = lines[status.state] ?? lines.idle;
    // The Amethyx X: bobbing while something happens, blinking when a version waits, grey after an error.
    const busy = ['checking', 'downloading', 'restarting'].includes(status.state);
    const mark = loadingMark(busy ? 'loading-mark update-status__mark' : 'update-status__mark');
    if (['ready', 'available'].includes(status.state)) mark.classList.add('update-status__mark--new');
    if (status.state === 'error') mark.classList.add('update-status__mark--error');

    const actions = [];
    if (status.state === 'restarting') {
      actions.push(h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => api.updates.postpone().catch(() => {}) }, 'Позже'));
    } else if (status.state === 'ready') {
      actions.push(h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: installUpdate }, 'Перезапустить и обновить'));
    } else if (status.state === 'available' || (status.state === 'error' && latest)) {
      actions.push(h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => api.updates.download().catch((error) => toast(errorMessage(error), 'error')) }, 'Скачать обновление'));
    }
    actions.push(
      h('button', { class: 'btn btn--secondary btn--compact', type: 'button', disabled: ['checking', 'downloading'].includes(status.state), onclick: checkNow }, 'Проверить обновления'),
    );

    // Element.append writes a missing part as the text "null": only the parts there are go in.
    statusBox.append(
      ...[
        h('div', { class: 'update-status__main' },
          mark,
          h('div', null, h('div', { class: 'update-status__title' }, title), hint ? h('div', { class: 'settings-card__desc' }, hint) : null),
        ),
        status.state === 'downloading' ? h('div', { class: 'progress' }, h('div', { class: 'progress__bar', style: { width: `${status.progress ?? 0}%` } })) : null,
        latest?.notes && ['available', 'downloading', 'ready', 'restarting'].includes(status.state) ? h('div', { class: 'update-notes' }, h('b', null, 'Что нового: '), latest.notes) : null,
        h('div', { class: 'settings-row', style: { justifyContent: 'flex-start', gap: '10px' } }, actions),
      ].filter(Boolean),
    );

    const feed = h('input', { class: 'input mono', type: 'text', spellcheck: 'false', placeholder: 'https://github.com/VanillaPlusLauncher/VanillaPlus/releases/latest/download/latest.json', value: updates.feedUrl ?? '' });
    feed.addEventListener('change', () => {
      const value = feed.value.trim();
      if (value && !/^https:\/\/\S+$/i.test(value)) {
        toast('Нужна ссылка, начинающаяся с https://', 'error');
        return;
      }
      save({ updates: { feedUrl: value } }, false);
    });

    return [
      card('Версия', `Установлена Amethyx Launcher ${current}.`, statusBox),
      card('Автоматически',
        null,
        row('Проверять обновления', 'При запуске лаунчера и раз в несколько часов.', toggle(updates.autoCheck !== false, (value) => save({ updates: { autoCheck: value } }), 'Проверять')),
        row('Скачивать сразу', 'Новая версия скачается в фоне.', toggle(updates.autoDownload !== false, (value) => save({ updates: { autoDownload: value } }), 'Скачивать')),
        row('Устанавливать сами', 'Когда игра закрыта, лаунчер на несколько секунд закроется, обновится без окон установщика и откроется снова. Выключено — по кнопке.', toggle(updates.autoInstall !== false, (value) => save({ updates: { autoInstall: value } }), 'Устанавливать')),
      ),
      card('Адрес обновлений', 'Пусто — официальные релизы Amethyx Launcher на GitHub. Свой адрес нужен, только если вы выпускаете свою сборку.', feed),
    ];
  }

  async function checkNow() {
    try {
      const status = await api.updates.check();
      updateStatus = status;
      render(true);
      if (status.state === 'latest') {
        toast('У вас последняя версия', 'success');
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function installUpdate() {
    const confirmed = await confirmDialog({ title: 'Обновить лаунчер?', message: 'Лаунчер закроется, установит новую версию и откроется сам. Сборки, миры и настройки останутся.', confirmLabel: 'Обновить' });
    if (!confirmed) return;
    try {
      await api.updates.install();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  api.updates.status().then((status) => { updateStatus = status; if (section === 'updates') render(true); }).catch(() => {});
  api.events.onUpdateStatus((status) => {
    updateStatus = status;
    if (section === 'updates' && element.classList.contains('page--active')) render(true);
  });

  async function resetAll() {
    const confirmed = await confirmDialog({ title: 'Сбросить все настройки?', message: 'Вернутся значения по умолчанию. Аккаунты и сборки не удаляются.', confirmLabel: 'Сбросить', danger: true });
    if (!confirmed) return;
    try {
      store.set({ settings: await api.settings.reset() });
      toast('Настройки сброшены', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  let renderedKey = '';
  function render(force = false) {
    const { settings, info } = store.get();
    if (!settings) {
      return;
    }
    // Text fields keep focus: the section is rebuilt only when nothing in it is being edited.
    const key = `${section}|${JSON.stringify(settings)}`;
    if (!force && (key === renderedKey || sectionHost.contains(document.activeElement) && document.activeElement.matches('input[type="text"], input[type="number"], input[type="password"], textarea'))) {
      return;
    }
    const changedSection = !renderedKey.startsWith(`${section}|`);
    renderedKey = key;
    SECTIONS.forEach((entry, index) => navButtons[index].setAttribute('aria-current', String(entry.key === section)));
    const builders = { game: gameSection, java: javaSection, appearance: appearanceSection, sounds: soundsSection, content: contentSection, online: onlineSection, launcher: launcherSection, updates: updatesSection };
    const scroll = element.scrollTop;
    sectionHost.replaceChildren(...builders[section](settings, info));
    sectionHost.classList.toggle('settings-sections--enter', changedSection);
    if (!changedSection) {
      element.scrollTop = scroll;
    }
  }

  function showSection(key) {
    section = SECTIONS.some((entry) => entry.key === key) ? key : 'game';
    render(true);
    element.scrollTop = 0;
  }

  store.subscribe(['settings', 'info'], () => render());
  onMcReady(() => render(true));
  render();
  return {
    element,
    onShow: () => {
      // Another page (the update banner) can ask for a section.
      const wanted = store.get().openSettingsSection;
      if (wanted) {
        store.set({ openSettingsSection: null });
        showSection(wanted);
      } else {
        render();
      }
    },
  };
}
