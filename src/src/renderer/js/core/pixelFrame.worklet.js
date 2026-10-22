/*
 * CSS Paint worklet "pixel-frame": the frame of a pixel-cut element follows its cut corners.
 * The corners are cut by a clip-path (a step of `cut` px), but a border or an inset box-shadow ring
 * is drawn along the plain rectangle, so the step itself had no line. Used as
 * `border-image: paint(pixel-frame) 0 fill / 0` (features.css), it draws over the element:
 *  - a border (which border-image replaces): the whole ring, along the step;
 *  - an inset ring (box-shadow "inset 0 0 0 Npx color", still drawn by the browser): only the two
 *    short lines of each step, joining the ring's sides.
 * Everything is read from the element's own computed style, so no rule needs extra variables.
 */

const NUMBER = /-?\d+(?:\.\d+)?/;
const CUT = /polygon\((?:evenodd,\s*)?0px (\d+(?:\.\d+)?)px/;
const COLOR = '(rgba?\\([^)]*\\)|#[0-9a-fA-F]{3,8}|[a-z]+)';
const RING_FIRST = new RegExp(`^\\s*inset ${COLOR} 0px 0px 0px (\\d+(?:\\.\\d+)?)px`);
const RING_LAST = new RegExp(`^\\s*${COLOR} 0px 0px 0px (\\d+(?:\\.\\d+)?)px inset`);

function transparent(color) {
  return color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color);
}

/** The first "inset 0 0 0 Npx color" of a box-shadow list: { color, width } or null. */
function insetRing(shadow) {
  // Commas inside rgba() would split a shadow: split only where a new shadow starts.
  for (const part of shadow.split(/,(?![^(]*\))/)) {
    const match = RING_LAST.exec(part) ?? RING_FIRST.exec(part);
    if (match) return { color: match[1], width: Number(match[2]) };
  }
  return null;
}

registerPaint(
  'pixel-frame',
  class {
    static get inputProperties() {
      return ['clip-path', 'border-top-style', 'border-top-width', 'border-top-color', 'box-shadow'];
    }

    paint(context, size, style) {
      const cut = Number(CUT.exec(String(style.get('clip-path')))?.[1] ?? 0);
      if (!cut) return;
      const ratio = globalThis.devicePixelRatio || 1;
      const snap = (value) => Math.round(value * ratio) / ratio;
      const W = size.width;
      const H = size.height;
      const c = snap(cut);

      const borderWidth = Number(NUMBER.exec(String(style.get('border-top-width')))?.[0] ?? 0);
      const borderColor = String(style.get('border-top-color')).trim();
      if (String(style.get('border-top-style')).trim() !== 'none' && borderWidth > 0) {
        if (transparent(borderColor)) return;
        // The border, which border-image replaces: a ring along the cut outline.
        const s = Math.max(snap(borderWidth), 1 / ratio);
        const outline = (o) => [
          [o, c + o], [c + o, c + o], [c + o, o], [W - c - o, o], [W - c - o, c + o], [W - o, c + o],
          [W - o, H - c - o], [W - c - o, H - c - o], [W - c - o, H - o], [c + o, H - o], [c + o, H - c - o], [o, H - c - o],
        ];
        context.fillStyle = borderColor;
        context.beginPath();
        for (const points of [outline(0), outline(s)]) {
          points.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
          context.closePath();
        }
        context.fill('evenodd');
        return;
      }

      const ring = insetRing(String(style.get('box-shadow')));
      if (!ring || transparent(ring.color)) return;
      // The browser draws the ring's sides; the step lines join them.
      const s = Math.max(snap(ring.width), 1 / ratio);
      const across = Math.max(0, c - s);
      context.fillStyle = ring.color;
      context.fillRect(c, s, s, c);
      context.fillRect(s, c, across, s);
      context.fillRect(W - c - s, s, s, c);
      context.fillRect(W - c, c, across, s);
      context.fillRect(c, H - c - s, s, c);
      context.fillRect(s, H - c - s, across, s);
      context.fillRect(W - c - s, H - c - s, s, c);
      context.fillRect(W - c, H - c - s, across, s);
    }
  },
);
