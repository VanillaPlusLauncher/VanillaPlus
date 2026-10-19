'use strict';

const { broadcast } = require('./broadcast');
const { CHANNELS } = require('../../shared/channels');

const THROTTLE_MS = 80;

/**
 * Creates a reporter that pushes task progress to the renderer.
 * Progress is throttled; the final 100% update is always delivered.
 *
 * Tasks: { taskId, kind: 'version' | 'java' | 'content' | …, label, instance? }. `instance` is the
 * name of the instance the task works on: the top bar shows it, so a download started on an
 * instance's page still says whose it is once you leave the page.
 */
function createTaskReporter({ taskId, kind, label, instance = null }) {
  let lastSentAt = 0;
  let lastStage = null;

  const send = (payload) => broadcast(CHANNELS.events.taskProgress, { taskId, kind, label, instance, ...payload });

  return {
    report(stage, percent, detail = '') {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      const now = Date.now();
      if (clamped < 100 && stage === lastStage && now - lastSentAt < THROTTLE_MS) {
        return;
      }
      lastSentAt = now;
      lastStage = stage;
      send({ state: 'running', stage, percent: clamped, detail });
    },
    finish(state, detail = '') {
      send({ state, stage: state, percent: state === 'done' ? 100 : 0, detail });
    },
  };
}

module.exports = { createTaskReporter };
