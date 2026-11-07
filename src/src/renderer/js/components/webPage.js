import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { copyText } from '../core/clipboard.js';
import { openModal } from './modal.js';

/*
 * A web page inside the launcher: links from descriptions, changelogs and news open here instead of in
 * the system browser. The page lives in a <webview> of its own session, sandboxed and without the
 * launcher's preload (main/window.js guardLinkViews); "В браузере" still sends it out.
 */

const PARTITION = 'persist:links';
const isWeb = (url) => /^https?:\/\//i.test(String(url ?? ''));

/** Opens `url` in a dialog with back, forward, reload, its address and "В браузере". */
export function openWebPage(url, { title = null } = {}) {
  if (!isWeb(url)) return null;
  // Without <webview> (a window made without it): the system browser, as before.
  if (!customElements.get('webview')) {
    api.app.openExternal(url).catch(() => {});
    return null;
  }
  const view = document.createElement('webview');
  view.className = 'web-page__view';
  view.setAttribute('partition', PARTITION);
  view.setAttribute('src', url);

  const back = h('button', { class: 'icon-button web-page__nav', type: 'button', 'aria-label': 'Назад', disabled: true, onclick: () => view.canGoBack() && view.goBack() }, '‹');
  const forward = h('button', { class: 'icon-button web-page__nav', type: 'button', 'aria-label': 'Вперёд', disabled: true, onclick: () => view.canGoForward() && view.goForward() }, '›');
  const reload = h('button', { class: 'icon-button web-page__nav', type: 'button', 'aria-label': 'Обновить страницу', onclick: () => view.reload() }, '↻');
  // The address: selectable, and a click copies it.
  const address = h('button', { class: 'web-page__address', type: 'button', title: 'Копировать адрес', 'data-i18n': 'off', onclick: () => copyText(current, 'Адрес скопирован') }, url);
  const progress = h('span', { class: 'web-page__progress' });
  const outside = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => api.app.openExternal(current).catch(() => {}) }, icon('globe'), 'В браузере');
  let current = url;

  const sync = () => {
    try {
      back.disabled = !view.canGoBack();
      forward.disabled = !view.canGoForward();
    } catch {
      // Not attached yet.
    }
  };
  const moved = (event) => {
    if (!event.isMainFrame && event.isMainFrame !== undefined) return;
    current = event.url;
    address.textContent = event.url;
    sync();
  };
  view.addEventListener('did-navigate', moved);
  view.addEventListener('did-navigate-in-page', moved);
  view.addEventListener('did-start-loading', () => progress.classList.add('web-page__progress--on'));
  view.addEventListener('did-stop-loading', () => {
    progress.classList.remove('web-page__progress--on');
    sync();
  });
  view.addEventListener('page-title-updated', (event) => {
    if (event.title) titleNode.textContent = event.title;
  });

  const modal = openModal({
    title: title || hostOf(url),
    size: 'xl',
    content: h('div', { class: 'web-page' }, h('div', { class: 'web-page__bar' }, back, forward, reload, address, outside), progress, view),
  });
  const titleNode = modal.body.closest('.modal').querySelector('.modal__title');
  titleNode.setAttribute('data-i18n', 'off');
  // A page's title can be a sentence: one line, cut with "…".
  titleNode.classList.add('web-page__title');
  return modal;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
