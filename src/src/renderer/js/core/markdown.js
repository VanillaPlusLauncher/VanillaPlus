/*
 * Project descriptions: Modrinth sends Markdown (often with HTML inside), CurseForge sends HTML.
 * Both end up as HTML that is cleaned by a whitelist before it touches the page: no scripts,
 * no styles, no event handlers, only https links and images.
 */

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'A', 'IMG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'CODE', 'PRE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'CENTER', 'DETAILS', 'SUMMARY',
  'SUP', 'SUB', 'SMALL', 'KBD', 'FIGURE', 'FIGCAPTION',
]);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META', 'SVG', 'MATH', 'NOSCRIPT', 'TEMPLATE']);

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, (_match, code) => `<code>${escapeHtml(code)}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
}

/** Small Markdown converter: headings, lists, quotes, code blocks, rules, paragraphs. HTML passes through. */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let paragraph = [];
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushParagraph();
      closeList();
      code = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
    } else if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      closeList();
      out.push('<hr>');
    } else if (!line.trim()) {
      flushParagraph();
      closeList();
    } else if (/^\s*</.test(line)) {
      flushParagraph();
      closeList();
      out.push(line);
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  closeList();
  if (code !== null) {
    out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}

function cleanNode(node, documentRef) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName;
      if (DROP_WITH_CONTENT.has(tag)) {
        child.remove();
        continue;
      }
      cleanNode(child, documentRef);
      if (!ALLOWED_TAGS.has(tag)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const keep =
          (tag === 'A' && name === 'href' && /^https:\/\//i.test(attribute.value)) ||
          (tag === 'IMG' && name === 'src' && /^https:\/\//i.test(attribute.value)) ||
          (tag === 'IMG' && (name === 'alt' || name === 'width' || name === 'height')) ||
          ((tag === 'TD' || tag === 'TH') && (name === 'colspan' || name === 'rowspan'));
        if (!keep) {
          child.removeAttribute(attribute.name);
        }
      }
      if (tag === 'IMG') {
        if (!child.getAttribute('src')) {
          child.remove();
          continue;
        }
        child.setAttribute('loading', 'lazy');
        child.setAttribute('referrerpolicy', 'no-referrer');
      }
    } else if (child.nodeType !== Node.TEXT_NODE) {
      child.remove();
    }
  }
}

/** Parses and whitelists HTML, returns a DocumentFragment safe to insert. */
export function safeHtml(html) {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  cleanNode(parsed.body, parsed);
  const fragment = document.createDocumentFragment();
  fragment.append(...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));
  return fragment;
}

export function renderDescription(body, format) {
  return safeHtml(format === 'markdown' ? markdownToHtml(body) : body);
}
