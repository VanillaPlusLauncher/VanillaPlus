/*
 * Little pixel effects around the 3D player: hearts for an air kiss, sparkles for "hello" and a
 * victory, notes for dancing, stars for a dab or flexing. Each sprite is a tiny pixel drawing scaled
 * up crisply; the particles float up, drift and fade (CSS animation), then remove themselves.
 * Nothing happens when animations are off.
 */

const SPRITES = {
  hearts: { colors: ['#ff5c7a', '#ff8fa3'], rows: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'] },
  sparkles: { colors: ['#d6c2ff', '#fff3b0', '#b18cff'], rows: ['...#...', '...#...', '..###..', '#######', '..###..', '...#...', '...#...'] },
  stars: { colors: ['#ffd23f', '#ffb703'], rows: ['..#..', '.###.', '#####', '.###.', '.#.#.'] },
  notes: { colors: ['#9be7ff', '#c3a6ff', '#ffb3dc'], rows: ['..###', '..#.#', '..#..', '..#..', '###..', '###..'] },
  // The pet creeper's sleep and its "puff".
  zzz: { colors: ['#e6dcff', '#b9a6ff'], rows: ['#####', '...#.', '..#..', '.#...', '#####'] },
  smoke: { colors: ['#e2e2e2', '#b4b4b4', '#ffffff', '#8c8c8c'], rows: ['.##.', '####', '####', '.##.'] },
};

const cache = new Map();

function sprite(kind, color) {
  const key = `${kind}:${color}`;
  if (!cache.has(key)) {
    const { rows } = SPRITES[kind];
    const canvas = document.createElement('canvas');
    canvas.width = rows[0].length;
    canvas.height = rows.length;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    rows.forEach((row, y) => [...row].forEach((cell, x) => cell === '#' && context.fillRect(x, y, 1, 1)));
    cache.set(key, canvas.toDataURL());
  }
  return cache.get(key);
}

/** A layer over `host` (which gets position: relative) that can emit particles. */
export function createParticles(host) {
  const layer = document.createElement('div');
  layer.className = 'particles';
  host.append(layer);
  return {
    /** `kind` from SPRITES; `count` particles from around the point (x, y) in % of the host. */
    emit(kind, { count = 9, x = 50, y = 35 } = {}) {
      if (!SPRITES[kind] || document.documentElement.dataset.animations === 'off') return;
      const { colors } = SPRITES[kind];
      for (let index = 0; index < count; index += 1) {
        const particle = document.createElement('img');
        particle.className = 'particles__item';
        particle.alt = '';
        particle.src = sprite(kind, colors[index % colors.length]);
        const size = 10 + Math.round(Math.random() * 8);
        particle.style.width = `${size}px`;
        particle.style.left = `${x + (Math.random() - 0.5) * 36}%`;
        particle.style.top = `${y + (Math.random() - 0.5) * 20}%`;
        particle.style.setProperty('--drift', `${(Math.random() - 0.5) * 70}px`);
        particle.style.setProperty('--rise', `${-60 - Math.random() * 70}px`);
        particle.style.setProperty('--spin', `${(Math.random() - 0.5) * 50}deg`);
        particle.style.animationDelay = `${index * 45}ms`;
        particle.addEventListener('animationend', () => particle.remove());
        layer.append(particle);
      }
    },
    dispose() {
      layer.remove();
    },
  };
}
