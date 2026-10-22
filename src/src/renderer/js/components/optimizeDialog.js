import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage, formatGigabytes } from '../core/format.js';
import { pixelBurst } from '../core/effects.js';
import { sfx } from '../core/sound.js';
import { refreshInstances } from '../state/actions.js';
import { openModal } from './modal.js';
import { openShaderDialog } from './shaderDialog.js';
import { toast } from './toast.js';

const TIER_LABELS = { low: 'слабый', mid: 'средний', high: 'мощный' };

/**
 * "Оптимизация": the computer and the pack are checked, then everything that makes the pack faster
 * is listed in groups — conflicts to fix, performance mods, memory, Java flags, video settings —
 * and applied with one button. Everything is ticked where it is safe; risky mods are shown but
 * never ticked. "Вернуть как было" undoes the last run. `onDone` refreshes the mod list.
 */
export function openOptimizeDialog(instance, onDone) {
  const body = h('div', { class: 'optimize' }, h('div', { class: 'optimize__loading' }, h('div', { class: 'skeleton', style: { height: '64px' } }), h('p', { class: 'text-muted' }, 'Смотрим на компьютер и сборку…'), h('div', { class: 'skeleton', style: { height: '260px' } })));
  const applyButton = h('button', { class: 'btn btn--primary', type: 'button', disabled: true, onclick: () => apply() }, icon('bolt'), 'Оптимизировать');
  const undoButton = h('button', { class: 'btn btn--ghost btn--compact optimize__undo', type: 'button', hidden: true, onclick: () => undo() }, 'Вернуть как было');
  let plan = null;
  const boxes = { mods: new Map(), problems: new Map(), ram: null, java: null, video: null };

  const chip = (label, value) => h('div', { class: 'optimize__chip' }, h('span', { class: 'text-muted' }, label), h('b', { title: value }, value));

  // Sections and rows come in one after another, a short wave (index → delay, see features.css).
  let wave = 0;
  function section(title, ...rows) {
    return h('section', { class: 'optimize__section optimize-in', style: { '--i': wave++ } }, h('div', { class: 'optimize__title' }, title), ...rows);
  }

  function row({ box, iconElement = null, title, text, tag = null, off = false, extra = null }) {
    return h(
      'label',
      { class: `optimize__row optimize-in${off ? ' optimize__row--off' : ''}`, style: { '--i': wave++ } },
      box,
      iconElement,
      h('span', { class: 'optimize__row-text' }, h('b', null, title, tag), h('span', { class: 'text-muted' }, text), extra),
    );
  }

  const checkbox = (checked, disabled = false) => h('input', { type: 'checkbox', checked, disabled });

  function render() {
    const { system } = plan;
    const parts = [];
    wave = 0;
    // "NVIDIA GeForce GTX 1650 with Max-Q Design" → "GTX 1650 Max-Q": the model is what matters.
    const gpuName = system.gpu?.name.replace(/\b(NVIDIA|GeForce|AMD|Radeon\(TM\)|Intel\(R\)|with|Design)\b|\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim();
    const gpu = system.gpu ? `${gpuName || system.gpu.name}${system.gpu.vramMb ? ` · ${formatGigabytes(system.gpu.vramMb)}` : ''}${system.gpu.integrated ? ' (встроенная)' : ''}` : 'не определена';
    parts.push(
      h('div', { class: 'optimize__system' },
        chip('Память', formatGigabytes(system.ramMb)),
        chip('Процессор', `${system.cores} потоков`),
        chip('Видеокарта', gpu),
        chip('Монитор', `${system.display.width}×${system.display.height}, ${system.display.refreshRate} Гц`),
        chip('Компьютер', TIER_LABELS[system.tier]),
      ),
    );

    if (plan.problems.length) {
      parts.push(
        section('Проблемы в сборке', ...plan.problems.map((problem) => {
          const box = checkbox(true);
          boxes.problems.set(problem.id, box);
          return row({ box, iconElement: h('span', { class: 'optimize__icon optimize__icon--warn' }, '!'), title: problem.title, text: `${problem.text} (${problem.names.join(', ')})` });
        })),
      );
    }

    if (plan.loader === 'vanilla') {
      parts.push(section('Моды для скорости', h('p', { class: 'text-soft' }, 'Моды работают с загрузчиком: поставьте Fabric в «Настройки» → «Версия», и здесь появятся Sodium, Lithium и другие.')));
    } else if (plan.mods.length) {
      const order = { core: 0, extra: 1, experimental: 2 };
      const mods = [...plan.mods].sort((a, b) => Number(a.installed) - Number(b.installed) || order[a.kind] - order[b.kind]);
      parts.push(
        section('Моды для скорости', ...mods.map((mod) => {
          const box = checkbox(mod.suggested, mod.installed || Boolean(mod.avoided));
          if (mod.installed) box.checked = true;
          boxes.mods.set(mod.projectId, box);
          const state = mod.installed ? (mod.enabled === false ? 'стоит, но выключен' : 'уже стоит') : mod.avoided ? `не советуем: ${mod.avoided}` : mod.risk ? `осторожно: ${mod.risk}` : '';
          const tag = mod.kind === 'experimental' ? h('span', { class: 'optimize__tag optimize__tag--risk' }, 'риск') : null;
          return row({
            box,
            iconElement: mod.iconUrl ? h('img', { class: 'optimize__icon', src: mod.iconUrl, alt: '' }) : h('span', { class: 'optimize__icon' }, icon('cube')),
            title: mod.title,
            tag,
            text: state ? `${mod.why} — ${state}` : mod.why,
            off: mod.installed || Boolean(mod.avoided),
          });
        })),
      );
    }

    const ramSame = plan.ram.recommended === plan.ram.current;
    boxes.ram = checkbox(!ramSame, ramSame);
    const javaBlocked = !plan.java.test.ok;
    boxes.java = checkbox(plan.java.changed && !javaBlocked, !plan.java.changed || javaBlocked);
    const javaNote = javaBlocked
      ? `Java отказалась от этих флагов: ${plan.java.test.error ?? 'ошибка'} — оставляем как есть.`
      : !plan.java.changed
        ? 'Уже настроено.'
        : plan.java.test.tested
          ? `Проверено на Java ${plan.java.test.major}: короткие паузы сборщика мусора вместо рывков. Ваши остальные аргументы останутся.`
          : 'Короткие паузы сборщика мусора вместо рывков. Ваши остальные аргументы останутся.';
    parts.push(
      section('Память и Java',
        row({
          box: boxes.ram,
          title: ramSame ? `Память: ${formatGigabytes(plan.ram.current)}` : `Память: ${formatGigabytes(plan.ram.current)} → ${formatGigabytes(plan.ram.recommended)}`,
          text: ramSame ? 'Уже столько, сколько нужно.' : `Подобрано под ${plan.ram.reasons.join(', ')} и память компьютера.${plan.ram.recommended < plan.ram.current ? ' Лишняя память не ускоряет игру, а паузы на сборку мусора становятся длиннее.' : ''}`,
          off: ramSame,
        }),
        row({
          box: boxes.java,
          title: 'Флаги Java для плавной игры (G1)',
          text: javaNote,
          off: !plan.java.changed || javaBlocked,
          extra: plan.java.changed ? h('details', { class: 'optimize__details' }, h('summary', null, 'Аргументы'), h('code', { class: 'optimize__flags' }, plan.java.recommended)) : null,
        }),
      ),
    );

    // Shaders have a window of their own: switched on, auto or own choice, how heavy.
    if (plan.loader !== 'vanilla') {
      parts.push(
        section('Шейдеры',
          h('div', { class: 'optimize__row optimize-in', style: { '--i': wave++ } },
            h('span', { class: 'optimize__icon' }, icon('image')),
            h('span', { class: 'optimize__row-text' }, h('b', null, 'Шейдеры под этот компьютер'), h('span', { class: 'text-muted' }, 'Включить, подобрать самый лёгкий подходящий шейдер или выбрать свой и настроить, что важнее: скорость или красота.')),
            h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => openShaderDialog(instance, onDone) }, 'Настроить'),
          ),
        ),
      );
    }

    const video = plan.video.changes;
    boxes.video = checkbox(video.length > 0, video.length === 0);
    parts.push(
      section('Графика',
        row({
          box: boxes.video,
          title: video.length ? `Настройки под ${TIER_LABELS[system.tier]} компьютер и монитор ${system.display.refreshRate} Гц` : 'Настройки графики уже подходят',
          text: video.length ? 'Лимит FPS по частоте монитора вместо вертикальной синхронизации: плавно и без задержки ввода.' : '',
          off: video.length === 0,
          extra: video.length
            ? h('div', { class: 'optimize__changes' }, ...video.map((change) => h('div', { class: 'optimize__change' }, h('span', { class: 'text-muted' }, change.label), h('span', null, change.from == null ? change.to : `${change.from} → ${change.to}`))))
            : null,
        }),
      ),
    );

    body.replaceChildren(...parts);
    undoButton.hidden = !plan.backup;
    applyButton.disabled = false;
  }

  async function load() {
    applyButton.disabled = true;
    try {
      plan = await api.content.optimize(instance.id);
      boxes.mods.clear();
      boxes.problems.clear();
      render();
    } catch (error) {
      body.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  async function apply() {
    const choices = {
      ram: Boolean(boxes.ram?.checked && !boxes.ram.disabled),
      java: Boolean(boxes.java?.checked && !boxes.java.disabled),
      video: Boolean(boxes.video?.checked && !boxes.video.disabled),
      mods: [...boxes.mods].filter(([, box]) => box.checked && !box.disabled).map(([id]) => id),
      problems: [...boxes.problems].filter(([, box]) => box.checked).map(([id]) => id),
    };
    if (!choices.ram && !choices.java && !choices.video && !choices.mods.length && !choices.problems.length) {
      toast('Ничего не отмечено', 'info');
      return;
    }
    applyButton.disabled = true;
    undoButton.disabled = true;
    applyButton.replaceChildren(icon('bolt'), 'Оптимизируем…');
    try {
      const result = await api.content.optimizeApply(instance.id, choices);
      await refreshInstances().catch(() => {});
      onDone?.();
      sfx('success');
      pixelBurst(applyButton, { count: 18 });
      body.replaceChildren(
        h('div', { class: 'optimize__done optimize-pop' },
          h('div', { class: 'optimize__title' }, 'Готово'),
          ...result.summary.map((line) => h('p', null, line)),
          result.failed.length ? h('p', { class: 'text-danger' }, `Не получилось: ${result.failed.join('; ')}`) : null,
          h('p', { class: 'text-muted' }, 'Если что-то не понравится — «Вернуть как было» в этом же окне.'),
        ),
      );
      applyButton.hidden = true;
      cancelButton.textContent = 'Закрыть';
      undoButton.hidden = false;
      undoButton.disabled = false;
    } catch (error) {
      toast(errorMessage(error), 'error');
      applyButton.disabled = false;
      applyButton.replaceChildren(icon('bolt'), 'Оптимизировать');
      undoButton.disabled = false;
    }
  }

  async function undo() {
    undoButton.disabled = true;
    try {
      await api.content.optimizeUndo(instance.id);
      await refreshInstances().catch(() => {});
      onDone?.();
      toast('Всё как было до оптимизации', 'success');
      modal.close();
    } catch (error) {
      toast(errorMessage(error), 'error');
      undoButton.disabled = false;
    }
  }

  const cancelButton = h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена');
  const modal = openModal({
    title: `Оптимизация «${instance.name}»`,
    wide: true,
    content: body,
    footer: [undoButton, h('span', { class: 'optimize__spacer' }), cancelButton, applyButton],
  });
  load();
  return modal;
}
