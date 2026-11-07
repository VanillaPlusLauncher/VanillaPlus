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

/**
 * The small bobbing X used wherever something loads. A mark drawn anew (a section rebuilt while a
 * download goes on) keeps the beat of the one it replaces: its endless animations run on the page's
 * clock instead of starting from the top, so the X never jerks back to the start.
 */
export function loadingMark(className = 'loading-mark') {
  const mark = h('img', { class: className, src: assetUrl('branding/amethyx-mark.png'), alt: '', 'aria-hidden': 'true' });
  const keepBeat = () => {
    for (const animation of mark.getAnimations?.() ?? []) {
      if (animation.startTime !== 0 && animation.effect?.getTiming().iterations === Infinity) animation.startTime = 0;
    }
  };
  // Before the first frame when the mark is already on the page; otherwise once its animation starts.
  requestAnimationFrame(keepBeat);
  mark.addEventListener('animationstart', keepBeat);
  return mark;
}

/**
 * A switch is often built anew right after a click: the settings page redraws its section once the
 * setting is saved. The new switch then starts its thumb where the clicked one was, so the move stays
 * one slide from the old option (it used to fly in from the left edge, or not move at all for the first option).
 */
const recentMoves = new Map();
const CARRY_MS = 800;

/**
 * Segmented control with a sliding thumb under the active option.
 * options: [{ value, label }]. Returns { element, setValue(value) }.
 */
export function createSegmented({ options, value, onChange }) {
  const signature = options.map((option) => String(option.value)).join('\u0001');
  // Unseen until it is put in its place (the first frame the switch has a size).
  const thumb = h('span', { class: 'segmented__thumb', style: { visibility: 'hidden' } });
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

  let placed = false;

  /** Where the thumb belongs for the current value, or null while the switch has no size. */
  function target() {
    const button = buttons[options.findIndex((option) => option.value === current)];
    return button?.offsetWidth ? { x: button.offsetLeft - 4, width: button.offsetWidth } : null;
  }

  function put({ x, width }) {
    thumb.style.width = `${width}px`;
    thumb.style.transform = `translateX(${x}px)`;
  }

  /** Puts the thumb somewhere without the slide. */
  function jump(position) {
    thumb.style.transition = 'none';
    put(position);
    void thumb.offsetWidth;
    thumb.style.transition = '';
  }

  function moveThumb() {
    const next = target();
    if (!next) {
      return;
    }
    if (!placed) {
      // First placement: no slide in from the left edge, unless a twin switch was just clicked.
      placed = true;
      const carried = recentMoves.get(signature);
      recentMoves.delete(signature);
      jump(carried && performance.now() - carried.at < CARRY_MS ? carried : next);
      thumb.style.visibility = '';
    }
    put(next);
  }

  function setValue(next) {
    const from = placed ? target() : null;
    current = next;
    options.forEach((option, index) => {
      buttons[index].setAttribute('aria-pressed', String(option.value === next));
    });
    if (from) {
      recentMoves.set(signature, { ...from, at: performance.now() });
    }
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
