/*
 * The player on the home screen: the account's skin in 3D, turning its head after the mouse and
 * making gestures — a wave when you come back, a jump when the game starts, a spin for a new skin,
 * a greeting when the pointer comes onto it, and every 8–16 s something on its own (clapping,
 * stretching, a shrug, looking around, steps on the spot…), never the same twice in a row. All gestures are small functions of time (skinview3d's
 * FunctionAnimation), and the head keeps following the mouse during them.
 */

const LOOK_YAW = 0.9;
const LOOK_PITCH = 0.45;
const IDLE_MIN_MS = 8000;
const IDLE_MAX_MS = 16000;
// A greeting when the pointer comes onto the player, not more often than this.
const GREET_COOLDOWN_MS = 6000;
const IDLE_GESTURES = ['wave', 'nod', 'dance', 'crouch', 'punch', 'clap', 'stretch', 'shrug', 'lookAround', 'walk', 'salute', 'think', 'jumpSpin'];
const GREETINGS = ['wave', 'nod', 'salute', 'clap'];

const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));

/** Gestures: (player, t seconds) => done? Each starts from the resting pose. */
const GESTURES = {
  wave(player, t) {
    const lift = ease(t / 0.3) * (1 - ease((t - 1.6) / 0.3));
    player.skin.rightArm.rotation.z = -lift * 2.6;
    player.skin.rightArm.rotation.x = Math.sin(t * 11) * 0.35 * lift;
    return t > 1.9;
  },
  jump(player, t) {
    const phase = Math.min(t / 0.9, 1);
    player.position.y = Math.sin(phase * Math.PI) * 4;
    const arms = Math.sin(phase * Math.PI);
    player.skin.leftArm.rotation.z = arms * 2.4;
    player.skin.rightArm.rotation.z = -arms * 2.4;
    player.skin.leftLeg.rotation.x = -arms * 0.4;
    player.skin.rightLeg.rotation.x = arms * 0.4;
    return t > 1.1;
  },
  spin(player, t) {
    player.rotation.y = ease(t / 1.2) * Math.PI * 2;
    return t > 1.3;
  },
  nod(player, t) {
    player.skin.head.rotation.x += Math.sin(t * 12) * 0.35 * (1 - ease(t / 1.1));
    return t > 1.1;
  },
  punch(player, t) {
    const hit = Math.sin(Math.min(t / 0.5, 1) * Math.PI);
    player.skin.rightArm.rotation.x = -hit * 1.7;
    player.skin.body.rotation.y = -hit * 0.3;
    return t > 0.7;
  },
  crouch(player, t) {
    const down = Math.sin(Math.min(t / 1.0, 1) * Math.PI);
    player.skin.body.rotation.x = down * 0.45;
    player.skin.head.position.z = -down * 1;
    player.position.y = -down * 1.2;
    return t > 1.05;
  },
  dance(player, t) {
    const beat = Math.sin(t * 8);
    player.skin.leftArm.rotation.z = 0.4 + Math.max(0, beat) * 2;
    player.skin.rightArm.rotation.z = -0.4 - Math.max(0, -beat) * 2;
    player.rotation.y = Math.sin(t * 4) * 0.4;
    player.position.y = Math.abs(beat) * 0.8;
    return t > 2.4;
  },
  clap(player, t) {
    const lift = ease(t / 0.3) * (1 - ease((t - 1.5) / 0.3));
    const hands = Math.abs(Math.sin(t * 11));
    player.skin.leftArm.rotation.x = -1.35 * lift;
    player.skin.rightArm.rotation.x = -1.35 * lift;
    player.skin.leftArm.rotation.z = -(0.15 + hands * 0.3) * lift;
    player.skin.rightArm.rotation.z = (0.15 + hands * 0.3) * lift;
    return t > 1.8;
  },
  stretch(player, t) {
    const up = ease(t / 0.6) * (1 - ease((t - 1.6) / 0.5));
    player.skin.leftArm.rotation.z = up * 2.9;
    player.skin.rightArm.rotation.z = -up * 2.9;
    player.skin.head.rotation.x -= up * 0.35;
    player.skin.body.rotation.x = -up * 0.08;
    player.position.y = up * 0.4;
    return t > 2.1;
  },
  shrug(player, t) {
    const up = ease(t / 0.3) * (1 - ease((t - 1.0) / 0.3));
    player.skin.leftArm.rotation.z = up * 0.55;
    player.skin.rightArm.rotation.z = -up * 0.55;
    player.skin.leftArm.rotation.x = -up * 0.3;
    player.skin.rightArm.rotation.x = -up * 0.3;
    player.skin.head.rotation.z = up * 0.25;
    return t > 1.3;
  },
  lookAround(player, t) {
    const env = ease(t / 0.4) * (1 - ease((t - 2.3) / 0.4));
    player.skin.head.rotation.y += Math.sin(t * 2.4) * 0.95 * env;
    player.skin.head.rotation.x += Math.sin(t * 1.3) * 0.15 * env;
    return t > 2.7;
  },
  walk(player, t) {
    const env = ease(t / 0.3) * (1 - ease((t - 2.2) / 0.3));
    const step = Math.sin(t * 7);
    player.skin.leftLeg.rotation.x = step * 0.6 * env;
    player.skin.rightLeg.rotation.x = -step * 0.6 * env;
    player.skin.leftArm.rotation.x = -step * 0.5 * env;
    player.skin.rightArm.rotation.x = step * 0.5 * env;
    player.position.y = Math.abs(step) * 0.3 * env;
    return t > 2.5;
  },
  salute(player, t) {
    const lift = ease(t / 0.3) * (1 - ease((t - 1.3) / 0.3));
    player.skin.rightArm.rotation.x = -2.5 * lift;
    player.skin.rightArm.rotation.z = 0.55 * lift;
    player.skin.head.rotation.x -= 0.1 * lift;
    return t > 1.6;
  },
  think(player, t) {
    const lift = ease(t / 0.4) * (1 - ease((t - 2.0) / 0.4));
    player.skin.rightArm.rotation.x = -1.9 * lift;
    player.skin.rightArm.rotation.z = 0.7 * lift;
    player.skin.head.rotation.x += 0.2 * lift;
    player.skin.head.rotation.z = -0.15 * lift + Math.sin(t * 3) * 0.05 * lift;
    return t > 2.4;
  },
  jumpSpin(player, t) {
    const phase = Math.min(t / 1.0, 1);
    player.position.y = Math.sin(phase * Math.PI) * 5;
    player.rotation.y = ease(phase) * Math.PI * 2;
    const arms = Math.sin(phase * Math.PI);
    player.skin.leftArm.rotation.z = arms * 1.8;
    player.skin.rightArm.rotation.z = -arms * 1.8;
    return t > 1.15;
  },
};

function resetPose(player) {
  for (const part of ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']) {
    player.skin[part].rotation.set(0, 0, 0);
  }
  player.skin.head.position.z = 0;
  player.position.y = 0;
  player.rotation.set(0, 0, 0);
}

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

  function play(name) {
    if (!GESTURES[name] || document.documentElement.dataset.animations === 'off') return;
    gesture = name;
    gestureStart = viewer.animation.progress;
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
    /** Off-screen: nothing is drawn (saves the GPU while another page is open). */
    setActive(active) {
      viewer.renderPaused = !active;
    },
    dispose() {
      clearTimeout(idleTimer);
      window.removeEventListener('pointermove', onPointer);
      viewer.dispose();
    },
  };
}

export { GESTURES };
