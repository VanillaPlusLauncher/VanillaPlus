/**
 * Keeps one element per page. Pages are created on first visit and then kept,
 * so their scroll position and local state survive navigation.
 *
 * A page left behind fades out, then sleeps (layout.css .page--asleep): it is not drawn at all. Only
 * see-through, the pages visited before stayed under the shown one, and their animations (the home
 * page's sparks, the builds' pulsing dots) had the whole window drawn again every frame.
 *
 * routes: { name: (context) => { element, onShow?, onHide? } }
 */
const SLEEP_AFTER_MS = 450;

export function createRouter({ host, routes, onChange }) {
  const pages = new Map();
  const sleepTimers = new Map();
  let currentName = null;

  function navigate(name) {
    if (!routes[name]) {
      throw new Error(`Неизвестная страница: ${name}`);
    }
    if (name === currentName) {
      // Same page with new parameters (another instance): let it refresh itself.
      pages.get(name)?.onShow?.();
      return;
    }

    const previous = pages.get(currentName);
    if (previous) {
      previous.onHide?.();
      previous.element.classList.remove('page--active');
      const element = previous.element;
      clearTimeout(sleepTimers.get(element));
      sleepTimers.set(element, setTimeout(() => element.classList.add('page--asleep'), SLEEP_AFTER_MS));
    }

    let page = pages.get(name);
    if (!page) {
      page = routes[name]({ navigate });
      host.append(page.element);
      pages.set(name, page);
    }
    clearTimeout(sleepTimers.get(page.element));
    if (page.element.classList.contains('page--asleep')) {
      page.element.classList.remove('page--asleep');
      // Its see-through style is read once more, so it fades in again instead of popping up.
      void getComputedStyle(page.element).opacity;
    }
    page.element.classList.add('page--active');
    page.onShow?.();
    currentName = name;
    onChange?.(name);
  }

  return { navigate, current: () => currentName };
}
