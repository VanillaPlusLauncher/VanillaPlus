<?php
// Signed skins: Amethyx skins in games without mods. A game shows another player's skin only when
// the textures come signed by a key it trusts (authlib checks the signature, Mojang's way: SHA1
// with RSA over the base64 value). The launcher tells offline players' games to trust this
// server's key (GET /skin-key), and this server signs only what it builds itself: textures on its
// own address. So the key vouches for nothing but Amethyx skins.
//  - GET /signed/<ns>/<name>.json[?uuid=<32 hex>]: the player's profile as Mojang's session server
//    answers it, for the launcher that hosts a world (a friend joins) or for the player's own game.
//  - GET /signed/uuid/<32 hex>.json: a player known only by the id an offline server gives a name
//    (offline-mode servers, worlds opened to LAN); the game asks its launcher for such players.

if (!defined('AMX')) { http_response_code(404); exit; }

const CLOUD_PUBLIC_URL = 'https://launcher.x-world.plus/cloud';
// A game asks once for every player it meets; a full server is a few hundred.
const CLOUD_SKIN_RATE_LIMIT = 600;
const CLOUD_SKIN_KEY_BITS = 4096;
const CLOUD_SKIN_UNAVAILABLE = 'Подпись скинов недоступна.';
// The viewer's own kind of account first, as /csl does; for an id there is no viewer: offline first.
const CLOUD_SKIN_ORDER = ['offline' => 0, 'ely' => 1, 'ms' => 2];

// This server as the games reach it (the tests run on PHP's own server at another address).
function cloud_public_base(): string {
  if (PHP_SAPI === 'cli-server') return 'http://' . preg_replace('/[^A-Za-z0-9.:\-\[\]]/', '', (string) ($_SERVER['HTTP_HOST'] ?? '127.0.0.1')) . '/cloud';
  return CLOUD_PUBLIC_URL;
}

// The server's own RSA key, made on the first request that needs it and kept in cloud_state.
function cloud_skin_key() {
  static $key = null;
  if ($key !== null) return $key;
  if (!function_exists('openssl_pkey_new')) throw new CloudFailure(503, CLOUD_SKIN_UNAVAILABLE);
  $db = cloud_db();
  $row = cloud_row($db, "SELECT v FROM cloud_state WHERE k = 'skin_key'");
  if (!$row) {
    $made = openssl_pkey_new(['private_key_bits' => CLOUD_SKIN_KEY_BITS, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    $pem = '';
    if ($made === false || !openssl_pkey_export($made, $pem)) throw new CloudFailure(503, CLOUD_SKIN_UNAVAILABLE);
    // Two first requests at once: the first key stored wins, both use it.
    cloud_run($db, "INSERT OR IGNORE INTO cloud_state (k, v) VALUES ('skin_key', ?)", [$pem]);
    $row = cloud_row($db, "SELECT v FROM cloud_state WHERE k = 'skin_key'");
  }
  $loaded = $row ? openssl_pkey_get_private((string) $row['v']) : false;
  if ($loaded === false) throw new CloudFailure(503, CLOUD_SKIN_UNAVAILABLE);
  return $key = $loaded;
}

// GET /skin-key: the public key as base64 DER (X.509 SubjectPublicKeyInfo), as the game reads keys.
function cloud_skin_key_answer(): array {
  $details = openssl_pkey_get_details(cloud_skin_key());
  $der = preg_replace('/-----[^-]+-----|\s+/', '', (string) ($details['key'] ?? ''));
  if ($der === '') throw new CloudFailure(503, CLOUD_SKIN_UNAVAILABLE);
  return cloud_json(['publicKey' => $der], 200, ['Cache-Control' => 'public, max-age=3600']);
}

// The id an offline server gives a name: Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name).
function cloud_offline_uuid(string $name): string {
  $hash = md5('OfflinePlayer:' . $name, true);
  $hash[6] = chr((ord($hash[6]) & 0x0f) | 0x30);
  $hash[8] = chr((ord($hash[8]) & 0x3f) | 0x80);
  return bin2hex($hash);
}

// Mojang's profile answer with the textures property signed by this server.
function cloud_signed_profile(array $user, string $uuid, string $name): array {
  $base = cloud_public_base();
  $textures = [];
  if ($user['skin_hash']) {
    $textures['SKIN'] = ['url' => "$base/textures/{$user['skin_hash']}"];
    // Classic skins carry no metadata in Mojang's answers; older games expect exactly that.
    if ($user['skin_model'] === 'slim') $textures['SKIN']['metadata'] = ['model' => 'slim'];
  }
  if ($user['cape_hash']) $textures['CAPE'] = ['url' => "$base/textures/{$user['cape_hash']}"];
  $payload = ['timestamp' => cloud_ms(), 'profileId' => $uuid, 'profileName' => $name, 'textures' => (object) $textures];
  $value = base64_encode((string) json_encode($payload, CLOUD_JSON));
  $signature = '';
  if (!openssl_sign($value, $signature, cloud_skin_key(), OPENSSL_ALGO_SHA1)) throw new CloudFailure(503, CLOUD_SKIN_UNAVAILABLE);
  return ['id' => $uuid, 'name' => $name, 'properties' => [['name' => 'textures', 'value' => $value, 'signature' => base64_encode($signature)]]];
}

function cloud_signed_answer(?array $user, string $uuid, string $name): array {
  $cache = ['Cache-Control' => 'public, max-age=60'];
  if (!$user) return cloud_json(['errno' => 404, 'msg' => 'not found'], 404, $cache);
  return cloud_json(cloud_signed_profile($user, $uuid, $name), 200, $cache);
}

function cloud_signed_by_name(string $ns, string $name): array {
  cloud_rate_limit('skins', CLOUD_SKIN_RATE_LIMIT);
  $uuid = (string) ($_GET['uuid'] ?? '');
  if (!preg_match(CLOUD_UUID, $uuid)) $uuid = cloud_offline_uuid($name);
  return cloud_signed_answer(cloud_skin_owner($ns, $name), $uuid, $name);
}

// Ids are made from names, never the other way round: the players with a skin or a cape are
// looked through (a name taken over or given a #code is not one a game would show).
function cloud_signed_by_uuid(string $uuid): array {
  cloud_rate_limit('skins', CLOUD_SKIN_RATE_LIMIT);
  $found = null;
  // Offline ids are version 3; Microsoft's and Ely.by's are version 4 and come with their skins.
  if ($uuid[12] === '3') {
    $rows = cloud_rows(cloud_db(), "SELECT ns, name, skin_hash, skin_model, cape_hash, last_seen FROM users
      WHERE name_lower <> '' AND instr(name_lower, '#') = 0 AND (skin_hash IS NOT NULL OR cape_hash IS NOT NULL)");
    foreach ($rows as $user) {
      if (cloud_offline_uuid((string) $user['name']) !== $uuid) continue;
      $rank = CLOUD_SKIN_ORDER[$user['ns']] ?? 9;
      $best = $found ? (CLOUD_SKIN_ORDER[$found['ns']] ?? 9) : 99;
      if ($rank < $best || ($rank === $best && (int) $user['last_seen'] > (int) $found['last_seen'])) $found = $user;
    }
  }
  return cloud_signed_answer($found, $uuid, $found ? (string) $found['name'] : '');
}
