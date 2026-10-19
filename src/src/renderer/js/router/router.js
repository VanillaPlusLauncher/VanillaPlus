/**
 * Keeps one element per page. Pages are created on first visit and then kept,
 * so their scroll position and local state survive navigation.
 *
 * routes: { name: (context) => { element, onShow?, onHide? } }
 */
export function createRouter({ host, routes, onChange }) {
  const pages = new Map();
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
    }

    let page = pages.get(name);
    if (!page) {
      page = routes[name]({ navigate });
      host.append(page.element);
      pages.set(name, page);
    }
    page.element.classList.add('page--active');
    page.onShow?.();
    currentName = name;
    onChange?.(name);
  }

  return { navigate, current: () => currentName };
}
