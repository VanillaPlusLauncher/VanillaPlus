import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';

/*
 * Pictures at full size over the launcher, as on Modrinth: arrows and keys go through them, the wheel or
 * a double click zooms in where the pointer is, a zoomed picture is dragged around. Escape, the cross or
 * a click beside the picture closes it.
 *
 * openLightbox([{ url, title }], startIndex)
 */
const MAX_ZOOM = 6;

export function openLightbox(images, start = 0) {
  if (!images?.length) return;
  let index = Math.max(0, Math.min(start, images.length - 1));
  let zoom = 1;
  let shiftX = 0;
  let shiftY = 0;
  let drag = null;

  const image = h('img', { class: 'lightbox__image', alt: '', draggable: 'false' });
  const stage = h('div', { class: 'lightbox__stage' }, image);
  const caption = h('span', { class: 'lightbox__caption', 'data-i18n': 'off' });
  const counter = h('span', { class: 'lightbox__counter' });
  const several = images.length > 1;
  const prev = h('button', { class: 'lightbox__nav lightbox__nav--prev', type: 'button', 'aria-label': 'Назад', hidden: !several, onclick: () => step(-1) }, '‹');
  const next = h('button', { class: 'lightbox__nav lightbox__nav--next', type: 'button', 'aria-label': 'Вперёд', hidden: !several, onclick: () => step(1) }, '›');
  const layer = h(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' },
    stage,
    prev,
    next,
    h(
      'div',
      { class: 'lightbox__bar' },
      h('div', { class: 'lightbox__text' }, caption, counter),
      h('button', { class: 'icon-button', type: 'button', title: 'Открыть в браузере', onclick: () => api.app.openExternal(images[index].url).catch(() => {}) }, icon('globe')),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Закрыть', onclick: () => close() }, icon('close')),
    ),
  );

  function apply(smooth = true) {
    image.classList.toggle('lightbox__image--smooth', smooth);
    image.style.transform = `translate(${shiftX}px, ${shiftY}px) scale(${zoom})`;
    layer.classList.toggle('lightbox--zoomed', zoom > 1);
  }

  function reset() {
    zoom = 1;
    shiftX = 0;
    shiftY = 0;
    apply(false);
  }

  function show() {
    reset();
    image.classList.add('lightbox__image--loading');
    image.onload = () => image.classList.remove('lightbox__image--loading');
    image.src = images[index].url;
    caption.textContent = images[index].title || '';
    counter.textContent = several ? `${index + 1} / ${images.length}` : '';
  }

  function step(delta) {
    index = (index + delta + images.length) % images.length;
    show();
  }

  /** Zooms to `target`, keeping the point under the pointer (x, y) where it is. */
  function zoomTo(target, x, y) {
    const next = Math.max(1, Math.min(MAX_ZOOM, target));
    const box = stage.getBoundingClientRect();
    const px = x - (box.left + box.width / 2);
    const py = y - (box.top + box.height / 2);
    shiftX = px - ((px - shiftX) * next) / zoom;
    shiftY = py - ((py - shiftY) * next) / zoom;
    zoom = next;
    if (zoom === 1) {
      shiftX = 0;
      shiftY = 0;
    }
    apply();
  }

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomTo(zoom * (event.deltaY < 0 ? 1.25 : 0.8), event.clientX, event.clientY);
  }, { passive: false });
  image.addEventListener('dblclick', (event) => zoomTo(zoom > 1 ? 1 : 2.5, event.clientX, event.clientY));
  image.addEventListener('pointerdown', (event) => {
    if (zoom <= 1) return;
    drag = { x: event.clientX - shiftX, y: event.clientY - shiftY, moved: false };
    image.setPointerCapture(event.pointerId);
  });
  image.addEventListener('pointermove', (event) => {
    if (!drag) return;
    shiftX = event.clientX - drag.x;
    shiftY = event.clientY - drag.y;
    drag.moved = true;
    apply(false);
  });
  image.addEventListener('pointerup', () => {
    drag = null;
  });
  // A click beside the picture closes it; on the picture it does nothing (it may be a drag).
  layer.addEventListener('click', (event) => {
    if (event.target === layer || event.target === stage) close();
  });

  const onKey = (event) => {
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowLeft' && several) step(-1);
    else if (event.key === 'ArrowRight' && several) step(1);
    else if (event.key === '+' || event.key === '=') zoomTo(zoom * 1.25, innerWidth / 2, innerHeight / 2);
    else if (event.key === '-') zoomTo(zoom * 0.8, innerWidth / 2, innerHeight / 2);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  function close() {
    document.removeEventListener('keydown', onKey, true);
    layer.classList.add('lightbox--closing');
    setTimeout(() => layer.remove(), 180);
  }

  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  show();
}
