'use strict';

const { broadcast } = require('../core/broadcast');
const { CHANNELS } = require('../../shared/channels');
const { SerialQueue } = require('../core/serialQueue');
const { createLogger } = require('../core/logger');

/*
 * The protection of the player's instances from AI tools. An instance made through the developer API
 * is marked `test` (instanceStore.normalize): the API may change and delete it freely. Anything that
 * deletes or changes another instance asks the player in the launcher's window first (the renderer's
 * components/devConfirm.js); no answer in two minutes is a "no". The API cannot answer for the player:
 * the answer comes only over IPC from the window.
 */

const ANSWER_TIMEOUT_MS = 2 * 60 * 1000;
/** One question at a time: a busy AI must not stack ten dialogs on the player. */
const queue = new SerialQueue();
const pending = new Map();
const log = createLogger('dev');
let nextId = 1;

class DeniedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'denied';
  }
}

/**
 * Asks the player in the launcher's window. request: { action, instanceId, name, detail }.
 * Resolves with true only when the player pressed the button that allows it.
 */
function askPlayer(request) {
  return queue.run(
    () =>
      new Promise((resolve) => {
        const window = require('../window').getMainWindow();
        if (!window || window.isDestroyed()) {
          resolve(false);
          return;
        }
        const id = nextId++;
        const finish = (yes) => {
          const entry = pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(id);
          if (!window.isDestroyed()) window.flashFrame(false);
          log.info(`Действие ИИ «${request.action}» для «${request.name}»: ${yes ? 'разрешено' : 'не разрешено'}`);
          resolve(yes === true);
        };
        const timer = setTimeout(() => {
          broadcast(CHANNELS.events.devConfirm, { id, cancel: true });
          finish(false);
        }, ANSWER_TIMEOUT_MS);
        pending.set(id, { finish, timer });
        require('../tray').showWindow(window);
        window.flashFrame(true);
        broadcast(CHANNELS.events.devConfirm, { id, ...request });
      }),
  );
}

/** The player's answer from the window (IPC only). */
function answer(id, yes) {
  pending.get(Number(id))?.finish(yes === true);
}

/**
 * Lets an API call change `instance`: a test instance at once, the player's own only after they
 * allow it. action: 'delete' | 'addMods' | 'removeMod' | 'writeFile' | 'stopGame'.
 */
async function allowChange(instance, action, detail = '') {
  if (instance.test) {
    return;
  }
  const yes = await askPlayer({ action, instanceId: instance.id, name: instance.name, detail: String(detail ?? '').slice(0, 300) });
  if (!yes) {
    throw new DeniedError(
      `The player did not allow this in the launcher window: "${instance.name}" is the player's own instance, not a test one. ` +
        'Do not retry; use a test instance (create_test_instance) or ask the player.',
    );
  }
}

module.exports = { allowChange, askPlayer, answer, DeniedError };
