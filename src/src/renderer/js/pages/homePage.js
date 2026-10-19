import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { assetUrl } from '../core/assets.js';
import { errorMessage, formatReleaseDate } from '../core/format.js';
import { describeInstance, formatAgo } from '../core/content.js';
import { getMcManifest, iconImage, mcUrl, onMcReady } from '../core/mc.js';
import { openInstance } from '../core/nav.js';
import { locale } from '../core/i18n.js';
import { createSparks, pixelBurst } from '../core/effects.js';
import { store } from '../state/appStore.js';
import { playInstance, saveSettings, selectedInstance, stopGame } from '../state/actions.js';
import { toast } from '../components/toast.js';
import { createProgress } from '../components/controls.js';
import { openCreateInstanceModal } from '../components/createInstanceModal.js';
import { currentSkin, openDressingRoom } from '../components/dressingRoom.js';
import { createHomePlayer } from '../skins/homePlayer.js';
import { defaultSkinUrl } from '../core/skinHead.js';

/** Yellow splash texts: small facts about the launcher, one at random, as on the game's title screen. */
const SPLASHES = [
  'Создан ночью!', 'Modrinth + CurseForge!', 'Ely.by внутри!', 'Сборки как в Prism!', 'Скин в 3D!', 'Fabric, Forge, NeoForge и Quilt!',
  'Семь видов Java!', 'Панорама из последней версии!', 'Звуки прямо из игры!', 'Теперь с модами!', 'Не копай вниз!', 'Крипер одобряет!',
  'Также попробуйте Terraria!', 'Сделано с любовью!', 'Кубы!', 'Алмазы!',
];

/**
 * A row that scrolls sideways with the mouse wheel (no scrollbar is shown). The page scrolls as
 * usual once the row is at its end, so the wheel never gets stuck.
 */
function wheelScroll(row) {
  let target = null;
  let frame = 0;
  // Cards that do not fit fade away at the edge (as into a pocket) instead of being cut off.
  const markEdges = () => {
    const max = row.scrollWidth - row.clientWidth;
    row.classList.toggle('fade-row--start', row.scrollLeft > 2);
    row.classList.toggle('fade-row--end', row.scrollLeft < max - 2);
  };
  row.classList.add('fade-row');
  row.addEventListener('scroll', markEdges, { passive: true });
  new ResizeObserver(markEdges).observe(row);
  new MutationObserver(markEdges).observe(row, { childList: true });
  const step = () => {
    const distance = target - row.scrollLeft;
    if (Math.abs(distance) < 1) {
      row.scrollLeft = target;
      target = null;
      frame = 0;
      return;
    }
    row.scrollLeft += distance * 0.25;
    frame = requestAnimationFrame(step);
  };
  row.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const max = row.scrollWidth - row.clientWidth;
      const from = target ?? row.scrollLeft;
      const next = Math.max(0, Math.min(max, from + event.deltaY * 1.2));
      if (next === from) return;
      event.preventDefault();
      target = next;
      if (!frame) frame = requestAnimationFrame(step);
    },
    { passive: false },
  );
}

/** Home screen: Minecraft logo, real news, recent instances and the play bar for the selected one. */
export function createHomePage({ navigate }) {
  const element = h('section', { class: 'page page--home', 'aria-label': 'Главная' });
  element.append(createSparks(10));

  const logo = h('div', { class: 'home-logo' });
  const splash = h('span', { class: 'home-splash' }, SPLASHES[Math.floor(Math.random() * SPLASHES.length)]);
  const renderLogo = () => {
    const logoTexture = getMcManifest()?.textures.gui.logo;
    // The splash belongs to the game's logo: without the logo it would sit on the heading.
    logo.replaceChildren(
      ...(logoTexture
        ? [h('img', { class: 'home-logo__img', src: mcUrl(logoTexture), alt: 'Minecraft' }), splash]
        : [h('h1', { class: 'hero__title' }, h('span', null, 'Твой мир.'), h('span', null, 'Твои правила.'))]),
    );
  };
  renderLogo();
  onMcReady(renderLogo);

  const recentHost = h('div', { class: 'recent-row' });
  const newsHost = h('div', { class: 'news-strip' });
  wheelScroll(recentHost);
  wheelScroll(newsHost);

  const hero = h(
    'div',
    { class: 'home-hero' },
    logo,
    h('p', { class: 'hero__subtitle' }, 'Java Edition · моды, сборки, скины'),
    h('div', { class: 'home-section' }, h('div', { class: 'home-section__head' }, h('h2', { class: 'section-title' }, 'Недавние сборки'), h('button', { class: 'link-button', type: 'button', onclick: () => navigate('builds') }, 'Все сборки ›')), recentHost),
    h('div', { class: 'home-section' }, h('div', { class: 'home-section__head' }, h('h2', { class: 'section-title' }, 'Новости Minecraft'), h('button', { class: 'link-button', type: 'button', onclick: () => api.app.openExternal(`https://www.minecraft.net/${locale().toLowerCase()}/articles`) }, 'minecraft.net ›')), newsHost),
  );

  const playBar = createPlayBar({ navigate });

  // The player in a column of its own (it covers nothing): the account's skin, looking at the
  // mouse; it and the "Гардероб" button under it open the wardrobe.
  const openWardrobe = () => openDressingRoom({ onApplied: () => loadPlayerSkin(true) });
  const makePlayer = () => createHomePlayer({ width: 200, height: 290, onClick: openWardrobe, onLost: rebuildPlayer });
  let player = makePlayer();
  let playerActive = true;
  // Until the account's own skin is in, "Загрузка…" is shown instead of a default Steve.
  const playerBox = player ? h('div', { class: 'home-player home-player--loading', title: 'Гардероб' }, player.canvas, h('span', { class: 'home-player__loading' }, 'Загрузка…')) : null;
  // Hearts, sparkles and notes around the player with some gestures.
  player?.attachEffects(playerBox);
  // The 3D view was lost (GPU restart): a new player takes its place, a few times a minute at most.
  let rebuilds = [];
  function rebuildPlayer() {
    rebuilds = rebuilds.filter((time) => Date.now() - time < 60000);
    if (!player || rebuilds.length >= 3) return;
    rebuilds.push(Date.now());
    const next = makePlayer();
    if (!next) return;
    const old = player;
    player = next;
    old.canvas.replaceWith(next.canvas);
    old.dispose();
    next.attachEffects(playerBox);
    next.setActive(playerActive);
    loadPlayerSkin();
  }
  const side = player ? h('aside', { class: 'home-side' }, playerBox, h('button', { class: 'btn btn--secondary btn--compact home-side__wardrobe', type: 'button', onclick: openWardrobe }, 'Гардероб')) : null;
  element.append(h('div', { class: 'home-top' }, hero, side), playBar.element);
  let playerLoad = 0;
  async function loadPlayerSkin(changed = false) {
    if (!player) return;
    const { accounts, selectedAccountId } = store.get();
    const account = accounts.find((candidate) => candidate.id === selectedAccountId) ?? null;
    const ticket = ++playerLoad;
    const skin = await currentSkin(account).catch(() => null);
    // Only the latest request counts: an older answer must not flash another skin.
    if (ticket !== playerLoad) return;
    const fallback = defaultSkinUrl('steve');
    if (skin) player.setSkin(`data:image/png;base64,${skin.pngBase64}`, skin.model);
    else if (fallback) player.setSkin(fallback, 'classic');
    else return; // The game's textures are not here yet: onMcReady asks again.
    player.setCape(skin?.capeBase64 ? `data:image/png;base64,${skin.capeBase64}` : null);
    requestAnimationFrame(() => playerBox.classList.remove('home-player--loading'));
    if (changed) player.play('spin');
  }
  store.subscribe(['selectedAccountId'], () => loadPlayerSkin(true));
  onMcReady(() => loadPlayerSkin());
  loadPlayerSkin();
  // The game starts: a jump; it ends: a wave.
  let lastGameState = store.get().game?.state;
  store.subscribe(['game'], ({ game }) => {
    if (game?.state === lastGameState) return;
    if (game?.state === 'running') player?.play('jump');
    else if (lastGameState === 'running') player?.play('wave');
    lastGameState = game?.state;
  });

  let recentKey = '';
  function renderRecent() {
    const { instances, settings } = store.get();
    const recent = [...instances].sort((a, b) => (b.lastPlayedAt ?? b.createdAt ?? '').localeCompare(a.lastPlayedAt ?? a.createdAt ?? '')).slice(0, 5);
    const key = JSON.stringify([recent.map((instance) => [instance.id, instance.name, instance.icon, instance.lastPlayedAt]), settings?.selectedInstanceId]);
    if (key === recentKey) {
      return;
    }
    recentKey = key;
    if (recent.length === 0) {
      recentHost.replaceChildren(
        h('button', { class: 'recent-card recent-card--new', type: 'button', onclick: () => openCreateInstanceModal() }, h('span', { class: 'recent-card__plus' }, '+'), h('span', null, 'Создать первую сборку')),
      );
      return;
    }
    recentHost.replaceChildren(
      ...recent.map((instance, index) =>
        h(
          'button',
          {
            class: `recent-card${instance.id === settings?.selectedInstanceId ? ' recent-card--selected' : ''}`,
            type: 'button',
            style: { '--delay': `${200 + index * 70}ms` },
            title: 'Клик — выбрать, двойной клик — открыть',
            onclick: () => saveSettings({ selectedInstanceId: instance.id }).catch(() => {}),
            ondblclick: () => openInstance(instance.id),
          },
          iconImage(instance.icon, 'recent-card__icon'),
          h('span', { class: 'recent-card__name' }, instance.name),
          h('span', { class: 'recent-card__meta' }, describeInstance(instance)),
        ),
      ),
      h('button', { class: 'recent-card recent-card--new', type: 'button', style: { '--delay': `${200 + recent.length * 70}ms` }, onclick: () => openCreateInstanceModal() }, h('span', { class: 'recent-card__plus' }, '+'), h('span', null, 'Новая')),
    );
  }

  async function loadNews() {
    newsHost.replaceChildren(...[0, 1, 2].map(() => h('div', { class: 'skeleton news-tile-skeleton' })));
    try {
      const articles = (await api.minecraft.news()).slice(0, 6);
      newsHost.replaceChildren(
        ...articles.map((article, index) =>
          h(
            'button',
            {
              class: 'news-tile',
              type: 'button',
              style: { '--delay': `${300 + index * 90}ms` },
              onclick: () => article.url && api.app.openExternal(article.url).catch((error) => toast(errorMessage(error), 'error')),
            },
            h('img', { class: 'news-tile__image', src: article.image, alt: '', loading: 'lazy' }),
            h('span', { class: 'news-tile__shade' }),
            h('span', { class: 'news-tile__body' }, h('span', { class: 'news-tile__tag' }, article.java ? 'Java Edition' : article.category), h('span', { class: 'news-tile__title' }, article.title), h('span', { class: 'news-tile__date' }, formatReleaseDate(article.date))),
          ),
        ),
      );
    } catch {
      // Offline: the launcher's own pictures instead of news.
      newsHost.replaceChildren(
        ...[
          ['Открой новые миры', 'backgrounds/news-forest.png', () => navigate('browse')],
          ['Собери свою игру', 'backgrounds/news-village.png', () => navigate('builds')],
        ].map(([title, image, action]) =>
          h('button', { class: 'news-tile', type: 'button', onclick: action }, h('img', { class: 'news-tile__image', src: assetUrl(image), alt: '' }), h('span', { class: 'news-tile__shade' }), h('span', { class: 'news-tile__body' }, h('span', { class: 'news-tile__title' }, title))),
        ),
      );
    }
  }

  store.subscribe(['instances', 'settings'], renderRecent);
  renderRecent();
  loadNews();

  return {
    element,
    onShow: () => {
      renderRecent();
      playBar.refresh();
      splash.textContent = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
      // Back on Home: the player greets you (a different gesture each time).
      playerActive = true;
      player?.setActive(true);
      player?.play(['wave', 'hello', 'nod', 'dance', 'flex'][Math.floor(Math.random() * 5)]);
    },
    onHide: () => {
      playerActive = false;
      player?.setActive(false);
    },
  };
}

/** Bottom bar: the selected instance, its status, Play and a quick instance switcher. */
function createPlayBar({ navigate }) {
  const iconHost = h('div', { class: 'play-bar__icon-host' });
  const nameElement = h('span', { class: 'play-bar__name' });
  const subtitleElement = h('span', { class: 'text-muted', style: { fontSize: '13px' } });
  const statusDot = h('span', { class: 'status-dot' });
  const statusText = h('span');
  const progress = createProgress();
  const progressRow = h('div', { style: { display: 'none' } }, progress.element);
  const playButton = h('button', { class: 'btn btn--primary btn--play', type: 'button' });
  const switchButton = h(
    'button',
    { class: 'play-bar__arrow', type: 'button', 'aria-label': 'Выбрать сборку', title: 'Выбрать сборку', onclick: (event) => openSwitcher(event.currentTarget) },
    icon('chevron'),
  );

  const element = h(
    'div',
    { class: 'surface surface--panel play-bar' },
    iconHost,
    h('div', { class: 'play-bar__meta' }, nameElement, subtitleElement),
    h('span', { class: 'play-bar__divider' }),
    h('div', { class: 'play-bar__status' }, h('div', { class: 'play-bar__status-line' }, statusDot, statusText), progressRow),
    h('div', { class: 'play-bar__actions' }, playButton, switchButton),
  );

  let iconKey = null;

  function refresh() {
    const state = store.get();
    const instance = selectedInstance();
    const taskKey = instance ? [`instance:${instance.id}`, `version:${instance.minecraft}`].find((key) => state.tasks[key]?.state === 'running') : null;
    const task = taskKey ? state.tasks[taskKey] : null;
    const javaTask = Object.values(state.tasks).find((candidate) => candidate.kind === 'java' && candidate.state === 'running');
    const running = state.game.state === 'running';
    const hasAccount = state.accounts.length > 0;

    const nextIconKey = instance?.icon ?? 'none';
    if (nextIconKey !== iconKey) {
      iconKey = nextIconKey;
      iconHost.replaceChildren(instance ? iconImage(instance.icon, 'play-bar__icon') : h('img', { class: 'play-bar__icon', src: assetUrl('icons/grass-block.png'), alt: '' }));
    }
    nameElement.textContent = instance?.name ?? 'Сборка не выбрана';
    subtitleElement.textContent = instance ? describeInstance(instance) : 'Создайте сборку или выберите её';

    let dot = 'idle';
    let text = 'Выберите сборку';
    if (running) {
      dot = '';
      const runningInstance = state.instances.find((candidate) => candidate.id === state.game.instanceId);
      text = `Игра запущена · ${runningInstance?.name ?? state.game.versionId ?? ''}`;
    } else if (state.game.state === 'launching' || state.launching) {
      dot = 'busy';
      text = 'Запуск…';
    } else if (task) {
      dot = 'busy';
      text = `Установка: ${task.stage ?? ''}`;
    } else if (javaTask) {
      dot = 'busy';
      text = `Загрузка ${javaTask.label}…`;
    } else if (!instance) {
      text = 'Ожидание выбора сборки';
    } else if (!hasAccount) {
      dot = 'busy';
      text = 'Добавьте аккаунт, чтобы играть';
    } else {
      dot = '';
      // Not installed yet: nothing to say, "Играть" downloads what is missing.
      text = instance.installed ? `Готово к запуску · играли ${formatAgo(instance.lastPlayedAt)}` : '';
    }
    statusDot.className = `status-dot${dot ? ` status-dot--${dot}` : ''}`;
    statusDot.hidden = !text;
    statusText.textContent = text;

    const busyTask = task ?? javaTask;
    progressRow.style.display = busyTask ? '' : 'none';
    if (busyTask) {
      progress.set(busyTask.percent);
    }

    playButton.className = running ? 'btn btn--secondary btn--compact btn--play' : 'btn btn--primary btn--play';
    playButton.disabled = !running && (Boolean(task) || state.launching || !instance);
    playButton.replaceChildren();
    if (running) {
      playButton.append(icon('close'), 'Остановить');
      playButton.onclick = () => stopGame();
    } else if (task) {
      playButton.append('Установка…');
      playButton.onclick = null;
    } else if (state.launching) {
      playButton.append('Запуск…');
      playButton.onclick = null;
    } else if (!instance) {
      playButton.append(icon('play'), 'Играть');
      playButton.onclick = null;
    } else {
      playButton.append(icon('play'), instance.installed ? 'Играть' : 'Скачать и играть');
      playButton.onclick = () => {
        pixelBurst(playButton, { count: 34, spread: 220 });
        playInstance(instance.id);
      };
    }
  }

  /** Which instance the home screen shows and plays: the same menu style as the dropdowns. */
  function openSwitcher(anchor) {
    const existing = document.querySelector('.play-switcher');
    if (existing) {
      existing.remove();
      return;
    }
    const { instances, settings } = store.get();
    const recent = [...instances].sort((a, b) => (b.lastPlayedAt ?? b.createdAt ?? '').localeCompare(a.lastPlayedAt ?? a.createdAt ?? ''));
    const close = () => {
      menu.classList.add('dropdown__menu--closing');
      setTimeout(() => menu.remove(), 120);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      anchor.classList.remove('play-bar__arrow--open');
    };
    const onOutside = (event) => {
      if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    const search = recent.length > 8 ? h('input', { class: 'dropdown__search', type: 'text', placeholder: 'Найти сборку…', spellcheck: 'false' }) : null;
    const list = h('div', { class: 'dropdown__list' });
    const renderList = () => {
      const query = search?.value.trim().toLowerCase() ?? '';
      const shown = recent.filter((instance) => !query || `${instance.name} ${instance.minecraft} ${instance.group ?? ''}`.toLowerCase().includes(query));
      list.replaceChildren(
        ...(shown.length === 0 ? [h('div', { class: 'dropdown__empty' }, instances.length === 0 ? 'Сборок пока нет' : 'Ничего не найдено')] : []),
        ...shown.map((instance) =>
          h(
            'div',
            {
              class: `dropdown__item play-switcher__item${instance.id === settings.selectedInstanceId ? ' dropdown__item--selected' : ''}`,
              role: 'option',
              onpointerenter: (event) => event.currentTarget.classList.add('dropdown__item--active'),
              onpointerleave: (event) => event.currentTarget.classList.remove('dropdown__item--active'),
              onclick: () => {
                close();
                saveSettings({ selectedInstanceId: instance.id }).catch(() => {});
              },
            },
            iconImage(instance.icon, 'play-switcher__icon'),
            h('span', { class: 'play-switcher__text' }, h('span', { class: 'play-switcher__name' }, instance.name), h('small', null, describeInstance(instance))),
          ),
        ),
      );
    };
    search?.addEventListener('input', renderList);
    const menu = h(
      'div',
      { class: 'dropdown__menu dropdown__menu--up play-switcher', role: 'listbox' },
      h('div', { class: 'play-switcher__title' }, 'Сборка на главном экране'),
      search,
      list,
      h('button', { class: 'play-switcher__all', type: 'button', onclick: () => { close(); navigate('builds'); } }, 'Все сборки ›'),
    );
    renderList();
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.maxHeight = `${Math.min(460, rect.top - 20)}px`;
    menu.style.left = `${Math.max(12, rect.right - menu.offsetWidth)}px`;
    menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    anchor.classList.add('play-bar__arrow--open');
    search?.focus();
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  store.subscribe(['settings', 'instances', 'tasks', 'game', 'launching', 'accounts'], refresh);
  refresh();

  return { element, refresh };
}
