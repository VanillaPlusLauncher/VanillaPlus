import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { LOADER_LABELS } from '../core/content.js';
import { refreshInstances } from '../state/actions.js';
import { openInstance } from '../core/nav.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { createSegmented } from './controls.js';

const FORMATS = [
  { value: 'modrinth', logo: 'modrinth', title: 'Modrinth (.mrpack)', text: 'Для Modrinth App, Prism Launcher и Amethyx. Моды с Modrinth — ссылками, остальные внутри.' },
  { value: 'curseforge', logo: 'curseforge', title: 'CurseForge (.zip)', text: 'Для приложения CurseForge. Моды с CurseForge — ссылками, остальные внутри.' },
  { value: 'zip', logo: null, title: 'Обычный .zip', text: 'Вся папка сборки целиком: открывают Prism Launcher, MultiMC и Amethyx.' },
];

/** "Экспортировать": a share code to paste into Amethyx, or a file in one of three formats. */
export function openShareDialog(instance) {
  const codeArea = h('textarea', { class: 'textarea mono share-code', rows: '5', readonly: true, placeholder: 'Готовим код…' });
  const codeInfo = h('div', { class: 'text-muted share-info' });
  const copyButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: true, onclick: () => copyCode() }, 'Копировать код');
  // Straight into a friend's chat: the friend gets "Собрать и играть".
  const sendButton = h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => sendToFriend() }, 'Отправить другу');
  const configs = h('input', { type: 'checkbox', checked: true });
  const worlds = h('input', { type: 'checkbox', checked: true });
  const screenshots = h('input', { type: 'checkbox' });
  const saveButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => saveFile() }, 'Сохранить');
  let format = 'modrinth';

  const codePanel = h(
    'div',
    { class: 'share-panel' },
    h('p', { class: 'text-soft' }, 'Друг вставляет код в Amethyx («Сборки» → «Вставить код») и получает ту же сборку: версию игры, загрузчик и те же версии модов, ресурспаков и шейдеров.'),
    codeArea,
    codeInfo,
    h('div', { class: 'share-actions' }, sendButton, copyButton),
  );

  async function sendToFriend() {
    let friends = [];
    try {
      const status = await api.friends.status();
      if (!status.available || !status.enabled) {
        toast('Друзья работают через сервер Amethyx: включите их в настройках.', 'info');
        return;
      }
      friends = (await api.friends.list()).friends;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    if (!friends.length) {
      toast('Пока нет друзей: добавьте их на вкладке «Друзья».', 'info');
      return;
    }
    const picker = openModal({
      title: 'Отправить другу',
      content: h(
        'div',
        { class: 'share-friends' },
        ...friends.map((friend) =>
          h(
            'button',
            {
              class: 'share-friends__item',
              type: 'button',
              onclick: async () => {
                picker.close();
                try {
                  await api.friends.sendInvite(friend.id, { instanceId: instance.id, withPack: true });
                  toast(`Сборка отправлена: ${friend.name}`, 'success');
                } catch (error) {
                  toast(errorMessage(error), 'error');
                }
              },
            },
            h('b', { 'data-i18n': 'off' }, friend.name),
            h('span', { class: 'text-muted' }, friend.online ? 'В сети' : 'Не в сети'),
          ),
        ),
      ),
    });
  }
  const formatCards = FORMATS.map((entry) =>
    h(
      'button',
      { class: 'share-format', type: 'button', 'data-format': entry.value, onclick: () => pickFormat(entry.value) },
      entry.logo ? h('span', { class: `platform-logo platform-logo--${entry.logo}` }) : icon('folder'),
      h('span', { class: 'share-format__text' }, h('b', null, entry.title), h('span', { class: 'text-muted' }, entry.text)),
    ),
  );
  const zipOnly = [h('label', { class: 'compat-dialog__remember' }, worlds, h('span', null, 'Миры')), h('label', { class: 'compat-dialog__remember' }, screenshots, h('span', null, 'Скриншоты'))];
  const filePanel = h(
    'div',
    { class: 'share-panel', hidden: true },
    h('div', { class: 'share-formats' }, ...formatCards),
    h('div', { class: 'share-options' }, h('label', { class: 'compat-dialog__remember' }, configs, h('span', null, 'Настройки модов (config)')), ...zipOnly),
    h('div', { class: 'share-actions' }, saveButton),
  );

  function pickFormat(value) {
    format = value;
    formatCards.forEach((card) => card.classList.toggle('share-format--active', card.dataset.format === value));
    zipOnly.forEach((label) => {
      label.hidden = value !== 'zip';
    });
  }
  pickFormat('modrinth');

  const mode = createSegmented({
    options: [
      { value: 'code', label: 'Код' },
      { value: 'file', label: 'Файл' },
    ],
    value: 'code',
    onChange: (value) => {
      codePanel.hidden = value !== 'code';
      filePanel.hidden = value !== 'file';
    },
  });

  async function makeCode() {
    try {
      const result = await api.share.makeCode(instance.id);
      codeArea.value = result.code;
      copyButton.disabled = false;
      codeInfo.textContent = result.skipped.length
        ? `В коде: ${result.included}. Не попали (добавлены вручную, не с Modrinth или CurseForge): ${result.skipped.join(', ')} — их можно передать файлом .mrpack.`
        : `В код попало всё — ${result.included} шт.`;
    } catch (error) {
      codeInfo.textContent = errorMessage(error);
    }
  }

  async function copyCode() {
    await navigator.clipboard.writeText(codeArea.value);
    toast('Код сборки скопирован', 'success');
  }

  async function saveFile() {
    saveButton.disabled = true;
    saveButton.textContent = 'Сохраняем…';
    try {
      const result = await api.share.exportPack(instance.id, { format, includeConfigs: configs.checked, includeWorlds: worlds.checked, includeScreenshots: screenshots.checked });
      if (result) {
        toast(`Сборка сохранена: ${result.path}`, 'success', 6000);
        modal.close();
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Сохранить';
    }
  }

  const modal = openModal({ title: `Экспорт «${instance.name}»`, wide: true, content: h('div', { class: 'share-dialog' }, mode.element, codePanel, filePanel) });
  requestAnimationFrame(() => mode.setValue('code'));
  makeCode();
  return modal;
}

/** "Вставить код": shows what a share code contains, then builds the instance. */
export function openImportCodeDialog() {
  const area = h('textarea', { class: 'textarea mono share-code', rows: '5', placeholder: 'Вставьте код сборки (VP1-…)' });
  const preview = h('div', { class: 'share-preview text-muted' }, 'Код начинается с VP1-.');
  const nameInput = h('input', { class: 'input', type: 'text', maxlength: '64', placeholder: 'Название сборки' });
  const createButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: true, onclick: () => create() }, 'Создать сборку');
  let parsed = null;

  async function check() {
    parsed = null;
    createButton.disabled = true;
    const code = area.value.trim();
    if (!code) {
      preview.textContent = 'Код начинается с VP1-.';
      return;
    }
    try {
      parsed = await api.share.parseCode(code);
      const counts = { mod: 0, resourcepack: 0, shader: 0 };
      parsed.content.forEach((entry) => {
        counts[entry.type] += 1;
      });
      preview.replaceChildren(
        h('b', null, parsed.name),
        ` — ${`Minecraft ${parsed.minecraft}, ${LOADER_LABELS[parsed.loader.type] ?? parsed.loader.type}${parsed.loader.version ? ` ${parsed.loader.version}` : ''}`}. Модов: ${counts.mod}, ресурспаков: ${counts.resourcepack}, шейдеров: ${counts.shader}.`,
      );
      nameInput.placeholder = parsed.name;
      createButton.disabled = false;
    } catch (error) {
      preview.textContent = errorMessage(error);
    }
  }

  async function create() {
    createButton.disabled = true;
    createButton.textContent = 'Собираем…';
    try {
      const { instance, failed } = await api.share.importCode(area.value.trim(), { name: nameInput.value.trim() || undefined });
      await refreshInstances();
      modal.close();
      toast(failed.length ? `Сборка «${instance.name}» готова, не удалось поставить: ${failed.length}` : `Сборка «${instance.name}» готова`, failed.length ? 'info' : 'success', 6000);
      openInstance(instance.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
      createButton.disabled = false;
      createButton.textContent = 'Создать сборку';
    }
  }

  area.addEventListener('input', () => check());
  const modal = openModal({
    title: 'Сборка по коду',
    wide: true,
    content: h('div', { class: 'share-dialog' }, area, preview, h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Название'), nameInput)),
    footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), createButton],
  });
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text.trim().startsWith('VP1-') && !area.value) {
        area.value = text.trim();
        check();
      }
    })
    .catch(() => {});
  return modal;
}
