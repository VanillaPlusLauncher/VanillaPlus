import { api } from '../services/api.js';
import { morph } from '../core/effects.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { iconUrl } from '../core/mc.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { createSegmented, createToggle, loadingState } from './controls.js';

/*
 * The own server's settings, all of server.properties a player may want, in five parts:
 * "Основное", "Игра", "Мир", "Игроки", "Ещё". Every change saves itself a moment later (no button,
 * no sound, no notice); a running server takes it on its next start, which the window says.
 * Keys the window does not know are listed under "Ещё" → "Все параметры", so nothing is out of reach.
 */

const AUTOSAVE_MS = 600;
const RAM_CHOICES = [1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384];
const bool = (key, label, def, hint = null, extra = {}) => ({ key, label, hint, type: 'bool', def, ...extra });
const number = (key, label, def, min, max, hint = null, extra = {}) => ({ key, label, hint, type: 'number', def, min, max, ...extra });

const PARTS = {
  main: [
    { key: 'motd', label: 'Описание в списке серверов', type: 'text', max: 59, def: '' },
    number('max-players', 'Игроков максимум', '20', 1, 500),
    number('server-port', 'Порт', '25565', 1024, 65535, 'Для игры в одной сети и из интернета менять не нужно.'),
    bool('online-mode', 'Только лицензия', 'true', 'Выключено — заходят и офлайн-аккаунты, и Ely.by.'),
    bool('white-list', 'Белый список', 'false', 'Заходят только игроки из списка на вкладке «Игроки».'),
    bool('enforce-whitelist', 'Выгонять убранных из белого списка', 'false'),
    bool('pvp', 'Игроки могут бить друг друга (PvP)', 'true'),
  ],
  game: [
    { key: 'gamemode', label: 'Режим игры', type: 'select', def: 'survival', options: [['survival', 'Выживание'], ['creative', 'Творческий'], ['adventure', 'Приключение'], ['spectator', 'Наблюдатель']] },
    bool('force-gamemode', 'Всегда этот режим при входе', 'false'),
    { key: 'difficulty', label: 'Сложность', type: 'select', def: 'easy', options: [['peaceful', 'Мирная'], ['easy', 'Лёгкая'], ['normal', 'Нормальная'], ['hard', 'Сложная']] },
    bool('hardcore', 'Хардкор', 'false', 'Одна жизнь: после смерти — только наблюдать.'),
    bool('allow-flight', 'Разрешить полёт', 'false', 'Нужно для модов с полётом и реактивными ранцами, иначе сервер выгоняет за «полёт».'),
    bool('allow-nether', 'Незер', 'true'),
    bool('spawn-monsters', 'Монстры', 'true', null, { optional: true }),
    bool('spawn-animals', 'Животные', 'true', null, { optional: true }),
    bool('spawn-npcs', 'Жители', 'true', null, { optional: true }),
    number('spawn-protection', 'Защита спавна, блоков', '16', 0, 64, 'Вокруг точки появления строят только операторы. 0 — без защиты.'),
    bool('enable-command-block', 'Командные блоки', 'false'),
    number('player-idle-timeout', 'Выгонять бездействующих через, минут', '0', 0, 1440, '0 — никогда.'),
  ],
  world: [
    { key: 'view-distance', label: 'Дальность прорисовки, чанков', type: 'range', def: '10', min: 3, max: 32, hint: 'Больше — дальше видно, но серверу тяжелее.' },
    { key: 'simulation-distance', label: 'Дальность жизни мира, чанков', type: 'range', def: '10', min: 3, max: 32, hint: 'Где растут посевы и ходят мобы.' },
    bool('generate-structures', 'Постройки: деревни, храмы, крепости', 'true', 'Для новых чанков.'),
    number('max-world-size', 'Граница мира, блоков от центра', '29999984', 1, 29999984),
  ],
  more: [
    { key: 'resource-pack', label: 'Ресурспак сервера (ссылка на zip)', type: 'text', max: 400, def: '' },
    bool('require-resource-pack', 'Ресурспак обязателен', 'false'),
    bool('enable-status', 'Показывать сервер в списке серверов', 'true'),
    bool('hide-online-players', 'Скрывать, кто сейчас в игре', 'false'),
    bool('enforce-secure-profile', 'Проверять подпись чата', 'true', 'Выключите, если игроки с офлайн-аккаунтами не могут писать в чат.'),
    number('max-tick-time', 'Сторож зависаний, мс', '60000', -1, 600000, '-1 — выключен: тяжёлые моды при загрузке не уронят сервер.'),
    bool('sync-chunk-writes', 'Надёжная запись мира', 'true', 'Выключите, если сервер подтормаживает при сохранении.'),
    number('network-compression-threshold', 'Сжатие сети, байт', '256', -1, 65536, '-1 — без сжатия (для игры в одной сети).'),
    number('entity-broadcast-range-percentage', 'Дальность видимости мобов, %', '100', 10, 1000),
    { key: 'op-permission-level', label: 'Права операторов', type: 'select', def: '4', options: [['1', '1 — строить на спавне'], ['2', '2 — команды и командные блоки'], ['3', '3 — выгонять и банить'], ['4', '4 — всё, включая остановку']] },
  ],
};
const KNOWN = new Set([...Object.values(PARTS).flat().map((field) => field.key), 'level-name', 'level-seed', 'level-type']);

/** "1.20.1" → [1, 20, 1]; the new numbering ("26.2") counts as newer than every 1.x. */
function versionParts(version) {
  return String(version ?? '')
    .split(/[.\-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function atLeast(version, wanted) {
  const have = versionParts(version);
  const need = versionParts(wanted);
  for (let index = 0; index < need.length; index += 1) {
    if ((have[index] ?? 0) !== need[index]) return (have[index] ?? 0) > need[index];
  }
  return true;
}

/** World types the server's version understands. */
function worldTypes(minecraft) {
  return atLeast(minecraft, '1.19')
    ? [['minecraft:normal', 'Обычный'], ['minecraft:flat', 'Плоский'], ['minecraft:large_biomes', 'Большие биомы'], ['minecraft:amplified', 'Расширенный']]
    : [['default', 'Обычный'], ['flat', 'Плоский'], ['largeBiomes', 'Большие биомы'], ['amplified', 'Расширенный']];
}

/** The instance's picture as a 64×64 PNG for server-icon.png. */
async function instanceIconPng(instance) {
  const url = await iconUrl(instance.icon);
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = 'anonymous';
    element.onload = () => resolve(element);
    element.onerror = reject;
    element.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = !url.startsWith('app://');
  context.drawImage(image, 0, 0, 64, 64);
  return canvas.toDataURL('image/png');
}

/** The server's picture in the friends' lists: the instance's own, set once the server is made. */
export async function setServerIconFromInstance(instance) {
  try {
    await api.server.setIcon(instance.id, await instanceIconPng(instance));
    return true;
  } catch {
    return false;
  }
}

/** Opens the settings of the instance's own server. `onRestart` restarts it (when it runs). */
export function openServerSettings(instance, { onRestart } = {}) {
  const body = h('div', { class: 'server-settings' }, loadingState('Читаем настройки сервера…'));
  let data = null;
  let part = 'main';
  const pending = { properties: {} };
  let timer = 0;
  const note = h('div', { class: 'server-settings__note', hidden: true });

  function flush() {
    clearTimeout(timer);
    timer = 0;
    const changes = { ...pending, properties: { ...pending.properties } };
    pending.properties = {};
    delete pending.ramMb;
    delete pending.javaArgs;
    if (!Object.keys(changes.properties).length && changes.ramMb === undefined && changes.javaArgs === undefined) return Promise.resolve();
    return api.server
      .saveSettings(instance.id, changes)
      .then((next) => {
        data = { ...next, players: data?.players ?? next.players };
        showNote();
      })
      .catch((error) => toast(errorMessage(error), 'error'));
  }

  function change(key, value) {
    pending.properties[key] = String(value);
    if (data) data.properties[key] = String(value);
    clearTimeout(timer);
    timer = setTimeout(flush, AUTOSAVE_MS);
  }

  function changeMeta(key, value) {
    pending[key] = value;
    if (data) data[key] = value;
    clearTimeout(timer);
    timer = setTimeout(flush, AUTOSAVE_MS);
  }

  function showNote() {
    note.hidden = !data?.running;
    if (data?.running) {
      note.replaceChildren(
        h('span', null, 'Сервер запущен: изменения заработают после перезапуска.'),
        onRestart ? h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: async () => { await flush(); onRestart(); modal.close(); } }, 'Перезапустить') : null,
      );
    }
  }

  const value = (field) => data.properties[field.key] ?? field.def;

  function control(field) {
    if (field.type === 'bool') {
      return createToggle({ checked: value(field) === 'true', label: field.label, onChange: (checked) => change(field.key, checked ? 'true' : 'false') });
    }
    if (field.type === 'select') {
      const select = h('select', { class: 'select' }, ...field.options.map(([option, label]) => h('option', { value: option }, label)));
      select.value = field.options.some(([option]) => option === value(field)) ? value(field) : field.def;
      select.addEventListener('change', () => change(field.key, select.value));
      return select;
    }
    if (field.type === 'range') {
      const output = h('b', { class: 'server-settings__range-value' }, value(field));
      const input = h('input', { class: 'range', type: 'range', min: String(field.min), max: String(field.max), step: '1', value: value(field) });
      const paint = () => {
        input.style.setProperty('--range-fill', `${((Number(input.value) - field.min) / (field.max - field.min)) * 100}%`);
        output.textContent = input.value;
      };
      paint();
      input.addEventListener('input', () => {
        paint();
        change(field.key, input.value);
      });
      return h('div', { class: 'server-settings__range' }, input, output);
    }
    const input = h('input', {
      class: 'input',
      type: field.type === 'number' ? 'number' : 'text',
      value: value(field),
      ...(field.type === 'number' ? { min: String(field.min), max: String(field.max) } : { maxlength: String(field.max ?? 200), spellcheck: 'false' }),
    });
    input.addEventListener('input', () => {
      if (field.type === 'number') {
        const number = Number(input.value);
        if (input.value === '' || !Number.isFinite(number) || number < field.min || number > field.max) return;
      }
      change(field.key, input.value.replace(/[\r\n]/g, ' '));
    });
    return input;
  }

  function row(label, hint, element) {
    return h('div', { class: 'server-settings__row' }, h('span', { class: 'server-settings__label' }, h('b', null, label), hint ? h('span', { class: 'text-muted' }, hint) : null), element);
  }

  function fields(list) {
    return list.filter((field) => !field.optional || field.key in data.properties).map((field) => row(field.label, field.hint, control(field)));
  }

  // --- "Мир": the worlds on the server, one from the instance, a new one --------------------------
  function worldPart() {
    const current = data.properties['level-name'] || 'world';
    const stopped = !data.running;
    const list = h(
      'div',
      { class: 'server-worlds' },
      ...(data.worlds.length ? data.worlds : [current]).map((name) =>
        h(
          'div',
          { class: `server-worlds__item${name === current ? ' server-worlds__item--current' : ''}` },
          icon('globe'),
          h('b', { 'data-i18n': 'off' }, name),
          name === current ? h('span', { class: 'badge' }, data.worlds.includes(name) ? 'сейчас' : 'появится при запуске') : null,
          h('span', { class: 'content-toolbar__spacer' }),
          name !== current ? h('button', { class: 'btn btn--ghost btn--compact', type: 'button', disabled: !stopped, onclick: () => { change('level-name', name); flush().then(render); } }, 'Играть в нём') : null,
          data.worlds.includes(name)
            ? h('button', { class: 'icon-button', type: 'button', title: 'Удалить мир', disabled: !stopped, onclick: () => removeWorld(name) }, icon('close'))
            : null,
        ),
      ),
    );
    const saveSelect = h('select', { class: 'select' }, ...data.saves.map((save) => h('option', { value: save }, save)));
    const nameInput = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'Новый мир', spellcheck: 'false' });
    const seedInput = h('input', { class: 'input mono', type: 'text', maxlength: '64', placeholder: 'Сид (необязательно)', spellcheck: 'false' });
    const typeSelect = h('select', { class: 'select' }, ...worldTypes(data.minecraft).map(([type, label]) => h('option', { value: type }, label)));
    return [
      stopped ? null : h('p', { class: 'server-settings__warn' }, 'Чтобы менять миры, остановите сервер.'),
      list,
      h('div', { class: 'server-settings__group' },
        h('b', null, 'Перенести мир из сборки'),
        data.saves.length
          ? h('div', { class: 'path-row' }, saveSelect, h('button', { class: 'btn btn--secondary btn--compact', type: 'button', disabled: !stopped, onclick: () => importWorld(saveSelect.value) }, 'Перенести'))
          : h('span', { class: 'text-muted' }, 'В сборке пока нет миров одиночной игры.'),
      ),
      h('div', { class: 'server-settings__group' },
        h('b', null, 'Новый мир'),
        h('div', { class: 'field-row field-row--3' }, nameInput, seedInput, typeSelect),
        h('button', { class: 'btn btn--secondary btn--compact', type: 'button', disabled: !stopped, onclick: () => newWorld(nameInput.value, seedInput.value, typeSelect.value) }, 'Создать при запуске'),
      ),
      ...fields(PARTS.world),
    ];
  }

  async function importWorld(save) {
    try {
      await flush();
      const name = await api.server.importWorld(instance.id, save);
      toast(`Мир «${name}» перенесён на сервер`, 'success');
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function newWorld(name, seed, type) {
    try {
      await flush();
      const folder = await api.server.newWorld(instance.id, { name, seed, type });
      toast(`Мир «${folder}» создастся при запуске сервера`, 'success');
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function removeWorld(name) {
    if (!(await confirmDialog({ title: `Удалить мир «${name}»?`, message: 'Папка мира попадёт в корзину.', confirmLabel: 'Удалить', danger: true }))) return;
    try {
      await api.server.deleteWorld(instance.id, name);
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  // --- "Игроки": white list, operators, banned --------------------------------------------------
  function playerList(list, title, hint) {
    const input = h('input', { class: 'input', type: 'text', maxlength: '16', placeholder: 'Ник', spellcheck: 'false' });
    const add = async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        data.players = await api.server.player(instance.id, list, 'add', name);
        input.value = '';
        render();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    };
    input.addEventListener('keydown', (event) => event.key === 'Enter' && add());
    const people = data.players[list] ?? [];
    return h(
      'div',
      { class: 'server-settings__group' },
      h('b', null, title),
      h('span', { class: 'text-muted' }, hint),
      h('div', { class: 'path-row' }, input, h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: add }, 'Добавить')),
      people.length
        ? h(
            'div',
            { class: 'server-players' },
            ...people.map((player) =>
              h(
                'span',
                { class: 'chip server-players__chip' },
                h('span', { 'data-i18n': 'off' }, player.name),
                h('button', {
                  class: 'server-players__remove',
                  type: 'button',
                  title: 'Убрать',
                  onclick: async () => {
                    try {
                      data.players = await api.server.player(instance.id, list, 'remove', player.name);
                      render();
                    } catch (error) {
                      toast(errorMessage(error), 'error');
                    }
                  },
                }, '×'),
              ),
            ),
          )
        : h('span', { class: 'text-muted' }, 'Пока никого.'),
    );
  }

  function playersPart() {
    return [
      playerList('whitelist', 'Белый список', data.properties['white-list'] === 'true' ? 'Включён: заходят только эти игроки.' : 'Сейчас выключен (вкладка «Основное»): заходят все.'),
      playerList('ops', 'Операторы', 'Могут пользоваться командами: /gamemode, /tp, /time и другими.'),
      playerList('banned', 'Забаненные', 'Не могут зайти на сервер.'),
    ];
  }

  // --- "Ещё": memory, Java, the picture, everything else --------------------------------------
  function morePart() {
    const ram = h('select', { class: 'select' }, ...RAM_CHOICES.map((mb) => h('option', { value: String(mb) }, `${(mb / 1024).toString().replace('.', ',')} ГБ`)));
    ram.value = RAM_CHOICES.includes(data.ramMb) ? String(data.ramMb) : '4096';
    ram.addEventListener('change', () => changeMeta('ramMb', Number(ram.value)));
    const javaArgs = h('input', { class: 'input mono', type: 'text', value: data.javaArgs, placeholder: '-XX:+UseG1GC', spellcheck: 'false', 'data-i18n': 'off' });
    javaArgs.addEventListener('input', () => changeMeta('javaArgs', javaArgs.value));
    const others = Object.keys(data.properties).filter((key) => !KNOWN.has(key)).sort();
    return [
      row('Память сервера', 'Больше модов — больше памяти: 4 ГБ хватает большинству сборок.', ram),
      row('Аргументы Java', 'Для тех, кто знает, что делает.', javaArgs),
      row('Значок в списке серверов', data.icon ? 'Стоит.' : 'Ещё нет.', h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: async () => { if (await setServerIconFromInstance(instance)) { data.icon = true; toast('Значок как у сборки', 'success'); render(); } else toast('Не получилось сделать значок', 'error'); } }, 'Как у сборки')),
      ...fields(PARTS.more),
      others.length
        ? h(
            'details',
            { class: 'server-settings__all' },
            h('summary', null, `Все параметры (${others.length})`),
            ...others.map((key) => row(key, null, control({ key, type: 'text', def: '', max: 500 }))),
          )
        : null,
    ];
  }

  const tabs = createSegmented({
    options: [
      { value: 'main', label: 'Основное' },
      { value: 'game', label: 'Игра' },
      { value: 'world', label: 'Мир' },
      { value: 'players', label: 'Игроки' },
      { value: 'more', label: 'Ещё' },
    ],
    value: part,
    onChange: (next) => {
      part = next;
      morph(() => render(), { panel: body.closest('.modal') });
    },
  });

  function render() {
    if (!data) return;
    let content;
    if (part === 'world') content = worldPart();
    else if (part === 'players') content = playersPart();
    else if (part === 'more') content = morePart();
    else content = fields(PARTS[part]);
    body.replaceChildren(note, h('div', { class: 'server-settings__part' }, ...content.filter(Boolean)));
    showNote();
  }

  async function reload() {
    try {
      data = await api.server.settings(instance.id);
      render();
    } catch (error) {
      body.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  const modal = openModal({
    title: `Настройки сервера «${instance.name}»`,
    size: 'xl',
    content: h('div', { class: 'server-settings__wrap' }, h('div', { class: 'server-settings__tabs' }, tabs.element), body),
    footer: [h('span', { class: 'text-muted server-settings__saved' }, 'Изменения сохраняются сами'), h('span', { class: 'content-toolbar__spacer' }), h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => modal.close() }, 'Готово')],
    onClose: () => flush(),
  });
  reload();
  return modal;
}
