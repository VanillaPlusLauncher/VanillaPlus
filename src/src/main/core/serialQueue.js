'use strict';

/**
 * Runs async tasks one after another. Used so that two installs never write
 * the same library or asset files at the same time.
 */
class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
}

module.exports = { SerialQueue };
