'use strict';

/*
 * Lists interface texts that have no translation yet. The interface is written in Russian; the
 * dictionaries in src/src/renderer/i18n/<lang>.json are keyed by the Russian text, with {0}, {1}…
 * where a template literal inserts values. Run with Node (or Electron with ELECTRON_RUN_AS_NODE=1):
 *
 *   node installer/tools/i18n-check.js            → missing texts per language
 *   node installer/tools/i18n-check.js --json     → the same as JSON, to translate and merge
 *
 * Log lines (log.info/warn/error) are skipped: they go to the log file, not the window.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'src', 'src');
const dictionaries = path.join(root, 'renderer', 'i18n');
const CYRILLIC = /[А-Яа-яЁё]/;

function files(directory, list = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/vendor|node_modules|i18n$/.test(full)) files(full, list);
    } else if (/\.(js|html)$/.test(entry.name)) {
      list.push(full);
    }
  }
  return list;
}

function texts() {
  const found = new Set();
  for (const file of files(root)) {
    const code = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line) && !/\b(log|console)\.(info|warn|error|debug|log)\(|reporter\.report\(|createLogger/.test(line))
      .join('\n');
    const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}]+)</g;
    for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
      let text = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!text || !CYRILLIC.test(text)) continue;
      if (match[3] !== undefined) {
        // Skip templates with nested templates or conditions: their parts are separate texts.
        if (/\$\{[^}]*[`?]/.test(text)) continue;
        let index = 0;
        text = text.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, () => `{${index++}}`);
      }
      found.add(text.trim().replace(/\\n/g, '\n'));
    }
  }
  return [...found];
}

const all = texts();
const report = {};
for (const file of fs.readdirSync(dictionaries).filter((name) => name.endsWith('.json'))) {
  const dictionary = JSON.parse(fs.readFileSync(path.join(dictionaries, file), 'utf8'));
  report[path.basename(file, '.json')] = all.filter((text) => dictionary[text] === undefined);
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const [language, missing] of Object.entries(report)) {
    console.log(`${language}: ${missing.length} missing of ${all.length}`);
    for (const text of missing.slice(0, 40)) console.log(`  · ${text}`);
  }
}
