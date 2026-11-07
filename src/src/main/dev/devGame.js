'use strict';

const { onBroadcast } = require('../core/broadcast');
const { CHANNELS } = require('../../shared/channels');

/*
 * The game as the developer API sees it: every line of its output with a stable number (the game's
 * own buffer drops old lines and renumbers), how the last run ended, the last crash report, and
 * waiting for a line or for the game to close. Fed by the events the game service sends the window.
 */

const MAX_LINES = 20000;
const lines = [];
/** Number of the first line still kept. */
let base = 0;
let lastState = 'idle';
let lastExit = null;
let lastCrash = null;
/** The last launch through the API: { instanceId, at, error }. */
let lastLaunch = null;
/** Instances the API launched in this run of the launcher (stop_game needs no question for them). */
const launchedByApi = new Set();
const waiters = new Set();
/** The crash report of the run that just ended is still being made (it comes seconds after the exit). */
let analyzing = false;
let analysisTimer = null;
const analysisWaiters = new Set();

const nextLine = () => base + lines.length;

function finishAnalysis() {
  analyzing = false;
  clearTimeout(analysisTimer);
  for (const resolve of [...analysisWaiters]) resolve();
  analysisWaiters.clear();
}

/** Resolves once the crash report of the last run is in (or after 15 s without one). */
const afterAnalysis = () => (analyzing ? new Promise((resolve) => analysisWaiters.add(resolve)) : Promise.resolve());
/** A problem found in a log (logAnalyzer.js), as the API gives it. */
const describeProblem = (problem) => ({ id: problem.id, title: problem.title ?? null, detail: problem.detail ?? null, fix: problem.fix ?? null });

onBroadcast(CHANNELS.events.gameLog, (line) => {
  const text = String(line ?? '');
  lines.push(text);
  if (lines.length > MAX_LINES) {
    const drop = lines.length - MAX_LINES;
    lines.splice(0, drop);
    base += drop;
  }
  const number = nextLine() - 1;
  for (const waiter of [...waiters]) waiter.onLine(text, number);
});

onBroadcast(CHANNELS.events.gameState, (state) => {
  const was = lastState;
  lastState = state?.state ?? 'idle';
  if (lastState !== 'idle' || was === 'idle') return;
  if (state.analyzing) {
    analyzing = true;
    clearTimeout(analysisTimer);
    analysisTimer = setTimeout(finishAnalysis, 15000);
  }
  if (was === 'running') {
    // exitCode null: stopped from the launcher (or by stop_game), not a crash.
    lastExit = { instanceId: state.instanceId ?? null, exitCode: state.exitCode ?? null, stoppedByRequest: state.exitCode === null, at: new Date().toISOString() };
  }
  // The launch's own error is filled in right after this event: the waiters look a moment later.
  setTimeout(() => {
    for (const waiter of [...waiters]) waiter.onIdle(was);
  }, 150);
});

onBroadcast(CHANNELS.events.gameCrash, (report) => {
  lastCrash = {
    instanceId: report?.instanceId ?? null,
    exitCode: report?.exitCode ?? null,
    exitText: report?.exitText ?? null,
    crash: report?.crash ?? null,
    problems: (report?.problems ?? []).map(describeProblem),
    log: report?.logId ?? null,
    at: new Date().toISOString(),
  };
  finishAnalysis();
});

/** Lines from number `from` (or the last `last` lines), optionally only those matching `filter`. */
function readLines({ from = null, last = 200, filter = null } = {}) {
  const start = from === null ? base : Math.max(base, from);
  let picked = lines.slice(start - base).map((text, index) => ({ n: start + index, text }));
  if (filter) picked = picked.filter((line) => filter.test(line.text));
  let truncated = false;
  if (picked.length > last) {
    truncated = true;
    // Without `from`: the newest lines; with it: the first ones, and nextLine continues after them.
    picked = from === null ? picked.slice(-last) : picked.slice(0, last);
  }
  const next = from !== null && truncated ? picked[picked.length - 1].n + 1 : nextLine();
  return { lines: picked, nextLine: next, truncated, firstKept: base };
}

function status() {
  const game = require('../minecraft/gameService').getStatus();
  return {
    state: game.state,
    instanceId: game.instanceId ?? null,
    startedAt: game.startedAt ?? null,
    nextLine: nextLine(),
    lastLaunch,
    lastExit,
    lastCrash,
  };
}

function noteLaunch(instanceId) {
  lastLaunch = { instanceId, at: new Date().toISOString(), fromLine: nextLine(), error: null };
  launchedByApi.add(instanceId);
  return lastLaunch;
}

function noteLaunchError(launch, error) {
  launch.error = error?.message ?? String(error);
}

/**
 * Waits for a line matching `pattern` (from line `from` on, earlier kept lines included), for the game
 * to close, or for `timeoutMs`. Resolves with { result: 'matched' | 'exited' | 'launch-failed' |
 * 'not-running' | 'timeout', line?, n?, status }.
 */
function waitFor({ pattern = null, from = null, timeoutMs }) {
  const state = () => require('../minecraft/gameService').getStatus().state;
  if (pattern && from !== null) {
    const earlier = readLines({ from, last: MAX_LINES, filter: pattern }).lines[0];
    if (earlier) return Promise.resolve({ result: 'matched', line: earlier.text, n: earlier.n, status: status() });
  }
  if (state() === 'idle') {
    // A game that crashed at once may be over before the AI asks: that is "exited", with the crash
    // report, not "not running".
    const launch = from !== null && lastLaunch && lastLaunch.fromLine >= from ? lastLaunch : null;
    if (!launch && !(from !== null && nextLine() > from)) {
      return Promise.resolve({ result: 'not-running', status: status() });
    }
    const result = launch?.error ? 'launch-failed' : 'exited';
    return afterAnalysis().then(() => ({ result, status: status() }));
  }
  return new Promise((resolve) => {
    const waiter = {
      onLine(text, n) {
        if (pattern?.test(text)) done({ result: 'matched', line: text, n });
      },
      onIdle(was) {
        done({ result: was === 'running' ? 'exited' : 'launch-failed' });
      },
    };
    const timer = setTimeout(() => done({ result: 'timeout' }), timeoutMs);
    function done(answer) {
      clearTimeout(timer);
      waiters.delete(waiter);
      // A closed game: the answer waits for its crash report, so the AI sees why at once.
      const ready = answer.result === 'exited' || answer.result === 'launch-failed' ? afterAnalysis() : Promise.resolve();
      ready.then(() => resolve({ ...answer, status: status() }));
    }
    waiters.add(waiter);
  });
}

module.exports = { readLines, status, waitFor, noteLaunch, noteLaunchError, launchedByApi, nextLine, describeProblem };
