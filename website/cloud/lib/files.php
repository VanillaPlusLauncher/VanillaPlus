<?php
// Files of share codes. Mods, resource packs and shaders that are on neither Modrinth nor
// CurseForge travel with a share code only when the player agrees. The launcher uploads them in
// parts (base64 text), then names them in a "pack"; the code carries the pack's id, and the
// friend's launcher downloads the parts and checks each file's SHA-256. They live in their own
// database (cloud_files_db). A pack nobody downloads goes FILE_DAYS days after it was made; every
// download keeps it (and its files) FILE_DAYS days more, so codes in use stay.

if (!defined('AMX')) { http_response_code(404); exit; }

const CLOUD_PART_BYTES = 1400 * 1000;
const CLOUD_MAX_FILE_BYTES = 64 * 1024 * 1024;
const CLOUD_MAX_PACK_FILES = 300;
// Raw sizes, as on the old server (the database holds a third more as base64).
const CLOUD_USER_BYTES = 150 * 1024 * 1024;
const CLOUD_STORE_BYTES = 320 * 1024 * 1024;
const CLOUD_FILE_DAYS = 7;
const CLOUD_UPLOAD_MS = 24 * 60 * 60 * 1000;
const CLOUD_PACK_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks'];
const CLOUD_GONE = 'Моды автора уже удалены с сервера.';

function cloud_parts_of(int $size): int {
  return max(1, (int) ceil($size / CLOUD_PART_BYTES));
}

function cloud_base64_length(int $size): int {
  return (int) ceil($size / 3) * 4;
}

// "mods/name.jar": a file right inside one of the content folders, with a name Windows accepts.
function cloud_pack_path($value): ?string {
  $text = is_scalar($value) ? (string) $value : '';
  $slash = strpos($text, '/');
  if ($slash === false) return null;
  $name = substr($text, $slash + 1);
  $length = mb_strlen($name, 'UTF-8');
  $ok = in_array(substr($text, 0, $slash), CLOUD_PACK_FOLDERS, true) && $length > 0 && $length <= 200
    && !preg_match('/[\\\\\/:*?"<>|\x00-\x1f]/', $name) && !preg_match('/^\.+$/D', $name);
  return $ok ? $text : null;
}

function cloud_file_list($files): array {
  if (!is_array($files) || !$files || count($files) > CLOUD_MAX_PACK_FILES || array_values($files) !== $files) throw new CloudFailure(400, 'Неверный список файлов.');
  return $files;
}

// The player's files and the parts the server has, without reading the parts' data.
function cloud_own_blobs(array $user): array {
  $db = cloud_files_db();
  $own = [];
  foreach (cloud_rows($db, 'SELECT hash, size, parts FROM blobs WHERE owner_id = ?', [$user['id']]) as $row) {
    $own[$row['hash']] = ['size' => (int) $row['size'], 'parts' => (int) $row['parts'], 'have' => []];
  }
  foreach (cloud_rows($db, 'SELECT hash, part FROM blob_parts WHERE owner_id = ?', [$user['id']]) as $row) {
    if (isset($own[$row['hash']])) $own[$row['hash']]['have'][(int) $row['part']] = true;
  }
  return $own;
}

// POST /v1/files/start { files: [{ hash, size }] }: which parts of these files the server still
// needs. New files must fit the player's share and the whole store.
function cloud_start_upload(array $user): array {
  $files = cloud_file_list(cloud_read_json()['files'] ?? null);
  $wanted = [];
  foreach ($files as $file) {
    $hash = is_array($file) && is_scalar($file['hash'] ?? null) ? (string) $file['hash'] : '';
    $size = is_array($file) && array_key_exists('size', $file) ? cloud_number($file['size']) : null;
    if (!preg_match(CLOUD_HEX64, $hash) || !cloud_is_integer($size) || $size < 0) throw new CloudFailure(400, 'Неверный список файлов.');
    if ($size > CLOUD_MAX_FILE_BYTES) throw new CloudFailure(413, 'Моды больше ' . (CLOUD_MAX_FILE_BYTES / 1048576) . ' МБ на сервер не загружаются.');
    $wanted[$hash] = (int) $size;
  }
  $db = cloud_files_db();
  $own = cloud_own_blobs($user);
  $added = [];
  foreach ($wanted as $hash => $size) {
    if (!isset($own[$hash]) || $own[$hash]['size'] !== $size) $added[$hash] = $size;
  }
  $addedBytes = array_sum($added);
  if ($addedBytes) {
    $usage = cloud_row($db, 'SELECT COALESCE(SUM(size), 0) AS total, COALESCE(SUM(CASE WHEN owner_id = ? THEN size END), 0) AS mine FROM blobs', [$user['id']]);
    if ((int) $usage['mine'] + $addedBytes > CLOUD_USER_BYTES) {
      throw new CloudFailure(507, 'На сервере можно держать до ' . (CLOUD_USER_BYTES / 1048576) . ' МБ своих модов. Пока передайте сборку файлом.');
    }
    if ((int) $usage['total'] + $addedBytes > CLOUD_STORE_BYTES) throw new CloudFailure(507, 'Хранилище сервера сейчас заполнено: попробуйте через несколько дней или передайте сборку файлом.');
  }
  cloud_tx($db, function (PDO $db) use ($user, $wanted, $added, $own) {
    $now = cloud_ms();
    // Same hash with another size cannot be the same file: it starts again.
    $dropParts = $db->prepare('DELETE FROM blob_parts WHERE owner_id = ? AND hash = ?');
    $dropBlob = $db->prepare('DELETE FROM blobs WHERE owner_id = ? AND hash = ?');
    $insert = $db->prepare('INSERT INTO blobs (owner_id, hash, size, parts, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
    foreach ($added as $hash => $size) {
      if (isset($own[$hash])) {
        cloud_bind($dropParts, [$user['id'], $hash]);
        $dropParts->execute();
        cloud_bind($dropBlob, [$user['id'], $hash]);
        $dropBlob->execute();
      }
      cloud_bind($insert, [$user['id'], (string) $hash, $size, cloud_parts_of($size), $now, $now + CLOUD_UPLOAD_MS]);
      $insert->execute();
    }
    // Files already here stay at least until this upload is done (the cleanup must not take them meanwhile).
    $keep = $db->prepare('UPDATE blobs SET expires_at = MAX(expires_at, ?) WHERE owner_id = ? AND hash = ?');
    foreach (array_keys($wanted) as $hash) {
      cloud_bind($keep, [$now + CLOUD_UPLOAD_MS, $user['id'], (string) $hash]);
      $keep->execute();
    }
  });
  $need = [];
  foreach ($wanted as $hash => $size) {
    $have = isset($added[$hash]) ? [] : $own[$hash]['have'];
    $missing = [];
    for ($part = 0; $part < cloud_parts_of($size); $part++) if (!isset($have[$part])) $missing[] = $part;
    if ($missing) $need[] = ['hash' => (string) $hash, 'parts' => $missing];
  }
  return cloud_json(['partBytes' => CLOUD_PART_BYTES, 'need' => $need]);
}

// PUT /v1/files/<hash>/<part>: one part of a file announced by /v1/files/start, as base64 text.
function cloud_put_part(array $user, string $hash, int $part): array {
  $db = cloud_files_db();
  $blob = cloud_row($db, 'SELECT size, parts FROM blobs WHERE owner_id = ? AND hash = ?', [$user['id'], $hash]);
  if (!$blob) throw new CloudFailure(404, 'Загрузка этого файла не начата или устарела.');
  $size = (int) $blob['size'];
  $parts = (int) $blob['parts'];
  if ($part >= $parts) throw new CloudFailure(400, 'Неверная часть файла.');
  $expected = cloud_base64_length($part === $parts - 1 ? $size - $part * CLOUD_PART_BYTES : CLOUD_PART_BYTES);
  if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $expected) throw new CloudFailure(413, 'Часть файла слишком большая.');
  $data = (string) @file_get_contents('php://input', false, null, 0, $expected + 1);
  if (strlen($data) !== $expected) throw new CloudFailure(400, 'Часть файла пришла не целиком.');
  cloud_run($db, 'INSERT OR REPLACE INTO blob_parts (owner_id, hash, part, data) VALUES (?, ?, ?, ?)', [$user['id'], $hash, $part, $data]);
  return cloud_json(['ok' => true]);
}

// POST /v1/packs { files: [{ path, hash, size }] }: the files of one share code, all uploaded.
function cloud_create_pack(array $user): array {
  $files = cloud_file_list(cloud_read_json()['files'] ?? null);
  $own = cloud_own_blobs($user);
  $paths = [];
  $clean = [];
  foreach ($files as $file) {
    $filePath = cloud_pack_path(is_array($file) ? ($file['path'] ?? null) : null);
    $hash = is_array($file) && is_scalar($file['hash'] ?? null) ? (string) $file['hash'] : '';
    if ($filePath === null || isset($paths[$filePath]) || !preg_match(CLOUD_HEX64, $hash)) throw new CloudFailure(400, 'Неверный список файлов.');
    $paths[$filePath] = true;
    $blob = $own[$hash] ?? null;
    $size = cloud_number($file['size'] ?? null);
    if (!$blob || $blob['size'] != $size || count($blob['have']) !== $blob['parts']) throw new CloudFailure(409, "Файл $filePath загружен не целиком.");
    $clean[] = ['path' => $filePath, 'hash' => $hash, 'size' => $blob['size']];
  }
  $db = cloud_files_db();
  $now = cloud_ms();
  $expiresAt = $now + CLOUD_FILE_DAYS * 86400000;
  $list = json_encode($clean, CLOUD_JSON);
  // The same files again (the same instance shared twice): the same pack, so the code stays the
  // same and the friend's launcher plays the instance it already built.
  $same = cloud_row($db, 'SELECT id FROM packs WHERE owner_id = ? AND files = ? AND expires_at > ?', [$user['id'], $list, $now]);
  $id = $same ? $same['id'] : cloud_random_hex(16);
  cloud_tx($db, function (PDO $db) use ($same, $id, $user, $list, $now, $expiresAt, $clean) {
    if ($same) cloud_run($db, 'UPDATE packs SET expires_at = ? WHERE id = ?', [$expiresAt, $id]);
    else cloud_run($db, 'INSERT INTO packs (id, owner_id, files, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [$id, $user['id'], $list, $now, $expiresAt]);
    cloud_keep_blobs($db, $user['id'], array_column($clean, 'hash'), $expiresAt);
  });
  return cloud_json(['id' => $id, 'expiresAt' => $expiresAt, 'files' => count($clean), 'bytes' => array_sum(array_column($clean, 'size'))]);
}

function cloud_keep_blobs(PDO $db, string $owner, array $hashes, int $until): void {
  $keep = $db->prepare('UPDATE blobs SET expires_at = MAX(expires_at, ?) WHERE owner_id = ? AND hash = ?');
  foreach (array_unique($hashes) as $hash) {
    cloud_bind($keep, [$until, $owner, (string) $hash]);
    $keep->execute();
  }
}

function cloud_pack_hashes(string $files): array {
  $list = json_decode($files, true);
  $hashes = [];
  foreach (is_array($list) ? $list : [] as $file) {
    if (is_array($file) && isset($file['hash']) && is_string($file['hash'])) $hashes[] = $file['hash'];
  }
  return $hashes;
}

// GET /packs/<id>: the files of a share code. No sign-in: the random id is the key. Asking for
// them is using the code: the pack and its files stay FILE_DAYS days more.
function cloud_pack_info(string $id): array {
  $db = cloud_files_db();
  $now = cloud_ms();
  $pack = cloud_row($db, 'SELECT owner_id, files FROM packs WHERE id = ? AND expires_at > ?', [$id, $now]);
  if (!$pack) return cloud_json(['error' => CLOUD_GONE], 404);
  $expiresAt = $now + CLOUD_FILE_DAYS * 86400000;
  cloud_tx($db, function (PDO $db) use ($id, $pack, $expiresAt) {
    cloud_run($db, 'UPDATE packs SET expires_at = ? WHERE id = ?', [$expiresAt, $id]);
    cloud_keep_blobs($db, $pack['owner_id'], cloud_pack_hashes($pack['files']), $expiresAt);
  });
  return cloud_json(['files' => json_decode($pack['files']), 'partBytes' => CLOUD_PART_BYTES, 'expiresAt' => $expiresAt]);
}

// GET /packs/<id>/<hash>/<part>: one part of a file of the pack, as base64 text.
function cloud_pack_part(string $id, string $hash, int $part): array {
  $db = cloud_files_db();
  $pack = cloud_row($db, 'SELECT owner_id, files FROM packs WHERE id = ? AND expires_at > ?', [$id, cloud_ms()]);
  $row = $pack && in_array($hash, cloud_pack_hashes($pack['files']), true)
    ? cloud_row($db, 'SELECT data FROM blob_parts WHERE owner_id = ? AND hash = ? AND part = ?', [$pack['owner_id'], $hash, $part])
    : null;
  if (!$row) return cloud_json(['error' => CLOUD_GONE], 404);
  return cloud_bytes((string) $row['data'], 'text/plain; charset=us-ascii', ['Cache-Control' => 'private, max-age=86400']);
}
