<?php
// The Amethyx server on the site's own hosting: https://launcher.x-world.plus/cloud/… (.htaccess
// sends every address here). Skins and capes other Amethyx players see in the game, friends with
// online status and messages, files of share codes, and a way to Modrinth and CurseForge for
// players whose network blocks them. The same answers as the old Cloudflare server
// (server/src/worker.js), without what ordinary hosting cannot do: tunnels and pushed events
// (the launcher asks /v1/updates instead).

define('AMX', true);
require __DIR__ . '/../lib/amethyx.php';
require __DIR__ . '/lib/schema.php';
require __DIR__ . '/lib/core.php';
require __DIR__ . '/lib/accounts.php';
require __DIR__ . '/lib/social.php';
require __DIR__ . '/lib/files.php';
require __DIR__ . '/lib/proxy.php';
require __DIR__ . '/lib/import.php';

const CLOUD_NO_TUNNELS = 'Туннели отключены: друзья подключаются напрямую.';

function cloud_route(string $method, string $path): ?array {
  if ($path === '/' && $method === 'GET') return cloud_json(['name' => 'Amethyx server', 'api' => 1]);
  // The player's outside address, for when their router does not open a port by itself (UPnP).
  if ($path === '/ip' && $method === 'GET') {
    cloud_rate_limit('api', CLOUD_RATE_LIMIT);
    return cloud_json(['ip' => cloud_client_ip()]);
  }

  if ($method === 'GET' && preg_match('#^/csl/(ms|ely|offline)/([A-Za-z0-9_]{1,16})\.json$#D', $path, $match)) return cloud_csl_profile($match[1], $match[2]);
  if ($method === 'GET' && preg_match('#^/(?:csl/(?:ms|ely|offline)/)?textures/([0-9a-f]{64})$#D', $path, $match)) return cloud_texture($match[1]);
  if ($method === 'GET' && preg_match('#^/packs/([0-9a-f]{32})$#D', $path, $match)) return cloud_pack_info($match[1]);
  if ($method === 'GET' && preg_match('#^/packs/([0-9a-f]{32})/([0-9a-f]{64})/(\d{1,4})$#D', $path, $match)) return cloud_pack_part($match[1], $match[2], (int) $match[3]);
  if ($method === 'GET' && $path === '/proxy') return cloud_proxy();
  if (($method === 'GET' || $method === 'POST') && $path === '/admin/import') return cloud_import($method);

  if (strpos($path, '/v1/') !== 0) return cloud_json(['error' => 'Не найдено.'], 404);
  // Parts of an upload come dozens a minute: past the limiter, but signed in and within the player's share.
  if ($method === 'PUT' && preg_match('#^/v1/files/([0-9a-f]{64})/(\d{1,4})$#D', $path, $match)) return cloud_put_part(cloud_authenticate(), $match[1], (int) $match[2]);
  // Asked every few seconds by each open launcher: a limit of its own.
  if ($method === 'GET' && $path === '/v1/updates') {
    cloud_rate_limit('updates', CLOUD_UPDATES_RATE_LIMIT);
    return cloud_updates(cloud_authenticate());
  }
  cloud_rate_limit('api', CLOUD_RATE_LIMIT);
  if ($method === 'POST' && $path === '/v1/auth/challenge') return cloud_start_challenge();
  if ($method === 'POST' && $path === '/v1/auth/verify') return cloud_finish_challenge();
  if ($method === 'POST' && $path === '/v1/auth/offline') return cloud_offline_sign_in();
  // No WebSockets on this hosting: friends join each other's worlds directly, news come by /v1/updates.
  if ($path === '/v1/live') throw new CloudFailure(410, 'Мгновенные уведомления недоступны.');
  if ($path === '/v1/tunnels' || strpos($path, '/v1/tunnels/') === 0) throw new CloudFailure(410, CLOUD_NO_TUNNELS);

  $user = cloud_authenticate();
  if ($method === 'GET' && $path === '/v1/me') return cloud_json(cloud_public_user($user, true));
  if ($method === 'GET' && $path === '/v1/messages') return cloud_list_messages($user);
  if ($method === 'POST' && $path === '/v1/messages') return cloud_send_message($user);
  if ($method === 'POST' && $path === '/v1/messages/read') return cloud_mark_read($user);
  if ($method === 'POST' && $path === '/v1/files/start') return cloud_start_upload($user);
  if ($method === 'POST' && $path === '/v1/packs') return cloud_create_pack($user);
  if ($method === 'GET' && preg_match('#^/v1/images/([0-9a-f]{32})$#D', $path, $match)) return cloud_image($user, $match[1]);
  if (($method === 'PUT' || $method === 'DELETE') && $path === '/v1/me/skin') return cloud_set_texture($method, $user, 'skin');
  if (($method === 'PUT' || $method === 'DELETE') && $path === '/v1/me/cape') return cloud_set_texture($method, $user, 'cape');
  if ($method === 'POST' && $path === '/v1/me/presence') return cloud_set_presence($user);
  if ($method === 'GET' && $path === '/v1/friends') return cloud_list_friends($user);
  if ($method === 'POST' && $path === '/v1/friends/request') return cloud_request_friend($user);
  if ($method === 'POST' && $path === '/v1/friends/accept') return cloud_answer_request($user, true);
  if ($method === 'POST' && $path === '/v1/friends/decline') return cloud_answer_request($user, false);
  if ($method === 'DELETE' && preg_match('#^/v1/friends/([^/]{1,64})$#D', $path, $match)) return cloud_remove_friend($user, rawurldecode($match[1]));
  return cloud_json(['error' => 'Не найдено.'], 404);
}

try {
  $response = cloud_route((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'), cloud_path());
  if ($response !== null) cloud_send($response);
} catch (CloudFailure $failure) {
  cloud_send(cloud_json(['error' => $failure->getMessage()], $failure->status));
} catch (Throwable $error) {
  error_log('Amethyx cloud: ' . $error);
  cloud_send(cloud_json(['error' => 'Ошибка сервера.'], 500));
}
cloud_after_response();
