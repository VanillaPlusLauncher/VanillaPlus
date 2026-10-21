import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage, formatReleaseDate } from '../core/format.js';
import { LOADER_LABELS, formatBytes } from '../core/content.js';
import { refreshInstances } from '../state/actions.js';
import { openInstance } from '../core/nav.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { createSegmented } from './controls.js';
import { createFileTree } from './fileTree.js';

const FORMATS = [
  { value: 'modrinth', logo: 'modrinth', title: 'Modrinth (.mrpack)', text: 'Для Modrinth App, Prism Launcher и Amethyx. Моды с Modrinth — ссылками, остальные внутри.' },
  { value: 'curseforge', logo: 'curseforge', title: 'CurseForge (.zip)', text: 'Для приложения CurseForge. Моды с CurseForge — ссылками, остальные внутри.' },
  { value: 'zip', logo: null, title: 'Обычный .zip', text: 'Папка сборки как есть: открывают Prism Launcher, MultiMC и Amethyx.' },
];

/** What a modpack usually carries: its mods, packs, shaders and their settings. */
const PACK_FOLDERS = new Set(['mods', 'resourcepacks', 'shaderpacks', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'global_packs', 'openloader', 'paxi']);
/** Never worth sending in a plain .zip: caches, logs, crash reports, screenshots. */
const ZIP_LEFT_OUT = new Set(['logs', 'crash-reports', 'screenshots', 'cache', 'debug', 'downloads', 'backup', 'backups']);
const tickedFor = (format) => (entry) => (format === 'zip' ? !entry.name.startsWith('.') && !ZIP_LEFT_OUT.has(entry.name) : PACK_FOLDERS.has(entry.name));

/** "Экспортировать": a share code to paste into Amethyx, or a file in one of three formats. */
export function openShareDialog(instance) {
  const codeArea = h('textarea', { class: 'textarea mono share-code', rows: '5', readonly: true, placeholder: 'Готовим код…' });
  const codeInfo = h('div', { class: 'text-muted share-info' });
  const copyButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: true, onclick: () => copyCode() }, 'Копировать код');
  // Straight into a friend's chat: the friend gets "Собрать и играть".
  const sendButton = h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => sendToFriend() }, 'Отправить другу');
  const saveButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => saveFile() }, icon('export'), 'Сохранить');
  // Files added by hand go along only when the player ticks this: to the Amethyx server for 14 days.
  const uploadCheck = h('input', { type: 'checkbox', onchange: () => toggleUpload() });
  const uploadText = h('span', null);
  const uploadBox = h('label', { class: 'share-upload', hidden: true }, uploadCheck, uploadText);
  // The code without the author's files, to go back to when the tick is taken off.
  let plainCode = null;
  let format = 'modrinth';
  // Which files and folders go into the file, like Prism Launcher's export.
  const tree = createFileTree({
    load: (relative) => api.share.listFiles(instance.id, relative),
    sizes: (paths) => api.share.folderSizes(instance.id, paths),
    ticked: tickedFor(format),
  });

  const codePanel = h(
    'div',
    { class: 'share-panel' },
    h('p', { class: 'text-soft' }, 'Друг вставляет код в Amethyx («Сборки» → «Вставить код») и получает ту же сборку: версию игры, загрузчик и те же версии модов, ресурспаков и шейдеров.'),
    codeArea,
    codeInfo,
    uploadBox,
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
                  await api.friends.sendInvite(friend.id, { instanceId: instance.id, withPack: true, code: codeArea.value });
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
  const filePanel = h(
    'div',
    { class: 'share-panel', hidden: true },
    h('div', { class: 'share-formats' }, ...formatCards),
    h('div', { class: 'share-tree-head' }, h('span', null, 'Что положить в файл'), h('span', { class: 'text-muted' }, 'Папка с галочкой — целиком; откройте её, чтобы выбрать отдельные файлы.')),
    tree.element,
    h('div', { class: 'share-actions' }, saveButton),
  );

  function pickFormat(value) {
    const changed = value !== format;
    format = value;
    formatCards.forEach((card) => card.classList.toggle('share-format--active', card.dataset.format === value));
    if (changed) tree.retick(tickedFor(value));
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

  function showCode(result) {
    codeArea.value = result.code;
    copyButton.disabled = false;
    if (result.uploaded) {
      const until = formatReleaseDate(new Date(result.uploaded.expiresAt).toISOString());
      // Two sentences in their own text nodes: each is translated by itself.
      codeInfo.replaceChildren(
        h('span', null, `В коде: ${result.included} с Modrinth и CurseForge и ${result.uploaded.count} с сервера Amethyx (${formatBytes(result.uploaded.bytes)}, хранятся до ${until}).`),
        ...(result.skipped.length ? [' ', h('span', null, `Не поместились (больше 64 МБ): ${result.skipped.join(', ')} — их можно передать файлом .mrpack.`)] : []),
      );
    } else {
      codeInfo.textContent = result.skipped.length
        ? `В коде: ${result.included}. Не попали (добавлены вручную, не с Modrinth или CurseForge): ${result.skipped.join(', ')} — их можно передать файлом .mrpack.`
        : `В код попало всё — ${result.included} шт.`;
    }
  }

  async function makeCode() {
    try {
      plainCode = await api.share.makeCode(instance.id);
      showCode(plainCode);
      if (plainCode.extra.count) {
        uploadText.textContent = `Загрузить на сервер Amethyx то, чего нет на Modrinth и CurseForge (${plainCode.extra.count} шт., ${formatBytes(plainCode.extra.bytes)}), чтобы друг получил это вместе с кодом. Через 14 дней файлы удалятся с сервера.`;
        uploadBox.hidden = false;
      }
    } catch (error) {
      codeInfo.textContent = errorMessage(error);
    }
  }

  async function toggleUpload() {
    const upload = uploadCheck.checked;
    for (const control of [uploadCheck, copyButton, sendButton]) control.disabled = true;
    if (upload) codeInfo.textContent = 'Загружаем файлы на сервер Amethyx…';
    try {
      showCode(upload ? await api.share.makeCode(instance.id, { upload: true }) : plainCode);
    } catch (error) {
      uploadCheck.checked = false;
      showCode(plainCode);
      toast(errorMessage(error), 'error', 8000);
    } finally {
      for (const control of [uploadCheck, copyButton, sendButton]) control.disabled = false;
    }
  }

  async function copyCode() {
    await navigator.clipboard.writeText(codeArea.value);
    toast('Код сборки скопирован', 'success');
  }

  async function saveFile() {
    const paths = tree.selectedPaths();
    if (!paths.length) {
      toast('Ничего не отмечено', 'info');
      return;
    }
    saveButton.disabled = true;
    saveButton.lastChild.textContent = 'Сохраняем…';
    try {
      const result = await api.share.exportPack(instance.id, { format, paths });
      if (result) {
        toast(`Сборка сохранена: ${result.path}`, 'success', 6000);
        modal.close();
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      saveButton.disabled = false;
      saveButton.lastChild.textContent = 'Сохранить';
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
  // The author's files from the server (mods added by hand): they come unless this is unticked.
  const filesCheck = h('input', { type: 'checkbox', checked: true });
  const filesText = h('span', null);
  const filesBox = h('label', { class: 'share-upload', hidden: true }, filesCheck, filesText);
  let parsed = null;

  async function check() {
    parsed = null;
    createButton.disabled = true;
    filesBox.hidden = true;
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
      if (parsed.files && parsed.files.expiresAt && parsed.files.expiresAt < Date.now()) {
        preview.append(h('br'), h('span', null, 'Файлы автора уже удалены с сервера (они хранятся 14 дней): сборка соберётся без них.'));
      } else if (parsed.files) {
        filesText.textContent = `Скачать файлы автора с сервера Amethyx: ${parsed.files.count} шт., ${formatBytes(parsed.files.bytes)}. Их нет на Modrinth и CurseForge — ставьте, если доверяете тому, кто прислал код.`;
        filesBox.hidden = false;
      }
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
      const { instance, failed, filesError } = await api.share.importCode(area.value.trim(), { name: nameInput.value.trim() || undefined, withFiles: !filesBox.hidden && filesCheck.checked });
      await refreshInstances();
      modal.close();
      toast(failed.length ? `Сборка «${instance.name}» готова, не удалось поставить: ${failed.length}` : `Сборка «${instance.name}» готова`, failed.length ? 'info' : 'success', 6000);
      if (filesError) toast(`Файлы автора не скачались: ${filesError}`, 'info', 8000);
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
    content: h('div', { class: 'share-dialog' }, area, preview, filesBox, h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Название'), nameInput)),
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
