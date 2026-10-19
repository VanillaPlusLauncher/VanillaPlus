'use strict';

/*
 * How the launcher downloads, from Settings → "Библиотека" → "Загрузки" (settings.downloads):
 * how many files at once, and in how many parts a big file is downloaded at the same time (like a
 * browser's download manager: several connections, each one a piece of the file).
 */

/**
 * A file this big or bigger is split into parts. Kept low: where each connection is slow (a busy
 * CDN, a throttled route) even a 1–2 MB mod comes noticeably faster in a few parts.
 */
const SEGMENT_MIN_BYTES = 1024 * 1024;
/** No part smaller than this: more connections than that do not help. */
const MIN_PART_BYTES = 512 * 1024;

const config = { parallel: 8, segments: 4 };

function configureDownloads(input) {
  if (Number.isFinite(input?.parallel)) config.parallel = Math.min(32, Math.max(1, Math.round(input.parallel)));
  if (Number.isFinite(input?.segments)) config.segments = Math.min(16, Math.max(1, Math.round(input.segments)));
}

/** Files downloaded at the same time; `scale` lets many tiny files (assets) go faster still. */
function parallelDownloads(scale = 1) {
  return Math.max(1, Math.round(config.parallel * scale));
}

/** In how many parts `size` bytes are downloaded (1: as one piece). */
function segmentsFor(size) {
  if (!Number.isFinite(size) || size < SEGMENT_MIN_BYTES || config.segments < 2) return 1;
  return Math.max(1, Math.min(config.segments, Math.floor(size / MIN_PART_BYTES)));
}

module.exports = { configureDownloads, parallelDownloads, segmentsFor, SEGMENT_MIN_BYTES };
