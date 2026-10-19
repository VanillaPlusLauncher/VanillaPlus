'use strict';

const { isAllowed } = require('./rules');

/** Feature flags the launcher supports. All are off, which skips optional arguments. */
const DEFAULT_FEATURES = Object.freeze({
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
});

const DEFAULT_JVM_ARGUMENTS = [
  '-Djava.library.path=${natives_directory}',
  '-Dminecraft.launcher.brand=${launcher_name}',
  '-Dminecraft.launcher.version=${launcher_version}',
  '-cp',
  '${classpath}',
];

function replacePlaceholders(template, values) {
  return template.replace(/\$\{([^}]+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** True when the argument still contains an unresolved ${placeholder}. */
function hasUnresolvedPlaceholder(argument) {
  return /\$\{[^}]+\}/.test(argument);
}

/**
 * Removes arguments whose placeholders could not be filled. A "--flag" that
 * precedes such a value is removed together with it, so no orphan flags remain.
 */
function dropUnresolved(list) {
  const result = [];
  for (const argument of list) {
    if (hasUnresolvedPlaceholder(argument)) {
      if (result.length > 0 && result[result.length - 1].startsWith('--')) {
        result.pop();
      }
      continue;
    }
    result.push(argument);
  }
  return result;
}

/**
 * Expands one argument list (modern "arguments.game/jvm" format). Entries are
 * either plain strings or objects with rules and a value (string or array).
 */
function expandArgumentList(entries = [], features, values) {
  const result = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      result.push(replacePlaceholders(entry, values));
      continue;
    }
    if (!isAllowed(entry.rules, features)) {
      continue;
    }
    const list = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const value of list) {
      result.push(replacePlaceholders(value, values));
    }
  }
  return dropUnresolved(result);
}

/**
 * Builds the JVM and game arguments for a version descriptor.
 * `values` supplies every placeholder value (classpath, natives, account, paths).
 */
function buildLaunchArguments(descriptor, values, features = DEFAULT_FEATURES) {
  let jvm;
  let game;

  if (descriptor.arguments) {
    jvm = expandArgumentList(descriptor.arguments.jvm, features, values);
    game = expandArgumentList(descriptor.arguments.game, features, values);
  } else {
    // Pre-1.13 descriptors use a single space-separated string for game arguments.
    // Split before filling placeholders: paths with spaces (C:\Users\Ivan Petrov\...) must stay one argument.
    jvm = DEFAULT_JVM_ARGUMENTS.map((argument) => replacePlaceholders(argument, values));
    game = dropUnresolved(
      (descriptor.minecraftArguments ?? '')
        .split(' ')
        .filter((argument) => argument.length > 0)
        .map((argument) => replacePlaceholders(argument, values)),
    );
  }

  return { jvm, game, mainClass: descriptor.mainClass };
}

/** Splits a user-entered argument string on whitespace, honouring double quotes. */
function splitUserArguments(text) {
  if (!text || !text.trim()) {
    return [];
  }
  const matches = text.match(/"[^"]*"|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^"(.*)"$/, '$1'));
}

module.exports = { buildLaunchArguments, splitUserArguments, DEFAULT_FEATURES };
