import { api } from '../services/api.js';
import { getMcManifest, mcUrl, onMcReady } from '../core/mc.js';

/**
 * The window background: a Minecraft title-screen panorama, a slowly turning cube.
 *  "panorama"         — the latest version's (it comes with the game's textures);
 *  "panorama:<id>"    — one of another version (downloaded once, see main/minecraft/panoramas.js);
 *  "panorama:random"  — a different one on every start.
 * Falls back to a plain dark background while nothing is ready, and to the latest panorama when a
 * chosen one cannot be fetched (offline).
 */
let randomPick = null;

export function createBackground(element) {
  let kind = null;
  let token = 0;

  function buildCube(faces) {
    const cube = document.createElement('div');
    cube.className = 'panorama__cube';
    faces.forEach((face, index) => {
      const side = document.createElement('div');
      side.className = `panorama__face panorama__face--${index}`;
      side.style.backgroundImage = `url("${mcUrl(face)}")`;
      cube.append(side);
    });
    const wrapper = document.createElement('div');
    wrapper.className = 'panorama';
    wrapper.append(cube);
    return wrapper;
  }

  /** Shows the cube once all faces are decoded (no face-by-face pop-in), over the previous one. */
  function show(faces, current) {
    const wrapper = buildCube(faces);
    element.append(wrapper);
    element.dataset.kind = 'panorama';
    Promise.all(
      faces.map(
        (face) =>
          new Promise((resolve) => {
            const image = new Image();
            image.onload = image.onerror = resolve;
            image.src = mcUrl(face);
          }),
      ),
    ).then(() => {
      if (current !== token) {
        wrapper.remove();
        return;
      }
      wrapper.classList.add('panorama--visible');
      // The old cube fades out under the new one, then goes. When a newer cube came meanwhile, that
      // one clears up instead: two cleanups would remove each other's cube and leave the window black.
      setTimeout(() => {
        if (current !== token) return;
        [...element.children].filter((child) => child !== wrapper).forEach((child) => child.remove());
      }, 900);
    });
  }

  function latestFaces() {
    const faces = getMcManifest()?.textures.panorama ?? [];
    return faces.length >= 6 ? faces : null;
  }

  async function chosenId() {
    const id = kind?.startsWith('panorama:') ? kind.slice('panorama:'.length) : null;
    if (id !== 'random') return id;
    if (!randomPick) {
      const list = await api.app.panoramas().catch(() => []);
      randomPick = list.length ? list[Math.floor(Math.random() * list.length)].id : null;
    }
    return randomPick;
  }

  async function render() {
    const current = ++token;
    const id = await chosenId();
    let faces = null;
    if (id) {
      faces = await api.app.panoramaFaces(id).catch(() => null);
    }
    faces ??= latestFaces();
    if (current !== token) return;
    if (!faces) {
      element.replaceChildren();
      element.dataset.kind = 'plain';
      return;
    }
    show(faces, current);
  }

  function setKind(next) {
    const value = typeof next === 'string' && next.startsWith('panorama') ? next : 'panorama';
    if (value === kind) {
      return;
    }
    kind = value;
    render();
  }

  onMcReady(() => {
    if (!element.querySelector('.panorama')) {
      render();
    }
  });

  return { setKind };
}
