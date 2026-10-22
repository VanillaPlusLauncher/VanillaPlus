import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { assetUrl } from '../core/assets.js';
import { errorMessage } from '../core/format.js';
import { pixelBurst } from '../core/effects.js';
import { sfx } from '../core/sound.js';
import { refreshInstances } from '../state/actions.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { createSegmented, createToggle, loadingState } from './controls.js';

const TIER_LABELS = { low: 'слабый', mid: 'средний', high: 'мощный' };
const LEVELS = [
  { value: 'speed', label: 'Скорость' },
  { value: 'balance', label: 'Баланс' },
  { value: 'beauty', label: 'Красота' },
];
const weightLabel = (weight) => (weight <= 1.5 ? 'лёгкий' : weight <= 3 ? 'средний' : 'тяжёлый');
const weightClass = (weight) => (weight <= 1.5 ? 'light' : weight <= 3 ? 'mid' : 'heavy');

/**
 * "Шейдеры": switched on and set up for this computer. Auto picks the heaviest pack the computer
 * carries at the chosen level (and one that works with Distant Horizons when it is in the pack);
 * "Сам выберу" lists the known packs and the ones already there. The shader loader (Iris or
 * Oculus) and the pack are installed on "Применить" (content/shaderService.js). `onDone` refreshes
 * the list behind.
 */
export function openShaderDialog(instance, onDone) {
  const body = h('div', { class: 'shaders' }, loadingState('Смотрим на компьютер и моды…'));
  const applyButton = h('button', { class: 'btn btn--primary', type: 'button', disabled: true, onclick: () => apply() }, icon('bolt'), 'Применить');
  const cancelButton = h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена');
  let plan = null;
  const choice = { enabled: true, auto: true, level: 'balance', pack: null };

  function packCard(pack, { selectable = true } = {}) {
    const id = pack.projectId ?? `file:${pack.file}`;
    const recommended = plan.recommended[choice.level] === pack.projectId;
    const disabled = selectable && pack.available === false;
    return h(
      'button',
      {
        class: `shader-card${choice.pack === id && selectable ? ' shader-card--chosen' : ''}${disabled ? ' shader-card--off' : ''}`,
        type: 'button',
        disabled: disabled || !selectable,
        onclick: () => {
          choice.pack = id;
          render();
        },
      },
      pack.iconUrl ? h('img', { class: 'shader-card__icon', src: pack.iconUrl, alt: '', loading: 'lazy' }) : h('img', { class: 'shader-card__icon shader-card__icon--empty', src: assetUrl('branding/amethyx-mark.png'), alt: '' }),
      h(
        'span',
        { class: 'shader-card__text' },
        h('b', { 'data-i18n': 'off' }, pack.title),
        h('span', { class: 'shader-card__tags' },
          pack.weight ? h('span', { class: `shader-tag shader-tag--${weightClass(pack.weight)}` }, weightLabel(pack.weight)) : h('span', { class: 'shader-tag' }, 'уже в сборке'),
          recommended ? h('span', { class: 'shader-tag shader-tag--best' }, 'подходит') : null,
          plan.distantHorizons && pack.dh ? h('span', { class: 'shader-tag' }, 'Distant Horizons') : null,
        ),
        pack.about ? h('span', { class: 'text-muted' }, pack.about) : null,
        disabled ? h('span', { class: 'text-muted' }, `Нет для Minecraft ${plan.minecraft}`) : null,
      ),
    );
  }

  function render() {
    if (!plan.engine) {
      body.replaceChildren(h('p', { class: 'text-soft' }, 'Шейдерам нужен загрузчик модов: поставьте Fabric в «Настройки» → «Версия», и здесь можно будет включить шейдеры.'));
      applyButton.disabled = true;
      return;
    }
    const gpu = plan.system.gpu ? plan.system.gpu.replace(/\b(NVIDIA|GeForce|AMD|Radeon\(TM\)|Intel\(R\)|with|Design)\b|\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim() : 'видеокарта не определена';
    const toggle = createToggle({ checked: choice.enabled, label: 'Шейдеры', onChange: (value) => { choice.enabled = value; render(); } });
    const levelControl = createSegmented({ options: LEVELS, value: choice.level, onChange: (value) => { choice.level = value; render(); } });
    const modeControl = createSegmented({
      options: [{ value: 'auto', label: 'Авто' }, { value: 'manual', label: 'Сам выберу' }],
      value: choice.auto ? 'auto' : 'manual',
      onChange: (value) => {
        choice.auto = value === 'auto';
        if (!choice.auto && !choice.pack) choice.pack = plan.recommended[choice.level];
        render();
      },
    });
    const parts = [
      h('div', { class: 'optimize__system' },
        h('div', { class: 'optimize__chip' }, h('span', { class: 'text-muted' }, 'Компьютер'), h('b', null, TIER_LABELS[plan.system.tier])),
        h('div', { class: 'optimize__chip' }, h('span', { class: 'text-muted' }, 'Видеокарта'), h('b', { title: plan.system.gpu ?? '' }, `${gpu}${plan.system.integrated ? ' (встроенная)' : ''}`)),
        h('div', { class: 'optimize__chip' }, h('span', { class: 'text-muted' }, 'Загрузчик шейдеров'), h('b', null, `${plan.engine.title}${plan.engine.installed ? ' — стоит' : plan.engine.available ? ' — поставится' : ' — нет для этой версии'}`)),
      ),
      plan.blockers.length ? h('p', { class: 'text-danger' }, `${plan.blockers.join(' и ')} не работает вместе с ${plan.engine.title}: выключите в модах или в «Оптимизации».`) : null,
      h('div', { class: 'shaders__row optimize-in', style: { '--i': 0 } }, h('span', { class: 'shaders__label' }, h('b', null, 'Шейдеры'), h('span', { class: 'text-muted' }, choice.enabled ? 'Включатся при следующем запуске игры' : 'Выключены: игра без шейдеров')), toggle),
    ];
    if (choice.enabled) {
      parts.push(
        h('div', { class: 'shaders__row optimize-in', style: { '--i': 1 } }, h('span', { class: 'shaders__label' }, h('b', null, 'Что важнее'), h('span', { class: 'text-muted' }, 'Скорость — больше FPS, Красота — дальние тени и тяжёлые шейдеры')), levelControl.element),
        h('div', { class: 'shaders__row optimize-in', style: { '--i': 2 } }, h('span', { class: 'shaders__label' }, h('b', null, 'Выбор шейдера'), h('span', { class: 'text-muted' }, choice.auto ? 'Лаунчер подберёт сам' : 'Любой из списка')), modeControl.element),
      );
      if (choice.auto) {
        const pack = plan.packs.find((candidate) => candidate.projectId === plan.recommended[choice.level]);
        parts.push(
          h('div', { class: 'shaders__auto optimize-in', style: { '--i': 3 } },
            pack ? packCard(pack, { selectable: false }) : h('p', { class: 'text-danger' }, `Нет подходящего шейдера для Minecraft ${plan.minecraft}.`),
            h('p', { class: 'text-muted' }, (() => {
              const why = choice.level === 'speed' ? 'полегче, чтобы FPS было больше' : choice.level === 'beauty' ? 'потяжелее, но красивее' : 'красиво и без тормозов';
              return plan.distantHorizons ? `Подобран под ${TIER_LABELS[plan.system.tier]} компьютер и Distant Horizons: ${why}.` : `Подобран под ${TIER_LABELS[plan.system.tier]} компьютер: ${why}.`;
            })()),
          ),
        );
      } else {
        parts.push(
          h('div', { class: 'shaders__grid optimize-in', style: { '--i': 3 } }, ...plan.packs.map((pack) => packCard(pack)), ...plan.ownPacks.map((pack) => packCard(pack))),
        );
      }
    }
    body.replaceChildren(...parts.filter(Boolean));
    applyButton.disabled = Boolean(plan.blockers.length && choice.enabled) || (choice.enabled && !plan.engine.installed && !plan.engine.available);
  }

  async function load() {
    try {
      plan = await api.content.shaderPlan(instance.id);
      Object.assign(choice, plan.saved);
      if (!choice.level) choice.level = 'balance';
      // The rows come in as a wave the first time only, not on every click.
      body.classList.add('shaders--enter');
      render();
      setTimeout(() => body.classList.remove('shaders--enter'), 900);
    } catch (error) {
      body.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  async function apply() {
    applyButton.disabled = true;
    applyButton.replaceChildren(icon('bolt'), 'Настраиваем…');
    try {
      const result = await api.content.shaderApply(instance.id, choice);
      await refreshInstances().catch(() => {});
      onDone?.();
      sfx('success');
      pixelBurst(applyButton, { count: 18 });
      body.replaceChildren(
        h('div', { class: 'optimize__done optimize-pop' },
          h('div', { class: 'optimize__title' }, 'Готово'),
          ...result.summary.map((line) => h('p', null, line)),
          result.failed.length ? h('p', { class: 'text-danger' }, `Не получилось: ${result.failed.join('; ')}`) : null,
        ),
      );
      applyButton.hidden = true;
      cancelButton.textContent = 'Закрыть';
    } catch (error) {
      toast(errorMessage(error), 'error', 8000);
      applyButton.disabled = false;
      applyButton.replaceChildren(icon('bolt'), 'Применить');
    }
  }

  const modal = openModal({ title: `Шейдеры «${instance.name}»`, wide: true, content: body, footer: [h('span', { class: 'optimize__spacer' }), cancelButton, applyButton] });
  load();
  return modal;
}
