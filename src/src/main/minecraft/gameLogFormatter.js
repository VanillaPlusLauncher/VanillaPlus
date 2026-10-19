'use strict';

/*
 * Since 1.7 the game writes its console log as log4j XML events (the launcher's log config
 * asks for that). This turns each event back into a readable line, the way latest.log looks:
 *   [21:30:38] [Render thread/INFO]: Setting user: Rich
 * followed by the stack trace when there is one. Plain-text output passes through unchanged.
 */

const EVENT_START = '<log4j:Event';
const EVENT_END = '</log4j:Event>';
/** An unclosed event this long is not XML after all: give its lines back as they are. */
const MAX_EVENT_LINES = 4000;

function attribute(xml, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1] ?? '';
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of an element: CDATA sections (log4j splits a CDATA that contains "]]>") or escaped text. */
function elementText(xml, tag) {
  const match = new RegExp(`<log4j:${tag}>([\\s\\S]*?)</log4j:${tag}>`).exec(xml);
  if (!match) {
    return null;
  }
  const inner = match[1];
  if (inner.includes('<![CDATA[')) {
    return inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  }
  return decodeEntities(inner);
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  return date.toTimeString().slice(0, 8);
}

function formatEvent(xml) {
  const prefix = `[${formatTime(attribute(xml, 'timestamp'))}] [${decodeEntities(attribute(xml, 'thread'))}/${attribute(xml, 'level')}]: `;
  const message = elementText(xml, 'Message') ?? '';
  const throwable = elementText(xml, 'Throwable');
  const lines = message.split(/\r?\n/).map((line, index) => (index === 0 ? prefix + line : line));
  if (throwable) {
    lines.push(...throwable.replace(/\s+$/, '').split(/\r?\n/));
  }
  return lines;
}

/** Returns { push(line), flush() }; formatted lines go to `onLine`. */
function createGameLogFormatter(onLine) {
  let buffer = null;

  function push(line) {
    if (buffer === null) {
      if (!line.trimStart().startsWith(EVENT_START)) {
        onLine(line);
        return;
      }
      buffer = [];
    }
    buffer.push(line);
    if (line.includes(EVENT_END)) {
      const xml = buffer.join('\n');
      buffer = null;
      for (const formatted of formatEvent(xml)) {
        onLine(formatted);
      }
    } else if (buffer.length > MAX_EVENT_LINES) {
      flush();
    }
  }

  function flush() {
    if (buffer) {
      const pending = buffer;
      buffer = null;
      pending.forEach(onLine);
    }
  }

  return { push, flush };
}

module.exports = { createGameLogFormatter };
