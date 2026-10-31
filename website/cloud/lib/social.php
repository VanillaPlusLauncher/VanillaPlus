<?php
// Friends and messages of the Amethyx server: requests, the friends list with online status,
// messages (text, a picture, an invite to play) with read marks, and the news the launcher asks
// for every few seconds (/v1/updates; this hosting cannot hold a connection open for pushes).

if (!defined('AMX')) { http_response_code(404); exit; }

const CLOUD_MAX_FRIENDS = 200;
const CLOUD_MAX_OUTGOING = 50;
const CLOUD_MAX_TEXT = 2000;
const CLOUD_MAX_IMAGE_BASE64 = 900 * 1024;
const CLOUD_MAX_INVITE_CODE = 60 * 1024;
const CLOUD_PAGE = 50;
// News older than this are not sent (a launcher back from sleep loads its chats anyway).
const CLOUD_UPDATES_WINDOW_MS = 10 * 60 * 1000;
// The clock /v1/updates gives runs a second behind, so a message being written at this moment
// is never skipped: it comes with the next answer.
const CLOUD_UPDATES_LAG_MS = 1000;
const CLOUD_UPDATES_MAX = 200;

// ---- Friends --------------------------------------------------------------

function cloud_unread_counts(array $user) {
  $counts = [];
  foreach (cloud_rows(cloud_db(), 'SELECT from_id, COUNT(*) AS count FROM messages WHERE to_id = ? AND read_at IS NULL GROUP BY from_id', [$user['id']]) as $row) {
    $counts[$row['from_id']] = (int) $row['count'];
  }
  return (object) $counts; // {} when there is nothing, as the worker answered
}

function cloud_list_friends(array $user): array {
  $db = cloud_db();
  $map = function (array $rows, bool $withPresence) {
    return array_map(function ($row) use ($withPresence) { return cloud_public_user($row, $withPresence); }, $rows);
  };
  return cloud_json([
    'me' => cloud_public_user($user, true),
    'unread' => cloud_unread_counts($user),
    'friends' => $map(cloud_rows($db, 'SELECT users.* FROM friends JOIN users ON users.id = friends.friend_id WHERE friends.user_id = ? ORDER BY users.name', [$user['id']]), true),
    'incoming' => $map(cloud_rows($db, 'SELECT users.* FROM friend_requests JOIN users ON users.id = friend_requests.from_id WHERE friend_requests.to_id = ? ORDER BY friend_requests.created_at DESC', [$user['id']]), false),
    'outgoing' => $map(cloud_rows($db, 'SELECT users.* FROM friend_requests JOIN users ON users.id = friend_requests.to_id WHERE friend_requests.from_id = ? ORDER BY friend_requests.created_at DESC', [$user['id']]), false),
  ]);
}

function cloud_are_friends(string $a, string $b): bool {
  return (bool) cloud_row(cloud_db(), 'SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?', [$a, $b]);
}

function cloud_make_friends(string $a, string $b): void {
  cloud_tx(cloud_db(), function (PDO $db) use ($a, $b) {
    $now = cloud_ms();
    cloud_run($db, 'DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', [$a, $b, $b, $a]);
    cloud_run($db, 'INSERT OR IGNORE INTO friends (user_id, friend_id, since) VALUES (?, ?, ?)', [$a, $b, $now]);
    cloud_run($db, 'INSERT OR IGNORE INTO friends (user_id, friend_id, since) VALUES (?, ?, ?)', [$b, $a, $now]);
  });
}

function cloud_request_friend(array $user): array {
  $body = cloud_read_json();
  $ns = $body['ns'] ?? null;
  $name = is_scalar($body['name'] ?? null) ? (string) $body['name'] : '';
  // Offline players may have a code after the name: "Steve#3fa1".
  $ok = preg_match('/^([A-Za-z0-9_]{1,16})(?:#([0-9a-fA-F]{4}|[0-9a-fA-F]{8}))?$/D', $name, $parts);
  if (!in_array($ns, CLOUD_NAMESPACES, true) || !$ok || (!empty($parts[2]) && $ns !== 'offline')) {
    throw new CloudFailure(400, 'Введите ник: латинские буквы, цифры и _, до 16 символов (у офлайн-игрока может быть код: Ник#1a2b).');
  }
  $target = cloud_user_by_name($ns, $name);
  if (!$target) throw new CloudFailure(404, "$name ещё не заходил в Amethyx с таким аккаунтом: пусть откроет «Друзья» в своём лаунчере.");
  if ($target['id'] === $user['id']) throw new CloudFailure(400, 'Это вы.');
  if (cloud_are_friends($user['id'], $target['id'])) return cloud_json(['state' => 'friends', 'user' => cloud_public_user($target)]);
  $db = cloud_db();
  // They already asked us: that is a yes from both sides.
  if (cloud_row($db, 'SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?', [$target['id'], $user['id']])) {
    cloud_make_friends($user['id'], $target['id']);
    return cloud_json(['state' => 'friends', 'user' => cloud_public_user($target)]);
  }
  $counts = cloud_row($db, 'SELECT (SELECT COUNT(*) FROM friends WHERE user_id = ?) AS friends, (SELECT COUNT(*) FROM friend_requests WHERE from_id = ?) AS outgoing', [$user['id'], $user['id']]);
  if ((int) $counts['friends'] >= CLOUD_MAX_FRIENDS) throw new CloudFailure(400, 'Друзей может быть не больше ' . CLOUD_MAX_FRIENDS . '.');
  if ((int) $counts['outgoing'] >= CLOUD_MAX_OUTGOING) throw new CloudFailure(400, 'Слишком много заявок ждут ответа.');
  cloud_run($db, 'INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)', [$user['id'], $target['id'], cloud_ms()]);
  return cloud_json(['state' => 'requested', 'user' => cloud_public_user($target)]);
}

function cloud_answer_request(array $user, bool $accept): array {
  $id = cloud_read_json()['id'] ?? null;
  if (!is_string($id) || mb_strlen($id, 'UTF-8') > 64) throw new CloudFailure(400, 'Неверный запрос.');
  if ($accept) {
    if (!cloud_row(cloud_db(), 'SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?', [$id, $user['id']])) throw new CloudFailure(404, 'Заявка не найдена.');
    cloud_make_friends($user['id'], $id);
  } else {
    // Declines an incoming request or takes back an outgoing one.
    cloud_run(cloud_db(), 'DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', [$id, $user['id'], $user['id'], $id]);
  }
  return cloud_json(['ok' => true]);
}

function cloud_remove_friend(array $user, string $id): array {
  cloud_run(cloud_db(), 'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', [$user['id'], $id, $id, $user['id']]);
  return cloud_json(['ok' => true]);
}

// ---- Messages -------------------------------------------------------------

function cloud_public_message(array $row): array {
  $body = $row['body'];
  if ($row['kind'] !== 'text') {
    $body = json_decode((string) $row['body']);
    if (json_last_error() !== JSON_ERROR_NONE) $body = null;
  }
  return [
    'id' => (int) $row['id'], 'from' => $row['from_id'], 'to' => $row['to_id'], 'kind' => $row['kind'], 'body' => $body,
    'createdAt' => (int) $row['created_at'], 'readAt' => isset($row['read_at']) ? (int) $row['read_at'] : null,
  ];
}

function cloud_store_message(array $user, string $to, string $kind, string $body): array {
  [$id, $now] = cloud_tx(cloud_db(), function (PDO $db) use ($user, $to, $kind, $body) {
    // The time is taken inside the write: /v1/updates never sees a later time before this message.
    $now = cloud_ms();
    cloud_run($db, 'INSERT INTO messages (from_id, to_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)', [$user['id'], $to, $kind, $body, $now]);
    return [(int) $db->lastInsertId(), $now];
  });
  $message = cloud_public_message(['id' => $id, 'from_id' => $user['id'], 'to_id' => $to, 'kind' => $kind, 'body' => $body, 'created_at' => $now]);
  return cloud_json(['message' => $message]);
}

function cloud_send_message(array $user): array {
  // A picture is up to 900 KB of base64: this body may be bigger than the others.
  $body = cloud_read_json(CLOUD_MAX_MESSAGE_JSON);
  $to = cloud_str($body['to'] ?? null);
  if (!cloud_are_friends($user['id'], $to)) throw new CloudFailure(403, 'Писать можно только друзьям.');
  $kind = $body['kind'] ?? null;

  if ($kind === 'image') {
    $data = cloud_str($body['image'] ?? null);
    if ($data === '' || strlen($data) > CLOUD_MAX_IMAGE_BASE64) throw new CloudFailure(400, 'Картинка слишком большая.');
    $bytes = base64_decode(substr($data, 0, 16), true);
    if ($bytes === false) throw new CloudFailure(400, 'Картинка повреждена.');
    $type = substr($bytes, 0, 2) === "\xff\xd8" ? 'image/jpeg' : (substr($bytes, 0, 2) === "\x89\x50" ? 'image/png' : null);
    if (!$type) throw new CloudFailure(400, 'Нужна картинка JPEG или PNG.');
    $imageId = cloud_random_hex(16);
    cloud_run(cloud_db(), 'INSERT INTO images (id, owner_id, to_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)', [$imageId, $user['id'], $to, $type, $data, cloud_ms()]);
    $caption = is_string($body['caption'] ?? null) ? cloud_cut($body['caption'], 200) : '';
    $picture = ['imageId' => $imageId, 'caption' => $caption, 'width' => cloud_round($body['width'] ?? null), 'height' => cloud_round($body['height'] ?? null)];
    return cloud_store_message($user, $to, 'image', json_encode($picture, CLOUD_JSON));
  }

  if ($kind === 'invite') {
    $invite = is_array($body['invite'] ?? null) ? $body['invite'] : [];
    $code = is_string($invite['code'] ?? null) && mb_strlen($invite['code'], 'UTF-8') <= CLOUD_MAX_INVITE_CODE ? $invite['code'] : null;
    $tunnel = is_string($invite['tunnel'] ?? null) && preg_match('/^[0-9a-f]{32}$/D', $invite['tunnel']) ? $invite['tunnel'] : null;
    if ($tunnel && !cloud_row(cloud_db(), 'SELECT 1 FROM tunnels WHERE id = ? AND owner_id = ?', [$tunnel, $user['id']])) {
      throw new CloudFailure(400, 'Туннель к миру не найден.');
    }
    // The instance's picture: a block or item of the game, or a modpack's icon on the web.
    $icon = is_string($invite['icon'] ?? null) && preg_match('/(*UCP)^(block:[a-z0-9_]{1,48}|item:[a-z0-9_]{1,48}|https:\/\/[^\s"\'<>]{1,280})$/uD', $invite['icon']) ? $invite['icon'] : null;
    $inviteKind = in_array($invite['kind'] ?? null, ['world', 'server', 'pack', 'play'], true) ? $invite['kind'] : null;
    $clean = [
      'instance' => cloud_text($invite['instance'] ?? null, 64), 'minecraft' => cloud_text($invite['minecraft'] ?? null, 32),
      'loader' => cloud_text($invite['loader'] ?? null, 16), 'server' => cloud_text($invite['server'] ?? null, 128),
      'world' => cloud_text($invite['world'] ?? null, 64), 'code' => $code, 'tunnel' => $tunnel, 'icon' => $icon, 'kind' => $inviteKind,
    ];
    if (!$clean['server'] && !$clean['code'] && !$clean['world'] && !$clean['tunnel']) throw new CloudFailure(400, 'В приглашении нет ни сервера, ни сборки.');
    return cloud_store_message($user, $to, 'invite', json_encode($clean, CLOUD_JSON));
  }

  $text = is_string($body['text'] ?? null) ? cloud_trim($body['text']) : '';
  if ($text === '') throw new CloudFailure(400, 'Пустое сообщение.');
  if (mb_strlen($text, 'UTF-8') > CLOUD_MAX_TEXT) throw new CloudFailure(400, 'Сообщение длиннее ' . CLOUD_MAX_TEXT . ' символов.');
  return cloud_store_message($user, $to, 'text', $text);
}

// A page of the conversation with a friend, newest last. `before` pages back.
function cloud_list_messages(array $user): array {
  $other = is_string($_GET['with'] ?? null) ? $_GET['with'] : '';
  $before = cloud_number($_GET['before'] ?? '') ?: 9007199254740991; // Number(…) || Number.MAX_SAFE_INTEGER
  $rows = cloud_rows(cloud_db(), 'SELECT * FROM messages WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND id < ? ORDER BY id DESC LIMIT ' . CLOUD_PAGE,
    [$user['id'], $other, $other, $user['id'], is_int($before) ? $before : (float) $before]);
  return cloud_json(['messages' => array_map('cloud_public_message', array_reverse($rows)), 'more' => count($rows) === CLOUD_PAGE]);
}

function cloud_mark_read(array $user): array {
  $other = cloud_read_json()['with'] ?? null;
  if (!is_string($other)) throw new CloudFailure(400, 'Неверный запрос.');
  cloud_tx(cloud_db(), function (PDO $db) use ($user, $other) {
    cloud_run($db, 'UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL', [cloud_ms(), $user['id'], $other]);
  });
  return cloud_json(['ok' => true]);
}

function cloud_image(array $user, string $id): array {
  $row = cloud_row(cloud_db(), 'SELECT * FROM images WHERE id = ?', [$id]);
  if (!$row || ($row['owner_id'] !== $user['id'] && $row['to_id'] !== $user['id'])) return cloud_json(['error' => 'Картинка не найдена или устарела.'], 404);
  return cloud_bytes((string) base64_decode((string) $row['data']), $row['type'], ['Cache-Control' => 'private, max-age=86400']);
}

// GET /v1/updates?since=<ms>: what happened for this player after the clock of the last answer,
// as the events the worker's LiveHub pushed: { type: 'message', message, from } for messages to
// them, { type: 'read', by } when a friend read their messages. The launcher asks every few
// seconds; its first call (since=0) only sets its clock.
function cloud_updates(array $user): array {
  $now = cloud_ms() - CLOUD_UPDATES_LAG_MS;
  $since = cloud_number($_GET['since'] ?? null);
  if (!$since || $since < $now - CLOUD_UPDATES_WINDOW_MS) return cloud_json(['now' => $now, 'events' => []]);
  $since = (int) floor($since);
  $db = cloud_db();
  $rows = cloud_rows($db, 'SELECT * FROM messages WHERE to_id = ? AND created_at > ? AND created_at <= ? ORDER BY created_at, id LIMIT ' . CLOUD_UPDATES_MAX,
    [$user['id'], $since, $now]);
  if (count($rows) === CLOUD_UPDATES_MAX) {
    // More than one answer holds: up to just before the last moment here, the rest next time.
    $cut = (int) $rows[count($rows) - 1]['created_at'];
    $rows = array_values(array_filter($rows, function ($row) use ($cut) { return (int) $row['created_at'] < $cut; }));
    $now = $cut - 1;
  }
  $senders = [];
  $ids = array_values(array_unique(array_column($rows, 'from_id')));
  if ($ids) {
    $marks = implode(', ', array_fill(0, count($ids), '?'));
    foreach (cloud_rows($db, "SELECT * FROM users WHERE id IN ($marks)", $ids) as $sender) $senders[$sender['id']] = $sender;
  }
  $events = [];
  foreach ($rows as $row) {
    $from = $senders[$row['from_id']] ?? null;
    $events[] = ['type' => 'message', 'message' => cloud_public_message($row), 'from' => $from ? cloud_public_user($from) : null];
  }
  foreach (cloud_rows($db, 'SELECT DISTINCT to_id FROM messages WHERE from_id = ? AND read_at > ? AND read_at <= ?', [$user['id'], $since, $now]) as $row) {
    $events[] = ['type' => 'read', 'by' => $row['to_id']];
  }
  return cloud_json(['now' => $now, 'events' => $events]);
}
