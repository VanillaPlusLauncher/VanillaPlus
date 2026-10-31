<?php
// GET /proxy?u=<https URL>: files and pictures of Modrinth and CurseForge for players who cannot
// reach their CDNs (Cloudflare is blocked for many players in Russia; this hosting is not). Only
// those hosts, only GET; the answer is passed on as it comes, never held in memory.

if (!defined('AMX')) { http_response_code(404); exit; }

const CLOUD_PROXY_HOSTS = ['api.modrinth.com', 'cdn.modrinth.com', 'api.curseforge.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net', 'forgecdn.net'];
const CLOUD_PROXY_AGENT = 'Amethyx-Proxy (launcher.x-world.plus)';
const CLOUD_PROXY_MAX_BYTES = 1024 * 1024 * 1024;
const CLOUD_PROXY_REDIRECTS = 5;
// What the launcher's request may pass on (x-api-key: CurseForge's key) and what of the answer comes back.
const CLOUD_PROXY_REQUEST_HEADERS = ['Accept' => 'HTTP_ACCEPT', 'Range' => 'HTTP_RANGE', 'If-None-Match' => 'HTTP_IF_NONE_MATCH', 'x-api-key' => 'HTTP_X_API_KEY'];
// Content-Range and ETag belong to the Range and If-None-Match passed on; Content-Encoding only in
// case a CDN compresses although nobody asked it to.
const CLOUD_PROXY_ANSWER_HEADERS = ['content-type', 'content-length', 'cache-control', 'content-range', 'etag', 'content-encoding'];

// Only https://<one of the hosts>[:443]/path: no user part, no backslashes, nothing a URL parser
// could read differently from curl.
function cloud_proxy_allowed(string $url): bool {
  if (strlen($url) > 4096 || !preg_match('#^https://([A-Za-z0-9.-]+)(?::443)?(/[^\x00-\x20\x7f\\\\\#]*)?$#D', $url, $match)) return false;
  return in_array(strtolower($match[1]), CLOUD_PROXY_HOSTS, true);
}

// A redirect's Location against the address it came from.
function cloud_proxy_resolve(string $base, string $location): string {
  $location = trim($location);
  if (preg_match('#^[A-Za-z][A-Za-z0-9+.-]*:#', $location)) return $location;
  preg_match('#^(https://[^/]+)(/[^?]*)?#', $base, $parts);
  $origin = $parts[1] ?? '';
  if (strpos($location, '//') === 0) return 'https:' . $location;
  if (strpos($location, '/') === 0) return $origin . $location;
  $dir = isset($parts[2]) ? substr($parts[2], 0, (int) strrpos($parts[2], '/') + 1) : '/';
  return $origin . $dir . $location;
}

function cloud_proxy(): ?array {
  cloud_rate_limit('proxy', CLOUD_PROXY_RATE_LIMIT);
  $url = is_string($_GET['u'] ?? null) ? $_GET['u'] : '';
  if (!cloud_proxy_allowed($url)) throw new CloudFailure(403, 'Этот адрес прокси не открывает.');
  $headers = ['User-Agent: ' . CLOUD_PROXY_AGENT];
  foreach (CLOUD_PROXY_REQUEST_HEADERS as $name => $key) {
    $value = $_SERVER[$key] ?? '';
    if (is_string($value) && $value !== '' && strlen($value) <= 2048 && !preg_match('/[\r\n\x00]/', $value)) $headers[] = $name . ': ' . $value;
  }
  // A big file takes as long as it takes; nothing on the way may hold it back.
  @set_time_limit(0);
  @ini_set('zlib.output_compression', '0');
  if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
  while (ob_get_level() > 0) @ob_end_clean();
  for ($hop = 0; $hop <= CLOUD_PROXY_REDIRECTS; $hop++) {
    $location = function_exists('curl_init') ? cloud_proxy_curl($url, $headers) : cloud_proxy_stream($url, $headers);
    if ($location === null) return null; // passed on
    $url = cloud_proxy_resolve($url, $location);
    if (!cloud_proxy_allowed($url)) throw new CloudFailure(502, 'Сайт перенаправил на чужой адрес.');
  }
  throw new CloudFailure(502, 'Слишком много перенаправлений.');
}

// The answer's status and headers, sent once before the first byte of the body.
function cloud_proxy_start(int $status, array $answer): void {
  http_response_code($status);
  header_remove('Content-Type');
  $type = $answer['content-type'] ?? 'application/octet-stream';
  // Never a script or a page of this site's own address: scripts become text, pages run nothing.
  if (preg_match('#javascript|ecmascript#i', $type)) $type = 'text/plain';
  header('Content-Type: ' . $type);
  foreach (CLOUD_PROXY_ANSWER_HEADERS as $name) {
    if ($name !== 'content-type' && isset($answer[$name])) header(ucwords($name, '-') . ': ' . $answer[$name]);
  }
  header("Content-Security-Policy: default-src 'none'; sandbox");
  header('X-Content-Type-Options: nosniff');
  header('X-Accel-Buffering: no'); // nginx passes it on at once
}

function cloud_proxy_is_redirect(int $status, array $answer): bool {
  return in_array($status, [301, 302, 303, 307, 308], true) && isset($answer['location']);
}

function cloud_proxy_too_big(array $answer): bool {
  return isset($answer['content-length']) && (float) $answer['content-length'] > CLOUD_PROXY_MAX_BYTES;
}

// One request with curl. Returns the Location of a redirect, or null once the answer is passed on.
function cloud_proxy_curl(string $url, array $headers): ?string {
  $state = ['status' => 0, 'answer' => [], 'started' => false, 'stop' => null, 'bytes' => 0];
  $curl = curl_init($url);
  curl_setopt_array($curl, [
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_FOLLOWLOCATION => false, // each hop is checked against the hosts
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
    CURLOPT_CONNECTTIMEOUT => 10,
    // A stalled transfer ends; a slow but moving one goes on.
    CURLOPT_LOW_SPEED_LIMIT => 1,
    CURLOPT_LOW_SPEED_TIME => 30,
    CURLOPT_HEADERFUNCTION => function ($curl, $line) use (&$state) {
      if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match)) {
        $state['status'] = (int) $match[1];
        $state['answer'] = [];
      } elseif (strpos($line, ':') !== false) {
        [$name, $value] = explode(':', $line, 2);
        $state['answer'][strtolower(trim($name))] = trim($value);
      }
      return strlen($line);
    },
    CURLOPT_WRITEFUNCTION => function ($curl, $chunk) use (&$state) {
      if (!$state['started']) {
        if (cloud_proxy_is_redirect($state['status'], $state['answer'])) { $state['stop'] = 'redirect'; return 0; }
        if (cloud_proxy_too_big($state['answer'])) { $state['stop'] = 'big'; return 0; }
        cloud_proxy_start($state['status'], $state['answer']);
        $state['started'] = true;
      }
      $state['bytes'] += strlen($chunk);
      if ($state['bytes'] > CLOUD_PROXY_MAX_BYTES || connection_aborted()) return 0;
      echo $chunk;
      flush();
      return strlen($chunk);
    },
  ]);
  $ok = curl_exec($curl);
  curl_close($curl);
  if ($state['started']) return null; // a transfer broken halfway just ends: the client sees it is short
  if (cloud_proxy_is_redirect($state['status'], $state['answer'])) return $state['answer']['location'];
  if ($state['stop'] === 'big' || cloud_proxy_too_big($state['answer'])) throw new CloudFailure(413, 'Файл слишком большой.');
  if ($ok === false || $state['status'] === 0) throw new CloudFailure(502, 'Сайт не ответил.');
  // An answer without a body (304, 204, an empty file).
  cloud_proxy_start($state['status'], $state['answer']);
  return null;
}

// The same with PHP's own https streams, for hostings without curl.
function cloud_proxy_stream(string $url, array $headers): ?string {
  $context = stream_context_create([
    'http' => ['method' => 'GET', 'header' => implode("\r\n", array_merge($headers, ['Connection: close'])), 'protocol_version' => 1.1,
      'follow_location' => 0, 'ignore_errors' => true, 'timeout' => 30],
    'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
  ]);
  $in = @fopen($url, 'rb', false, $context);
  if (!$in) throw new CloudFailure(502, 'Сайт не ответил.');
  $status = 0;
  $answer = [];
  foreach (stream_get_meta_data($in)['wrapper_data'] ?? [] as $line) {
    if (!is_string($line)) continue;
    if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match)) { $status = (int) $match[1]; $answer = []; }
    elseif (strpos($line, ':') !== false) {
      [$name, $value] = explode(':', $line, 2);
      $answer[strtolower(trim($name))] = trim($value);
    }
  }
  if (cloud_proxy_is_redirect($status, $answer)) { fclose($in); return $answer['location']; }
  if ($status === 0) { fclose($in); throw new CloudFailure(502, 'Сайт не ответил.'); }
  if (cloud_proxy_too_big($answer)) { fclose($in); throw new CloudFailure(413, 'Файл слишком большой.'); }
  // PHP has already undone chunked transfer: the length is the file's own.
  unset($answer['transfer-encoding']);
  cloud_proxy_start($status, $answer);
  $bytes = 0;
  while (!feof($in) && !connection_aborted()) {
    $chunk = fread($in, 65536);
    if ($chunk === false || $chunk === '') {
      if (feof($in) || !empty(stream_get_meta_data($in)['timed_out'])) break; // a stalled transfer ends
      continue;
    }
    $bytes += strlen($chunk);
    if ($bytes > CLOUD_PROXY_MAX_BYTES) break;
    echo $chunk;
    flush();
  }
  fclose($in);
  return null;
}
