import { api } from '../services/api.js';
import { h, icon } from './dom.js';

/**
 * A mod's (or pack's) picture. When it has none, or its picture does not load, the launcher looks
 * for one under the same name on CurseForge and Modrinth (main/content findIcon) and puts it in
 * place; until then — or if nothing is found — a cube stands there.
 * `project`: { iconUrl, title, slug, type }; `className` is the picture's class (the cube gets
 * `<className>--empty` too).
 */
export function projectIcon(project, className) {
  const placeholder = () => h('div', { class: `${className} ${className}--empty` }, icon('cube'));
  let element;
  const lookUp = () => {
    api.content
      .findIcon({ title: project.title, slug: project.slug, type: project.type })
      .then((url) => {
        if (!url || !element.isConnected) return;
        const picture = h('img', { class: className, src: url, alt: '', loading: 'lazy' });
        picture.addEventListener('error', () => picture.replaceWith(placeholder()), { once: true });
        element.replaceWith(picture);
        element = picture;
      })
      .catch(() => {});
  };
  if (project.iconUrl) {
    element = h('img', { class: className, src: project.iconUrl, alt: '', loading: 'lazy' });
    element.addEventListener(
      'error',
      () => {
        const cube = placeholder();
        element.replaceWith(cube);
        element = cube;
        lookUp();
      },
      { once: true },
    );
  } else {
    element = placeholder();
    // Asked once the cube is on the page (replaceWith needs it there).
    requestAnimationFrame(lookUp);
  }
  return element;
}
