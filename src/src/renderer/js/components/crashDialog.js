import { h } from '../core/dom.js';
import { store } from '../state/appStore.js';
import { go as navigate } from '../core/nav.js';
import { openModal } from './modal.js';
import { renderProblems } from './instanceTabs.js';

const ACTION_TABS = { java: 'java', memory: 'java', 'jvm-args': 'java', mods: 'mod', version: 'version' };

function openInstanceAt(instanceId, tab, logId = null) {
  store.set({ openInstanceId: instanceId, openInstanceTab: tab, openInstanceLog: logId });
  navigate('instance');
}

/**
 * After a crash: what the launcher understood from the logs, in plain words, with buttons that
 * lead to the fix. report: { instanceId, exitCode, problems, crash, exitText, logId }.
 */
export function showCrashDialog(report) {
  const instance = store.get().instances.find((candidate) => candidate.id === report.instanceId);
  const name = instance?.name ?? 'Игра';
  const found = report.problems?.length > 0;

  let modal;
  const go = (tab, logId = null) => {
    modal.close();
    openInstanceAt(report.instanceId, tab, logId);
  };

  const content = h(
    'div',
    { class: 'crash-dialog' },
    h(
      'p',
      { class: 'crash-dialog__lead' },
      found
        ? report.problems.length === 1
          ? 'Лаунчер посмотрел журнал и нашёл причину:'
          : 'Лаунчер посмотрел журнал и нашёл возможные причины:'
        : 'Понятной причины в журнале не нашлось. Посмотрите журнал: обычно ошибка видна в последних красных строках.',
    ),
    found ? renderProblems(report.problems, (action) => go(ACTION_TABS[action] ?? 'settings')) : null,
    report.crash?.description ? h('div', { class: 'crash-dialog__report' }, h('b', null, 'Отчёт игры: '), report.crash.description, report.crash.exception ? h('div', { class: 'mono text-muted' }, report.crash.exception) : null) : null,
    h('div', { class: 'crash-dialog__code text-muted' }, `Код выхода ${report.exitCode ?? '—'}${report.exitText ? ` — ${report.exitText}` : ''}`),
  );

  modal = openModal({
    title: `${name} вылетела`,
    content,
    wide: true,
    footer: [
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Закрыть'),
      h('button', { class: 'btn btn--primary btn--compact', type: 'button', onclick: () => go('log', report.logId) }, 'Открыть журнал'),
    ],
  });
  return modal;
}
