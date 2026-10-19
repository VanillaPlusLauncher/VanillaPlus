import { locale } from './i18n.js';

// Dates follow the interface language.
const dateFormatter = { format: (value) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(value) };

export const VERSION_TYPE_LABELS = {
  release: 'Релиз',
  snapshot: 'Снапшот',
  old_beta: 'Бета',
  old_alpha: 'Альфа',
};

export function formatReleaseDate(isoDate) {
  if (!isoDate) {
    return 'дата неизвестна';
  }
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? 'дата неизвестна' : dateFormatter.format(date);
}

export function formatGigabytes(megabytes) {
  const gigabytes = megabytes / 1024;
  return Number.isInteger(gigabytes) ? `${gigabytes} ГБ` : `${gigabytes.toFixed(1)} ГБ`;
}

export function formatMegabytes(megabytes) {
  return `${Math.round(megabytes)} МБ`;
}

/** Converts an error text from the main process into a short, readable message. */
export function errorMessage(error) {
  return error?.message || 'Неизвестная ошибка';
}
