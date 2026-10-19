'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

/*
 * Versions without log4j (before 1.7) and their libraries (launchwrapper, jinput) log through
 * java.util.logging. Its default console output is two lines per message with a localized date
 * in the Windows code page. This config makes it one UTF-8 line in the same shape as newer
 * versions and keeps jinput's controller scan (harmless "Failed to initialize device") quiet.
 */

const CONFIG_FILE = 'legacy-logging.properties';
const CONFIG = [
  'handlers=java.util.logging.ConsoleHandler',
  '.level=INFO',
  'java.util.logging.ConsoleHandler.level=ALL',
  'java.util.logging.ConsoleHandler.encoding=UTF-8',
  'java.util.logging.ConsoleHandler.formatter=java.util.logging.SimpleFormatter',
  // [time] [logger/LEVEL]: message, then the stack trace if there is one.
  'java.util.logging.SimpleFormatter.format=[%1$tT] [%3$s/%4$s]: %5$s%6$s%n',
  'net.java.games.input.level=SEVERE',
  '',
].join('\n');

/** Writes the config into `directory` (if it changed) and returns the JVM argument that enables it. */
async function legacyLoggingArgument(directory) {
  const configPath = path.join(directory, CONFIG_FILE);
  const current = await fsp.readFile(configPath, 'utf8').catch(() => null);
  if (current !== CONFIG) {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(configPath, CONFIG, 'utf8');
  }
  return `-Djava.util.logging.config.file=${configPath}`;
}

module.exports = { legacyLoggingArgument };
