/*
 * The start screen (its markup is in index.html, so it is there from the very first frame): the
 * launcher's X, its name, a loading bar and what is loading. The bar is an amethyst crystal growing
 * along it: faceted, a glint running over it, a crystal tip at its end and little sparkles popping
 * off the tip (features.css, .splash__*). Meanwhile everything the launcher needs is fetched (its
 * look, instances, accounts, fonts, news); when all of it is in, the screen fades and the launcher
 * is ready.
 */

/** Sparkles fly off the crystal's tip while the screen is up. Returns a function that stops them. */
function startSparkles(track, bar) {
  let running = true;
  const spawn = () => {
    if (!running) return;
    const spark = document.createElement('span');
    spark.className = 'splash__spark';
    spark.style.left = `${bar.offsetWidth + 2}px`;
    spark.style.setProperty('--fly-x', `${Math.round(6 + Math.random() * 16)}px`);
    spark.style.setProperty('--fly-y', `${Math.round(-10 - Math.random() * 18)}px`);
    spark.addEventListener('animationend', () => spark.remove());
    track.append(spark);
    setTimeout(spawn, 140 + Math.random() * 220);
  };
  spawn();
  return () => {
    running = false;
  };
}

/**
 * Runs the start-up `tasks` ([{ label, run: () => Promise }]) all at once behind the start screen,
 * shows what is loading, and fades the screen out when all are done — never before `minMs` (the
 * crystal gets to grow a little) and never later than `maxMs`. Resolves when the launcher can be used.
 */
export function runSplash({ tasks, minMs = 1500, maxMs = 15000 }) {
  const splash = document.getElementById('splash');
  if (!splash) return Promise.all(tasks.map((task) => task.run().catch(() => {})));
  const status = splash.querySelector('.splash__status');
  const track = splash.querySelector('.splash__track');
  const bar = splash.querySelector('.splash__bar');
  const stopSparkles = startSparkles(track, bar);
  const started = performance.now();
  const pending = new Set(tasks);
  let done = 0;

  const showProgress = () => {
    // A little of the crystal from the start, so the bar is never an empty slot.
    bar.style.width = `${Math.round(8 + (done / Math.max(1, tasks.length)) * 92)}%`;
    const next = [...pending][0];
    status.textContent = next ? `${next.label}…` : 'Готово';
  };
  showProgress();

  const all = Promise.all(
    tasks.map((task) =>
      Promise.resolve()
        .then(() => task.run())
        .catch(() => {})
        .finally(() => {
          pending.delete(task);
          done += 1;
          showProgress();
        }),
    ),
  );
  const timeout = new Promise((resolve) => setTimeout(resolve, maxMs));
  return Promise.race([all, timeout])
    .then(() => new Promise((resolve) => setTimeout(resolve, Math.max(0, minMs - (performance.now() - started)))))
    .then(
      () =>
        new Promise((resolve) => {
          splash.classList.add('splash--leaving');
          setTimeout(() => {
            stopSparkles();
            splash.remove();
            resolve();
          }, 520);
        }),
    );
}
