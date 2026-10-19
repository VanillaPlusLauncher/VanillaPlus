/**
 * Minimal DOM helpers. Attributes map to properties for form controls and to
 * attributes for everything else; `onXxx` props become event listeners.
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === 'class') {
      element.className = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked' || key === 'disabled') {
      element[key] = value;
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

/** Decorative icon drawn from the design atlas (see css/base.css for names). */
export function icon(name) {
  return h('span', { class: `icon icon--${name}`, 'aria-hidden': 'true' });
}

export function replaceChildren(element, ...children) {
  element.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
}
