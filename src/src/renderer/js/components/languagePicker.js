import { h } from '../core/dom.js';
import { LANGUAGES, setLanguage } from '../core/i18n.js';
import { sfx } from '../core/sound.js';
import { saveSettings } from '../state/actions.js';
import { store } from '../state/appStore.js';
import { openModal } from './modal.js';

/**
 * The first start: the launcher asks which language to speak, once. All languages are the same
 * button in a 3 × 3 grid, in a fixed order, none put first; closing the window without a choice
 * keeps Windows' language. The names stay in their own language.
 */
export function askLanguageOnce(systemLanguage) {
  if (store.get().settings?.ui?.language) return;
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
      ...LANGUAGES.map((entry) =>
        h(
          'button',
          { class: 'language-picker__item', type: 'button', lang: entry.code, onclick: () => choose(entry.code) },
          h('span', { class: 'language-picker__code' }, entry.code.toUpperCase()),
          h('span', { class: 'language-picker__name' }, entry.label),
        ),
      ),
    ),
    onClose: () => choose(systemLanguage),
  });
  return modal;
}
