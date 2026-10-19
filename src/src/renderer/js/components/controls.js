import { h } from '../core/dom.js';
import { assetUrl } from '../core/assets.js';

/** Switch control. `onChange(boolean)` is called on user input. */
export function createToggle({ checked, onChange, label }) {
  const input = h('input', {
    type: 'checkbox',
    checked: Boolean(checked),
    'aria-label': label,
    onchange: (event) => onChange?.(event.target.checked),
  });
  return h(
    'label',
    { class: 'toggle' },
    input,
    h('span', { class: 'toggle__track' }),
    h('span', { class: 'toggle__thumb' }),
  );
}

/**
 * "Загрузка…" for a page whose content comes from the network: the launcher's X, bobbing and
 * glinting, and a line of text, so an empty screen never looks broken while the first answer is on
 * its way.
 */
export function loadingState(text = 'Загрузка…') {
  return h('div', { class: 'loading-state', role: 'status' }, loadingMark(), h('span', { class: 'loading-state__text' }, text));
}

/** The small bobbing X used wherever something loads. */
export function loadingMark(className = 'loading-mark') {
  return h('img', { class: className, src: assetUrl('branding/amethyx-mark.png'), alt: '', 'aria-hidden': 'true' });
}

/**
 * Segmented control with a sliding thumb under the active option.
 * options: [{ value, label }]. Returns { element, setValue(value) }.
 */
export function createSegmented({ options, value, onChange }) {
  const thumb = h('span', { class: 'segmented__thumb' });
  const buttons = options.map((option) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(option.value === value),
        onclick: () => {
          if (option.value !== current) {
            setValue(option.value);
            onChange?.(option.value);
          }
        },
      },
      option.label,
    ),
  );
  let current = value;

  const element = h('div', { class: 'segmented', role: 'group' }, thumb, buttons);

  function moveThumb() {
    const index = options.findIndex((option) => option.value === current);
    const button = buttons[index];
    if (!button) {
      return;
    }
    thumb.style.width = `${button.offsetWidth}px`;
    thumb.style.transform = `translateX(${button.offsetLeft - 4}px)`;
  }

  function setValue(next) {
    current = next;
    options.forEach((option, index) => {
      buttons[index].setAttribute('aria-pressed', String(option.value === next));
    });
    moveThumb();
  }

  requestAnimationFrame(moveThumb);
  // A switch built while hidden (a tab not open yet) has no size at first: the thumb is placed
  // again whenever the switch gets its size or the font changes the buttons' width.
  new ResizeObserver(() => moveThumb()).observe(element);
  return { element, setValue };
}

/** Linear progress bar. `set(percent, { indeterminate, error })` updates it. */
export function createProgress() {
  const bar = h('span', { class: 'progress__bar' });
  const element = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);

  function set(percent, { indeterminate = false, error = false } = {}) {
    element.classList.toggle('progress--indeterminate', indeterminate);
    element.classList.toggle('progress--error', error);
    if (!indeterminate) {
      bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      element.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
  }

  return { element, set };
}
