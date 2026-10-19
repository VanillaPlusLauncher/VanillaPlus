/** Small visual effects: pixel bursts on Play and floating sparks behind the home screen. */

const BURST_COLORS = ['var(--color-accent)', 'var(--color-accent-strong)', '#ffffff', '#ffd479'];

function animationsEnabled() {
  return document.documentElement.dataset.animations !== 'off';
}

/** Throws square "pixels" out of an element, like breaking a block. */
export function pixelBurst(element, { count = 22, colors = BURST_COLORS, spread = 160 } = {}) {
  if (!animationsEnabled() || !element) {
    return;
  }
  const rect = element.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  for (let index = 0; index < count; index += 1) {
    const particle = document.createElement('span');
    particle.className = 'pixel-burst';
    const angle = Math.random() * Math.PI * 2;
    const distance = spread * (0.35 + Math.random() * 0.65);
    const size = 4 + Math.round(Math.random() * 3) * 2;
    Object.assign(particle.style, {
      left: `${originX + (Math.random() - 0.5) * rect.width * 0.6}px`,
      top: `${originY + (Math.random() - 0.5) * rect.height * 0.4}px`,
      width: `${size}px`,
      height: `${size}px`,
      background: colors[index % colors.length],
    });
    particle.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--dy', `${Math.sin(angle) * distance - 40}px`);
    particle.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 360)}deg`);
    particle.style.setProperty('--life', `${700 + Math.random() * 600}ms`);
    document.body.append(particle);
    particle.addEventListener('animationend', () => particle.remove(), { once: true });
  }
}

/** Fills a container with slowly rising glowing pixels. */
export function createSparks(count = 18) {
  const container = document.createElement('div');
  container.className = 'sparks';
  container.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < count; index += 1) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    const size = 3 + Math.round(Math.random() * 3);
    Object.assign(spark.style, { left: `${Math.random() * 100}%`, width: `${size}px`, height: `${size}px` });
    spark.style.setProperty('--duration', `${10 + Math.random() * 14}s`);
    spark.style.setProperty('--delay', `${-Math.random() * 20}s`);
    spark.style.setProperty('--drift', `${(Math.random() - 0.5) * 120}px`);
    container.append(spark);
  }
  return container;
}

/** Counts a number up with an ease-out, for statistics. */
export function countUp(element, target, { duration = 900, format = (value) => String(value) } = {}) {
  if (!animationsEnabled()) {
    element.textContent = format(target);
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(Math.round(target * eased));
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}
