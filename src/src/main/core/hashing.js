'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

/** Computes the SHA-1 hex digest of a file without loading it into memory. */
function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { sha1File };
