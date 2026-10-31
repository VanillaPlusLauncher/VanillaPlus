import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { iconImage } from '../core/mc.js';
import { errorMessage } from '../core/format.js';
import { beginInstall } from '../core/installQueue.js';
import { sfx } from '../core/sound.js';
import { store } from '../state/appStore.js';
import { confirmCompatibility } from './compatDialog.js';
import { openOptimizeDialog } from './optimizeDialog.js';

/*
 * "Умный помощник": a grass block on the builds page and on each instance's page. A click opens a
 * small chat at the right edge: questions as buttons, or typed in your own words — conflicts in the
 * pack, mods worth adding, updates, a faster game — and answers with the fixes as buttons. No AI:
 * the checks are the launcher's own (main/content/assistant.js). It never opens or speaks by
 * itself; the walk-through (tour.js) introduces it once.
 */

const QUESTIONS = [
  { key: 'check', label: 'Есть несовместимости?' },
  { key: 'suggest', label: 'Что добавить?' },
  { key: 'updates', label: 'Есть обновления?' },
  { key: 'speed', label: 'Как ускорить игру?' },
];

/** Topics for "посоветуй моды на …" (keys of TOPICS in main/content/assistant.js). */
const TOPICS = [
  { key: 'magic', title: 'Магия', words: /маги|волшеб|заклин|колдов|чар/ },
  { key: 'tech', title: 'Техника', words: /техн|механ|завод|автомат|электр|create|крейт/ },
  { key: 'decor', title: 'Декор', words: /декор|мебел|украш|строит|постро|дизайн|интерьер/ },
  { key: 'mobs', title: 'Мобы', words: /моб|животн|существ|монстр|звер|питом/ },
  { key: 'adventure', title: 'Приключения', words: /приключ|данж|подземел|босс|квест|исследов/ },
  { key: 'worldgen', title: 'Биомы', words: /биом|генерац|ландшафт|рельеф|структур|деревн/ },
  { key: 'storage', title: 'Хранение', words: /хранен|сундук|склад|рюкзак|сортир/ },
  { key: 'food', title: 'Еда и фермы', words: /\sед[аыу][\s,.!?]|фермер|урожа|готовк|кулинар|ферм/ },
  { key: 'transport', title: 'Транспорт', words: /транспорт|машин|поезд|самол[её]т|лодк|корабл|дирижабл/ },
  { key: 'equipment', title: 'Оружие и броня', words: /оруж|брон[яеи]|меч|снаряж/ },
  { key: 'map', title: 'Карты', words: /карт[аыуе]|миникарт/ },
];

/**
 * What a typed question is about: { key, topic } or null. The text is padded with spaces: \b does
 * not see Russian letters, so whole short words are matched as \sword[\s,.!?].
 */
function understand(text) {
  const said = ` ${text.toLowerCase().replace(/ё/g, 'е')} `;
  if (/несовмест|конфликт|совмест|вылет|краш|крах|crash/.test(said)) return { key: 'check' };
  if (/обнов|апдейт|update|свеж/.test(said)) return { key: 'updates' };
  if (/оптимиз|fps|фпс|лаг|тормоз|ускор|быстр|скорост|производит|зависа/.test(said)) return { key: 'speed' };
  const topic = TOPICS.find((entry) => entry.words.test(said));
  if (topic) return { key: 'suggest', topic: topic.key };
  if (/посовет|добав|постав|предлож|рекоменд|какие моды|что скач|скучн|интересн/.test(said)) return { key: 'suggest' };
  if (/провер|проблем|ошибк|не запуск|не работа|сломал|в порядке|все ли|норм ли/.test(said)) return { key: 'check' };
  if (/как дела|как ты|как сам|как жизнь/.test(said)) return { key: 'mood' };
  if (/спасиб|благодар|круто|класс|супер|отлично|thanks/.test(said)) return { key: 'thanks' };
  if (/кто ты|что (ты )?умеешь|помоги|помощь|help|как (тобой|пользоват)/.test(said)) return { key: 'help' };
  if (/привет|здаров|здравств|\s(хай|йо|ку|хей)[\s,.!?]|hello|\bhi\b/.test(said)) return { key: 'hello' };
  return null;
}

/** "1 мод", "3 мода", "12 модов". */
function count(n, one, few, many) {
  const word = n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
  return `${n} ${word}`;
}

let panel = null;

/** The grass block button; `getInstance()` is the instance it talks about first, `onChanged(id)` reloads its list. */
export function createAssistantButton({ getInstance = () => null, onChanged = null } = {}) {
  return h(
    'button',
    {
      class: 'btn btn--ghost btn--compact assistant-button',
      type: 'button',
      title: 'Проверит моды на конфликты, посоветует, что добавить, найдёт обновления',
      onclick: () => openAssistant({ instanceId: getInstance()?.id ?? null, onChanged }),
    },
    iconImage('block:grass_block', 'assistant-button__block'),
    'Умный помощник',
  );
}

export function closeAssistant() {
  if (!panel || panel.element.hidden) return;
  panel.element.classList.add('assistant--leaving');
  document.removeEventListener('keydown', panel.onKey, true);
  setTimeout(() => {
    panel.element.hidden = true;
    panel.element.classList.remove('assistant--leaving');
  }, 180);
}

export function openAssistant({ instanceId = null, onChanged = null } = {}) {
  if (!panel) panel = createPanel();
  panel.onChanged = onChanged;
  const wasOpen = !panel.element.hidden;
  panel.fillInstances(instanceId);
  if (!wasOpen) {
    panel.element.hidden = false;
    panel.element.classList.remove('assistant--in');
    void panel.element.offsetWidth;
    panel.element.classList.add('assistant--in');
    document.addEventListener('keydown', panel.onKey, true);
    sfx('click');
  }
  panel.greet();
  panel.input.focus();
}

function createPanel() {
  const self = { onChanged: null, instanceId: null, busy: false, greeted: false };
  const face = iconImage('block:grass_block', 'assistant__face');
  const select = h('select', { class: 'select select--compact assistant__instance', title: 'Про какую сборку говорим', onchange: () => switchTo(select.value) });
  const log = h('div', { class: 'assistant__log', 'aria-live': 'polite' });
  const chips = h('div', { class: 'assistant__chips' }, QUESTIONS.map((question) => h('button', { class: 'assistant-chip', type: 'button', onclick: () => ask(question.key, { said: question.label }) }, question.label)));
  const input = h('input', { class: 'input assistant__input', type: 'text', maxlength: '200', placeholder: 'Спроси что-нибудь…' });
  const form = h(
    'form',
    {
      class: 'assistant__ask',
      onsubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text || self.busy) return;
        input.value = '';
        const meaning = understand(text);
        ask(meaning?.key ?? 'unknown', { said: text, topic: meaning?.topic });
      },
    },
    input,
    h('button', { class: 'btn btn--primary btn--compact assistant__send', type: 'submit', title: 'Спросить' }, '›'),
  );
  const element = h(
    'aside',
    { class: 'assistant', role: 'dialog', 'aria-label': 'Умный помощник', hidden: true },
    h(
      'header',
      { class: 'assistant__head' },
      h('span', { class: 'assistant__avatar' }, face),
      h('div', { class: 'assistant__who' }, h('b', null, 'Умный помощник'), select),
      h('button', { class: 'icon-button assistant__close', type: 'button', title: 'Закрыть', onclick: () => closeAssistant() }, icon('close')),
    ),
    log,
    chips,
    form,
  );
  document.body.append(element);

  const current = () => store.get().instances.find((instance) => instance.id === self.instanceId) ?? null;

  function fillInstances(wanted) {
    const { instances, settings } = store.get();
    const id = [wanted, self.instanceId, settings?.selectedInstanceId, instances[0]?.id].find((candidate) => candidate && instances.some((instance) => instance.id === candidate)) ?? null;
    select.replaceChildren(...instances.map((instance) => h('option', { value: instance.id }, instance.name)));
    select.hidden = instances.length === 0;
    if (id && self.instanceId && id !== self.instanceId && self.greeted) {
      self.instanceId = id;
      select.value = id;
      bot(`Окей, теперь смотрю «${current()?.name}».`);
      return;
    }
    self.instanceId = id;
    if (id) select.value = id;
  }

  function switchTo(id) {
    if (id === self.instanceId) return;
    self.instanceId = id;
    bot(`Окей, теперь смотрю «${current()?.name}».`);
  }

  function scrollDown() {
    requestAnimationFrame(() => log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }));
  }

  /** The block hops when it says something. */
  function hop() {
    face.classList.remove('assistant__face--hop');
    void face.offsetWidth;
    face.classList.add('assistant__face--hop');
  }

  /** A message of the block: text lines and anything else (cards, buttons). */
  function bot(...parts) {
    const said = message(...parts);
    log.append(said);
    hop();
    scrollDown();
    return said;
  }

  function user(text) {
    log.append(h('div', { class: 'assistant-msg assistant-msg--user' }, h('p', null, text)));
    scrollDown();
  }

  const muted = (text) => h('p', { class: 'assistant-msg__muted' }, text);
  /** A message not yet in the log (an answer replaces the "thinking" dots). */
  const message = (...parts) => h('div', { class: 'assistant-msg assistant-msg--bot' }, ...parts.flat().filter(Boolean).map((part) => (typeof part === 'string' ? h('p', null, part) : part)));

  function greet() {
    if (self.greeted) return;
    self.greeted = true;
    const instance = current();
    bot(
      'Привет! Я травяной блок, помощник по сборкам.',
      instance
        ? `Могу проверить моды в «${instance.name}» на конфликты, посоветовать, что добавить, и поискать обновления. Жми на вопрос внизу или пиши своими словами.`
        : 'Как появится сборка — проверю её моды на конфликты, посоветую, что добавить, и поищу обновления.',
    );
  }

  async function ask(key, { said, topic = null } = {}) {
    if (self.busy) return;
    user(said);
    const instance = current();
    const needsInstance = !['hello', 'help', 'thanks', 'mood', 'unknown'].includes(key);
    if (needsInstance && !instance) {
      bot('Сборок пока нет. Создай первую — кнопка «Новая сборка» на странице «Сборки».');
      return;
    }
    if (!needsInstance) {
      talk(key);
      return;
    }
    self.busy = true;
    element.classList.add('assistant--busy');
    const thinking = bot(h('span', { class: 'assistant-dots', 'aria-label': 'Думаю' }, h('i'), h('i'), h('i')));
    try {
      thinking.replaceWith(await ANSWERS[key](instance, topic));
    } catch (error) {
      thinking.replaceWith(message(`Не получилось: ${errorMessage(error)}`, muted('Проверь интернет и спроси ещё раз.')));
    } finally {
      hop();
      scrollDown();
      self.busy = false;
      element.classList.remove('assistant--busy');
    }
  }

  function talk(key) {
    if (key === 'hello') bot('Йо! Спрашивай: про конфликты модов, что добавить или про обновления.');
    else if (key === 'thanks') bot('Да не за что! Если что — я тут.');
    else if (key === 'mood') bot('Норм, фотосинтезирую потихоньку. Чем помочь со сборкой?');
    else if (key === 'help') bot('Я умею проверять моды на конфликты (дубли, не тот загрузчик или версия, нехватка нужных модов), советовать моды — для скорости, для удобства или по теме — и искать обновления.', topicChips('Попробуй, например:'));
    else bot('Тут я пока не понял. Я разбираюсь в модах: могу проверить конфликты, посоветовать моды или найти обновления.', topicChips('Или назови тему:'));
  }

  function topicChips(label) {
    return h(
      'div',
      { class: 'assistant-topics' },
      muted(label),
      h('div', { class: 'assistant-topics__list' }, TOPICS.map((topic) => h('button', { class: 'assistant-chip assistant-chip--small', type: 'button', onclick: () => ask('suggest', { said: `Посоветуй моды: ${topic.title.toLowerCase()}`, topic: topic.key }) }, topic.title))),
    );
  }

  function changed(instance) {
    self.onChanged?.(instance.id);
  }

  // --- Fixes and installs ------------------------------------------------------------------

  async function installMod(instance, project) {
    const request = { instanceId: instance.id, platform: project.platform, projectId: project.projectId, type: 'mod', title: project.title, iconUrl: project.iconUrl };
    if (!(await confirmCompatibility(request))) return false;
    const done = beginInstall();
    try {
      await api.content.install(request);
      return true;
    } finally {
      done();
    }
  }

  function problemCard(instance, problem) {
    const note = h('p', { class: 'assistant-card__error', hidden: true });
    const buttons = h('div', { class: 'assistant-card__buttons' });
    const card = h('div', { class: `assistant-card assistant-card--${problem.level}` }, h('b', { class: 'assistant-card__title' }, problem.title), h('p', null, problem.text), buttons, note);
    for (const fix of problem.fixes) {
      const button = h('button', { class: 'btn btn--secondary btn--compact', type: 'button' }, fix.label);
      button.onclick = async () => {
        const all = [...buttons.querySelectorAll('button')];
        all.forEach((other) => (other.disabled = true));
        button.textContent = 'Делаю…';
        note.hidden = true;
        try {
          if (fix.action === 'install') {
            if (!(await installMod(instance, fix.project))) {
              all.forEach((other) => (other.disabled = false));
              button.textContent = fix.label;
              return;
            }
          } else {
            await api.content.setEnabledMany(instance.id, 'mod', fix.files, fix.action === 'enable');
          }
          card.classList.add('assistant-card--done');
          buttons.replaceChildren(h('span', { class: 'assistant-card__done' }, '✓ Готово'));
          sfx('success');
          changed(instance);
        } catch (error) {
          note.textContent = errorMessage(error);
          note.hidden = false;
          all.forEach((other) => (other.disabled = false));
          button.textContent = fix.label;
        }
      };
      buttons.append(button);
    }
    return card;
  }

  function modRow(instance, item) {
    const button = h('button', { class: 'btn btn--secondary btn--compact', type: 'button' }, 'Поставить');
    const row = h(
      'div',
      { class: 'assistant-mod' },
      item.iconUrl ? h('img', { class: 'assistant-mod__icon', src: item.iconUrl, alt: '', decoding: 'async' }) : h('span', { class: 'assistant-mod__icon' }, icon('cube')),
      h('b', { class: 'assistant-mod__title' }, item.title),
      button,
      h('span', { class: 'assistant-mod__why' }, item.why ?? ''),
    );
    row.install = async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = '…';
      try {
        if (await installMod(instance, item)) {
          button.textContent = 'Стоит';
          row.classList.add('assistant-mod--done');
          changed(instance);
          return;
        }
        button.disabled = false;
        button.textContent = 'Поставить';
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Поставить';
        row.append(h('p', { class: 'assistant-card__error' }, errorMessage(error)));
      }
    };
    button.onclick = () => row.install();
    return row;
  }

  function modGroup(instance, group, withTitle) {
    const rows = group.items.map((item) => modRow(instance, item));
    const all = rows.length > 1 ? h('button', { class: 'link-button assistant-group__all', type: 'button' }, 'Поставить все') : null;
    if (all) {
      all.onclick = async () => {
        all.disabled = true;
        for (const row of rows) await row.install();
        all.remove();
      };
    }
    return h('div', { class: 'assistant-group' }, withTitle || all ? h('div', { class: 'assistant-group__head' }, withTitle ? h('b', null, group.title) : h('span'), all) : null, ...rows);
  }

  // --- Answers -----------------------------------------------------------------------------

  const ANSWERS = {
    async check(instance) {
      const result = await api.content.assistantCheck(instance.id);
      const offline = result.offline ? muted('Без интернета проверил только сами файлы.') : null;
      if (!result.problems.length) {
        return message(
          result.modCount ? `Проверил ${count(result.modCount, 'мод', 'мода', 'модов')} в «${instance.name}» — конфликтов не вижу.` : `В «${instance.name}» пока нет модов — и конфликтов нет.`,
          offline,
          result.modCount ? muted('Если игра всё равно вылетает, загляни во вкладку «Журнал»: там будет причина.') : null,
        );
      }
      const errors = result.problems.filter((problem) => problem.level === 'error').length;
      return message(
        `Проверил ${count(result.modCount, 'мод', 'мода', 'модов')} и нашёл ${count(result.problems.length, 'проблему', 'проблемы', 'проблем')}${errors ? '' : ' — не страшные, но лучше поправить'}:`,
        result.problems.map((problem) => problemCard(instance, problem)),
        offline,
      );
    },

    async suggest(instance, topic) {
      if (instance.loader.type === 'vanilla') {
        return message(`«${instance.name}» — сборка без загрузчика (ванилла), моды в ней не работают.`, muted('Поставь Fabric или NeoForge в настройках сборки → «Версия», и я подберу моды.'));
      }
      const result = await api.content.assistantSuggest(instance.id, topic);
      const groups = result.groups.filter((group) => group.items.length);
      const topicTitle = TOPICS.find((entry) => entry.key === topic)?.title;
      if (topic) {
        if (!groups.length) return message(`По теме «${topicTitle}» для ${instance.minecraft} ничего нового не нашёл.`, topicChips('Можно другую тему:'));
        return message(`Самое скачиваемое на тему «${topicTitle}» для ${instance.minecraft}:`, groups.map((group) => modGroup(instance, group, false)), topicChips('Ещё темы:'));
      }
      if (!groups.length) return message('Всё самое нужное у тебя уже стоит. Хочешь чего-то конкретного?', topicChips('Выбери тему:'));
      return message(`Вот что я бы добавил в «${instance.name}»:`, groups.map((group) => modGroup(instance, group, true)), topicChips('Или выбери тему:'));
    },

    async speed(instance) {
      const optimize = h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => openOptimizeDialog(instance, () => changed(instance)) }, icon('bolt'), 'Открыть оптимизацию');
      const tail = [muted('Память, Java и графику под твой компьютер подстроит «Оптимизация»:'), h('div', { class: 'assistant-card__buttons' }, optimize)];
      if (instance.loader.type === 'vanilla') {
        return message('В ванилле моды для скорости не поставить — нужен Fabric или NeoForge (настройки сборки → «Версия»).', tail);
      }
      const result = await api.content.assistantSuggest(instance.id, 'speed');
      const group = result.groups[0];
      if (!group?.items.length) return message('Моды для скорости у тебя уже стоят — красавчик.', tail);
      return message(`Для скорости в «${instance.name}» я бы поставил:`, modGroup(instance, group, false), tail);
    },

    async updates(instance) {
      const updates = await api.content.checkUpdates(instance.id, 'mod');
      if (!updates.length) return message('Все моды свежие — обновлять нечего.');
      const shown = updates.slice(0, 6);
      const list = h(
        'div',
        { class: 'assistant-updates' },
        shown.map((update) => h('div', { class: 'assistant-updates__row' }, h('b', null, update.title), h('span', null, `${update.currentVersion ?? '?'} → ${update.version.versionNumber}`))),
        updates.length > shown.length ? muted(`и ещё ${updates.length - shown.length}`) : null,
      );
      const result = h('p', { class: 'assistant-msg__muted', hidden: true });
      const button = h('button', { class: 'btn btn--primary btn--compact', type: 'button' }, `Обновить все (${updates.length})`);
      button.onclick = async () => {
        button.disabled = true;
        try {
          // New mod versions can break a world: every world is backed up first (as in the mod list).
          button.textContent = 'Копия миров…';
          await api.instances.backupAll(instance.id, 'Перед обновлением модов').catch(() => 0);
          button.textContent = 'Обновляю…';
          const { updated, failed } = await api.content.updateMany(instance.id, 'mod', updates);
          button.remove();
          result.textContent = failed.length ? `Обновил ${updated.length}, не вышло: ${failed.map((entry) => entry.title).slice(0, 3).join(', ')}` : `Готово, обновил ${count(updated.length, 'мод', 'мода', 'модов')}. Копии миров сделал заранее.`;
          result.hidden = false;
          sfx('success');
          changed(instance);
        } catch (error) {
          button.disabled = false;
          button.textContent = `Обновить все (${updates.length})`;
          result.textContent = errorMessage(error);
          result.hidden = false;
        }
      };
      return message(`Есть ${count(updates.length, 'обновление', 'обновления', 'обновлений')}:`, list, h('div', { class: 'assistant-card__buttons' }, button), result);
    },
  };

  self.onKey = (event) => {
    if (event.key === 'Escape' && !document.querySelector('.modal-layer')) {
      event.stopPropagation();
      closeAssistant();
    }
  };

  // The list of instances follows renames, new and deleted instances.
  store.subscribe(['instances'], () => {
    if (!element.hidden) fillInstances(self.instanceId);
  });

  return Object.assign(self, { element, input, fillInstances, greet });
}
