/*
 * Languages of the launcher. The interface is written in Russian; another language is applied to
 * what is on screen: every text node and the title / placeholder / aria-label attributes are looked
 * up in that language's dictionary (renderer/i18n/<lang>.json, keyed by the Russian text) as they
 * appear, so pages, dialogs, toasts and error messages need no changes of their own.
 * Texts built from parts are matched by patterns: "Установлено: {0}" → "Installed: {0}", and the
 * parts are translated too when the dictionary knows them. User content (names, logs, inputs) is
 * left alone: anything inside [data-i18n="off"], inputs, textareas, code and the game log.
 */

export const LANGUAGES = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' },
  { code: 'pl', label: 'Polski' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'zh', label: '简体中文' },
];

const ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
const CYRILLIC = /[А-Яа-яЁё]/;
const SKIP = 'input, textarea, select option[data-raw], code, pre, .mono, [data-i18n="off"], .log-view, .console-view';
const RUSSIAN_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const RUSSIAN_DATE = new RegExp(`^(\\d{1,2}) (${RUSSIAN_MONTHS.join('|')}) (\\d{4}) г\\.$`);

let language = 'ru';
let dictionary = null;
let patterns = [];
let observer = null;
// Original Russian of each translated text node / attribute, so switching back (or to another
// language) starts from the source text.
const originalText = new WeakMap();
const originalAttributes = new WeakMap();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(dict) {
  patterns = Object.entries(dict)
    .filter(([source]) => /\{\d\}/.test(source) && CYRILLIC.test(source.replace(/\{\d\}/g, '')))
    .map(([source, target]) => {
      const order = [];
      const body = escapeRegExp(source).replace(/\\\{(\d)\\\}/g, (_, index) => {
        order.push(Number(index));
        return '([\\s\\S]+?)';
      });
      return { re: new RegExp(`^${body}$`), order, target, weight: source.replace(/\{\d\}/g, '').length };
    })
    .sort((a, b) => b.weight - a.weight);
}

/** One piece of text in the current language, or null when there is nothing to change. */
export function translate(text) {
  if (!dictionary || !text || !CYRILLIC.test(text)) return null;
  const trimmed = text.trim();
  const exact = dictionary[trimmed];
  if (exact !== undefined) return text.replace(trimmed, exact);
  // "Шрифты…": a known text with an ellipsis after it (the start screen's steps).
  if (trimmed.endsWith('…') && dictionary[trimmed.slice(0, -1)] !== undefined) return text.replace(trimmed, `${dictionary[trimmed.slice(0, -1)]}…`);
  // "28 сентября 2026 г.": a date written before the language was loaded, in this language's way.
  const date = RUSSIAN_DATE.exec(trimmed);
  if (date) {
    const value = new Date(Number(date[3]), RUSSIAN_MONTHS.indexOf(date[2]), Number(date[1]));
    return text.replace(trimmed, new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(value));
  }
  for (const pattern of patterns) {
    const match = pattern.re.exec(trimmed);
    if (match) {
      const values = [];
      pattern.order.forEach((index, position) => {
        values[index] = match[position + 1];
      });
      const result = pattern.target.replace(/\{(\d)\}/g, (_, index) => {
        const value = values[Number(index)] ?? '';
        return dictionary[value.trim()] ?? value;
      });
      return text.replace(trimmed, result);
    }
  }
  return null;
}

/** For code that builds text itself (canvas labels, native dialogs): t('Готово'). */
export function t(text) {
  return translate(text)?.trim() ?? text;
}

function skipped(element) {
  return Boolean(element?.closest?.(SKIP));
}

function translateTextNode(node) {
  if (skipped(node.parentElement)) return;
  const known = originalText.get(node);
  // The page changed the text since we translated it: that new text is the source now.
  const source = known && node.nodeValue === known.translated ? known.source : node.nodeValue;
  const result = dictionary ? translate(source) : null;
  if (result !== null && result !== node.nodeValue) {
    originalText.set(node, { source, translated: result });
    node.nodeValue = result;
  } else if (!dictionary && known && node.nodeValue === known.translated) {
    node.nodeValue = known.source;
    originalText.delete(node);
  }
}

function translateAttributes(element) {
  if (skipped(element) && !element.matches('input, textarea')) return;
  let saved = originalAttributes.get(element);
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const known = saved?.[name];
    const source = known && value === known.translated ? known.source : value;
    const result = dictionary ? translate(source) : null;
    if (result !== null && result !== value) {
      saved ??= {};
      saved[name] = { source, translated: result };
      originalAttributes.set(element, saved);
      element.setAttribute(name, result);
    } else if (!dictionary && known && value === known.translated) {
      element.setAttribute(name, known.source);
    }
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
    else translateAttributes(node);
  }
}

function startObserver() {
  observer?.disconnect();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateTextNode(mutation.target);
      else if (mutation.type === 'attributes') translateAttributes(mutation.target);
      else mutation.addedNodes.forEach((node) => translateTree(node));
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
}

const LOCALES = { ru: 'ru-RU', en: 'en-US', uk: 'uk-UA', pl: 'pl-PL', es: 'es-ES', pt: 'pt-BR', de: 'de-DE', fr: 'fr-FR', zh: 'zh-CN' };

/** Locale for dates, times and numbers in the current language. */
export function locale() {
  return LOCALES[language] ?? 'ru-RU';
}

export function currentLanguage() {
  return language;
}

/** Switches the whole window to `code` (one of LANGUAGES). */
export async function setLanguage(code) {
  const next = LANGUAGES.some((entry) => entry.code === code) ? code : 'ru';
  if (next === language && (next === 'ru' || dictionary)) return;
  if (next === 'ru') {
    dictionary = null;
    patterns = [];
  } else {
    try {
      const response = await fetch(new URL(`../../i18n/${next}.json`, import.meta.url));
      dictionary = await response.json();
      compile(dictionary);
    } catch {
      dictionary = null;
      patterns = [];
    }
  }
  language = next;
  document.documentElement.lang = next;
  translateTree(document.body);
  if (dictionary) startObserver();
  else observer?.disconnect();
}
