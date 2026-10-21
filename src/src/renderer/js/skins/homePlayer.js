/*
 * The player on the home screen: the account's skin in 3D, turning its head after the mouse and
 * making gestures — a wave when you come back, a jump when the game starts, a spin for a new skin,
 * a greeting when the pointer comes onto it, and every 8–16 s something on its own (clapping,
 * stretching, a dab, flexing, an air kiss, a bow…), never the same twice in a row, some with a pixel
 * effect around it. Gestures live in gestures.js; the head keeps following the mouse during them.
 */

import { armsRaised, ease, GESTURES, GESTURE_EFFECTS, GREETINGS, IDLE_GESTURES, resetPose } from './gestures.js';
import { createParticles } from './particles.js';

const LOOK_YAW = 0.9;
const LOOK_PITCH = 0.45;
const IDLE_MIN_MS = 8000;
const IDLE_MAX_MS = 16000;
// A greeting when the pointer comes onto the player, not more often than this.
const GREET_COOLDOWN_MS = 6000;
/**
 * `onLost`: called when the 3D view is gone for good (the GPU process restarted, or Chromium took
 * the WebGL context away); the page then puts a new player in its place.
 */
export function createHomePlayer({ width = 220, height = 300, onClick, onLost } = {}) {
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
  // A depth range that fits the model (three.js' 0.1…2000 by default): overlapping skin layers of
  // the arms, body and legs no longer flicker against each other.
  viewer.camera.near = 8;
  viewer.camera.far = 400;
  viewer.camera.updateProjectionMatrix();
  // Room above the head and under the feet (jumps, the cape).
  viewer.zoom = 0.78;
  // Turned a little towards the page's content.
  viewer.playerWrapper.rotation.y = -0.4;

  const look = { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0 };
  // Turning the player with the mouse to look at the skin from every side (see below).
  const REST_YAW = -0.4;
  const TURN_BACK_MS = 4000;
  const spin = { yaw: 0, tilt: 0, targetYaw: 0, targetTilt: 0, dragging: false, moved: false, startX: 0, startY: 0, startYaw: 0, startTilt: 0, releasedAt: 0 };
  let gesture = null;
  let gestureStart = 0;
  let idleTimer = 0;

  const still = () => document.documentElement.dataset.animations === 'off';

  viewer.animation = new lib.FunctionAnimation((player, progress) => {
    resetPose(player);
    // Animations off: the plain pose, only turned by hand (no breathing, no looking around).
    if (still()) {
      player.skin.leftArm.rotation.z = 0.06;
      player.skin.rightArm.rotation.z = -0.06;
      spin.yaw += (spin.targetYaw - spin.yaw) * 0.35;
      spin.tilt += (spin.targetTilt - spin.tilt) * 0.35;
      viewer.playerWrapper.rotation.y = REST_YAW + spin.yaw;
      viewer.playerWrapper.rotation.x = spin.tilt;
      return;
    }
    // Breathing arms, like the game's idle pose, and a slow shift of weight from foot to foot.
    player.skin.leftArm.rotation.z = 0.03 * Math.cos(progress * 2) + 0.06;
    player.skin.rightArm.rotation.z = -0.03 * Math.cos(progress * 2) - 0.06;
    player.rotation.z = Math.sin(progress * 0.7) * 0.025;
    player.skin.head.rotation.z = Math.sin(progress * 0.9 + 1) * 0.03;
    if (gesture === 'point' ? pointAtMouse(player, progress - gestureStart) : gesture && GESTURES[gesture](player, progress - gestureStart)) {
      gesture = null;
    }
    // Back to its usual angle a while after it was turned by hand (the nearest full turn).
    if (!spin.dragging && spin.releasedAt && performance.now() - spin.releasedAt > TURN_BACK_MS) {
      spin.targetYaw = Math.round(spin.yaw / (Math.PI * 2)) * Math.PI * 2;
      spin.targetTilt = 0;
    }
    spin.yaw += (spin.targetYaw - spin.yaw) * 0.22;
    spin.tilt += (spin.targetTilt - spin.tilt) * 0.22;
    viewer.playerWrapper.rotation.y = REST_YAW + spin.yaw;
    viewer.playerWrapper.rotation.x = spin.tilt;
    look.yaw += (look.targetYaw - look.yaw) * 0.12;
    look.pitch += (look.targetPitch - look.pitch) * 0.12;
    // Arms up: the head follows the mouse much less, so a raised arm never sinks into it.
    const follow = 1 - 0.85 * armsRaised(player);
    player.skin.head.rotation.y += look.yaw * follow;
    player.skin.head.rotation.x += look.pitch * follow;
    player.skin.body.rotation.y += look.yaw * 0.25 * follow;
  });

  /**
   * Points at the mouse: the right arm goes up towards the pointer (swung to its side first, then
   * lifted forward), held for a moment while the head looks the same way, then down again.
   */
  function pointAtMouse(player, t) {
    const lift = ease(t / 0.35) * (1 - ease((t - 1.9) / 0.4));
    const side = Math.max(-0.9, Math.min(0.9, -look.targetYaw * 0.8));
    player.skin.rightArm.rotation.z = side * lift;
    player.skin.rightArm.rotation.x = (-1.45 + look.targetPitch * 0.6) * lift;
    player.skin.body.rotation.y += look.targetYaw * 0.2 * lift;
    return t > 2.3;
  }

  function onPointer(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    // While it is being turned, the player looks straight ahead.
    if (spin.dragging || Math.abs(spin.yaw) > 0.05) {
      look.targetYaw = 0;
      look.targetPitch = 0;
      return;
    }
    const dx = (event.clientX - (rect.left + rect.width / 2)) / 700;
    const dy = (event.clientY - (rect.top + rect.height * 0.25)) / 500;
    // The model is turned: its own left-right is shifted by that turn.
    look.targetYaw = Math.max(-1, Math.min(1, dx)) * LOOK_YAW + 0.4;
    look.targetPitch = Math.max(-1, Math.min(1, dy)) * LOOK_PITCH;
  }
  window.addEventListener('pointermove', onPointer, { passive: true });

  let effects = null;
  function play(name) {
    if ((!GESTURES[name] && name !== 'point') || document.documentElement.dataset.animations === 'off') return;
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

  // Hold and drag: the player turns round (and tilts a little); a plain click opens the Wardrobe.
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    wake(60000);
    Object.assign(spin, { dragging: true, moved: false, startX: event.clientX, startY: event.clientY, startYaw: spin.targetYaw, startTilt: spin.targetTilt });
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add('home-player__canvas--grabbing');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!spin.dragging) return;
    const dx = event.clientX - spin.startX;
    const dy = event.clientY - spin.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) spin.moved = true;
    spin.targetYaw = spin.startYaw + dx * 0.012;
    spin.targetTilt = Math.max(-0.35, Math.min(0.35, spin.startTilt + dy * 0.005));
  });
  const release = (event, cancelled = false) => {
    if (!spin.dragging) return;
    spin.dragging = false;
    spin.releasedAt = performance.now();
    wake(TURN_BACK_MS + 1500);
    canvas.classList.remove('home-player__canvas--grabbing');
    if (!spin.moved && !cancelled) onClick?.();
  };
  canvas.addEventListener('pointerup', (event) => release(event));
  canvas.addEventListener('pointercancel', (event) => release(event, true));

  /*
   * Animations off (Windows 7 / 8 and weak computers start that way): nothing moves by itself, so
   * the picture is drawn only while something changes — the player being turned or turning back,
   * a new skin — and the GPU rests the rest of the time.
   */
  let shown = true;
  let awakeUntil = performance.now() + 1500;
  function wake(ms) {
    awakeUntil = Math.max(awakeUntil, performance.now() + ms);
    if (shown) viewer.renderPaused = false;
  }
  const restTimer = setInterval(() => {
    if (!shown || !still() || spin.dragging) return;
    if (performance.now() > awakeUntil) viewer.renderPaused = true;
  }, 300);

  let disposed = false;  canvas.addEventListener('webglcontextlost', () => {
    // three.js asks for the context back; when it does not come within a moment, start anew.
    setTimeout(() => {
      if (!disposed && viewer.renderer.getContext().isContextLost()) onLost?.();
    }, 600);
  });

  return {
    canvas,
    setSkin(source, model = 'classic') {
      wake(1500);
      viewer.loadSkin(source, { model: model === 'slim' ? 'slim' : 'default' });
    },
    setCape(source) {
      wake(1500);
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
      shown = active;
      wake(1500);
      viewer.renderPaused = !active;
    },
    dispose() {
      disposed = true;
      clearTimeout(idleTimer);
      clearInterval(restTimer);
      window.removeEventListener('pointermove', onPointer);
      effects?.dispose();
      viewer.dispose();
      try {
        viewer.renderer.forceContextLoss();
      } catch {
        // Already lost.
      }
    },
  };
}

export { GESTURES } from './gestures.js';
