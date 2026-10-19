'use strict';

const { safeStorage } = require('electron');
const { readJsonFile, writeJsonFileAtomic } = require('../core/jsonFile');
const { getAppPaths } = require('../core/paths');

const EMPTY_STORE = Object.freeze({ selectedId: null, accounts: [] });

/** Loads the account list. A corrupt file is treated as empty instead of crashing. */
async function loadAccountStore() {
  const data = await readJsonFile(getAppPaths().accountsFile, null);
  if (!data || !Array.isArray(data.accounts)) {
    return { ...EMPTY_STORE, accounts: [] };
  }
  return { selectedId: data.selectedId ?? null, accounts: data.accounts };
}

async function saveAccountStore(store) {
  await writeJsonFileAtomic(getAppPaths().accountsFile, store);
}

/** Encrypts a secret with the OS user key (DPAPI on Windows). Tokens are never stored in plain text. */
function encryptSecret(plainText) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Шифрование Windows недоступно, поэтому Microsoft-аккаунт нельзя сохранить безопасно.');
  }
  return safeStorage.encryptString(plainText).toString('base64');
}

function decryptSecret(encoded) {
  if (!encoded) {
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}

module.exports = { loadAccountStore, saveAccountStore, encryptSecret, decryptSecret };
