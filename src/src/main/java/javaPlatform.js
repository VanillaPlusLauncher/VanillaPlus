'use strict';

const path = require('node:path');

/*
 * What differs between systems for Java: the executable's name, which builds to download
 * (Windows x64; macOS on Apple Silicon or Intel) and in what kind of archive.
 */

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** "java.exe" on Windows, "java" elsewhere. */
const JAVA_BINARY = IS_WINDOWS ? 'java.exe' : 'java';

/** The java executable of a Java home folder. */
function javaIn(home) {
  return path.join(home, 'bin', JAVA_BINARY);
}

/**
 * The system as the Java vendors name it: os "windows" / "mac", arch "x64" / "aarch64",
 * archive "zip" (Windows) / "tar.gz" (macOS), label for messages.
 */
const PLATFORM = IS_MAC
  ? { os: 'mac', arch: process.arch === 'arm64' ? 'aarch64' : 'x64', archive: 'tar.gz', label: 'macOS' }
  : { os: 'windows', arch: 'x64', archive: 'zip', label: 'Windows' };

/** Mojang's name for this system in its list of Java runtimes. */
function mojangPlatformKey() {
  if (IS_MAC) return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (IS_WINDOWS) return 'windows-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux';
}

module.exports = { IS_WINDOWS, IS_MAC, JAVA_BINARY, javaIn, PLATFORM, mojangPlatformKey };
