/*
 * The launcher answers the mouse everywhere: a card under the pointer leans towards it in 3D with a
 * soft light following the pointer, the title-screen panorama behind everything drifts a little the
 * other way, as if you looked around, and a button's icon makes its own move (css/motion.css) when the
 * pointer comes. Turned off with the animations (data-animations="off").
 */

const TILT_SELECTOR = '.recent-card, .news-tile, .instance-card, .accent-option, .wardrobe__step, .panorama-option, .runtime-card';
/** Buttons whose icon moves when the pointer comes onto them. */
const MOVING_ICON_SELECTOR = '.btn, .icon-button:not(.icon-button--window), .chip, .tabs__button, .context-menu__item';
/** How far a card leans at its edge, in degrees (a card up to TILT_SIZE px across; wider ones lean less). */
const MAX_TILT = 7;
const TILT_SIZE = 280;
/** How far the panorama drifts at the window's edge, in pixels. */
const DRIFT = 14;

let installed = false;

export function installAliveUi() {
  if (installed) return;
  installed = true;
  const root = document.documentElement;
  const drift = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let frame = 0;
  let card = null;
  // The card's box as it was before it leaned: measuring the leaning card instead made the lean feed
  // back into the next measurement, and the card shook.
  let box = null;

  const off = () => root.dataset.animations === 'off';

  function step() {
    drift.x += (drift.targetX - drift.x) * 0.08;
    drift.y += (drift.targetY - drift.y) * 0.08;
    // Set on the panorama itself: a variable on the root would restyle the whole page every frame.
    for (const panorama of document.querySelectorAll('.panorama')) {
      panorama.style.translate = `${drift.x.toFixed(2)}px ${drift.y.toFixed(2)}px`;
    }
    frame = Math.abs(drift.targetX - drift.x) + Math.abs(drift.targetY - drift.y) > 0.05 ? requestAnimationFrame(step) : 0;
  }

  function release() {
    if (!card) return;
    card.classList.remove('is-tilting');
    card.style.removeProperty('--tilt-x');
    card.style.removeProperty('--tilt-y');
    card.style.removeProperty('--tilt-depth');
    card = null;
    box = null;
  }

  document.addEventListener(
    'pointermove',
    (event) => {
      if (off()) {
        release();
        return;
      }
      drift.targetX = (event.clientX / window.innerWidth - 0.5) * -DRIFT;
      drift.targetY = (event.clientY / window.innerHeight - 0.5) * -DRIFT * 0.6;
      if (!frame) frame = requestAnimationFrame(step);

      const next = event.target instanceof Element ? event.target.closest(TILT_SELECTOR) : null;
      if (next !== card) {
        release();
        card = next;
        if (card) {
          box = card.getBoundingClientRect();
          // A wide card (an instance in the list view) leans a little and from farther away, so its
          // edges stay in place instead of swinging out of the window.
          card.style.setProperty('--tilt-depth', `${Math.max(700, Math.round(box.width * 3))}px`);
          card.classList.add('is-tilting');
        }
      }
      if (!card) return;
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
      const tiltX = MAX_TILT * Math.min(1, TILT_SIZE / box.width);
      const tiltY = MAX_TILT * Math.min(1, TILT_SIZE / box.height);
      card.style.setProperty('--tilt-x', `${((x - 0.5) * 2 * tiltX).toFixed(2)}deg`);
      card.style.setProperty('--tilt-y', `${((0.5 - y) * 2 * tiltY).toFixed(2)}deg`);
      card.style.setProperty('--glare-x', `${(x * 100).toFixed(1)}%`);
      card.style.setProperty('--glare-y', `${(y * 100).toFixed(1)}%`);
    },
    { passive: true },
  );
  document.addEventListener('pointerleave', release);
  window.addEventListener('blur', release);
  // Scrolling moves the card away from its measured box: let it go, the next move measures again.
  // While a page scrolls, what passes under the still pointer does not answer it: a clear sheet over the
  // page's content takes the pointer (features/alive.css .scroll-shield). Rows lighting up, icons
  // starting their moves and tooltips on every frame made long mod lists stutter. A sheet rather than
  // `pointer-events: none` on the content: that is inherited, and switching it restyled the ~3000
  // elements of a long list twice per scroll (25–60 ms each).
  const shield = document.createElement('div');
  shield.className = 'scroll-shield';
  let shieldTimer = 0;
  document.addEventListener(
    'scroll',
    (event) => {
      release();
      const page = event.target instanceof Element && event.target.classList.contains('page') ? event.target : null;
      if (!page) return;
      if (shield.parentElement !== page) {
        // In the page's own scrolled content, as tall as all of it: the wheel still scrolls the page.
        shield.style.height = `${page.scrollHeight}px`;
        page.append(shield);
      }
      clearTimeout(shieldTimer);
      shieldTimer = setTimeout(() => shield.remove(), 160);
    },
    { capture: true, passive: true },
  );

  // The icon's move plays to its end once it has started, also when the pointer leaves at once: a move
  // cut off by :hover ending jumped back to the start in one frame.
  document.addEventListener(
    'pointerover',
    (event) => {
      if (off() || !(event.target instanceof Element)) return;
      const button = event.target.closest(MOVING_ICON_SELECTOR);
      if (!button || button.disabled || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return;
      const icon = button.querySelector('.icon');
      if (!icon || icon.classList.contains('is-moving')) return;
      icon.classList.add('is-moving');
      const done = (end) => {
        if (end.target !== icon) return;
        icon.classList.remove('is-moving');
        icon.removeEventListener('animationend', done);
        icon.removeEventListener('animationcancel', done);
      };
      icon.addEventListener('animationend', done);
      icon.addEventListener('animationcancel', done);
    },
    { passive: true },
  );
}
