import { h } from '../core/dom.js';
import { DEFAULT_OVERLAY_KEY, hotkeyParts, readCombination } from '../core/hotkey.js';
import { toast } from './toast.js';

/**
 * Any key combination, recorded: a click on the button, then the keys. Esc or a click elsewhere
 * leaves it as it was; "Сбросить" brings back the default. `onChange(accelerator)` saves it.
 */
export function createHotkeyInput({ value, onChange, defaultValue = DEFAULT_OVERLAY_KEY }) {
  let current = value || defaultValue;
  let recording = false;

  const caps = (parts) => parts.flatMap((part, index) => [...(index ? [h('span', { class: 'hotkey__plus' }, '+')] : []), h('kbd', { class: 'hotkey__cap' }, part)]);
  const button = h('button', { class: 'btn btn--secondary btn--compact hotkey__button', type: 'button', 'data-i18n': 'off', onclick: () => (recording ? stop() : start()) });
  const reset = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => choose(defaultValue) }, 'Сбросить');
  const element = h('div', { class: 'hotkey' }, button, reset);

  function paint(held = null) {
    button.classList.toggle('hotkey__button--recording', recording);
    if (recording) {
      button.replaceChildren(...(held?.length ? [...caps(held), h('span', { class: 'hotkey__plus' }, '+'), h('span', { class: 'hotkey__wait' }, '…')] : [h('span', { class: 'hotkey__wait' }, 'Нажмите клавиши…')]));
    } else {
      button.replaceChildren(...caps(hotkeyParts(current)));
    }
    reset.disabled = current === defaultValue;
  }

  function onKey(event) {
    // The settings section was drawn anew while recording: this copy lets the keys go.
    if (!element.isConnected) {
      stop();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'keyup') {
      if (recording) paint(readCombination(event).held);
      return;
    }
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      stop();
      return;
    }
    const result = readCombination(event);
    if (result.held) {
      paint(result.held);
    } else if (result.error) {
      toast(result.error, 'error', 3200);
    } else {
      choose(result.done);
    }
  }

  function onPointer(event) {
    if (!element.contains(event.target)) stop();
  }

  function start() {
    recording = true;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', stop);
    paint();
  }

  function stop() {
    if (!recording) return;
    recording = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('blur', stop);
    paint();
  }

  function choose(next) {
    stop();
    if (next === current) return;
    current = next;
    paint();
    onChange?.(next);
  }

  paint();
  return { element, stop };
}
