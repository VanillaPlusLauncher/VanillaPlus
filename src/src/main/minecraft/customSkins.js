'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../core/logger');
const { loadSkin, loadCape, normalizeUuid } = require('../skins/skinStore');

/*
 * Amethyx skins and capes in modded instances, through CustomSkinLoader (GPL-3.0, by xfl03;
 * downloaded from Modrinth like any other mod, never bundled). The mod asks a list of skin sources
 * by player name, in order; the launcher writes that list before every launch:
 *  1. the player's own Amethyx skin and cape, from files next to the config (works offline);
 *  2. the Amethyx server: skins and capes of other Amethyx players (when it is configured);
 *  3. the usual source of the account type (Mojang or Ely.by), so everyone else looks as always.
 * Vanilla instances cannot load mods: there the skin of an offline account still comes from the
 * local profile server (skinAgent.js), Microsoft and Ely.by accounts keep their normal skins.
 */

const MODRINTH_PROJECT = 'idMHQ4n2';
const MOD_FILE = /customskinloader/i;
const DATA_FOLDER = 'CustomSkinLoader';
const OWN_FOLDER = 'Amethyx';
const log = createLogger('custom-skins');

/** Namespace on the Amethyx server: players are looked up among accounts of the viewer's kind. */
function namespaceOf(provider) {
  if (provider === 'microsoft') return 'ms';
  if (provider === 'ely') return 'ely';
  return 'offline';
}

function loadList({ session, model, serverUrl }) {
  const list = [
    {
      name: 'Amethyx',
      type: 'Legacy',
      checkPNG: false,
      skin: `${OWN_FOLDER}/skins/{USERNAME}.png`,
      model: model === 'slim' ? 'slim' : 'default',
      cape: `${OWN_FOLDER}/capes/{USERNAME}.png`,
      elytra: `${OWN_FOLDER}/capes/{USERNAME}.png`,
    },
  ];
  if (serverUrl) {
    list.push({ name: 'Amethyx Online', type: 'CustomSkinAPI', root: `${serverUrl}/csl/${namespaceOf(session.provider)}/` });
  }
  // The names "Mojang" and "ElyBy" are the mod's own: it fills in their addresses itself.
  list.push(session.provider === 'ely' ? { name: 'ElyBy', type: 'ElyByAPI', root: 'http://skinsystem.ely.by/textures/' } : { name: 'Mojang', type: 'MojangAPI' });
  return list;
}

/** Is CustomSkinLoader in the mods folder? 'enabled', 'disabled' (turned off by the player) or null. */
async function modState(modsDirectory) {
  let names = [];
  try {
    names = await fsp.readdir(modsDirectory);
  } catch {
    return null;
  }
  const files = names.filter((name) => MOD_FILE.test(name));
  if (files.some((name) => name.toLowerCase().endsWith('.jar'))) return 'enabled';
  return files.length ? 'disabled' : null;
}

/** The player's own skin and cape as files the mod reads; old ones are removed first. */
async function writeOwnTextures(dataDirectory, session) {
  const own = path.join(dataDirectory, OWN_FOLDER);
  await fsp.rm(own, { recursive: true, force: true });
  await fsp.mkdir(path.join(own, 'skins'), { recursive: true });
  await fsp.mkdir(path.join(own, 'capes'), { recursive: true });
  let uuid;
  try {
    uuid = normalizeUuid(session.uuid);
  } catch {
    return { skin: null, cape: null };
  }
  const [skin, cape] = await Promise.all([loadSkin(uuid), loadCape(uuid)]);
  // CustomSkinLoader looks files up by the in-game name; Windows file names ignore case like the mod.
  if (skin) await fsp.writeFile(path.join(own, 'skins', `${session.username}.png`), skin.png);
  if (cape) await fsp.writeFile(path.join(own, 'capes', `${session.username}.png`), cape);
  return { skin, cape };
}

/**
 * Before a launch: makes sure a modded instance has CustomSkinLoader and its source list.
 * Never blocks the launch: a failed step is written to the game log and skipped.
 * `installMod()` installs the mod from Modrinth into the instance (contentService.installProject).
 */
async function prepareCustomSkins({ settings, instance, session, gameDirectory, serverUrl, installMod, onLog = () => {} }) {
  if (instance.loader.type === 'vanilla' || settings.social?.skinsInMods === false) {
    return;
  }
  try {
    let state = await modState(path.join(gameDirectory, 'mods'));
    if (state === 'disabled') {
      onLog('Скины Amethyx: CustomSkinLoader выключен в этой сборке');
      return;
    }
    if (!state) {
      onLog('Скины Amethyx: ставим мод CustomSkinLoader…');
      try {
        await installMod(MODRINTH_PROJECT);
        state = 'enabled';
      } catch (error) {
        onLog(`Скины Amethyx: CustomSkinLoader не поставлен (${error.message})`);
        return;
      }
    }
    const dataDirectory = path.join(gameDirectory, DATA_FOLDER);
    const { skin, cape } = await writeOwnTextures(dataDirectory, session);
    const configPath = path.join(dataDirectory, 'CustomSkinLoader.json');
    let config = {};
    try {
      config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    } catch {
      // No config yet: the mod adds its other settings itself.
    }
    config.loadlist = loadList({ session, model: skin?.model, serverUrl });
    config.enableCape = true;
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
    const parts = [skin ? 'свой скин' : null, cape ? 'свой плащ' : null, serverUrl ? 'скины других игроков Amethyx' : null].filter(Boolean);
    onLog(`Скины Amethyx: ${parts.length ? parts.join(', ') : 'обычные скины'} (CustomSkinLoader)`);
  } catch (error) {
    log.warn(`CustomSkinLoader не настроен: ${error.message}`);
    onLog(`Скины Amethyx не настроены: ${error.message}`);
  }
}

module.exports = { prepareCustomSkins, namespaceOf, MODRINTH_PROJECT };
