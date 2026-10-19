import { h } from '../core/dom.js';
import { store, MAX_LOG_LINES } from '../state/appStore.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { errorMessage } from '../core/format.js';

/** Maps a log line to a CSS modifier so errors and warnings stand out. */
function lineClass(line) {
  if (line.startsWith('---')) {
    return 'log-view__line--meta';
  }
  if (/\b(ERROR|Exception|Caused by|FATAL)\b/i.test(line)) {
    return 'log-view__line--error';
  }
  if (/\b(WARN|WARNING)\b/i.test(line)) {
    return 'log-view__line--warn';
  }
  return '';
}

/** Live game log. Autoscrolls while the user stays near the bottom. */
export function openLogModal() {
  const view = h('div', { class: 'log-view', role: 'log', 'aria-live': 'off' });
  let renderedCount = 0;

  function appendNewLines() {
    const { logs, logCount } = store.get();
    if (logCount < renderedCount) {
      view.replaceChildren();
      renderedCount = 0;
    }
    const fresh = logs.slice(Math.max(0, logs.length - (logCount - renderedCount)));
    const stickToBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    for (const line of fresh) {
      const className = lineClass(line);
      view.append(h('div', { class: className ? `log-view__line ${className}` : 'log-view__line' }, line || ' '));
    }
    renderedCount = logCount;
    // Keep the view as long as the buffer: a long session must not grow the page without limit.
    while (view.childElementCount > MAX_LOG_LINES) {
      view.firstElementChild.remove();
    }
    if (stickToBottom) {
      view.scrollTop = view.scrollHeight;
    }
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(view.innerText);
      toast('Журнал скопирован в буфер обмена', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const content = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', flex: '1', minHeight: '0' } }, view);
  const modal = openModal({
    title: 'Журнал игры',
    content,
    wide: true,
    footer: [
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => copyLogs() }, 'Копировать'),
      h(
        'button',
        {
          class: 'btn btn--secondary btn--compact',
          type: 'button',
          onclick: () => {
            // Clears only the view; the main process keeps its buffer for the next start.
            store.set({ logs: [], logCount: 0 });
            view.replaceChildren();
            renderedCount = 0;
          },
        },
        'Очистить',
      ),
    ],
    onClose: () => unsubscribe(),
  });

  const unsubscribe = store.subscribe(['logCount'], appendNewLines);
  appendNewLines();
  view.scrollTop = view.scrollHeight;
  return modal;
}
