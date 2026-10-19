/*
 * 3D player model with animations, on top of skinview3d (window.skinview3d, MIT licence).
 * Drag to rotate, wheel to zoom. Falls back to nothing when WebGL is unavailable.
 */

import { GESTURES, resetPose } from './gestures.js';

export const ANIMATIONS = [
  { key: 'idle', label: 'Стоит', create: (lib) => new lib.IdleAnimation() },
  { key: 'walk', label: 'Идёт', create: (lib) => new lib.WalkingAnimation() },
  { key: 'run', label: 'Бежит', create: (lib) => new lib.RunningAnimation() },
  { key: 'fly', label: 'Летит', create: (lib) => new lib.FlyingAnimation() },
  { key: 'wave', label: 'Машет', create: (lib) => new lib.WaveAnimation() },
  { key: 'crouch', label: 'Присел', create: (lib) => new lib.CrouchAnimation() },
  { key: 'hit', label: 'Удар', create: (lib) => new lib.HitAnimation() },
  { key: 'swim', label: 'Плывёт', create: (lib) => new lib.SwimAnimation() },
  { key: 'none', label: 'Замер', create: () => null },
];

const PARTS = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
// THREE.NearestFilter, LinearFilter, LinearMipmapLinearFilter.
const NEAREST_FILTER = 1003;
const LINEAR_FILTER = 1006;
const LINEAR_MIPMAP_LINEAR_FILTER = 1008;
// THREE.LinearSRGBColorSpace.
const LINEAR_SRGB_COLOR_SPACE = 'srgb-linear';
// Tiny5 is drawn on an 8px grid: one font pixel is 1/8 of the font size.
const PIXEL_FONT_SIZE = 8;
const PIXEL_STEP = 10;

/**
 * The nickname as a tiny canvas: each font pixel becomes exactly one canvas pixel, white on the
 * game's translucent black, with a pixel of margin. Drawn PIXEL_STEP times larger first, then each
 * grid cell is read at its centre, which drops the soft edges of the browser's text rendering.
 */
function pixelNameTag(name) {
  const cellsHigh = 12;
  const baselineCell = 9;
  const big = document.createElement('canvas');
  const bigContext = big.getContext('2d', { willReadFrequently: true });
  bigContext.font = `${PIXEL_FONT_SIZE * PIXEL_STEP}px Tiny5`;
  const cellsWide = Math.ceil(bigContext.measureText(name).width / PIXEL_STEP) + 2;
  big.width = cellsWide * PIXEL_STEP;
  big.height = cellsHigh * PIXEL_STEP;
  bigContext.font = `${PIXEL_FONT_SIZE * PIXEL_STEP}px Tiny5`;
  bigContext.fillStyle = '#fff';
  bigContext.fillText(name, PIXEL_STEP, baselineCell * PIXEL_STEP);
  const data = bigContext.getImageData(0, 0, big.width, big.height).data;
  const on = (cx, cy) => data[((cy * PIXEL_STEP + PIXEL_STEP / 2) * big.width + cx * PIXEL_STEP + PIXEL_STEP / 2) * 4 + 3] > 127;
  let top = cellsHigh;
  let bottom = -1;
  let left = cellsWide;
  let right = -1;
  for (let cy = 0; cy < cellsHigh; cy += 1) {
    for (let cx = 0; cx < cellsWide; cx += 1) {
      if (on(cx, cy)) {
        top = Math.min(top, cy);
        bottom = Math.max(bottom, cy);
        left = Math.min(left, cx);
        right = Math.max(right, cx);
      }
    }
  }
  if (bottom < 0) {
    top = 0;
    bottom = 0;
    left = 0;
    right = 0;
  }
  // The game's tag: one pixel of background around the letters (and the full cap height kept).
  top = Math.min(top, baselineCell - 5);
  const small = document.createElement('canvas');
  small.width = right - left + 3;
  small.height = bottom - top + 3;
  const context = small.getContext('2d');
  context.fillStyle = 'rgba(0, 0, 0, 0.3)';
  context.fillRect(0, 0, small.width, small.height);
  context.fillStyle = '#fff';
  for (let cy = top; cy <= bottom; cy += 1) {
    for (let cx = left; cx <= right; cx += 1) {
      if (on(cx, cy)) context.fillRect(cx - left + 1, cy - top + 1, 1, 1);
    }
  }
  return small;
}

/**
 * `light`: for several models on one screen (the Wardrobe) — rendered at a lower resolution, which
 * keeps four live models smooth.
 */
export function createSkinViewer3d({ width = 280, height = 400, light = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'skin3d__canvas';
  const lib = window.skinview3d;
  if (!lib) {
    return null;
  }
  let viewer;
  try {
    viewer = new lib.SkinViewer({ canvas, width, height, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  // Smooth edges by rendering at twice the screen resolution, not by the FXAA pass: FXAA blurred
  // every hard pixel edge, the nickname's letters most of all.
  if (viewer.fxaaPass) viewer.fxaaPass.enabled = false;
  // Without FXAA the scene renders straight to the screen, where three.js would convert the skin
  // colours to sRGB a second time (skinview3d turns colour management off) and wash them out.
  viewer.renderer.outputColorSpace = LINEAR_SRGB_COLOR_SPACE;
  viewer.pixelRatio = light ? Math.min(2, (window.devicePixelRatio || 1) * 1.25) : Math.min(3, (window.devicePixelRatio || 1) * 2);
  viewer.fov = 45;
  // Room above the head: the nickname stays in view when the running model bounces.
  viewer.zoom = 0.74;
  viewer.autoRotate = true;
  viewer.autoRotateSpeed = 0.55;
  viewer.controls.enablePan = false;
  viewer.animation = new lib.IdleAnimation();

  let pendingSource = null;
  let pendingFrame = 0;
  let model = 'default';
  let animationKey = 'idle';

  function flush() {
    pendingFrame = 0;
    if (pendingSource) {
      viewer.loadSkin(pendingSource, { model });
      pendingSource = null;
    }
  }

  return {
    canvas,
    /** Shows a skin: a canvas (live editing), an image or a data URL. Updates are batched per frame. */
    setSkin(source, skinModel = 'classic') {
      model = skinModel === 'slim' ? 'slim' : 'default';
      pendingSource = source;
      if (!pendingFrame) {
        pendingFrame = requestAnimationFrame(flush);
      }
    },
    setCape(dataUrl) {
      if (dataUrl) {
        viewer.loadCape(dataUrl).catch?.(() => {});
      } else {
        viewer.resetCape();
      }
    },
    setAnimation(key) {
      animationKey = key;
      const entry = ANIMATIONS.find((candidate) => candidate.key === key) ?? ANIMATIONS[0];
      viewer.animation = entry.create(lib);
    },
    get animation() {
      return animationKey;
    },
    /** One of the player's gestures (gestures.js), then back to standing. */
    playGesture(name) {
      const gesture = GESTURES[name];
      if (!gesture || document.documentElement.dataset.animations === 'off') return;
      animationKey = name;
      let start = null;
      let done = false;
      viewer.animation = new lib.FunctionAnimation((player, progress) => {
        resetPose(player);
        // Breathing arms between the moves, like the game's idle pose.
        player.skin.leftArm.rotation.z = 0.03 * Math.cos(progress * 2) + 0.06;
        player.skin.rightArm.rotation.z = -0.03 * Math.cos(progress * 2) - 0.06;
        start ??= progress;
        if (!done && gesture(player, progress - start)) {
          done = true;
          queueMicrotask(() => animationKey === name && this.setAnimation('idle'));
        }
      });
    },
    /** Hidden models are not drawn at all. */
    setPaused(paused) {
      viewer.renderPaused = paused;
    },
    setAutoRotate(value) {
      viewer.autoRotate = value;
    },
    setNameTag(name) {
      if (!name) {
        viewer.nameTag = null;
        return;
      }
      const pixel = document.documentElement.dataset.font === 'pixel';
      const font = pixel ? `${PIXEL_FONT_SIZE * PIXEL_STEP}px Tiny5` : '48px Inter';
      // The tag is a canvas texture: the web font must be loaded before it is drawn.
      document.fonts
        .load(font)
        .catch(() => {})
        .then(() => {
          const tag = new lib.NameTagObject(name, { font, backgroundStyle: 'rgba(0, 0, 0, 0.3)' });
          // skinview3d paints once the font is ready; the texture is replaced right after.
          const paint = tag.paint.bind(tag);
          tag.paint = () => {
            paint();
            const texture = tag.textMaterial?.map;
            if (!texture) return;
            if (pixel) {
              // Like the game: one texel per font pixel, only ever magnified, so it stays crisp
              // while the model moves (a big texture shrunk with nearest sampling loses pixels).
              const image = pixelNameTag(name);
              texture.image = image;
              tag.scale.x = (image.width / image.height) * tag.height;
              texture.magFilter = NEAREST_FILTER;
              texture.minFilter = NEAREST_FILTER;
              texture.generateMipmaps = false;
            } else {
              texture.magFilter = LINEAR_FILTER;
              texture.minFilter = LINEAR_MIPMAP_LINEAR_FILTER;
              texture.generateMipmaps = true;
            }
            texture.needsUpdate = true;
          };
          viewer.nameTag = tag;
        });
    },
    setOuterLayer(visible) {
      for (const part of PARTS) {
        const object = viewer.playerObject.skin[part];
        if (object?.outerLayer) {
          object.outerLayer.visible = visible;
        }
      }
    },
    setSize(nextWidth, nextHeight) {
      viewer.setSize(nextWidth, nextHeight);
    },
    /** PNG snapshot of the current view (for library thumbnails). */
    snapshot() {
      return canvas.toDataURL('image/png');
    },
    /**
     * The WebGL context is let go at once: Chromium keeps at most 16 per page and, past that, takes
     * the oldest one away — the home player's, after the Wardrobe had been opened a few times.
     */
    dispose() {
      viewer.dispose();
      try {
        viewer.renderer.forceContextLoss();
      } catch {
        // Already lost.
      }
    },
  };
}
