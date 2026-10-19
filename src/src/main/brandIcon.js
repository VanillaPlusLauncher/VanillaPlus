'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * The launcher's mark as a data URL, for the little pages of the notices and the tray menu.
 * The PNG file is used as it is: a copy made smaller with nativeImage can come out empty on screens
 * with Windows scaling (the tray menu then showed a broken picture). The page scales it itself.
 */

const ICON = path.join(__dirname, '..', '..', 'assets', 'branding', 'amethyx-mark.png');
let cached;

/** The mark as "data:image/png;base64,…", or null when the file cannot be read. */
function brandIconDataUrl() {
  if (cached === undefined) {
    try {
      cached = `data:image/png;base64,${fs.readFileSync(ICON).toString('base64')}`;
    } catch {
      cached = null;
    }
  }
  return cached;
}

module.exports = { brandIconDataUrl, BRAND_ICON_PATH: ICON };
