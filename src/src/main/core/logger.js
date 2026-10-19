'use strict';

const fs = require('node:fs');
const path = require('node:path');

let logFilePath = null;

/** Enables file logging into the given directory. Console logging works without it. */
function initLogger(logsDirectory) {
  fs.mkdirSync(logsDirectory, { recursive: true });
  logFilePath = path.join(logsDirectory, 'launcher.log');
}

function write(level, scope, message) {
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `${line}\n`);
    } catch {
      // Logging must never take the launcher down.
    }
  }
}

function createLogger(scope) {
  return {
    info: (message) => write('INFO', scope, message),
    warn: (message) => write('WARN', scope, message),
    error: (message) => write('ERROR', scope, message),
  };
}

module.exports = { initLogger, createLogger };
