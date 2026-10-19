import { h } from '../core/dom.js';
import { sfx } from '../core/sound.js';

/*
 * Launcher-styled dropdowns. Every <select class="select"> on the page gets a button and a list
 * drawn by the launcher instead of the system one. The native select stays in the DOM (hidden)
 * and remains the source of truth: pages keep reading and setting `select.value`, filling it with
 * <option>s and listening to "change" exactly as before.
 */

const SEARCH_THRESHOLD = 12;
const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 340;

const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const indexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

let openMenu = null;

function closeOpenMenu() {
  openMenu?.close();
}

function optionLabel(option) {
  return option?.textContent ?? '';
}

/** The select's own classes (select--compact, widths…) carried over to its button. */
function buttonClass(select) {
  return `${select.className.replace(/\bdropdown__native\b/g, '').trim()} dropdown__button`;
}

function enhance(select) {
  const button = h(
    'button',
    { class: buttonClass(select), type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'data-sound': 'none' },
    h('span', { class: 'dropdown__label' }),
    h('span', { class: 'dropdown__chevron', 'aria-hidden': 'true' }),
  );
  if (select.getAttribute('aria-label')) {
    button.setAttribute('aria-label', select.getAttribute('aria-label'));
  }
  const label = button.firstChild;

  function refresh() {
    const option = select.options[select.selectedIndex];
    label.textContent = optionLabel(option) || '—';
    button.disabled = select.disabled || select.options.length === 0;
    const next = `${buttonClass(select)}${button.classList.contains('dropdown__button--open') ? ' dropdown__button--open' : ''}`;
    if (button.className !== next) {
      button.className = next;
    }
  }

  // Programmatic changes (select.value = …) do not fire events: catch them on this element.
  Object.defineProperty(select, 'value', {
    configurable: true,
    get: () => valueDescriptor.get.call(select),
    set: (value) => {
      valueDescriptor.set.call(select, value);
      refresh();
    },
  });
  Object.defineProperty(select, 'selectedIndex', {
    configurable: true,
    get: () => indexDescriptor.get.call(select),
    set: (value) => {
      indexDescriptor.set.call(select, value);
      refresh();
    },
  });
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'class'] });
  select.addEventListener('change', refresh);

  button.addEventListener('click', () => {
    if (openMenu?.owner === select) {
      closeOpenMenu();
    } else {
      open(select, button);
    }
  });
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open(select, button);
    }
  });

  select.classList.add('dropdown__native');
  select.tabIndex = -1;
  select._dropdown = { button, refresh };
  refresh();
  return button;
}

function choose(select, index) {
  if (index !== select.selectedIndex) {
    indexDescriptor.set.call(select, index);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  select._dropdown.refresh();
  sfx('click');
}

function open(select, button) {
  closeOpenMenu();
  const options = [...select.options];
  if (options.length === 0) {
    return;
  }
  sfx('tab');
  let active = Math.max(0, select.selectedIndex);
  const list = h('div', { class: 'dropdown__list', role: 'listbox' });
  const search = options.length > SEARCH_THRESHOLD ? h('input', { class: 'dropdown__search', type: 'text', placeholder: 'Поиск…', spellcheck: 'false' }) : null;
  const menu = h('div', { class: 'dropdown__menu' }, search, list);
  let items = [];

  function renderItems() {
    const query = search?.value.trim().toLowerCase() ?? '';
    items = options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !query || optionLabel(option).toLowerCase().includes(query));
    list.replaceChildren(
      ...items.map(({ option, index }) =>
        h(
          'div',
          {
            class: `dropdown__item${index === select.selectedIndex ? ' dropdown__item--selected' : ''}${option.disabled ? ' dropdown__item--disabled' : ''}`,
            role: 'option',
            'aria-selected': String(index === select.selectedIndex),
            'data-index': String(index),
            onpointerdown: (event) => event.preventDefault(),
            onclick: () => {
              if (!option.disabled) {
                choose(select, index);
                close();
                button.focus();
              }
            },
            onpointermove: () => setActive(index, false),
          },
          h('span', { class: 'dropdown__item-text' }, optionLabel(option)),
        ),
      ),
    );
    if (items.length === 0) {
      list.append(h('div', { class: 'dropdown__empty' }, 'Ничего не найдено'));
    }
    if (!items.some((item) => item.index === active)) {
      active = items[0]?.index ?? -1;
    }
    setActive(active, true);
  }

  function setActive(index, scroll) {
    active = index;
    for (const element of list.children) {
      element.classList.toggle('dropdown__item--active', element.dataset.index === String(index));
    }
    if (scroll) {
      list.querySelector('.dropdown__item--active')?.scrollIntoView({ block: 'nearest' });
    }
  }

  function move(step) {
    const position = items.findIndex((item) => item.index === active);
    let next = position;
    do {
      next = Math.min(items.length - 1, Math.max(0, next + step));
    } while (items[next]?.option.disabled && next > 0 && next < items.length - 1);
    if (items[next]) {
      setActive(items[next].index, true);
    }
  }

  function place() {
    const rect = button.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - MENU_GAP - 8;
    const above = rect.top - MENU_GAP - 8;
    const upward = below < 200 && above > below;
    const room = Math.min(MENU_MAX_HEIGHT, upward ? above : below);
    menu.style.minWidth = `${rect.width}px`;
    menu.style.maxWidth = `${Math.max(rect.width, 420)}px`;
    menu.style.maxHeight = `${room}px`;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - Math.max(rect.width, menu.offsetWidth) - 8)}px`;
    menu.style.top = upward ? '' : `${rect.bottom + MENU_GAP}px`;
    menu.style.bottom = upward ? `${window.innerHeight - rect.top + MENU_GAP}px` : '';
    menu.classList.toggle('dropdown__menu--up', upward);
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0 && !options[active].disabled) {
        choose(select, active);
      }
      close();
      button.focus();
    } else if (event.key === 'Tab') {
      close();
    } else if (!search && event.key.length === 1) {
      // Without a search box, typing jumps to the first matching item.
      const match = items.find((item) => optionLabel(item.option).toLowerCase().startsWith(event.key.toLowerCase()));
      if (match) setActive(match.index, true);
    }
  }

  function onOutside(event) {
    if (!menu.contains(event.target) && !button.contains(event.target)) {
      close();
    }
  }

  function onScroll(event) {
    if (!menu.contains(event.target)) {
      close();
    }
  }

  function close() {
    if (openMenu?.owner !== select) {
      return;
    }
    openMenu = null;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('dropdown__button--open');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    menu.classList.add('dropdown__menu--closing');
    setTimeout(() => menu.remove(), 120);
  }

  search?.addEventListener('input', renderItems);
  document.body.append(menu);
  renderItems();
  place();
  requestAnimationFrame(place);
  button.setAttribute('aria-expanded', 'true');
  button.classList.add('dropdown__button--open');
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', close);
  openMenu = { owner: select, close };
  (search ?? list).focus?.();
  search?.focus();
}

/** Puts the launcher button right after its select (again, if a page moved the select). */
function attach(select) {
  if (!select.matches('select.select') || select.multiple) {
    return;
  }
  const button = select._dropdown?.button ?? enhance(select);
  if (select.nextSibling !== button) {
    select.after(button);
  }
}

function scan(root) {
  if (root instanceof HTMLSelectElement) {
    attach(root);
  } else if (root.querySelectorAll) {
    root.querySelectorAll('select.select').forEach(attach);
  }
}

/** Enhances every select already on the page and every one added later. */
export function installDropdowns() {
  scan(document.body);
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => node.nodeType === 1 && scan(node));
      record.removedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        const selects = node instanceof HTMLSelectElement ? [node] : [...(node.querySelectorAll?.('select') ?? [])];
        for (const select of selects) {
          const button = select._dropdown?.button;
          // The select was taken out on its own: its button must not stay behind.
          if (button?.isConnected && !select.isConnected) {
            button.remove();
          }
          if (openMenu?.owner === select && !select.isConnected) {
            closeOpenMenu();
          }
        }
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}
