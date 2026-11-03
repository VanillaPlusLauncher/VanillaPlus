// Removes comments from the site's public files (.js, .css, .html) in the server package (argv[2]),
// so the page's code doesn't explain itself to visitors. The repository keeps the comments.
// JS is cut with a small tokenizer that knows strings, template literals and regex literals.
import fs from 'node:fs';
import path from 'node:path';

function stripJs(src) {
  let out = '';
  let i = 0;
  let last = ''; // last significant char, to tell a regex literal from a division
  const regexAllowed = () => last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(return|typeof|case|in|of|delete|void|throw|new)$/.test(out.trimEnd());
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (c === '`' && depth && src[j] === '}') { depth--; j++; continue; }
        if (src[j] === c && !depth) break;
        j++;
      }
      out += src.slice(i, j + 1); i = j + 1; last = c; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      j++;
      while (/[a-z]/i.test(src[j] || '')) j++;
      out += src.slice(i, j); i = j; last = 'r'; continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return tidy(out);
}

const tidy = (text) => text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, k, all) => l !== '' || (all[k - 1] ?? '') !== '').join('\n').replace(/^\n+/, '');
const stripCss = (src) => tidy(src.replace(/\/\*[\s\S]*?\*\//g, ''));
const stripHtml = (src) => tidy(src.replace(/<!--[\s\S]*?-->/g, ''));

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) { if (name !== 'downloads' && name !== 'lib') walk(file); continue; }
    const ext = path.extname(name).toLowerCase();
    const fn = ext === '.js' ? stripJs : ext === '.css' ? stripCss : ext === '.html' ? stripHtml : null;
    if (!fn) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = fn(before);
    fs.writeFileSync(file, after.endsWith('\n') ? after : after + '\n');
    console.log(`${path.relative(process.argv[2], file).padEnd(24)} ${before.length} -> ${after.length}`);
  }
}
walk(process.argv[2]);
