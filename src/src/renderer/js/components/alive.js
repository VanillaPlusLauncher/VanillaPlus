/*
 * The launcher answers the mouse everywhere: a card under the pointer leans towards it in 3D with a
 * soft light following the pointer, and the title-screen panorama behind everything drifts a little
 * the other way, as if you looked around. Turned off with the animations (data-animations="off").
 */

const TILT_SELECTOR = '.recent-card, .news-tile, .instance-card, .accent-option, .wardrobe__step, .panorama-option, .runtime-card';
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
  document.addEventListener('scroll', release, { capture: true, passive: true });
}
