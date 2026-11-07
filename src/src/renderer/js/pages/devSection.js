import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { copyText } from '../core/clipboard.js';
import { locale } from '../core/i18n.js';
import { store } from '../state/appStore.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/modal.js';

/*
 * Settings → «Разработчик»: developer mode for people who make mods and test them in the launcher,
 * also with AI tools (main/dev). Off by default; while it is off only the switch is shown.
 */

/** What each AI action is called in «Что делал ИИ» (tools of main/dev/devTools.js that change something). */
const ACTIONS = {
  create_test_instance: 'Создать тестовую сборку',
  add_mods: 'Добавить моды',
  remove_mod: 'Убрать мод',
  launch_instance: 'Запустить игру',
  stop_game: 'Закрыть игру',
  delete_instance: 'Удалить сборку',
  write_instance_file: 'Изменить файл',
};
const OUTCOMES = { ok: 'готово', error: 'ошибка', denied: 'не разрешено' };
/** Folders of an instance with one click: [folder, label]. */
const FOLDERS = [['', 'Папка сборки'], ['mods', 'mods'], ['config', 'config'], ['logs', 'logs'], ['crash-reports', 'crash-reports'], ['saves', 'saves']];

let status = null;
let folderInstance = null;
/** Parts of the section on screen that follow the AI access and the instances. */
const views = new Set();

function refreshViews() {
  for (const view of [...views]) {
    if (view.element.isConnected) view.paint();
    else views.delete(view);
  }
}

api.events.onDevStatus((next) => {
  status = next;
  refreshViews();
});
store.subscribe(['instances'], refreshViews);

function follow(element, paint) {
  views.add({ element, paint });
  paint();
  return element;
}

const claudeCommand = (current) => `claude mcp add --scope user --transport http amethyx ${current.url} --header "Authorization: Bearer ${current.key}"`;
const jsonConfig = (current) => JSON.stringify({ mcpServers: { amethyx: { type: 'http', url: current.url, headers: { Authorization: `Bearer ${current.key}` } } } }, null, 2);

/** The section's cards. helpers: { card, row, toggle, save } of the settings page. */
export function devSection(settings, { card, row, toggle, save }) {
  const dev = settings.dev ?? {};
  api.dev.status().then((next) => {
    status = next;
    refreshViews();
  }).catch(() => {});

  const intro = card('Режим разработчика', 'Для тех, кто делает моды и проверяет их в этом лаунчере, в том числе с помощью ИИ (Claude Code и подобных). Для обычной игры он не нужен.',
    // Turned off, it also closes the AI's access: turning it on again does not reopen it by itself.
    row('Режим разработчика', 'Открывает функции ниже. Пока вы их не включите, ничего не меняется.', toggle(dev.enabled === true, (value) => save({ dev: value ? { enabled: true } : { enabled: false, api: false } }), 'Режим разработчика')));
  if (!dev.enabled) {
    return [intro];
  }
  return [intro, aiCard(dev, { card, row, toggle, save }), journalCard(card), launchCard(dev, { card, row, toggle, save }), foldersCard(settings, card), testsCard(card)];
}

function aiCard(dev, { card, row, toggle, save }) {
  const state = h('div', { class: 'settings-card__desc' });
  const apiLine = h('div', { class: 'settings-card__desc' });
  const copyCommand = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => copyText(claudeCommand(status), 'Команда скопирована') }, 'Скопировать команду для Claude Code');
  const copyJson = h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => copyText(jsonConfig(status), 'Настройка скопирована') }, 'Скопировать настройку JSON');
  const renew = h('button', {
    class: 'btn btn--ghost btn--compact',
    type: 'button',
    onclick: async () => {
      const confirmed = await confirmDialog({ title: 'Заменить ключ?', message: 'Старый ключ сразу перестанет работать: в Claude Code и других программах настройку нужно будет добавить заново.', confirmLabel: 'Заменить' });
      if (!confirmed) return;
      try {
        status = await api.dev.newKey();
        refreshViews();
        toast('Ключ заменён', 'success', 2200);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  }, 'Новый ключ');
  const paint = () => {
    const running = Boolean(dev.api && status?.running);
    state.replaceChildren(
      !dev.api ? 'Выключено.'
        : running ? h('span', null, h('span', { class: 'text-accent' }, 'Работает: '), h('span', { class: 'mono' }, status.url))
          : status?.error ? `Не включился: ${status.error}` : 'Включается…',
    );
    apiLine.replaceChildren(...(running ? [h('span', null, 'Тот же доступ для своих скриптов: '), h('span', { class: 'mono' }, status.apiUrl)] : []));
    copyCommand.disabled = !running;
    copyJson.disabled = !running;
    renew.disabled = !status?.key;
  };
  return follow(
    card('Доступ для ИИ (MCP)', 'ИИ на этом компьютере сможет создавать тестовые сборки, запускать их, читать журнал игры и закрывать её. Сборки игрока он не удалит и не изменит, пока вы не нажмёте «Разрешить» в окне лаунчера.',
      row('Разрешить ИИ управлять лаунчером', 'Только с этого компьютера и только с ключом, который есть в команде ниже.', toggle(dev.api === true, (value) => save({ dev: { api: value } }), 'Доступ для ИИ')),
      state,
      h('div', { class: 'settings-row', style: { justifyContent: 'flex-start', flexWrap: 'wrap', gap: '10px' } }, copyCommand, copyJson, renew),
      h('div', { class: 'settings-card__desc' }, 'Команду вставьте в терминал и перезапустите Claude Code. Настройка JSON — для Cursor и других программ с MCP. Ключ хранится только на этом компьютере, никому его не отправляйте.'),
      apiLine,
    ),
    paint,
  );
}

function journalCard(card) {
  const list = h('div', { class: 'dev-journal', style: { display: 'grid', gap: '6px' } });
  const entryRow = (entry) => {
    const time = new Date(entry.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return h('div', { class: 'settings-row', style: { justifyContent: 'flex-start', gap: '10px', flexWrap: 'wrap' }, title: entry.detail ?? '' },
      h('span', { class: 'mono text-muted' }, time),
      h('span', null, ACTIONS[entry.tool] ?? entry.tool),
      entry.subject ? h('b', { 'data-i18n': 'off' }, entry.subject) : null,
      h('span', { class: entry.outcome === 'ok' ? 'text-accent' : 'text-muted' }, OUTCOMES[entry.outcome] ?? entry.outcome),
    );
  };
  const paint = () => {
    const entries = status?.journal ?? [];
    list.replaceChildren(...(entries.length ? entries.slice(0, 20).map(entryRow) : [h('span', { class: 'text-muted' }, 'Пока ничего.')]));
  };
  return follow(card('Что делал ИИ', 'Последние действия через доступ для ИИ: что он менял и запускал. Наведите на строку, чтобы увидеть подробности ошибки.', list), paint);
}

function launchCard(dev, { card, row, toggle, save }) {
  const flag = (key, title, description) => row(title, description, toggle(dev[key] === true, (value) => save({ dev: { [key]: value } }), title));
  return card('Запуск игры', 'Действует на все сборки, пока включён режим разработчика. Меняется со следующего запуска.',
    flag('verboseLogs', 'Подробный журнал игры', 'Сообщения уровня отладки от игры, Fabric, Forge и NeoForge. Журнал станет намного длиннее.'),
    flag('javaDebug', 'Отладчик Java', 'Игра ждёт отладчик на 127.0.0.1:5005 (в IntelliJ IDEA: Remote JVM Debug). Игра запускается сразу, не дожидаясь его.'),
    flag('mixinExport', 'Mixin: сохранять изменённые классы', 'Mixin записывает изменённые классы в папку .mixin.out сборки.'),
    flag('cheats', 'Команды в любом мире', 'Перед запуском включает читы во всех мирах сборки, после выхода из игры возвращает как было.'),
  );
}

function foldersCard(settings, card) {
  const select = h('select', { class: 'select', 'aria-label': 'Сборка', onchange: () => { folderInstance = select.value; } });
  const instances = [...(store.get().instances ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const wanted = instances.some((instance) => instance.id === folderInstance) ? folderInstance : settings.selectedInstanceId;
  select.append(...instances.map((instance) => h('option', { value: instance.id, selected: instance.id === wanted, 'data-raw': '' }, `${instance.name} · ${instance.minecraft}`)));
  const open = (folder) => api.dev.openFolder(select.value || null, folder).catch((error) => toast(errorMessage(error), 'error'));
  return card('Папки и журналы', 'Папки сборки одним нажатием. Если папки ещё нет, она появится.',
    instances.length ? select : h('span', { class: 'text-muted' }, 'Сборок пока нет.'),
    instances.length ? h('div', { class: 'toolbar__chips' }, FOLDERS.map(([folder, label]) => h('button', { class: 'chip', type: 'button', onclick: () => open(folder) }, icon('folder'), label))) : null,
    h('div', { class: 'settings-row', style: { justifyContent: 'flex-start' } },
      h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => api.dev.openFolder(null, 'launcher-log').catch((error) => toast(errorMessage(error), 'error')) }, icon('folder'), 'Журнал лаунчера')),
  );
}

function testsCard(card) {
  const count = h('span', { class: 'text-soft' });
  const remove = h('button', {
    class: 'btn btn--secondary btn--compact btn--danger',
    type: 'button',
    onclick: async () => {
      const confirmed = await confirmDialog({ title: 'Удалить все тестовые сборки?', message: 'Удалятся сборки, которые создал ИИ, вместе с их мирами и модами. Ваши сборки останутся.', confirmLabel: 'Удалить', danger: true });
      if (!confirmed) return;
      try {
        const { removed } = await api.dev.removeTests();
        toast(`Удалено тестовых сборок: ${removed}`, 'success');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  }, 'Удалить все тестовые');
  const paint = () => {
    const tests = (store.get().instances ?? []).filter((instance) => instance.test).length;
    count.textContent = `Сейчас тестовых сборок: ${tests}`;
    remove.disabled = tests === 0;
  };
  return follow(
    card('Тестовые сборки', 'Сборки, которые создал ИИ. Они лежат в своей группе, и ИИ может менять и удалять их без вопроса. Копия тестовой сборки — уже ваша обычная.',
      h('div', { class: 'settings-row' }, count, remove)),
    paint,
  );
}
