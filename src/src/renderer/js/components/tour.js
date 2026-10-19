import { h } from '../core/dom.js';
import { go } from '../core/nav.js';
import { sfx } from '../core/sound.js';

/*
 * A short walk through the launcher for someone who opens it for the first time: one part of the
 * window after another is lit up (the rest dims) and a card next to it says in plain words what it
 * is for. Nothing has to be chosen or set up: "Дальше", "Назад", "Пропустить" (or Esc / the arrow
 * keys). Shown once after the first start; Settings → "Лаунчер" can show it again.
 */

const DONE_KEY = 'amethyx.tour.done';
/** Room around a lit-up part, in px. */
const PAD = 8;

const STEPS = [
  {
    title: 'Добро пожаловать в Amethyx!',
    text: 'Это лаунчер Minecraft: Java Edition. За минуту покажу, где что находится. Ничего выбирать не нужно — просто нажимайте «Дальше».',
  },
  {
    target: '#account-button',
    title: 'Аккаунт',
    text: 'Здесь ваш игровой профиль. Есть лицензия — войдите через Microsoft. Нет — подойдёт Ely.by или просто ник (офлайн). Аккаунтов может быть несколько.',
  },
  {
    route: 'home',
    target: '.play-bar',
    title: 'Играть',
    text: 'Главная кнопка лаунчера. Она запускает выбранную сборку; при первом запуске лаунчер сам скачает игру и Java. Стрелка справа — выбрать другую сборку.',
  },
  {
    target: '[data-route="builds"]',
    title: 'Сборки',
    text: 'Сборка — это отдельная копия Minecraft: своя версия игры, свои моды, миры и настройки. Можно держать сколько угодно сборок, они не мешают друг другу.',
  },
  {
    target: '[data-route="browse"]',
    title: 'Библиотека',
    text: 'Моды, модпаки, ресурспаки и шейдеры с Modrinth и CurseForge. Нажмите «Добавить» — лаунчер сам поставит нужные зависимости в сборку.',
  },
  {
    target: '[data-route="friends"]',
    title: 'Друзья',
    text: 'Добавьте друга по нику, пишите ему, кидайте скриншоты и зовите в свой мир одной кнопкой — без белого IP и настройки роутера.',
  },
  {
    route: 'home',
    target: '.home-side__wardrobe',
    title: 'Гардероб',
    text: 'Скины: загрузите PNG, возьмите скин по нику или с сайтов скинов. Новый скин сразу видно на 3D-модели.',
  },
  {
    target: '[data-route="settings"]',
    title: 'Настройки',
    text: 'Память для игры, внешний вид, звуки и язык. Если что-то непонятно, это обучение можно пройти снова: «Настройки» → «Лаунчер». Приятной игры!',
  },
];

let active = null;

function rectOf(selector) {
  if (!selector) return null;
  const element = [...document.querySelectorAll(selector)].find((candidate) => candidate.offsetParent !== null || candidate.getClientRects().length);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width && rect.height ? rect : null;
}

/** Starts the walk-through now (also when it was seen before). */
export function startTour() {
  if (active) return;
  let index = 0;

  const spot = h('div', { class: 'tour__spot' });
  const counter = h('span', { class: 'tour__count' });
  const title = h('h3', { class: 'tour__title' });
  const text = h('p', { class: 'tour__text' });
  const back = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => show(index - 1) }, 'Назад');
  const next = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => show(index + 1) }, 'Дальше');
  const skip = h('button', { class: 'tour__skip', type: 'button', onclick: () => finish() }, 'Пропустить');
  const dots = h('span', { class: 'tour__dots' }, ...STEPS.map(() => h('i')));
  const card = h(
    'div',
    { class: 'tour__card', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'tour__head' }, counter, skip),
    title,
    text,
    h('div', { class: 'tour__foot' }, dots, h('span', { class: 'tour__buttons' }, back, next)),
  );
  // A click on the dimmed part does nothing: the walk goes on with the buttons.
  const layer = h('div', { class: 'tour' }, spot, card);

  const place = () => {
    const step = STEPS[index];
    const rect = rectOf(step.target);
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!rect) {
      // No part to show (the welcome, or it is not on screen): the card in the middle, all dimmed.
      spot.classList.add('tour__spot--none');
      spot.style.cssText = `left:${width / 2}px; top:${height / 2}px; width:0; height:0;`;
      card.style.left = `${Math.round((width - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.round((height - card.offsetHeight) / 2)}px`;
      return;
    }
    spot.classList.remove('tour__spot--none');
    spot.style.cssText = `left:${rect.left - PAD}px; top:${rect.top - PAD}px; width:${rect.width + PAD * 2}px; height:${rect.height + PAD * 2}px;`;
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const gap = 18;
    let left;
    let top;
    if (rect.right + gap + cardWidth < width - 12) {
      // Room on the right (the sidebar): beside it.
      left = rect.right + PAD + gap;
      top = rect.top + rect.height / 2 - cardHeight / 2;
    } else if (rect.bottom + gap + cardHeight < height - 12) {
      // Below it.
      left = rect.left + rect.width / 2 - cardWidth / 2;
      top = rect.bottom + PAD + gap;
    } else {
      // Above it.
      left = rect.left + rect.width / 2 - cardWidth / 2;
      top = rect.top - PAD - gap - cardHeight;
    }
    card.style.left = `${Math.round(Math.min(width - cardWidth - 12, Math.max(12, left)))}px`;
    card.style.top = `${Math.round(Math.min(height - cardHeight - 12, Math.max(12, top)))}px`;
  };

  function show(target) {
    if (target < 0) return;
    if (target >= STEPS.length) {
      finish();
      return;
    }
    index = target;
    const step = STEPS[index];
    if (step.route) go(step.route);
    counter.textContent = `${index + 1} из ${STEPS.length}`;
    title.textContent = step.title;
    text.textContent = step.text;
    back.hidden = index === 0;
    next.textContent = index === STEPS.length - 1 ? 'Понятно' : 'Дальше';
    [...dots.children].forEach((dot, dotIndex) => dot.classList.toggle('is-on', dotIndex === index));
    card.classList.remove('tour__card--in');
    void card.offsetWidth;
    card.classList.add('tour__card--in');
    sfx('click');
    // The page may still be opening: place now and once more when it has settled.
    place();
    setTimeout(place, 320);
    next.focus();
  }

  const onKey = (event) => {
    if (event.key === 'Escape') finish();
    else if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === 'ArrowLeft') show(index - 1);
  };

  function finish() {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      // Shown again next time then; nothing breaks.
    }
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    layer.classList.add('tour--leaving');
    setTimeout(() => layer.remove(), 220);
    active = null;
  }

  active = { finish };
  document.body.append(layer);
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);
  show(0);
}

/** First start: the walk-through once, after the language question (or any other dialog) is closed. */
export function startTourOnce() {
  let done = false;
  try {
    done = localStorage.getItem(DONE_KEY) === '1';
  } catch {
    done = false;
  }
  if (done) return;
  const wait = () => (document.querySelector('.modal-layer') ? setTimeout(wait, 400) : setTimeout(startTour, 500));
  wait();
}
