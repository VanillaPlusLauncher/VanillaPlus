<?php
// Core of the Amethyx server on the site's hosting (the PHP twin of server/src/worker.js): its two
// SQLite databases, answers, request bodies, the client's address, the rate limit, the hourly
// cleanup and outgoing HTTPS. Works on PHP 7.4 and newer.
// Nothing here is reachable from the web by itself (see ../.htaccess and the guard below).

if (!defined('AMX')) { http_response_code(404); exit; }

const CLOUD_JSON = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_INVALID_UTF8_SUBSTITUTE;
const CLOUD_MAX_PNG_BYTES = 256 * 1024;
// JSON bodies: 512 KB as in the worker; a message may carry a picture of up to 900 KB of base64.
const CLOUD_MAX_JSON = CLOUD_MAX_PNG_BYTES * 2;
const CLOUD_MAX_MESSAGE_JSON = 1200 * 1024;
// Requests a minute from one address: /v1/ and /ip as in the worker; the launcher's polling of
// /v1/updates and the CDN proxy (a modpack is hundreds of files) have their own, wider limits.
const CLOUD_RATE_LIMIT = 60;
const CLOUD_UPDATES_RATE_LIMIT = 600;
const CLOUD_PROXY_RATE_LIMIT = 1200;
const CLOUD_CLEANUP_EVERY = 3600;
const CLOUD_TOO_MANY = 'Слишком много запросов, подождите минуту.';

class CloudFailure extends Exception {
  public $status;

  public function __construct(int $status, string $message) {
    parent::__construct($message);
    $this->status = $status;
  }
}

// ---- Answers --------------------------------------------------------------
// A handler returns [status, headers, body]; index.php sends it. JSON is not kept by anyone unless
// a handler says otherwise (the skins of /csl).

function cloud_json($body, int $status = 200, array $headers = []): array {
  $headers += ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'];
  return ['status' => $status, 'headers' => $headers, 'body' => (string) json_encode($body, CLOUD_JSON)];
}

function cloud_bytes(string $data, string $type, array $headers = [], int $status = 200): array {
  return ['status' => $status, 'headers' => ['Content-Type' => $type] + $headers, 'body' => $data];
}

function cloud_send(array $response): void {
  if (headers_sent()) return;
  http_response_code($response['status']);
  foreach ($response['headers'] as $name => $value) header($name . ': ' . $value);
  // With PHP's own compression on, the length of what goes out is not known here.
  if (!filter_var(ini_get('zlib.output_compression'), FILTER_VALIDATE_BOOLEAN)) header('Content-Length: ' . strlen($response['body']));
  echo $response['body'];
  while (ob_get_level() > 0) @ob_end_flush();
  flush();
}

// ---- Time, randomness, text as the worker had them -------------------------

function cloud_ms(): int {
  return (int) floor(microtime(true) * 1000);
}

function cloud_random_hex(int $bytes): string {
  return bin2hex(random_bytes($bytes));
}

// JavaScript's String.trim(): Unicode spaces as well.
function cloud_trim(string $text): string {
  $trimmed = preg_replace('/^[\s\p{Z}\x{FEFF}]+|[\s\p{Z}\x{FEFF}]+$/uD', '', $text);
  return $trimmed === null ? trim($text) : $trimmed;
}

function cloud_cut(string $text, int $max): string {
  return mb_substr($text, 0, $max, 'UTF-8');
}

// The worker's text(value, max): a trimmed string cut to $max characters, or null.
function cloud_text($value, int $max): ?string {
  if (!is_string($value)) return null;
  $text = cloud_trim($value);
  return $text === '' ? null : cloud_cut($text, $max);
}

// A string field; anything else counts as empty (so it fails the checks that follow).
function cloud_str($value): string {
  return is_string($value) ? $value : '';
}

// JavaScript's Number(value) for what JSON holds; null stands for NaN.
function cloud_number($value) {
  if ($value === null) return 0;
  if (is_bool($value)) return $value ? 1 : 0;
  if (is_int($value)) return $value;
  if (is_float($value)) return is_finite($value) ? $value : null;
  if (is_string($value)) {
    $text = trim($value);
    if ($text === '') return 0;
    return is_numeric($text) ? $text + 0 : null;
  }
  return null;
}

function cloud_is_integer($number): bool {
  return is_int($number) || (is_float($number) && is_finite($number) && floor($number) === $number);
}

// Number.isFinite(value) ? Math.round(value) : null
function cloud_round($value): ?int {
  return is_int($value) || (is_float($value) && is_finite($value)) ? (int) floor($value + 0.5) : null;
}

// ---- Request --------------------------------------------------------------

// The body, at most $max bytes. A POST over the hosting's post_max_size arrives empty: too big too.
function cloud_input(int $max, string $tooBig = 'Слишком большой запрос.'): string {
  $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
  if ($length > $max) throw new CloudFailure(413, $tooBig);
  $data = (string) @file_get_contents('php://input', false, null, 0, $max + 1);
  if (strlen($data) > $max || ($data === '' && $length > 0)) throw new CloudFailure(413, $tooBig);
  return $data;
}

function cloud_read_json(int $max = CLOUD_MAX_JSON): array {
  $body = json_decode(cloud_input($max), true);
  if (is_array($body)) return $body;
  throw new CloudFailure(400, 'Нужен JSON.');
}

function cloud_authorization(): string {
  $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
  if ($header === '' && function_exists('getallheaders')) {
    foreach (getallheaders() as $name => $value) if (strcasecmp($name, 'Authorization') === 0) $header = $value;
  }
  return (string) $header;
}

// The path under /cloud: "/v1/me" for https://launcher.x-world.plus/cloud/v1/me?…, still
// percent-encoded (friend ids are decoded where they are read).
function cloud_path(): string {
  $path = explode('?', (string) ($_SERVER['REQUEST_URI'] ?? '/'), 2)[0];
  // The folder of index.php in the address: from SCRIPT_NAME when it names index.php, else this
  // folder's own name ("/cloud").
  $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
  $bases = [];
  if (substr($script, -10) === '/index.php') $bases[] = substr($script, 0, -10);
  $bases[] = '/' . basename(dirname(__DIR__));
  foreach ($bases as $base) {
    if ($base === '') continue;
    if ($path === $base) return '/';
    if (strpos($path, $base . '/') === 0) return substr($path, strlen($base));
  }
  return $path === '' ? '/' : $path;
}

// The client's address. nginx in front of Apache connects from this machine (127.0.0.1, or the
// server's own address on some hostings): then, and only then, the address nginx passes on counts,
// X-Real-IP or the last X-Forwarded-For entry (the one nginx added; the ones before it come from
// the client and may be anything).
function cloud_client_ip(): string {
  $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
  if ($ip === '127.0.0.1' || $ip === '::1' || ($ip !== '' && $ip === (string) ($_SERVER['SERVER_ADDR'] ?? ''))) {
    $forwarded = trim((string) ($_SERVER['HTTP_X_REAL_IP'] ?? ''));
    if ($forwarded === '') {
      $list = explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
      $forwarded = trim((string) end($list));
    }
    if (filter_var($forwarded, FILTER_VALIDATE_IP)) $ip = $forwarded;
  }
  return $ip;
}

// ---- Databases ------------------------------------------------------------
// Two files in the site's data folder (amx_data_dir: outside the web root when the hosting allows,
// otherwise site/data, closed), named like the site's own with a random part: cloud-<random>.sqlite
// (accounts, friends, messages) and cloud-files-<random>.sqlite (files of share codes, big and
// apart, so they never crowd out the rest).

function cloud_db(): PDO {
  static $db = null;
  if (!$db) $db = cloud_open('cloud', CLOUD_MAIN_SCHEMA);
  return $db;
}

function cloud_files_db(): PDO {
  static $db = null;
  if (!$db) $db = cloud_open('cloud-files', CLOUD_FILES_SCHEMA);
  return $db;
}

function cloud_find_db(string $dir, string $prefix): ?string {
  foreach (glob($dir . '/' . $prefix . '-*.sqlite') ?: [] as $file) {
    // "cloud-*" also matches "cloud-files-*": only <prefix>-<24 hex>.sqlite is this one.
    if (preg_match('/^' . preg_quote($prefix, '/') . '-[0-9a-f]{24}\.sqlite$/D', basename($file))) return $file;
  }
  return null;
}

function cloud_open(string $prefix, string $schema): PDO {
  if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) throw new RuntimeException('PHP on this hosting has no pdo_sqlite.');
  $dir = amx_data_dir();
  $file = cloud_find_db($dir, $prefix);
  if ($file !== null) return cloud_connect($file, $schema);
  // The very first requests may come together: only one of them makes the file.
  $lock = @fopen($dir . '/' . $prefix . '.lock', 'c');
  if ($lock) flock($lock, LOCK_EX);
  try {
    $file = cloud_find_db($dir, $prefix);
    return cloud_connect($file ?? $dir . '/' . $prefix . '-' . cloud_random_hex(12) . '.sqlite', $schema);
  } finally {
    if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
  }
}

function cloud_connect(string $file, string $schema): PDO {
  $db = new PDO('sqlite:' . $file, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);
  // A busy database makes a request wait a little instead of failing; WAL lets reads go on
  // during a write; the WAL file is cut back after big writes (file parts, imports).
  $db->exec('PRAGMA busy_timeout = 5000');
  $db->exec('PRAGMA journal_mode = WAL');
  $db->exec('PRAGMA synchronous = NORMAL');
  $db->exec('PRAGMA journal_size_limit = 67108864');
  if ((int) $db->query('PRAGMA user_version')->fetchColumn() < CLOUD_SCHEMA_VERSION) {
    $db->exec($schema);
    $db->exec('PRAGMA user_version = ' . CLOUD_SCHEMA_VERSION);
  }
  return $db;
}

// A statement with its values bound by type: numbers as numbers, so SQLite compares and stores
// them as the worker's D1 did.
function cloud_run(PDO $db, string $sql, array $args = []): PDOStatement {
  $query = $db->prepare($sql);
  cloud_bind($query, $args);
  $query->execute();
  return $query;
}

function cloud_bind(PDOStatement $query, array $args): void {
  $index = 1;
  foreach ($args as $value) {
    $type = is_int($value) ? PDO::PARAM_INT : ($value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
    $query->bindValue($index++, $value, $type);
  }
}

function cloud_row(PDO $db, string $sql, array $args = []): ?array {
  $row = cloud_run($db, $sql, $args)->fetch();
  return $row === false ? null : $row;
}

function cloud_rows(PDO $db, string $sql, array $args = []): array {
  return cloud_run($db, $sql, $args)->fetchAll();
}

// Runs $work in one write transaction, taken at once (BEGIN IMMEDIATE): a busy database makes it
// wait (busy_timeout) rather than fail halfway.
function cloud_tx(PDO $db, callable $work) {
  $db->exec('BEGIN IMMEDIATE');
  try {
    $result = $work($db);
    $db->exec('COMMIT');
    return $result;
  } catch (Throwable $error) {
    try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) { /* already rolled back */ }
    throw $error;
  }
}

// A random secret of this server (it keys the hashes of addresses in the rate limit).
function cloud_secret(): string {
  static $secret = null;
  if ($secret !== null) return $secret;
  $db = cloud_db();
  $row = cloud_row($db, "SELECT v FROM cloud_state WHERE k = 'secret'");
  if (!$row) {
    cloud_run($db, "INSERT OR IGNORE INTO cloud_state (k, v) VALUES ('secret', ?)", [cloud_random_hex(32)]);
    $row = cloud_row($db, "SELECT v FROM cloud_state WHERE k = 'secret'");
  }
  return $secret = (string) $row['v'];
}

// ---- Rate limit -----------------------------------------------------------
// Requests per address in the current minute, kept only as a keyed hash of the address and only
// for that minute (a new minute starts the count again).

function cloud_rate_limit(string $bucket, int $limit): void {
  $who = substr(hash_hmac('sha256', cloud_client_ip(), cloud_secret()), 0, 32);
  $minute = intdiv(time(), 60);
  $db = cloud_db();
  cloud_run($db, 'INSERT INTO cloud_rate (who, bucket, minute, n) VALUES (?, ?, ?, 1)
    ON CONFLICT (who, bucket) DO UPDATE SET n = CASE WHEN minute = excluded.minute THEN n + 1 ELSE 1 END, minute = excluded.minute',
    [$who, $bucket, $minute]);
  $row = cloud_row($db, 'SELECT n FROM cloud_rate WHERE who = ? AND bucket = ?', [$who, $bucket]);
  if ($row && (int) $row['n'] > $limit) throw new CloudFailure(429, CLOUD_TOO_MANY);
}

// ---- Cleanup --------------------------------------------------------------
// The worker's daily cron, here at most once an hour, started by whichever request comes: pictures
// older than 30 days (the messages stay, showing "picture expired"), expired sign-ins and
// challenges, old tunnels, share-code files no code needs any more, uploads never finished, and
// the rate limit's past minutes.

const CLOUD_IMAGE_DAYS = 30;
const CLOUD_TUNNEL_DAYS = 2;

// Whether this request takes the cleanup's turn (only one of many at the same moment does).
function cloud_cleanup_due(): bool {
  $db = cloud_db();
  $now = time();
  $row = cloud_row($db, "SELECT v FROM cloud_state WHERE k = 'cleanup'");
  if ($row && (int) $row['v'] > $now - CLOUD_CLEANUP_EVERY) return false;
  $query = $row
    ? cloud_run($db, "UPDATE cloud_state SET v = ? WHERE k = 'cleanup' AND v = ?", [(string) $now, $row['v']])
    : cloud_run($db, "INSERT OR IGNORE INTO cloud_state (k, v) VALUES ('cleanup', ?)", [(string) $now]);
  return $query->rowCount() === 1;
}

// Deletes in batches; false when a batch was full (there is more for the next turn).
function cloud_cleanup(int $rows, int $big): bool {
  $now = cloud_ms();
  $done = true;
  $batch = function (PDO $db, string $table, string $where, array $args, int $limit) use (&$done) {
    $query = cloud_run($db, "DELETE FROM $table WHERE rowid IN (SELECT rowid FROM $table WHERE $where LIMIT $limit)", $args);
    if ($query->rowCount() >= $limit) $done = false;
  };
  $db = cloud_db();
  $batch($db, 'images', 'created_at < ?', [$now - CLOUD_IMAGE_DAYS * 86400000], $big);
  $batch($db, 'challenges', 'expires_at < ?', [$now], $rows);
  $batch($db, 'sessions', 'expires_at < ?', [$now], $rows);
  $batch($db, 'tunnels', 'created_at < ?', [$now - CLOUD_TUNNEL_DAYS * 86400000], $rows);
  $batch($db, 'cloud_rate', 'minute < ?', [intdiv(time(), 60) - 1], max($rows, 5000));
  $files = cloud_files_db();
  $batch($files, 'packs', 'expires_at < ?', [$now], $rows);
  // Parts first, then the files whose parts are all gone.
  $batch($files, 'blob_parts', 'EXISTS (SELECT 1 FROM blobs WHERE blobs.owner_id = blob_parts.owner_id AND blobs.hash = blob_parts.hash AND blobs.expires_at < ?)', [$now], $big);
  $batch($files, 'blobs', 'expires_at < ? AND NOT EXISTS (SELECT 1 FROM blob_parts WHERE blob_parts.owner_id = blobs.owner_id AND blob_parts.hash = blobs.hash)', [$now], $rows);
  return $done;
}

// After the answer is out. With PHP-FPM the visitor no longer waits for it at all; otherwise the
// batches are small, and what is left goes to the next turn a minute later.
function cloud_after_response(): void {
  try {
    if (!cloud_cleanup_due()) return;
    $background = function_exists('fastcgi_finish_request');
    if ($background) {
      fastcgi_finish_request();
      ignore_user_abort(true);
      @set_time_limit(300);
    }
    $done = $background ? cloud_cleanup(20000, 2000) : cloud_cleanup(300, 20);
    if (!$done) cloud_run(cloud_db(), "UPDATE cloud_state SET v = ? WHERE k = 'cleanup'", [(string) (time() - CLOUD_CLEANUP_EVERY + 60)]);
  } catch (Throwable $error) {
    error_log('Amethyx cloud cleanup: ' . $error->getMessage());
  }
}

// ---- Outgoing HTTPS -------------------------------------------------------

// GET with a 10-second limit, through curl when the hosting has it, otherwise PHP's own streams.
// Returns [status, body]; throws when the other side cannot be reached.
function cloud_http_get(string $url, array $headers): array {
  if (function_exists('curl_init')) {
    $curl = curl_init($url);
    curl_setopt_array($curl, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_HTTPHEADER => $headers,
      CURLOPT_FOLLOWLOCATION => true,
      CURLOPT_MAXREDIRS => 3,
      CURLOPT_CONNECTTIMEOUT => 10,
      CURLOPT_TIMEOUT => 10,
    ]);
    $body = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);
    if ($body === false) throw new RuntimeException('HTTPS request failed: ' . $error);
    return [$status, (string) $body];
  }
  $context = stream_context_create(['http' => [
    'method' => 'GET', 'header' => implode("\r\n", $headers), 'timeout' => 10,
    'ignore_errors' => true, 'follow_location' => 1, 'max_redirects' => 3,
  ]]);
  $body = @file_get_contents($url, false, $context);
  $status = 0;
  foreach ($http_response_header ?? [] as $line) {
    if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $line, $match)) $status = (int) $match[1]; // the last answer after redirects
  }
  if ($body === false || $status === 0) throw new RuntimeException('HTTPS request failed: ' . $url);
  return [$status, (string) $body];
}
