/*
 * Tooltips in the launcher's style instead of Windows' grey ones, for every element with a `title`
 * anywhere in the interface. While the pointer is over such an element its `title` is taken off
 * (so the system tooltip never shows) and put back when the pointer leaves; the text is read at that
 * moment, so it is already in the interface language.
 */

const DELAY_MS = 380;
let tip = null;
let current = null;
let timer = 0;

function element() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  return tip;
}

function place(target) {
  const box = target.getBoundingClientRect();
  const node = element();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let left = box.left + box.width / 2 - width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  // Above the element, or below it when there is no room at the top.
  const above = box.top - height - 8;
  const top = above >= 8 ? above : box.bottom + 8;
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
  node.dataset.side = above >= 8 ? 'top' : 'bottom';
}

function hide() {
  clearTimeout(timer);
  if (current) {
    if (current.dataset.tipText && !current.hasAttribute('title')) current.setAttribute('title', current.dataset.tipText);
    delete current.dataset.tipText;
    current = null;
  }
  tip?.classList.remove('tooltip--visible');
}

function show(target) {
  hide();
  const text = target.getAttribute('title');
  if (!text) return;
  current = target;
  target.dataset.tipText = text;
  target.removeAttribute('title');
  timer = setTimeout(() => {
    if (current !== target || !target.isConnected) return;
    const node = element();
    node.textContent = text;
    place(target);
    node.classList.add('tooltip--visible');
  }, DELAY_MS);
}

export function installTooltips() {
  document.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[title]') : null;
    if (target && target !== current) show(target);
  });
  document.addEventListener('pointerout', (event) => {
    if (current && !current.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('blur', hide);
  // Only scrolling that moves the element hides its tooltip (rows and carousels elsewhere move on their own).
  document.addEventListener(
    'scroll',
    (event) => {
      if (current && (event.target === document || event.target.contains?.(current))) hide();
    },
    true,
  );
}
