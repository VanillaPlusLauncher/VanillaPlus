import { locale } from './i18n.js';

/** Shared labels and helpers for mods, packs and loaders. */

export const LOADER_LABELS = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
export const PLATFORM_LABELS = { modrinth: 'Modrinth', curseforge: 'CurseForge' };
export const CONTENT_TYPES = [
  { type: 'modpack', label: 'Модпаки', short: 'Модпаки', folder: null },
  { type: 'mod', label: 'Моды', short: 'Моды', folder: 'mods' },
  { type: 'resourcepack', label: 'Ресурспаки', short: 'Ресурспаки', folder: 'resourcepacks' },
  { type: 'shader', label: 'Шейдеры', short: 'Шейдеры', folder: 'shaderpacks' },
  // Data packs go into one world of the instance (saves/<world>/datapacks).
  { type: 'datapack', label: 'Датапаки', short: 'Датапаки', folder: null },
];
export const SORTS = [
  { value: 'relevance', label: 'По релевантности' },
  { value: 'downloads', label: 'По загрузкам' },
  { value: 'follows', label: 'По популярности' },
  { value: 'updated', label: 'Недавно обновлённые' },
  { value: 'newest', label: 'Новые' },
];

export function formatCount(value) {
  const number = Number(value) || 0;
  if (number >= 1e6) {
    return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)} млн`;
  }
  if (number >= 1e3) {
    return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)} тыс.`;
  }
  return String(number);
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export function formatPlayTime(ms) {
  const minutes = Math.round((ms ?? 0) / 60000);
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

// Dates follow the interface language.
const relativeFormats = new Map();
const relativeFormat = () => {
  const key = locale();
  if (!relativeFormats.has(key)) relativeFormats.set(key, new Intl.RelativeTimeFormat(key, { numeric: 'auto' }));
  return relativeFormats.get(key);
};

export function formatAgo(iso) {
  if (!iso) {
    return 'никогда';
  }
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relativeFormat().format(Math.round(seconds / size), unit);
    }
  }
  return 'только что';
}

/** "Fabric 0.16.5 · 1.20.1" */
export function describeInstance(instance) {
  const loader = instance.loader?.type && instance.loader.type !== 'vanilla' ? `${LOADER_LABELS[instance.loader.type]}${instance.loader.version ? ` ${shortLoaderVersion(instance.loader.version)}` : ''}` : 'Vanilla';
  return `${instance.minecraft} · ${loader}`;
}

function shortLoaderVersion(version) {
  return version.replace(/^\d+\.\d+(\.\d+)?-/, '');
}
