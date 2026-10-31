<?php
// Accounts of the Amethyx server: sign-in, sessions, the player's own skin, cape and presence, and
// the skins other players' games load (CustomSkinLoader's CustomSkinAPI).
//  - Microsoft and Ely.by: proven the way Minecraft servers check players. The launcher "joins" a
//    server id with its game session at Mojang or Ely.by; this server asks them whether it did.
//    The game token itself never comes here.
//  - Offline: no account to check. The first launcher that takes a name gets a secret for it;
//    later ones with the same name get "Name#code" (see cloud_offline_sign_in).

if (!defined('AMX')) { http_response_code(404); exit; }

const CLOUD_NAMESPACES = ['ms', 'ely', 'offline'];
const CLOUD_NAME = '/^[A-Za-z0-9_]{1,16}$/D';
const CLOUD_UUID = '/^[0-9a-f]{32}$/D';
const CLOUD_HEX64 = '/^[0-9a-f]{64}$/D';
const CLOUD_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CLOUD_CHALLENGE_MS = 2 * 60 * 1000;
// The launcher reports every 5 minutes while it is open.
const CLOUD_ONLINE_MS = 7 * 60 * 1000;
const CLOUD_CAPE_WIDTHS = [64, 128, 256, 512];
const CLOUD_STATUSES = ['online', 'playing'];
const CLOUD_HAS_JOINED = [
  'ms' => 'https://sessionserver.mojang.com/session/minecraft/hasJoined',
  'ely' => 'https://authserver.ely.by/session/hasJoined',
];

// Where to ask Mojang / Ely.by. The tests run on PHP's own server and point this at a fake one;
// on the hosting (Apache, FPM) the variable is never read.
function cloud_has_joined_url(string $ns): string {
  if (PHP_SAPI === 'cli-server') {
    $fake = getenv('AMX_CLOUD_TEST_SESSION_SERVER');
    if (is_string($fake) && $fake !== '') return rtrim($fake, '/') . '/' . $ns;
  }
  return CLOUD_HAS_JOINED[$ns];
}

// ---- Users and sessions ---------------------------------------------------

function cloud_user_by_id(string $id): ?array {
  return cloud_row(cloud_db(), 'SELECT * FROM users WHERE id = ?', [$id]);
}

function cloud_user_by_name(string $ns, string $name): ?array {
  return cloud_row(cloud_db(), 'SELECT * FROM users WHERE ns = ? AND name_lower = ? LIMIT 1', [$ns, strtolower($name)]);
}

function cloud_is_online(array $user): bool {
  return cloud_ms() - (int) $user['last_seen'] < CLOUD_ONLINE_MS;
}

// What other players may see. Presence details only for friends ($withPresence).
function cloud_public_user(array $user, bool $withPresence = false): array {
  // An offline player whose name was already taken has a code: friends add them as "Name#code".
  $lower = (string) $user['name_lower'];
  $tag = $user['ns'] === 'offline' && strpos($lower, '#') !== false ? explode('#', $lower)[1] : null;
  $result = [
    'id' => $user['id'], 'ns' => $user['ns'], 'name' => $user['name'], 'tag' => $tag,
    'skin' => $user['skin_hash'] ?? null, 'model' => $user['skin_model'] ?? 'classic', 'cape' => $user['cape_hash'] ?? null,
  ];
  if ($withPresence) {
    $presence = $user['presence'] ? json_decode((string) $user['presence']) : null;
    $result['online'] = cloud_is_online($user);
    $result['presence'] = $result['online'] ? $presence : null;
    $result['lastSeen'] = (int) $user['last_seen'] ?: null;
  }
  return $result;
}

function cloud_create_session(array $user): array {
  $token = cloud_random_hex(32);
  cloud_tx(cloud_db(), function (PDO $db) use ($user, $token) {
    $now = cloud_ms();
    cloud_run($db, 'DELETE FROM sessions WHERE user_id = ? AND expires_at < ?', [$user['id'], $now]);
    cloud_run($db, 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hash('sha256', $token), $user['id'], $now + CLOUD_SESSION_MS]);
  });
  return cloud_json(['token' => $token, 'user' => cloud_public_user($user, true)]);
}

// The signed-in player of this request: "Authorization: Bearer <token>", only its SHA-256 is kept.
function cloud_authenticate(): array {
  $header = cloud_authorization();
  $token = strpos($header, 'Bearer ') === 0 ? trim(substr($header, 7)) : '';
  if (!preg_match(CLOUD_HEX64, $token)) throw new CloudFailure(401, 'Нужен вход.');
  $row = cloud_row(cloud_db(), 'SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?', [hash('sha256', $token), cloud_ms()]);
  if (!$row) throw new CloudFailure(401, 'Вход устарел.');
  return $row;
}

// ---- Sign-in --------------------------------------------------------------

function cloud_start_challenge(): array {
  $body = cloud_read_json();
  $ns = cloud_str($body['ns'] ?? null);
  $name = cloud_str($body['name'] ?? null);
  $uuid = cloud_str($body['uuid'] ?? null);
  if (!isset(CLOUD_HAS_JOINED[$ns]) || !preg_match(CLOUD_NAME, $name) || !preg_match(CLOUD_UUID, $uuid)) throw new CloudFailure(400, 'Неверные данные аккаунта.');
  $id = cloud_random_hex(16);
  $serverId = cloud_random_hex(16);
  cloud_tx(cloud_db(), function (PDO $db) use ($id, $ns, $name, $uuid, $serverId) {
    $now = cloud_ms();
    cloud_run($db, 'DELETE FROM challenges WHERE expires_at < ?', [$now]);
    cloud_run($db, 'INSERT INTO challenges (id, ns, name, uuid, server_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [$id, $ns, $name, $uuid, $serverId, $now + CLOUD_CHALLENGE_MS]);
  });
  return cloud_json(['challengeId' => $id, 'serverId' => $serverId]);
}

function cloud_finish_challenge(): array {
  $body = cloud_read_json();
  $challengeId = cloud_str($body['challengeId'] ?? null);
  if (!preg_match('/^[0-9a-f]{32}$/D', $challengeId)) throw new CloudFailure(400, 'Неверный запрос.');
  $db = cloud_db();
  $challenge = cloud_row($db, 'SELECT * FROM challenges WHERE id = ? AND expires_at > ?', [$challengeId, cloud_ms()]);
  if (!$challenge) throw new CloudFailure(400, 'Проверка устарела, попробуйте ещё раз.');
  // One use only, whatever Mojang / Ely.by answer.
  cloud_run($db, 'DELETE FROM challenges WHERE id = ?', [$challengeId]);
  $ns = $challenge['ns'];
  $url = cloud_has_joined_url($ns) . '?username=' . rawurlencode($challenge['name']) . '&serverId=' . $challenge['server_id'];
  [$status, $text] = cloud_http_get($url, ['User-Agent: AmethyxServer/1']);
  $profile = $status === 200 ? json_decode($text, true) : null;
  $profileId = is_array($profile) && isset($profile['id']) && is_scalar($profile['id']) ? strtolower(str_replace('-', '', (string) $profile['id'])) : '';
  if ($profileId !== $challenge['uuid']) {
    throw new CloudFailure(403, $ns === 'ms' ? 'Microsoft не подтвердил аккаунт.' : 'Ely.by не подтвердил аккаунт.');
  }
  $name = isset($profile['name']) && is_scalar($profile['name']) ? (string) $profile['name'] : $challenge['name'];
  $id = $ns . ':' . $challenge['uuid'];
  cloud_tx($db, function (PDO $db) use ($ns, $name, $id, $challenge) {
    // Names of these accounts are unique at Mojang / Ely.by: whoever had this name before has changed it.
    cloud_run($db, "UPDATE users SET name_lower = '' WHERE ns = ? AND name_lower = ? AND id <> ?", [$ns, strtolower($name), $id]);
    cloud_run($db, 'INSERT INTO users (id, ns, uuid, name, name_lower, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower',
      [$id, $ns, $challenge['uuid'], $name, strtolower($name), cloud_ms()]);
  });
  return cloud_create_session(cloud_user_by_id($id));
}

// Offline accounts: the name is held by the launcher's secret. Popular names (Steve, Alex…) are
// taken many times over, so a second player with a taken name gets a short code from their own
// secret ("Steve#3fa1"), and friends add them by the name with the code.
function cloud_offline_sign_in(): array {
  $body = cloud_read_json();
  $name = cloud_str($body['name'] ?? null);
  $secret = cloud_str($body['secret'] ?? null);
  if (!preg_match(CLOUD_NAME, $name) || !preg_match(CLOUD_HEX64, $secret)) throw new CloudFailure(400, 'Неверные данные аккаунта.');
  $lower = strtolower($name);
  $secretHash = hash('sha256', $secret);
  $create = function (string $id, string $nameLower) use ($name, $secretHash) {
    cloud_run(cloud_db(), 'INSERT INTO users (id, ns, uuid, name, name_lower, secret_hash, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      [$id, 'offline', $name, $nameLower, $secretHash, cloud_ms()]);
  };

  $plainId = 'offline:' . $lower;
  $plain = cloud_user_by_id($plainId);
  if ($plain && $plain['secret_hash'] === $secretHash) return cloud_create_session($plain);
  if (!$plain) {
    $create($plainId, $lower);
    return cloud_create_session(cloud_user_by_id($plainId));
  }
  // The name is someone else's: the same name with this player's code (a longer one in the rare
  // case that the short code is taken too).
  foreach ([4, 8] as $length) {
    $tagged = $lower . '#' . substr($secretHash, 0, $length);
    $existing = cloud_user_by_id('offline:' . $tagged);
    if ($existing && $existing['secret_hash'] !== $secretHash) continue;
    if (!$existing) $create('offline:' . $tagged, $tagged);
    return cloud_create_session(cloud_user_by_id('offline:' . $tagged));
  }
  throw new CloudFailure(409, "Ник $name в Amethyx уже занят: выберите для офлайн-аккаунта другой ник.");
}

// ---- Own profile ----------------------------------------------------------

// Width and height of a PNG, or null.
function cloud_png_size(string $bytes): ?array {
  if (strlen($bytes) < 24 || substr($bytes, 0, 8) !== "\x89PNG\r\n\x1a\n" || substr($bytes, 12, 4) !== 'IHDR') return null;
  $size = unpack('Nwidth/Nheight', substr($bytes, 16, 8));
  return ['width' => $size['width'], 'height' => $size['height']];
}

// Decodes and checks a skin or cape sent as base64.
function cloud_read_png($base64, string $kind): array {
  if (!is_string($base64) || strlen($base64) > CLOUD_MAX_PNG_BYTES * 1.4) throw new CloudFailure(400, 'Файл слишком большой.');
  $bytes = base64_decode($base64, true);
  if ($bytes === false) throw new CloudFailure(400, 'Файл повреждён.');
  $size = cloud_png_size($bytes);
  if (!$size) throw new CloudFailure(400, 'Нужен PNG-файл.');
  $ok = $kind === 'skin'
    ? $size['width'] === 64 && ($size['height'] === 64 || $size['height'] === 32)
    : in_array($size['width'], CLOUD_CAPE_WIDTHS, true) && $size['height'] * 2 === $size['width'];
  if (!$ok) throw new CloudFailure(400, "Размер {$size['width']}x{$size['height']} не подходит.");
  return ['bytes' => $bytes, 'base64' => $base64];
}

function cloud_save_texture(array $png): string {
  $hash = hash('sha256', $png['bytes']);
  cloud_run(cloud_db(), 'INSERT OR IGNORE INTO textures (hash, data, created_at) VALUES (?, ?, ?)', [$hash, $png['base64'], cloud_ms()]);
  return $hash;
}

// Removes a texture nobody uses any more.
function cloud_drop_texture_if_unused(?string $hash): void {
  if (!$hash) return;
  $db = cloud_db();
  if (!cloud_row($db, 'SELECT 1 FROM users WHERE skin_hash = ? OR cape_hash = ? LIMIT 1', [$hash, $hash])) {
    cloud_run($db, 'DELETE FROM textures WHERE hash = ?', [$hash]);
  }
}

// PUT /v1/me/skin|cape { png, model } sets it, DELETE takes it off.
function cloud_set_texture(string $method, array $user, string $kind): array {
  $old = $kind === 'skin' ? $user['skin_hash'] : $user['cape_hash'];
  $hash = null;
  $model = null;
  if ($method === 'PUT') {
    $body = cloud_read_json();
    $hash = cloud_save_texture(cloud_read_png($body['png'] ?? null, $kind));
    $model = ($body['model'] ?? null) === 'slim' ? 'slim' : 'classic';
  }
  if ($kind === 'skin') {
    cloud_run(cloud_db(), 'UPDATE users SET skin_hash = ?, skin_model = ? WHERE id = ?', [$hash, $model, $user['id']]);
  } else {
    cloud_run(cloud_db(), 'UPDATE users SET cape_hash = ? WHERE id = ?', [$hash, $user['id']]);
  }
  if ($old !== $hash) cloud_drop_texture_if_unused($old);
  return cloud_json(['ok' => true, 'hash' => $hash]);
}

function cloud_set_presence(array $user): array {
  $body = cloud_read_json();
  $status = $body['status'] ?? null;
  if ($status === 'offline') {
    cloud_run(cloud_db(), 'UPDATE users SET last_seen = 0, presence = NULL WHERE id = ?', [$user['id']]);
    return cloud_json(['ok' => true]);
  }
  $presence = [
    'status' => in_array($status, CLOUD_STATUSES, true) ? $status : 'online',
    'instance' => cloud_text($body['instance'] ?? null, 64),
    'minecraft' => cloud_text($body['minecraft'] ?? null, 32),
    'loader' => cloud_text($body['loader'] ?? null, 16),
    'server' => cloud_text($body['server'] ?? null, 128),
  ];
  cloud_run(cloud_db(), 'UPDATE users SET last_seen = ?, presence = ? WHERE id = ?', [cloud_ms(), json_encode($presence, CLOUD_JSON), $user['id']]);
  return cloud_json(['ok' => true]);
}

// ---- CustomSkinLoader -----------------------------------------------------

// GET /csl/<ns>/<name>.json in CustomSkinAPI format. The game asks with the viewer's kind of
// account. A player of that kind with this name is the answer; when there is none, the player may
// use another kind (on an offline server Microsoft, Ely.by and offline players meet): then the one
// of the other kinds seen last that has a skin or a cape.
function cloud_csl_profile(string $ns, string $name): array {
  $cache = ['Cache-Control' => 'public, max-age=60'];
  $user = cloud_user_by_name($ns, $name);
  if (!$user) {
    $user = cloud_row(cloud_db(), 'SELECT * FROM users WHERE name_lower = ? AND ns <> ? AND (skin_hash IS NOT NULL OR cape_hash IS NOT NULL)
      ORDER BY last_seen DESC, created_at DESC LIMIT 1', [strtolower($name), $ns]);
  }
  if (!$user || (!$user['skin_hash'] && !$user['cape_hash'])) return cloud_json(['errno' => 404, 'msg' => 'not found'], 404, $cache);
  $body = ['username' => $user['name']];
  if ($user['skin_hash']) $body['skins'] = [$user['skin_model'] === 'slim' ? 'slim' : 'default' => $user['skin_hash']];
  if ($user['cape_hash']) $body['cape'] = $user['cape_hash'];
  return cloud_json($body, 200, $cache);
}

function cloud_texture(string $hash): array {
  $row = cloud_row(cloud_db(), 'SELECT data FROM textures WHERE hash = ?', [$hash]);
  if (!$row) return cloud_bytes('Not found', 'text/plain; charset=utf-8', [], 404);
  return cloud_bytes((string) base64_decode((string) $row['data']), 'image/png', ['Cache-Control' => 'public, max-age=31536000, immutable']);
}
