'use strict';

const os = require('node:os');

/** OS name as used in Mojang version JSON rules. */
const CURRENT_OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

/** Architecture as used in Mojang rules: "x86" means 32-bit, "x64" means 64-bit. */
const CURRENT_ARCH_RULE = process.arch === 'ia32' ? 'x86' : 'x64';

function matchesOs(osRule) {
  if (osRule.name && osRule.name !== CURRENT_OS_NAME) {
    return false;
  }
  if (osRule.arch && osRule.arch !== CURRENT_ARCH_RULE) {
    return false;
  }
  if (osRule.version && !new RegExp(osRule.version).test(os.release())) {
    return false;
  }
  return true;
}

function ruleApplies(rule, features) {
  if (rule.os && !matchesOs(rule.os)) {
    return false;
  }
  if (rule.features) {
    for (const [feature, expected] of Object.entries(rule.features)) {
      if (Boolean(features[feature]) !== Boolean(expected)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Evaluates a Mojang rule list. Rules are applied in order and the last
 * matching rule wins. With no rules the entry is allowed; with rules but no
 * match it is disallowed.
 */
function isAllowed(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return true;
  }
  let allowed = false;
  for (const rule of rules) {
    if (ruleApplies(rule, features)) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

module.exports = { isAllowed, CURRENT_OS_NAME };
