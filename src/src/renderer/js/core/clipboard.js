import { toast } from '../components/toast.js';

/** Text the user has selected with the mouse: a click that only selected it should do nothing else. */
export function selectedText() {
  return String(window.getSelection?.() ?? '').trim();
}

/** Puts text on the clipboard and says so. */
export function copyText(text, done = 'Скопировано') {
  return navigator.clipboard.writeText(String(text ?? '')).then(
    () => toast(done, 'success', 2400),
    () => toast('Не удалось скопировать', 'error'),
  );
}
