'use strict';

/**
 * Runs `worker` over `items` with at most `limit` operations in flight.
 * The first error stops the remaining work and is rethrown.
 */
async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  let failure = null;

  const runner = async () => {
    while (!failure && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failure = failure ?? error;
        return;
      }
    }
  };

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  if (failure) {
    throw failure;
  }
}

module.exports = { runWithConcurrency };
