'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/*
 * Zip archives of whole folders (world backups) and unpacking (Java, backups). The bsdtar that
 * ships with the system does it in its own process (Windows 10 1803+, macOS); Windows 7 and 8 have
 * no tar.exe, and there adm-zip does it (asynchronous reading and inflating; packing a big world
 * takes the launcher a moment).
 */

function systemTar() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
}

function hasSystemTar() {
  return fs.existsSync(systemTar());
}

/** bsdtar reads "C:" in a path as a remote host: it only ever gets paths relative to `cwd`. */
function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(systemTar(), args, { cwd, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar завершился с кодом ${code}`))));
  });
}

/** Unpacks `zipPath` (a zip, or a tar.gz where tar exists) into the existing folder `targetDirectory`. */
function extractArchive(zipPath, targetDirectory) {
  if (hasSystemTar()) {
    // Relative names from the common parent: see runTar.
    const cwd = path.dirname(zipPath);
    return runTar(['-xf', path.basename(zipPath), '-C', path.relative(cwd, targetDirectory) || '.'], cwd);
  }
  const AdmZip = require('adm-zip');
  return new Promise((resolve, reject) => {
    try {
      new AdmZip(zipPath).extractAllToAsync(targetDirectory, true, false, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Packs the folder `relativeFolder` (inside `cwd`) into the zip `relativeZip` (also relative to
 * `cwd`); entries keep the folder's own path ("saves/<world>/…").
 */
function zipFolder(cwd, relativeFolder, relativeZip) {
  if (hasSystemTar()) return runTar(['-a', '-c', '-f', relativeZip, relativeFolder], cwd);
  const AdmZip = require('adm-zip');
  return new Promise((resolve, reject) => {
    const zip = new AdmZip();
    zip.addLocalFolderAsync(
      path.join(cwd, relativeFolder),
      (done, error) => {
        if (error) return reject(error);
        if (!done) return undefined;
        zip.writeZip(path.join(cwd, relativeZip), (writeError) => (writeError ? reject(writeError) : resolve()));
        return undefined;
      },
      relativeFolder.split(path.sep).join('/'),
    );
  });
}

module.exports = { hasSystemTar, extractArchive, zipFolder, runTar };
