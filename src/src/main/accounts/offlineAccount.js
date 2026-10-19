'use strict';

const crypto = require('node:crypto');

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/**
 * Offline UUID as Minecraft computes it: MD5 of "OfflinePlayer:<name>",
 * formatted as a version-3 UUID. Same name always gives the same UUID, so saves stay linked.
 */
function offlineUuid(username) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Validates a nickname and returns the offline profile fields. */
function createOfflineProfile(rawUsername) {
  const username = String(rawUsername ?? '').trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('Ник должен содержать от 3 до 16 символов: латинские буквы, цифры или _.');
  }
  return { username, uuid: offlineUuid(username) };
}

module.exports = { createOfflineProfile, offlineUuid };
