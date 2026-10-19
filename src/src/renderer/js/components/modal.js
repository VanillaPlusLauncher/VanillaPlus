import { h, icon } from '../core/dom.js';
import { sfx } from '../core/sound.js';

const CLOSE_ANIMATION_MS = 380;

/**
 * Opens a modal dialog. Returns { close, body }.
 * `content` and `footer` are DOM nodes; `onClose` runs once after the dialog closes.
 */
export function openModal({ title, content, footer = [], wide = false, size = null, dismissible = true, onClose }) {
  const body = h('div', { class: 'modal__body' }, content);
  const closeButton = h(
    'button',
    { class: 'icon-button', type: 'button', 'aria-label': 'Закрыть', onclick: () => close() },
    icon('close'),
  );
  const layer = h(
    'div',
    {
      class: 'modal-layer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onclick: (event) => {
        if (dismissible && event.target === layer) {
          close();
        }
      },
    },
    h(
      'div',
      { class: `modal${wide ? ' modal--wide' : ''}${size ? ` modal--${size}` : ''}` },
      h('div', { class: 'modal__header' }, h('h2', { class: 'modal__title' }, title), closeButton),
      body,
      footer.length > 0 ? h('div', { class: 'modal__footer' }, footer) : null,
    ),
  );

  let closed = false;
  function onKeydown(event) {
    // Only the topmost dialog reacts: Escape in a confirmation must not close the dialog below it.
    if (event.key === 'Escape' && dismissible && layer === layer.parentElement?.lastElementChild) {
      close();
    }
  }
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    sfx('modalClose');
    document.removeEventListener('keydown', onKeydown);
    layer.classList.remove('modal-layer--visible');
    setTimeout(() => layer.remove(), CLOSE_ANIMATION_MS);
    onClose?.();
  }

  document.addEventListener('keydown', onKeydown);
  document.getElementById('modal-root').append(layer);
  sfx('modalOpen');
  requestAnimationFrame(() => {
    layer.classList.add('modal-layer--visible');
    body.querySelector('input, textarea')?.focus();
  });
  return { close, body };
}

/** Asks a yes/no question. Resolves with true when the user confirms. */
export function confirmDialog({ title, message, confirmLabel = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      if (!answered) {
        answered = true;
        resolve(value);
      }
      modal.close();
    };
    const modal = openModal({
      title,
      content: h('p', { class: 'text-soft' }, message),
      footer: [
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => answer(false) }, 'Отмена'),
        h(
          'button',
          { class: `btn btn--compact ${danger ? 'btn--secondary btn--danger' : 'btn--primary'}`, type: 'button', onclick: () => answer(true) },
          confirmLabel,
        ),
      ],
      onClose: () => answer(false),
    });
  });
}
