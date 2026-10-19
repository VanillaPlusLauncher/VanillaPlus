import { h } from '../core/dom.js';
import { LANGUAGES, setLanguage } from '../core/i18n.js';
import { sfx } from '../core/sound.js';
import { saveSettings } from '../state/actions.js';
import { store } from '../state/appStore.js';
import { openModal } from './modal.js';

/**
 * The first start: the launcher asks which language to speak, once. Windows' language comes first
 * and is chosen when the window is closed without a choice. The names stay in their own language.
 */
export function askLanguageOnce(systemLanguage) {
  if (store.get().settings?.ui?.language) return;
  const ordered = [...LANGUAGES].sort((a, b) => Number(b.code === systemLanguage) - Number(a.code === systemLanguage));
  let chosen = false;
  const choose = async (code) => {
    if (chosen) return;
    chosen = true;
    sfx('click');
    setLanguage(code);
    modal.close();
    await saveSettings({ ui: { language: code } }).catch(() => {});
  };
  const modal = openModal({
    title: 'Language · Язык',
    content: h(
      'div',
      { class: 'language-picker', 'data-i18n': 'off' },
      ...ordered.map((entry) =>
        h(
          'button',
          { class: `language-picker__item${entry.code === systemLanguage ? ' language-picker__item--system' : ''}`, type: 'button', onclick: () => choose(entry.code) },
          entry.label,
        ),
      ),
    ),
    onClose: () => choose(systemLanguage),
  });
  return modal;
}
