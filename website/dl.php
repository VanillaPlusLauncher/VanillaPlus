<?php
// Download links of the site: dl.php?platform=windows gives the latest build,
// dl.php?id=N a particular one. Each download adds one to that day's counter.

define('AMX', true);
require __DIR__ . '/lib/amethyx.php';

$row = null;
if (isset($_GET['id'])) {
  $q = amx_db()->prepare('SELECT * FROM versions WHERE id = ? AND hidden = 0');
  $q->execute([(int) $_GET['id']]);
  $row = $q->fetch() ?: null;
} else {
  $platform = in_array($_GET['platform'] ?? '', AMX_PLATFORMS, true) ? $_GET['platform'] : 'windows';
  $row = amx_latest($platform);
  // A build put into downloads/ by hand counts too, even before the admin looked at it.
  if (!$row && amx_import_downloads()) $row = amx_latest($platform);
}

if (!$row || !is_file(AMX_DOWNLOADS . '/' . $row['file'])) {
  http_response_code(404);
  header('Content-Type: text/html; charset=utf-8');
  echo '<!doctype html><meta charset="utf-8"><title>Amethyx</title><p style="font:16px sans-serif">Эта версия пока недоступна. <a href="./">На главную</a></p>';
  exit;
}

// The launcher fetches a big file in 4–16 parts at once, each through this link with its own
// Range; a resumed download starts mid-file too. Only the start of a file counts, so one
// download is one, and a HEAD request (just asking about the file) is none.
$range = $_SERVER['HTTP_RANGE'] ?? '';
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($range === '' || preg_match('/^bytes=0-/i', $range))) {
  amx_count('download', (string) $row['id']);
}
header('Cache-Control: no-store');
header('Location: downloads/' . rawurlencode($row['file']), true, 302);
