import { toast } from '../components/toast.js';

/** Text the user has selected with the mouse: a click that only selected it should do nothing else. */
export function selectedText() {
  return String(window.getSelection?.() ?? '').trim();
}

/**
 * The old way, for when the page is not focused (the clipboard API refuses then: focus in a web page
 * inside the launcher, or the window just behind another): a hidden field, selected and copied.
 */
function copyWithField(value) {
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('copy refused');
}

/** Puts text on the clipboard and says so. */
export function copyText(text, done = 'Скопировано') {
  const value = String(text ?? '');
  return navigator.clipboard
    .writeText(value)
    .catch(() => copyWithField(value))
    .then(
      () => toast(done, 'success', 2400),
      () => toast('Не удалось скопировать', 'error'),
    );
}
