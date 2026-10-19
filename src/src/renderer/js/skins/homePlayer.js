/*
 * The player on the home screen: the account's skin in 3D, turning its head after the mouse and
 * making gestures — a wave when you come back, a jump when the game starts, a spin for a new skin,
 * a greeting when the pointer comes onto it, and every 8–16 s something on its own (clapping,
 * stretching, a dab, flexing, an air kiss, a bow…), never the same twice in a row, some with a pixel
 * effect around it. Gestures live in gestures.js; the head keeps following the mouse during them.
 */

import { GESTURES, GESTURE_EFFECTS, GREETINGS, IDLE_GESTURES, resetPose } from './gestures.js';
import { createParticles } from './particles.js';

const LOOK_YAW = 0.9;
const LOOK_PITCH = 0.45;
const IDLE_MIN_MS = 8000;
const IDLE_MAX_MS = 16000;
// A greeting when the pointer comes onto the player, not more often than this.
const GREET_COOLDOWN_MS = 6000;
export function createHomePlayer({ width = 220, height = 300, onClick } = {}) {
  const lib = window.skinview3d;
  if (!lib) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'home-player__canvas';
  let viewer;
  try {
    viewer = new lib.SkinViewer({ canvas, width, height });
  } catch {
    return null;
  }
  if (viewer.fxaaPass) viewer.fxaaPass.enabled = false;
  viewer.renderer.outputColorSpace = 'srgb-linear';
  viewer.pixelRatio = Math.min(2, (window.devicePixelRatio || 1) * 1.5);
  viewer.controls.enabled = false;
  viewer.autoRotate = false;
  viewer.fov = 38;
  // Room above the head and under the feet (jumps, the cape).
  viewer.zoom = 0.78;
  // Turned a little towards the page's content.
  viewer.playerWrapper.rotation.y = -0.4;

  const look = { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0 };
  let gesture = null;
  let gestureStart = 0;
  let idleTimer = 0;

  viewer.animation = new lib.FunctionAnimation((player, progress) => {
    resetPose(player);
    // Breathing arms, like the game's idle pose, and a slow shift of weight from foot to foot.
    player.skin.leftArm.rotation.z = 0.03 * Math.cos(progress * 2) + 0.06;
    player.skin.rightArm.rotation.z = -0.03 * Math.cos(progress * 2) - 0.06;
    player.rotation.z = Math.sin(progress * 0.7) * 0.025;
    player.skin.head.rotation.z = Math.sin(progress * 0.9 + 1) * 0.03;
    if (gesture && GESTURES[gesture](player, progress - gestureStart)) {
      gesture = null;
    }
    look.yaw += (look.targetYaw - look.yaw) * 0.12;
    look.pitch += (look.targetPitch - look.pitch) * 0.12;
    player.skin.head.rotation.y += look.yaw;
    player.skin.head.rotation.x += look.pitch;
    player.skin.body.rotation.y += look.yaw * 0.25;
  });

  function onPointer(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dx = (event.clientX - (rect.left + rect.width / 2)) / 700;
    const dy = (event.clientY - (rect.top + rect.height * 0.25)) / 500;
    // The model is turned: its own left-right is shifted by that turn.
    look.targetYaw = Math.max(-1, Math.min(1, dx)) * LOOK_YAW + 0.4;
    look.targetPitch = Math.max(-1, Math.min(1, dy)) * LOOK_PITCH;
  }
  window.addEventListener('pointermove', onPointer, { passive: true });

  let effects = null;
  function play(name) {
    if (!GESTURES[name] || document.documentElement.dataset.animations === 'off') return;
    gesture = name;
    gestureStart = viewer.animation.progress;
    if (GESTURE_EFFECTS[name]) effects?.emit(GESTURE_EFFECTS[name]);
  }

  let lastIdle = null;
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Never the same gesture twice in a row.
      const choices = IDLE_GESTURES.filter((name) => name !== lastIdle);
      lastIdle = choices[Math.floor(Math.random() * choices.length)];
      if (!viewer.renderPaused && !gesture) play(lastIdle);
      scheduleIdle();
    }, IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS));
  }
  scheduleIdle();

  // The pointer coming onto the player: it greets you (now and then, never in the middle of a gesture).
  let greetedAt = 0;
  canvas.addEventListener('pointerenter', () => {
    if (gesture || viewer.renderPaused || Date.now() - greetedAt < GREET_COOLDOWN_MS) return;
    greetedAt = Date.now();
    play(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
  });

  canvas.addEventListener('click', () => onClick?.());

  return {
    canvas,
    setSkin(source, model = 'classic') {
      viewer.loadSkin(source, { model: model === 'slim' ? 'slim' : 'default' });
    },
    setCape(source) {
      if (source) viewer.loadCape(source).catch?.(() => {});
      else viewer.resetCape();
    },
    play,
    /** Pixel effects (hearts, sparkles…) drawn over `host` with the gestures. */
    attachEffects(host) {
      effects = createParticles(host);
    },
    /** Off-screen: nothing is drawn (saves the GPU while another page is open). */
    setActive(active) {
      viewer.renderPaused = !active;
    },
    dispose() {
      clearTimeout(idleTimer);
      window.removeEventListener('pointermove', onPointer);
      effects?.dispose();
      viewer.dispose();
    },
  };
}

export { GESTURES } from './gestures.js';
