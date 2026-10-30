import { api } from '../services/api.js';
import { morph } from '../core/effects.js';
import { h, icon } from '../core/dom.js';
import { errorMessage, formatReleaseDate } from '../core/format.js';
import { renderDescription } from '../core/markdown.js';
import { formatCount, LOADER_LABELS, PLATFORM_LABELS } from '../core/content.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';

const VERSION_TYPE_BADGES = { release: ['Релиз', ''], beta: ['Бета', 'badge--warning'], alpha: ['Альфа', 'badge--danger'] };

/**
 * Project page in a dialog: description, screenshots and every version, each installable.
 * context: { instance (or null), type, onInstall(versionId) -> Promise, filters: { gameVersion, loader } }
 * ilters are the catalog's version and loader, which may differ from the instance's.
 */
export function openProjectModal(hit, { instance = null, type = 'mod', onInstall, filters = null }) {
  const wantedVersion = filters?.gameVersion ?? instance?.minecraft ?? null;
  const wantedLoader = filters ? filters.loader : instance?.loader.type ?? null;
  const descriptionHost = h('div', { class: 'project-description' }, h('div', { class: 'skeleton', style: { height: '220px' } }));
  const galleryHost = h('div', { class: 'project-gallery' });
  const versionsHost = h('div', { class: 'version-list' }, h('div', { class: 'skeleton', style: { height: '64px' } }));
  let compatibleOnly = Boolean(wantedVersion);
  let project = null;

  const tabs = [
    ['description', 'Описание', descriptionHost],
    ['gallery', 'Галерея', galleryHost],
    ['versions', 'Версии', versionsHost],
  ];
  const tabHost = h('div', { class: 'project-tab-host' });
  const tabButtons = tabs.map(([key, label]) =>
    h('button', { class: 'tabs__button', type: 'button', role: 'tab', 'aria-selected': String(key === 'description'), onclick: () => showTab(key) }, label),
  );

  function showTab(key) {
    if (tabHost.isConnected) {
      morph(() => openTab(key), { panel: tabHost.closest('.modal') });
      return;
    }
    openTab(key);
  }

  function openTab(key) {
    tabs.forEach(([tabKey], index) => tabButtons[index].setAttribute('aria-selected', String(tabKey === key)));
    tabHost.replaceChildren(tabs.find(([tabKey]) => tabKey === key)[2]);
    if (key === 'versions' && !versionsHost.dataset.loaded) {
      loadVersions();
    }
  }

  const compatibleToggle = h('label', { class: 'check-row' }, h('input', {
    type: 'checkbox',
    checked: compatibleOnly,
    onchange: (event) => {
      compatibleOnly = event.target.checked;
      versionsHost.dataset.loaded = '';
      loadVersions();
    },
  }), wantedVersion ? `Только для ${wantedVersion}${wantedLoader && wantedLoader !== 'vanilla' ? `, ${LOADER_LABELS[wantedLoader] ?? wantedLoader}` : ''}` : 'Только совместимые');

  const installButton = h(
    'button',
    { class: 'btn btn--primary', type: 'button', onclick: () => install(null, installButton) },
    icon('download'),
    type === 'modpack' ? 'Установить модпак' : instance ? `В «${instance.name}»` : 'Установить',
  );

  const header = h(
    'div',
    { class: 'project-header' },
    hit.iconUrl ? h('img', { class: 'project-header__icon', src: hit.iconUrl, alt: '' }) : h('div', { class: 'project-header__icon project-header__icon--empty' }, icon('cube')),
    h(
      'div',
      { class: 'project-header__meta' },
      h('div', { class: 'project-header__title' }, hit.title, h('span', { class: `badge badge--${hit.platform}` }, h('span', { class: `platform-logo platform-logo--${hit.platform}` }), PLATFORM_LABELS[hit.platform])),
      h('div', { class: 'project-header__sub' }, hit.author ? `от ${hit.author}` : '', ' · ', `${formatCount(hit.downloads)} загрузок`),
      h('p', { class: 'project-header__summary' }, hit.description),
      h('div', { class: 'project-header__chips' }, (hit.categories ?? []).slice(0, 6).map((category) => h('span', { class: 'chip chip--static' }, category))),
    ),
    h('div', { class: 'project-header__actions' }, installButton, h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => api.app.openExternal(project?.links?.site ?? hit.url) }, 'Открыть сайт')),
  );

  async function install(versionId, button) {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Установка…';
    try {
      await onInstall(versionId);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function loadProject() {
    try {
      project = await api.content.project(hit.platform, hit.id);
      descriptionHost.replaceChildren(renderDescription(project.body || project.description || '', project.bodyFormat));
      descriptionHost.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (link) {
          event.preventDefault();
          api.app.openExternal(link.href).catch(() => {});
        }
      });
      if (project.gallery.length === 0) {
        galleryHost.replaceChildren(h('p', { class: 'text-muted' }, 'У проекта нет скриншотов.'));
      } else {
        galleryHost.replaceChildren(
          ...project.gallery.map((image, index) =>
            h(
              'button',
              { class: 'gallery-item', type: 'button', style: { '--delay': `${index * 40}ms` }, onclick: () => openLightbox(project.gallery, index) },
              h('img', { src: image.url, alt: image.title, loading: 'lazy' }),
              image.title ? h('span', null, image.title) : null,
            ),
          ),
        );
      }
      tabButtons[1].querySelector('.tabs__count')?.remove();
      tabButtons[1].append(h('span', { class: 'tabs__count' }, String(project.gallery.length)));
    } catch (error) {
      descriptionHost.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  async function loadVersions() {
    versionsHost.dataset.loaded = '1';
    versionsHost.replaceChildren(h('div', { class: 'skeleton', style: { height: '64px' } }), h('div', { class: 'skeleton', style: { height: '64px' } }));
    try {
      const query = compatibleOnly && wantedVersion ? { gameVersion: wantedVersion, loader: wantedLoader, type } : { type };
      const versions = await api.content.versions(hit.platform, hit.id, query);
      if (versions.length === 0) {
        versionsHost.replaceChildren(h('p', { class: 'text-muted' }, compatibleOnly ? 'Нет версий для этой сборки. Снимите галочку, чтобы увидеть все.' : 'Версий нет.'));
        return;
      }
      versionsHost.replaceChildren(
        ...versions.slice(0, 60).map((version) => {
          const [typeLabel, typeClass] = VERSION_TYPE_BADGES[version.type] ?? VERSION_TYPE_BADGES.release;
          const button = h('button', { class: 'btn btn--secondary btn--compact', type: 'button' }, icon('download'), 'Установить');
          button.addEventListener('click', () => install(version.id, button));
          return h(
            'div',
            { class: 'list-row version-row' },
            h(
              'div',
              { class: 'version-row__meta' },
              h('div', { class: 'version-row__title' }, version.name || version.versionNumber, h('span', { class: `badge ${typeClass}` }, typeLabel)),
              h(
                'div',
                { class: 'version-row__sub' },
                [version.gameVersions.slice(0, 6).join(', '), version.loaders.map((loader) => LOADER_LABELS[loader] ?? loader).join(', '), formatReleaseDate(version.date)]
                  .filter(Boolean)
                  .join(' · '),
              ),
            ),
            button,
          );
        }),
      );
    } catch (error) {
      versionsHost.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  const versionsTabContent = versionsHost;
  tabs[2][2] = h('div', { class: 'project-versions' }, compatibleToggle, versionsTabContent);

  openModal({
    title: hit.title,
    size: 'xl',
    content: h('div', { class: 'project-modal' }, header, h('div', { class: 'tabs', role: 'tablist' }, tabButtons), tabHost),
  });
  showTab('description');
  loadProject();
}

/** Full-size screenshots with arrows and keyboard navigation. */
function openLightbox(images, start) {
  let index = start;
  const image = h('img', { class: 'lightbox__image', alt: '' });
  const caption = h('div', { class: 'lightbox__caption' });
  const show = () => {
    image.src = images[index].url;
    caption.textContent = `${images[index].title || ''} ${index + 1}/${images.length}`.trim();
  };
  const step = (delta) => {
    index = (index + delta + images.length) % images.length;
    show();
  };
  const layer = h(
    'div',
    { class: 'lightbox', role: 'dialog', onclick: (event) => event.target === layer && close() },
    h('button', { class: 'lightbox__nav lightbox__nav--prev', type: 'button', 'aria-label': 'Назад', onclick: () => step(-1) }, '‹'),
    h('figure', null, image, caption),
    h('button', { class: 'lightbox__nav lightbox__nav--next', type: 'button', 'aria-label': 'Вперёд', onclick: () => step(1) }, '›'),
  );
  const onKey = (event) => {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
    event.stopPropagation();
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  show();
}
