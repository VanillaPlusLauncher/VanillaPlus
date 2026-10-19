'use strict';

const { execFile } = require('node:child_process');

/*
 * Java writes to a pipe in the Windows ANSI code page unless told otherwise (Java 8 always,
 * newer versions for some messages), while most output is ASCII or UTF-8. Each line is decoded
 * as UTF-8 first and in the system code page when it is not valid UTF-8.
 */

/** Code pages whose WHATWG encoding label is not simply "windows-<number>". */
const SPECIAL_LABELS = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874' };
const DEFAULT_CODE_PAGE = 1252;

let fallbackDecoderPromise = null;

function readAnsiCodePage() {
  if (process.platform !== 'win32') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        const match = /ACP\s+REG_SZ\s+(\d+)/.exec(stdout ?? '');
        resolve(error || !match ? null : Number(match[1]));
      },
    );
  });
}

function decoderFor(codePage) {
  const label = SPECIAL_LABELS[codePage] ?? `windows-${codePage}`;
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder(`windows-${DEFAULT_CODE_PAGE}`);
  }
}

/** Decoder for the system code page; looked up once. */
function getFallbackDecoder() {
  fallbackDecoderPromise ??= readAnsiCodePage().then((codePage) => decoderFor(codePage ?? DEFAULT_CODE_PAGE));
  return fallbackDecoderPromise;
}

/** Returns decode(buffer) → string: UTF-8 when valid, the system code page otherwise. */
async function createConsoleDecoder() {
  const fallback = await getFallbackDecoder();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  return (buffer) => {
    try {
      return utf8.decode(buffer);
    } catch {
      return fallback.decode(buffer);
    }
  };
}

module.exports = { createConsoleDecoder };
