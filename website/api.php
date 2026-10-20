<?php
// The site's API: api.php?a=<action>. Public actions feed the page (latest builds,
// visit counters); the rest need the admin session or, for uploads, an API token.

define('AMX', true);
require __DIR__ . '/lib/amethyx.php';

$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

function need_post(): void {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') amx_fail(405, 'method', 'Use POST.');
}

switch ($action) {

  // ---- Public -------------------------------------------------------------

  case 'site':
    $latest = [];
    foreach (AMX_PLATFORMS as $platform) {
      $row = amx_latest($platform);
      if ($row) $latest[$platform] = amx_version_row($row);
    }
    $all = array_filter(amx_db()->query('SELECT * FROM versions WHERE hidden = 0 ORDER BY created_at DESC, id DESC')->fetchAll(), 'amx_file_present');
    amx_heal_feeds();
    amx_json(['latest' => $latest, 'versions' => array_values(array_map('amx_version_row', $all))]);

  case 'hit':
    need_post();
    $kind = (string) (amx_body()['kind'] ?? '');
    if (!in_array($kind, AMX_HIT_KINDS, true)) amx_fail(400, 'kind');
    amx_count($kind);
    amx_json(['ok' => true]);

  // ---- Logging in ---------------------------------------------------------

  case 'me':
    amx_json(['admin' => amx_admin_login(), 'setup' => !amx_has_admin()]);

  case 'setup':
    need_post();
    if (amx_has_admin()) amx_fail(409, 'exists', 'The admin already exists.');
    $body = amx_body();
    $login = trim((string) ($body['login'] ?? ''));
    $password = (string) ($body['password'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_.-]{3,32}$/', $login)) amx_fail(400, 'login', 'Login: 3–32 latin letters, digits, _ . -');
    if ($problem = amx_check_password($password)) amx_fail(400, 'password', $problem);
    amx_db()->prepare('INSERT INTO admin (login, pass_hash, created_at) VALUES (?, ?, ?)')
      ->execute([$login, amx_hash_password($password), time()]);
    amx_import_downloads();
    amx_write_feeds();
    amx_session_start();
    session_regenerate_id(true);
    $_SESSION['admin'] = $login;
    $_SESSION['seen'] = time();
    amx_json(['admin' => $login]);

  case 'login':
    need_post();
    $body = amx_body();
    $login = trim((string) ($body['login'] ?? ''));
    $password = (string) ($body['password'] ?? '');
    if (amx_login_locked()) amx_fail(429, 'locked', 'Too many attempts. Try again in 15 minutes.');
    $q = amx_db()->prepare('SELECT login, pass_hash FROM admin WHERE login = ?');
    $q->execute([$login]);
    $row = $q->fetch();
    if (!$row || !password_verify($password, $row['pass_hash'])) {
      amx_login_failed();
      usleep(400000);
      amx_fail(401, 'wrong', 'Wrong login or password.');
    }
    if (password_needs_rehash($row['pass_hash'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT)) {
      amx_db()->prepare('UPDATE admin SET pass_hash = ? WHERE login = ?')->execute([amx_hash_password($password), $login]);
    }
    amx_session_start();
    session_regenerate_id(true);
    $_SESSION['admin'] = $row['login'];
    $_SESSION['seen'] = time();
    amx_json(['admin' => $row['login']]);

  case 'logout':
    need_post();
    amx_session_start();
    $_SESSION = [];
    session_destroy();
    amx_json(['ok' => true]);

  case 'password':
    need_post();
    $login = amx_require_admin();
    $body = amx_body();
    $q = amx_db()->prepare('SELECT pass_hash FROM admin WHERE login = ?');
    $q->execute([$login]);
    if (!password_verify((string) ($body['old'] ?? ''), (string) $q->fetchColumn())) amx_fail(401, 'wrong', 'The current password is wrong.');
    if ($problem = amx_check_password((string) ($body['new'] ?? ''))) amx_fail(400, 'password', $problem);
    amx_db()->prepare('UPDATE admin SET pass_hash = ? WHERE login = ?')->execute([amx_hash_password((string) $body['new']), $login]);
    amx_json(['ok' => true]);

  // ---- Versions -----------------------------------------------------------

  case 'versions':
    amx_require_admin(true);
    $rows = amx_db()->query("
      SELECT v.*, COALESCE((SELECT SUM(n) FROM stats s WHERE s.kind = 'download' AND s.ref = CAST(v.id AS TEXT)), 0) AS downloads
      FROM versions v ORDER BY v.created_at DESC, v.id DESC")->fetchAll();
    amx_json(['versions' => array_map(function ($row) { return amx_version_row($row, true); }, $rows)]);

  case 'version-update':
    need_post();
    amx_require_admin(true);
    $body = amx_body();
    $id = (int) ($body['id'] ?? 0);
    $q = amx_db()->prepare('SELECT * FROM versions WHERE id = ?');
    $q->execute([$id]);
    $row = $q->fetch();
    if (!$row) amx_fail(404, 'missing', 'No such version.');
    $set = [];
    if (isset($body['version'])) $set['version'] = mb_substr(trim((string) $body['version']), 0, 40);
    if (isset($body['notes'])) $set['notes'] = mb_substr((string) $body['notes'], 0, 4000);
    if (isset($body['channel'])) $set['channel'] = $body['channel'] === 'beta' ? 'beta' : 'release';
    if (isset($body['platform']) && in_array($body['platform'], AMX_PLATFORMS, true)) $set['platform'] = $body['platform'];
    if (isset($body['hidden'])) $set['hidden'] = $body['hidden'] ? 1 : 0;
    foreach ($set as $column => $value) {
      amx_db()->prepare("UPDATE versions SET $column = ? WHERE id = ?")->execute([$value, $id]);
    }
    if (!empty($set['hidden'])) amx_db()->prepare('UPDATE versions SET latest = 0 WHERE id = ?')->execute([$id]);
    if (!empty($body['latest'])) amx_mark_latest($id);
    amx_write_feeds();
    amx_json(['ok' => true]);

  case 'version-delete':
    need_post();
    amx_require_admin();
    $id = (int) (amx_body()['id'] ?? 0);
    $q = amx_db()->prepare('SELECT file FROM versions WHERE id = ?');
    $q->execute([$id]);
    $file = $q->fetchColumn();
    if ($file === false) amx_fail(404, 'missing', 'No such version.');
    amx_db()->prepare('DELETE FROM versions WHERE id = ?')->execute([$id]);
    @unlink(AMX_DOWNLOADS . '/' . $file);
    amx_write_feeds();
    amx_json(['ok' => true]);

  case 'import':
    need_post();
    amx_require_admin();
    $added = count(amx_import_downloads());
    amx_write_feeds();
    amx_json(['added' => $added]);

  // ---- Uploading a build in pieces ----------------------------------------
  // start -> chunk (as many as needed, raw bytes) -> finish. A piece is always small
  // enough for the hosting's request limit, so a 150 MB installer goes through anyway.

  case 'upload-start':
    need_post();
    amx_require_admin(true);
    $body = amx_body();
    $name = amx_safe_name((string) ($body['name'] ?? ''));
    $size = (int) ($body['size'] ?? 0);
    if ($name === '') amx_fail(400, 'name', 'The file must be an installer or archive (.exe, .zip, .dmg…).');
    if ($size <= 0 || $size > 2 * 1024 * 1024 * 1024) amx_fail(400, 'size', 'Bad file size.');
    if (is_file(AMX_DOWNLOADS . '/' . $name)) amx_fail(409, 'exists', 'A file with this name is already on the site. Delete that version first or rename the file.');
    if (!is_dir(AMX_DOWNLOADS) && !@mkdir(AMX_DOWNLOADS, 0755, true)) amx_fail(500, 'storage', 'Cannot create the downloads folder.');
    $free = @disk_free_space(AMX_DOWNLOADS);
    if ($free !== false && $free < $size * 1.1) amx_fail(507, 'space', 'Not enough disk space on the hosting.');
    $platform = in_array($body['platform'] ?? '', AMX_PLATFORMS, true) ? $body['platform'] : amx_guess_platform($name);
    if ($platform === null) amx_fail(400, 'platform', 'Choose the platform.');
    $version = trim((string) ($body['version'] ?? '')) ?: amx_guess_version($name);
    if ($version === '') amx_fail(400, 'version', 'Enter the version.');
    $meta = [
      'name' => $name, 'version' => mb_substr($version, 0, 40), 'platform' => $platform,
      'channel' => ($body['channel'] ?? '') === 'beta' || stripos($version, 'beta') !== false ? 'beta' : 'release',
      'notes' => mb_substr((string) ($body['notes'] ?? ''), 0, 4000), 'latest' => !empty($body['latest']),
    ];
    $tmp = amx_data_dir() . '/tmp';
    if (!is_dir($tmp)) @mkdir($tmp, 0750, true);
    foreach (amx_db()->query('SELECT id FROM uploads WHERE created_at < ' . (time() - 86400))->fetchAll(PDO::FETCH_COLUMN) as $old) {
      @unlink("$tmp/$old.part");
      amx_db()->prepare('DELETE FROM uploads WHERE id = ?')->execute([$old]);
    }
    $id = bin2hex(random_bytes(16));
    if (file_put_contents("$tmp/$id.part", '') === false) amx_fail(500, 'storage', 'Cannot write to the data folder.');
    amx_db()->prepare('INSERT INTO uploads (id, meta, size, created_at) VALUES (?, ?, ?, ?)')
      ->execute([$id, json_encode($meta, JSON_UNESCAPED_UNICODE), $size, time()]);
    amx_json(['id' => $id, 'chunk' => amx_chunk_size()]);

  case 'upload-chunk':
    need_post();
    amx_require_admin(true);
    $id = (string) ($_GET['id'] ?? '');
    $offset = (int) ($_GET['offset'] ?? -1);
    $q = amx_db()->prepare('SELECT size FROM uploads WHERE id = ?');
    $q->execute([$id]);
    $size = $q->fetchColumn();
    if ($size === false || !preg_match('/^[0-9a-f]{32}$/', $id)) amx_fail(404, 'upload', 'Unknown upload.');
    $part = amx_data_dir() . "/tmp/$id.part";
    clearstatcache(true, $part);
    $have = filesize($part);
    if ($offset !== $have) amx_json(['received' => $have, 'resend' => true], 409);
    $in = fopen('php://input', 'rb');
    $out = fopen($part, 'ab');
    $copied = stream_copy_to_stream($in, $out, amx_chunk_size() + 1);
    fclose($in);
    fclose($out);
    clearstatcache(true, $part);
    if ($copied > amx_chunk_size() || filesize($part) > (int) $size) {
      ftruncate(fopen($part, 'r+b'), $have);
      amx_fail(400, 'chunk', 'The piece is too big.');
    }
    amx_json(['received' => filesize($part)]);

  case 'upload-finish':
    need_post();
    amx_require_admin(true);
    $body = amx_body();
    $id = (string) ($body['id'] ?? '');
    $q = amx_db()->prepare('SELECT meta, size FROM uploads WHERE id = ?');
    $q->execute([$id]);
    $row = $q->fetch();
    if (!$row) amx_fail(404, 'upload', 'Unknown upload.');
    $meta = json_decode($row['meta'], true);
    $part = amx_data_dir() . "/tmp/$id.part";
    clearstatcache(true, $part);
    if (filesize($part) !== (int) $row['size']) amx_fail(400, 'incomplete', 'The file has not arrived completely.');
    $expected = strtolower((string) ($body['sha256'] ?? ''));
    if ($expected !== '' && hash_file('sha256', $part) !== $expected) {
      @unlink($part);
      amx_db()->prepare('DELETE FROM uploads WHERE id = ?')->execute([$id]);
      amx_fail(400, 'checksum', 'The file was damaged on the way. Upload it again.');
    }
    $target = AMX_DOWNLOADS . '/' . $meta['name'];
    if (is_file($target)) amx_fail(409, 'exists', 'A file with this name is already on the site.');
    if (!@rename($part, $target)) {
      if (!@copy($part, $target)) amx_fail(500, 'storage', 'Cannot move the file into downloads.');
      @unlink($part);
    }
    @chmod($target, 0644);
    amx_db()->prepare('DELETE FROM uploads WHERE id = ?')->execute([$id]);
    $versionId = amx_add_version($meta['name'], $meta['version'], $meta['platform'], $meta['channel'], $meta['notes'], $meta['latest']);
    amx_write_feeds();
    $q = amx_db()->prepare('SELECT * FROM versions WHERE id = ?');
    $q->execute([$versionId]);
    amx_json(['version' => amx_version_row($q->fetch(), true)]);

  case 'upload-cancel':
    need_post();
    amx_require_admin(true);
    $id = (string) (amx_body()['id'] ?? '');
    if (preg_match('/^[0-9a-f]{32}$/', $id)) {
      @unlink(amx_data_dir() . "/tmp/$id.part");
      amx_db()->prepare('DELETE FROM uploads WHERE id = ?')->execute([$id]);
    }
    amx_json(['ok' => true]);

  // ---- Statistics ---------------------------------------------------------

  case 'stats':
    amx_require_admin();
    $days = max(7, min(365, (int) ($_GET['days'] ?? 30)));
    $from = date('Y-m-d', time() - ($days - 1) * 86400);
    $q = amx_db()->prepare('SELECT day, kind, SUM(n) AS n FROM stats WHERE day >= ? GROUP BY day, kind');
    $q->execute([$from]);
    $byDay = [];
    for ($i = $days - 1; $i >= 0; $i--) {
      $day = date('Y-m-d', time() - $i * 86400);
      $byDay[$day] = ['day' => $day, 'view' => 0, 'download' => 0, 'video' => 0];
    }
    foreach ($q->fetchAll() as $row) {
      if (isset($byDay[$row['day']][$row['kind']])) $byDay[$row['day']][$row['kind']] = (int) $row['n'];
    }
    $totals = ['view' => 0, 'download' => 0, 'video' => 0];
    foreach (amx_db()->query('SELECT kind, SUM(n) AS n FROM stats GROUP BY kind')->fetchAll() as $row) {
      if (isset($totals[$row['kind']])) $totals[$row['kind']] = (int) $row['n'];
    }
    amx_json(['days' => array_values($byDay), 'totals' => $totals]);

  // ---- API tokens ---------------------------------------------------------

  case 'tokens':
    amx_require_admin();
    $rows = amx_db()->query('SELECT id, name, created_at, used_at FROM tokens ORDER BY id DESC')->fetchAll();
    amx_json(['tokens' => array_map(function ($row) {
      return ['id' => (int) $row['id'], 'name' => $row['name'],
        'created' => date('Y-m-d', (int) $row['created_at']), 'used' => $row['used_at'] ? date('Y-m-d H:i', (int) $row['used_at']) : null];
    }, $rows)]);

  case 'token-create':
    need_post();
    amx_require_admin();
    $name = mb_substr(trim((string) (amx_body()['name'] ?? '')), 0, 60) ?: 'token';
    $token = amx_new_token();
    amx_db()->prepare('INSERT INTO tokens (name, hash, created_at) VALUES (?, ?, ?)')->execute([$name, hash('sha256', $token), time()]);
    amx_json(['token' => $token]);

  case 'token-delete':
    need_post();
    amx_require_admin();
    amx_db()->prepare('DELETE FROM tokens WHERE id = ?')->execute([(int) (amx_body()['id'] ?? 0)]);
    amx_json(['ok' => true]);

  case 'limits':
    amx_require_admin();
    amx_json([
      'php' => PHP_VERSION, 'chunk' => amx_chunk_size(),
      'post_max_size' => ini_get('post_max_size'), 'upload_max_filesize' => ini_get('upload_max_filesize'),
      'data_outside_site' => strpos(realpath(amx_data_dir()), realpath(AMX_ROOT)) !== 0,
      'free_space' => @disk_free_space(AMX_ROOT) ?: null,
    ]);

  default:
    amx_fail(404, 'action', 'Unknown action.');
}
