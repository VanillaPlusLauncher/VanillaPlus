'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../core/logger');

/*
 * Versions before 1.6 have no --gameDir of their own. launchwrapper's VanillaTweakInjector writes
 * the game folder into a static field of the Minecraft class, but it does so on its own thread
 * while the game is already starting. Whatever reads the folder before that falls back to the
 * default %APPDATA%\.minecraft: in particular the world list and the save loader of the menu.
 * The integrated server reads it later and always gets the instance. So worlds were saved to the
 * instance but the menu looked for them in .minecraft and showed none.
 *
 * The fix: give the game a home whose default folder is a link to the instance. Whichever path
 * the game ends up with, both lead to the same files.
 */

const LEGACY_MAIN_CLASS = 'net.minecraft.launchwrapper.Launch';
/** Tweakers that start an old vanilla client (no tweakClass means VanillaTweaker). */
const VANILLA_TWEAKER = /^net\.minecraft\.launchwrapper\.(Alpha|Indev)?VanillaTweaker$/;
const log = createLogger('legacy-home');

/** True for old vanilla clients started by launchwrapper's vanilla tweakers. */
function needsLegacyHome(mainClass, gameArguments) {
  if (mainClass !== LEGACY_MAIN_CLASS) {
    return false;
  }
  const tweakIndex = gameArguments.indexOf('--tweakClass');
  return tweakIndex === -1 || VANILLA_TWEAKER.test(gameArguments[tweakIndex + 1] ?? '');
}

/** Where old Minecraft looks for its folder inside a home directory (see Minecraft.getAppDir). */
function defaultFolderInHome(home) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'minecraft');
  }
  return path.join(home, '.minecraft');
}

/** Points `linkPath` at `target`, replacing an older link. Returns false when a real folder is in the way. */
async function ensureLink(linkPath, target) {
  try {
    const stats = await fsp.lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      return false;
    }
    await fsp.unlink(linkPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  // A junction on Windows needs no admin rights; other systems ignore the type.
  await fsp.symlink(target, linkPath, 'junction');
  return true;
}

/**
 * Prepares the redirected home for an old version. Returns { jvmArgs, env } to add to the launch,
 * or empty lists when the version does not need it or the link could not be made.
 */
async function prepareLegacyHome({ layout, homeKey, gameDirectory, mainClass, gameArguments }) {
  const none = { jvmArgs: [], env: {} };
  if (!needsLegacyHome(mainClass, gameArguments)) {
    return none;
  }
  const home = layout.legacyHomeDirectory(homeKey);
  const linkPath = defaultFolderInHome(home);
  try {
    if (!(await ensureLink(linkPath, gameDirectory))) {
      log.warn(`${linkPath} — обычная папка, а не ссылка: старая версия может не найти свои миры`);
      return none;
    }
  } catch (error) {
    log.warn(`Не удалось связать папку игры ${homeKey}: ${error.message}`);
    return none;
  }
  // Windows builds the default folder from %APPDATA%, other systems from user.home.
  return process.platform === 'win32' ? { jvmArgs: [], env: { APPDATA: home } } : { jvmArgs: [`-Duser.home=${home}`], env: {} };
}

module.exports = { prepareLegacyHome };
