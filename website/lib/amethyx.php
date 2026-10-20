<?php
// Shared code of the Amethyx site backend: storage (SQLite), the admin session,
// API tokens, versions and the visit counters. Works on PHP 7.4 and newer.
// Nothing here is reachable from the web by itself (see .htaccess and the guard below).

if (!defined('AMX')) { http_response_code(404); exit; }

const AMX_ROOT = __DIR__ . '/..';
const AMX_DOWNLOADS = AMX_ROOT . '/downloads';
const AMX_PLATFORMS = ['windows', 'mac-arm64', 'mac-x64', 'linux'];
const AMX_HIT_KINDS = ['view', 'video'];
const AMX_LOGIN_TRIES = 5;          // failed logins allowed per address...
const AMX_LOGIN_WINDOW = 15 * 60;   // ...within this many seconds
const AMX_SESSION_IDLE = 12 * 3600; // a session ends after 12 hours without activity

// The data folder holds the database and unfinished uploads. It lives next to the
// site folder when the hosting allows it (then the web can't reach it at all),
// otherwise in site/data, which .htaccess closes and whose file names are random.
function amx_data_dir(): string {
  static $dir = null;
  if ($dir !== null) return $dir;
  $outside = dirname(realpath(AMX_ROOT)) . '/amethyx-data';
  $inside = AMX_ROOT . '/data';
  // The @ keeps quiet hostings that forbid looking outside the site folder (open_basedir).
  foreach ([$outside, $inside] as $candidate) {
    if (@is_dir($candidate) && @is_writable($candidate)) return $dir = $candidate;
  }
  foreach ([$outside, $inside] as $candidate) {
    if (@mkdir($candidate, 0750, true)) {
      @file_put_contents($candidate . '/index.html', '');
      @file_put_contents($candidate . '/.htaccess', "Require all denied\nDeny from all\n");
      return $dir = $candidate;
    }
  }
  amx_fail(500, 'storage', 'The site cannot create its data folder. Allow writing to the site folder.');
}

function amx_db(): PDO {
  static $db = null;
  if ($db) return $db;
  if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
    amx_fail(500, 'sqlite', 'PHP on this hosting has no pdo_sqlite. Turn it on in the PHP settings of the site.');
  }
  $dir = amx_data_dir();
  $files = glob($dir . '/amethyx-*.sqlite') ?: [];
  $file = $files ? $files[0] : $dir . '/amethyx-' . bin2hex(random_bytes(12)) . '.sqlite';
  $db = new PDO('sqlite:' . $file, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);
  $db->exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  $db->exec("
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_fail (who TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, used_at INTEGER);
    -- AUTOINCREMENT: a deleted version's number is never given again, so its downloads stay its own.
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, platform TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'release',
      file TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, sha256 TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      hidden INTEGER NOT NULL DEFAULT 0, latest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS stats (day TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, ref));
    CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, meta TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
  ");
  return $db;
}

function amx_setting(string $key, ?string $default = null): ?string {
  $row = amx_db()->prepare('SELECT v FROM settings WHERE k = ?');
  $row->execute([$key]);
  $value = $row->fetchColumn();
  return $value === false ? $default : $value;
}

function amx_set_setting(string $key, string $value): void {
  amx_db()->prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')->execute([$key, $value]);
}

// A random secret of this site, used to hash addresses for the login limit.
function amx_secret(): string {
  $secret = amx_setting('secret');
  if (!$secret) { $secret = bin2hex(random_bytes(32)); amx_set_setting('secret', $secret); }
  return $secret;
}

function amx_json($data, int $status = 200): void {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function amx_fail(int $status, string $code, string $message = ''): void {
  amx_json(['error' => $code, 'message' => $message], $status);
}

function amx_body(): array {
  $raw = file_get_contents('php://input');
  $data = json_decode($raw ?: '[]', true);
  return is_array($data) ? $data : [];
}

function amx_https(): bool {
  return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
    || (($_SERVER['SERVER_PORT'] ?? '') === '443');
}

// ---- Admin session -------------------------------------------------------

function amx_session_start(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;
  session_name('AMXSESS');
  session_set_cookie_params([
    'lifetime' => 0, 'path' => '/', 'secure' => amx_https(), 'httponly' => true, 'samesite' => 'Strict',
  ]);
  session_start();
  if (!empty($_SESSION['admin']) && time() - ($_SESSION['seen'] ?? 0) > AMX_SESSION_IDLE) {
    $_SESSION = [];
  }
  if (!empty($_SESSION['admin'])) $_SESSION['seen'] = time();
}

function amx_admin_login(): ?string {
  amx_session_start();
  return $_SESSION['admin'] ?? null;
}

function amx_has_admin(): bool {
  return (int) amx_db()->query('SELECT COUNT(*) FROM admin')->fetchColumn() > 0;
}

// Session requests that change something must carry the X-Amethyx header: a page on
// another site cannot add it without the browser asking first, so it can't act for you.
function amx_require_admin(bool $tokenAllowed = false): string {
  if ($tokenAllowed) {
    $name = amx_token_user();
    if ($name !== null) return 'token:' . $name;
  }
  $login = amx_admin_login();
  if ($login === null) amx_fail(401, 'login', 'Log in first.');
  if ($_SERVER['REQUEST_METHOD'] !== 'GET' && ($_SERVER['HTTP_X_AMETHYX'] ?? '') !== '1') {
    amx_fail(403, 'header', 'Missing X-Amethyx header.');
  }
  return $login;
}

// Failed logins are remembered per address, and only as a keyed hash of it.
function amx_client_key(): string {
  return hash_hmac('sha256', $_SERVER['REMOTE_ADDR'] ?? '', amx_secret());
}

function amx_login_locked(): bool {
  $db = amx_db();
  $db->prepare('DELETE FROM login_fail WHERE at < ?')->execute([time() - AMX_LOGIN_WINDOW]);
  $q = $db->prepare('SELECT COUNT(*) FROM login_fail WHERE who = ?');
  $q->execute([amx_client_key()]);
  return (int) $q->fetchColumn() >= AMX_LOGIN_TRIES;
}

function amx_login_failed(): void {
  amx_db()->prepare('INSERT INTO login_fail (who, at) VALUES (?, ?)')->execute([amx_client_key(), time()]);
}

function amx_check_password(string $password): ?string {
  if (mb_strlen($password) < 10) return 'The password needs at least 10 characters.';
  return null;
}

function amx_hash_password(string $password): string {
  return password_hash($password, defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT);
}

// ---- API tokens (for uploading builds from a script) ----------------------

function amx_token_user(): ?string {
  $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
  if ($header === '' && function_exists('getallheaders')) {
    foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) $header = $v;
  }
  if (!preg_match('/^Bearer\s+(amx_[A-Za-z0-9]{40})$/', trim($header), $m)) return null;
  $q = amx_db()->prepare('SELECT id, name FROM tokens WHERE hash = ?');
  $q->execute([hash('sha256', $m[1])]);
  $row = $q->fetch();
  if (!$row) amx_fail(401, 'token', 'Unknown token.');
  amx_db()->prepare('UPDATE tokens SET used_at = ? WHERE id = ?')->execute([time(), $row['id']]);
  return $row['name'];
}

function amx_new_token(): string {
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  $token = 'amx_';
  for ($i = 0; $i < 40; $i++) $token .= $alphabet[random_int(0, 61)];
  return $token;
}

// ---- Versions ------------------------------------------------------------

function amx_guess_platform(string $file): ?string {
  $name = strtolower($file);
  if (preg_match('/mac.*arm64|arm64.*mac|apple.?silicon/', $name)) return 'mac-arm64';
  if (preg_match('/mac|darwin|\.dmg$/', $name)) return 'mac-x64';
  if (preg_match('/\.(exe|msi|msix)$/', $name)) return 'windows';
  if (preg_match('/linux|\.appimage$|\.deb$|\.rpm$/', $name)) return 'linux';
  return null;
}

function amx_guess_version(string $file): string {
  return preg_match('/(\d+\.\d+(?:\.\d+)?(?:-(?:alpha|beta|rc|pre)[0-9A-Za-z.]*?)?)(?=\.(?:exe|zip|dmg|msi|msix|appimage|deb|rpm)$|-(?:mac|win|linux|arm64|x64))/i', $file, $m) ? $m[1] : '';
}

function amx_safe_name(string $name): string {
  $name = preg_replace('/[^A-Za-z0-9._-]+/', '-', basename($name));
  $name = trim($name, '.-');
  if ($name === '' || !preg_match('/\.(exe|zip|dmg|msi|msix|appimage|deb|rpm|tar\.gz)$/i', $name)) return '';
  return $name;
}

function amx_version_row(array $row, bool $admin = false): array {
  $out = [
    'id' => (int) $row['id'], 'version' => $row['version'], 'platform' => $row['platform'],
    'channel' => $row['channel'], 'size' => (int) $row['size'], 'sha256' => $row['sha256'],
    'notes' => $row['notes'], 'date' => date('Y-m-d', (int) $row['created_at']),
    'url' => 'dl.php?id=' . (int) $row['id'],
  ];
  if ($admin) {
    $out['file'] = $row['file'];
    $out['hidden'] = (bool) $row['hidden'];
    $out['latest'] = (bool) $row['latest'];
    $out['downloads'] = (int) ($row['downloads'] ?? 0);
    $out['missing'] = !is_file(AMX_DOWNLOADS . '/' . $row['file']);
  }
  return $out;
}

// The version a "Download" button gives: the one marked latest, otherwise the newest
// visible one of that platform.
function amx_latest(string $platform): ?array {
  $q = amx_db()->prepare('SELECT * FROM versions WHERE platform = ? AND hidden = 0 ORDER BY latest DESC, created_at DESC, id DESC');
  $q->execute([$platform]);
  foreach ($q->fetchAll() as $row) {
    if (is_file(AMX_DOWNLOADS . '/' . $row['file'])) return $row; // a build whose file is gone is skipped
  }
  return null;
}

function amx_mark_latest(int $id): void {
  $db = amx_db();
  $q = $db->prepare('SELECT platform FROM versions WHERE id = ?');
  $q->execute([$id]);
  $platform = $q->fetchColumn();
  if ($platform === false) return;
  $db->prepare('UPDATE versions SET latest = 0 WHERE platform = ?')->execute([$platform]);
  $db->prepare('UPDATE versions SET latest = 1, hidden = 0 WHERE id = ?')->execute([$id]);
}

function amx_add_version(string $file, string $version, string $platform, string $channel, string $notes, bool $latest, ?int $createdAt = null): int {
  $path = AMX_DOWNLOADS . '/' . $file;
  $db = amx_db();
  $db->prepare('INSERT INTO versions (version, platform, channel, file, size, sha256, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    ->execute([$version, $platform, $channel, $file, filesize($path), hash_file('sha256', $path), $notes, $createdAt ?? time()]);
  $id = (int) $db->lastInsertId();
  if ($latest) amx_mark_latest($id);
  return $id;
}

// Builds put into downloads/ by hand (or shipped with the site) join the list.
function amx_import_downloads(): array {
  if (!is_dir(AMX_DOWNLOADS)) return [];
  $known = amx_db()->query('SELECT file FROM versions')->fetchAll(PDO::FETCH_COLUMN);
  $added = [];
  $files = glob(AMX_DOWNLOADS . '/*') ?: [];
  usort($files, function ($a, $b) { return filemtime($a) <=> filemtime($b); });
  foreach ($files as $path) {
    $file = basename($path);
    if (!is_file($path) || in_array($file, $known, true) || amx_safe_name($file) !== $file) continue;
    $platform = amx_guess_platform($file);
    if ($platform === null) continue;
    $version = amx_guess_version($file);
    if ($version === '') continue; // only files named with their version, like Amethyx-Setup-1.7.0.exe
    $channel = stripos($version, 'beta') !== false ? 'beta' : 'release';
    $added[] = amx_add_version($file, $version, $platform, $channel, '', false, filemtime($path));
  }
  foreach (AMX_PLATFORMS as $platform) {
    $q = amx_db()->prepare('SELECT COUNT(*) FROM versions WHERE platform = ? AND latest = 1');
    $q->execute([$platform]);
    if ((int) $q->fetchColumn() === 0 && ($row = amx_latest($platform))) amx_mark_latest((int) $row['id']);
  }
  return $added;
}

// ---- Update feeds for the launcher ---------------------------------------
// The launcher reads updates/latest.json (the released version) and updates/beta.json (the newest
// test build; only launchers already on a beta read it, and they take whichever of the two is
// newer). Plain files, so they work on any hosting; rewritten after every change of the versions
// list. Each takes the Windows build of its channel marked latest, otherwise the newest one.
// An update the launcher downloads goes through dl.php and counts as a download.

function amx_feed_row(string $channel): ?array {
  $q = amx_db()->prepare("SELECT * FROM versions WHERE platform = 'windows' AND hidden = 0 AND channel = ?
    ORDER BY latest DESC, created_at DESC, id DESC");
  $q->execute([$channel]);
  foreach ($q->fetchAll() as $row) {
    if (amx_file_present($row)) return $row; // a build whose file is gone is skipped
  }
  return null;
}

function amx_file_present(array $row): bool {
  return is_file(AMX_DOWNLOADS . '/' . $row['file']);
}

// Without $base it is called on requests of the admin (session or token): the site's address is
// taken from such a request, never from a visitor's, whose Host header could point anywhere,
// and remembered so that amx_heal_feeds() can bring the files back later.
function amx_write_feeds(?string $base = null): void {
  $dir = AMX_ROOT . '/updates';
  if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return;
  if ($base === null) {
    $host = preg_replace('/[^A-Za-z0-9.:-]/', '', $_SERVER['HTTP_HOST'] ?? '');
    // The launcher only takes https links; plain http stays only for a test on this computer.
    $local = preg_match('/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/', $host);
    $base = ($host !== '' ? ($local && !amx_https() ? 'http://' : 'https://') . $host : '')
      . rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/';
    amx_set_setting('site_base', $base);
  }
  foreach (['latest' => 'release', 'beta' => 'beta'] as $name => $channel) {
    $row = amx_feed_row($channel);
    $file = "$dir/$name.json";
    if (!$row) { @unlink($file); continue; }
    $feed = [
      'version' => $row['version'], 'date' => date('Y-m-d', (int) $row['created_at']), 'notes' => mb_substr($row['notes'], 0, 4000),
      'installer' => ['url' => $base . 'dl.php?id=' . (int) $row['id'], 'sha256' => $row['sha256'], 'size' => (int) $row['size']],
    ];
    @file_put_contents($file, json_encode($feed, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), LOCK_EX);
  }
}

// The site's files can be replaced or wiped while the database (outside the site folder) stays:
// then the feeds are written again with the address the admin's requests left behind.
function amx_heal_feeds(): void {
  $dir = AMX_ROOT . '/updates';
  if (is_file("$dir/beta.json") && is_file("$dir/latest.json")) return;
  $base = amx_setting('site_base');
  if (!$base) return;
  foreach (['latest' => 'release', 'beta' => 'beta'] as $name => $channel) {
    if (!is_file("$dir/$name.json") && amx_feed_row($channel)) { amx_write_feeds($base); return; }
  }
}

// ---- Counters ------------------------------------------------------------
// Only numbers per day are kept: no addresses, no cookies, nothing about the visitor.

function amx_count(string $kind, string $ref = ''): void {
  amx_db()->prepare('INSERT INTO stats (day, kind, ref, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, kind, ref) DO UPDATE SET n = n + 1')
    ->execute([date('Y-m-d'), $kind, $ref]);
}

function amx_bytes(string $value): int {
  $value = trim($value);
  if ($value === '' || $value === '-1') return PHP_INT_MAX;
  $n = (int) $value;
  switch (strtolower(substr($value, -1))) {
    case 'g': $n *= 1024;
    case 'm': $n *= 1024;
    case 'k': $n *= 1024;
  }
  return $n;
}

// Pieces of an upload stay well under the hosting's request size limit.
function amx_chunk_size(): int {
  $limit = amx_bytes((string) ini_get('post_max_size'));
  return (int) max(256 * 1024, min(8 * 1024 * 1024, $limit * 0.8));
}
