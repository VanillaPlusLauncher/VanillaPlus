import { api } from '../services/api.js';
import { h } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { LOADER_LABELS } from '../core/content.js';
import { refreshInstances } from '../state/actions.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';

/**
 * "Из других лаунчеров": the launcher looks for Prism, ElyPrism, PolyMC, MultiMC, Modrinth App,
 * CurseForge, ATLauncher, GDLauncher, Millida, TLauncher, SKLauncher, Legacy Launcher and the
 * official launcher, lists their instances, and moves the chosen ones in (a copy: the other
 * launcher keeps its own).
 */
export function openLauncherImportDialog() {
  const selected = new Map();
  const host = h('div', { class: 'launcher-import' }, h('p', { class: 'text-muted' }, 'Ищем другие лаунчеры…'));
  const worlds = h('input', { type: 'checkbox', checked: true });
  const screenshots = h('input', { type: 'checkbox', checked: true });
  const moveButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: true, onclick: () => move() }, 'Перенести');

  function updateButton() {
    moveButton.disabled = selected.size === 0;
    moveButton.textContent = selected.size ? `Перенести (${selected.size})` : 'Перенести';
  }

  function contents(instance) {
    const parts = [];
    if (instance.mods) parts.push(`модов: ${instance.mods}`);
    if (instance.worlds) parts.push(`миров: ${instance.worlds}`);
    if (instance.shaderpacks) parts.push(`шейдеров: ${instance.shaderpacks}`);
    return parts.join(' · ');
  }

  function row(launcher, instance) {
    const id = `${launcher.id}|${instance.key}`;
    const check = h('input', { type: 'checkbox', tabindex: '-1' });
    const loader = instance.loader.type === 'vanilla' ? 'Vanilla' : `${LOADER_LABELS[instance.loader.type] ?? instance.loader.type}${instance.loader.version ? ` ${instance.loader.version.replace(`${instance.minecraft}-`, '')}` : ''}`;
    const item = h(
      'button',
      {
        class: 'launcher-import__item',
        type: 'button',
        onclick: () => {
          if (selected.has(id)) selected.delete(id);
          else selected.set(id, { launcher, instance });
          check.checked = selected.has(id);
          item.classList.toggle('launcher-import__item--on', check.checked);
          updateButton();
        },
      },
      check,
      h('span', { class: 'launcher-import__text' }, h('b', { 'data-i18n': 'off' }, instance.name), h('span', { class: 'text-muted' }, `Minecraft ${instance.minecraft} · ${loader}`)),
      h('span', { class: 'launcher-import__count text-muted' }, contents(instance)),
    );
    return item;
  }

  async function load() {
    try {
      const launchers = await api.content.scanLaunchers();
      if (!launchers.length) {
        host.replaceChildren(h('p', { class: 'text-soft' }, 'Других лаунчеров со сборками не нашлось. Лаунчер ищет Prism Launcher, ElyPrismLauncher, PolyMC, MultiMC, Modrinth App, CurseForge, ATLauncher, GDLauncher, Millida, TLauncher, SKLauncher, Legacy Launcher и официальный лаунчер Minecraft.'));
        return;
      }
      host.replaceChildren(
        ...launchers.map((launcher) =>
          h(
            'section',
            { class: 'launcher-import__group' },
            h('div', { class: 'launcher-import__head' }, h('b', null, launcher.name), h('span', { class: 'text-muted', 'data-i18n': 'off' }, launcher.root)),
            h('div', { class: 'launcher-import__list' }, ...launcher.instances.map((instance) => row(launcher, instance))),
          ),
        ),
      );
    } catch (error) {
      host.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  async function move() {
    const jobs = [...selected.values()];
    modal.close();
    let done = 0;
    for (const { launcher, instance } of jobs) {
      try {
        toast(`Переносим «${instance.name}» из ${launcher.name}…`, 'info', 2500);
        const result = await api.content.importFromLauncher({ launcherId: launcher.id, key: instance.key, worlds: worlds.checked, screenshots: screenshots.checked });
        done += 1;
        toast(`«${result.instance.name}» перенесена${result.recognised ? `, распознано модов: ${result.recognised}` : ''}`, 'success', 5000);
      } catch (error) {
        toast(`«${instance.name}»: ${errorMessage(error)}`, 'error', 7000);
      }
    }
    await refreshInstances().catch(() => {});
    if (jobs.length > 1) toast(`Перенесено сборок: ${done} из ${jobs.length}`, done === jobs.length ? 'success' : 'info', 5000);
  }

  const modal = openModal({
    title: 'Перенос из других лаунчеров',
    wide: true,
    content: h(
      'div',
      { class: 'modal__section' },
      h('p', { class: 'text-soft' }, 'Выберите сборки: Vanilla+ создаст такие же (версия игры и загрузчик) и скопирует моды, настройки, ресурспаки и шейдеры. В другом лаунчере всё останется как было.'),
      h('div', { class: 'share-options' }, h('label', { class: 'compat-dialog__remember' }, worlds, h('span', null, 'Миры')), h('label', { class: 'compat-dialog__remember' }, screenshots, h('span', null, 'Скриншоты'))),
      host,
    ),
    footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), moveButton],
  });
  load();
  return modal;
}
