<?php
// Moving the old server's data here: POST admin/import?db=main|files with a piece of a dump of its
// Cloudflare database (wrangler d1 export; server/tools/import-to-site.mjs sends it in pieces).
// Only the site's API token may do it. The SQL is never run as it is: each statement is read here,
// only INSERTs into the old server's own tables are taken (their values become bound parameters),
// the dump's CREATE / PRAGMA lines are skipped, and anything else refuses the whole piece.

if (!defined('AMX')) { http_response_code(404); exit; }

const CLOUD_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

// The biggest piece this hosting takes in one request (a little under post_max_size).
function cloud_import_limit(): int {
  $limit = amx_bytes((string) ini_get('post_max_size'));
  return (int) min(CLOUD_IMPORT_MAX_BYTES, max(256 * 1024, $limit * 0.9));
}

function cloud_import(string $method): array {
  // The site's API token (Authorization: Bearer amx_…); a wrong one is refused and counted there.
  if (amx_token_user() === null) throw new CloudFailure(401, 'Нужен токен сайта.');
  if ($method === 'GET') return cloud_json(['maxBytes' => cloud_import_limit()]);
  $name = is_string($_GET['db'] ?? null) ? $_GET['db'] : '';
  if (!isset(CLOUD_TABLES[$name])) throw new CloudFailure(400, 'Укажите базу: db=main или db=files.');
  @set_time_limit(300);
  $tables = CLOUD_TABLES[$name];
  // Everything is read and checked before anything is written.
  $plan = [];
  $skipped = 0;
  foreach (cloud_sql_statements(cloud_input(CLOUD_IMPORT_MAX_BYTES)) as $tokens) {
    $insert = cloud_import_statement($tokens, $tables);
    if ($insert === null) $skipped++;
    else $plan[] = $insert;
  }
  // The first piece of a dump empties this database's tables first.
  $reset = ($_SERVER['HTTP_X_IMPORT_RESET'] ?? '') === '1';
  $db = $name === 'main' ? cloud_db() : cloud_files_db();
  $counts = array_fill_keys(array_keys($tables), 0);
  try {
    cloud_tx($db, function (PDO $db) use ($reset, $tables, $plan, &$counts) {
      if ($reset) {
        foreach (array_keys($tables) as $table) $db->exec("DELETE FROM $table");
        if (isset($tables['messages'])) $db->exec("DELETE FROM sqlite_sequence WHERE name = 'messages'");
      }
      $prepared = [];
      foreach ($plan as $insert) {
        [$table, $columns, $rows, $mode] = $insert;
        $key = "$mode $table " . implode(',', $columns);
        if (!isset($prepared[$key])) {
          $prepared[$key] = $db->prepare("INSERT OR $mode INTO $table (" . implode(', ', $columns) . ') VALUES (' . implode(', ', array_fill(0, count($columns), '?')) . ')');
        }
        foreach ($rows as $values) {
          cloud_import_bind($prepared[$key], $values);
          $prepared[$key]->execute();
          $counts[$table]++;
        }
      }
    });
  } catch (PDOException $error) {
    throw new CloudFailure(400, 'Строки не вошли в базу: ' . $error->getMessage());
  }
  $totals = [];
  foreach (array_keys($tables) as $table) $totals[$table] = (int) $db->query("SELECT COUNT(*) FROM $table")->fetchColumn();
  return cloud_json(['ok' => true, 'db' => $name, 'reset' => $reset, 'tables' => $counts, 'totals' => $totals, 'skipped' => $skipped]);
}

function cloud_import_bind(PDOStatement $query, array $values): void {
  $index = 1;
  foreach ($values as $value) {
    if (is_array($value)) $query->bindValue($index++, $value['blob'], PDO::PARAM_LOB);
    elseif (is_int($value)) $query->bindValue($index++, $value, PDO::PARAM_INT);
    elseif ($value === null) $query->bindValue($index++, null, PDO::PARAM_NULL);
    elseif (is_float($value)) $query->bindValue($index++, json_encode($value), PDO::PARAM_STR);
    else $query->bindValue($index++, $value, PDO::PARAM_STR);
  }
}

function cloud_import_refuse(array $tokens, string $why = ''): void {
  $preview = [];
  foreach (array_slice($tokens, 0, 6) as $token) $preview[] = $token[0] === 's' || $token[0] === 'b' ? "'…'" : $token[1];
  throw new CloudFailure(400, 'Принимаются только INSERT в таблицы Amethyx' . ($why !== '' ? " ($why)" : '') . ', а здесь: ' . mb_substr(implode(' ', $preview), 0, 80, 'UTF-8'));
}

// One statement of the dump: [table, columns, rows, mode] for an INSERT, null for what is skipped.
function cloud_import_statement(array $tokens, array $tables): ?array {
  $word = function (int $index) use ($tokens) {
    return isset($tokens[$index]) && $tokens[$index][0] === 'w' ? strtoupper($tokens[$index][1]) : null;
  };
  $first = $word(0);
  // The dump's own lines: transaction marks, settings and the tables, which are here already.
  if (in_array($first, ['PRAGMA', 'BEGIN', 'COMMIT', 'END'], true)) return null;
  if ($first === 'CREATE' && (in_array($word(1), ['TABLE', 'INDEX'], true) || ($word(1) === 'UNIQUE' && $word(2) === 'INDEX'))) return null;
  // SQLite's counter of message ids follows the ids imported by itself.
  if ($first === 'DELETE' && $word(1) === 'FROM' && count($tokens) === 3 && cloud_sql_name($tokens[2]) === 'sqlite_sequence') return null;
  if ($first !== 'INSERT' && $first !== 'REPLACE') cloud_import_refuse($tokens);

  // INSERT [OR REPLACE|IGNORE…] INTO table [(columns)] VALUES (…)[, (…)]. A plain INSERT replaces
  // a row already there, so a piece sent twice (after a broken connection) does no harm.
  $index = 1;
  $mode = 'REPLACE';
  if ($first === 'INSERT' && $word(1) === 'OR') {
    if (!in_array($word(2), ['REPLACE', 'IGNORE', 'ABORT', 'FAIL', 'ROLLBACK'], true)) cloud_import_refuse($tokens);
    if ($word(2) === 'IGNORE') $mode = 'IGNORE';
    $index = 3;
  }
  if ($word($index++) !== 'INTO') cloud_import_refuse($tokens);
  $table = cloud_sql_name($tokens[$index++] ?? null);
  if ($table === null || cloud_sql_is($tokens, $index, '.')) cloud_import_refuse($tokens);
  // SQLite's and Cloudflare's own tables.
  if ($table === 'sqlite_sequence' || $table === 'd1_migrations' || strpos($table, '_cf_') === 0) return null;
  if (!isset($tables[$table])) cloud_import_refuse($tokens, "таблицы $table здесь нет");
  $columns = $tables[$table];
  if (cloud_sql_is($tokens, $index, '(')) {
    $columns = [];
    do {
      $index++;
      $column = cloud_sql_name($tokens[$index++] ?? null);
      if ($column === null || !in_array($column, $tables[$table], true) || in_array($column, $columns, true)) cloud_import_refuse($tokens, 'неизвестный столбец');
      $columns[] = $column;
    } while (cloud_sql_is($tokens, $index, ','));
    if (!cloud_sql_is($tokens, $index++, ')')) cloud_import_refuse($tokens);
  }
  if ($word($index++) !== 'VALUES') cloud_import_refuse($tokens);
  $rows = [];
  do {
    if ($rows) $index++; // the comma between rows
    if (!cloud_sql_is($tokens, $index++, '(')) cloud_import_refuse($tokens);
    $values = [];
    do {
      if ($values) $index++;
      $values[] = cloud_sql_value($tokens, $index);
    } while (cloud_sql_is($tokens, $index, ','));
    if (!cloud_sql_is($tokens, $index++, ')') || count($values) !== count($columns)) cloud_import_refuse($tokens, 'не то число значений');
    $rows[] = $values;
  } while (cloud_sql_is($tokens, $index, ','));
  if ($index !== count($tokens)) cloud_import_refuse($tokens); // ON CONFLICT, RETURNING, SELECT…
  return [$table, $columns, $rows, $mode];
}

function cloud_sql_is(array $tokens, int $index, string $punctuation): bool {
  return isset($tokens[$index]) && $tokens[$index][0] === 'p' && $tokens[$index][1] === $punctuation;
}

// A table or column name, bare or quoted.
function cloud_sql_name($token): ?string {
  return is_array($token) && ($token[0] === 'w' || $token[0] === 'i') ? strtolower($token[1]) : null;
}

// A value: a literal, a negative number, or one of the functions SQLite's dumps write strings
// with (replace(…, '\n', char(10)), char(…), unistr(…)), worked out here.
function cloud_sql_value(array $tokens, int &$index) {
  $token = $tokens[$index++] ?? null;
  if ($token === null) cloud_import_refuse($tokens);
  if ($token[0] === 's') return $token[1];
  if ($token[0] === 'b') return ['blob' => $token[1]];
  if ($token[0] === 'n') return cloud_sql_number($token[1]);
  if ($token[0] === 'p' && ($token[1] === '-' || $token[1] === '+') && isset($tokens[$index]) && $tokens[$index][0] === 'n') {
    $number = cloud_sql_number($tokens[$index++][1]);
    return $token[1] === '-' ? -$number : $number;
  }
  if ($token[0] === 'w') {
    $upper = strtoupper($token[1]);
    if ($upper === 'NULL') return null;
    if ($upper === 'TRUE' || $upper === 'FALSE') return $upper === 'TRUE' ? 1 : 0;
    if (cloud_sql_is($tokens, $index, '(')) {
      $index++;
      $args = [];
      if (!cloud_sql_is($tokens, $index, ')')) {
        do {
          if ($args) $index++;
          $args[] = cloud_sql_value($tokens, $index);
        } while (cloud_sql_is($tokens, $index, ','));
      }
      if (!cloud_sql_is($tokens, $index++, ')')) cloud_import_refuse($tokens);
      return cloud_sql_call(strtolower($token[1]), $args, $tokens);
    }
  }
  cloud_import_refuse($tokens, 'непонятное значение');
}

function cloud_sql_number(string $text) {
  if (preg_match('/^0x([0-9a-f]+)$/iD', $text, $match)) return (int) hexdec($match[1]);
  // Digits that fit a 64-bit integer stay one (same length: comparing as text is comparing numbers).
  $max = (string) PHP_INT_MAX;
  if (preg_match('/^\d+$/D', $text) && (strlen($text) < strlen($max) || (strlen($text) === strlen($max) && strcmp($text, $max) <= 0))) return (int) $text;
  return (float) $text;
}

function cloud_sql_call(string $name, array $args, array $tokens) {
  if ($name === 'replace' && count($args) === 3) {
    [$text, $from, $to] = $args;
    if ($text === null || $from === null || $to === null) return null;
    return (string) $from === '' ? (string) $text : str_replace((string) $from, (string) $to, (string) $text);
  }
  if ($name === 'char') {
    $text = '';
    foreach ($args as $code) $text .= cloud_utf8_char((int) $code);
    return $text;
  }
  if ($name === 'unistr' && count($args) === 1 && is_string($args[0])) {
    return preg_replace_callback('/\\\\(?:\\\\|u([0-9a-fA-F]{4})|\+([0-9a-fA-F]{6})|U([0-9a-fA-F]{8})|([0-9a-fA-F]{4}))/', function ($match) {
      if ($match[0] === '\\\\') return '\\';
      $hex = '';
      foreach ([1, 2, 3, 4] as $group) if (isset($match[$group]) && $match[$group] !== '') $hex = $match[$group];
      return cloud_utf8_char((int) hexdec($hex));
    }, $args[0]);
  }
  cloud_import_refuse($tokens, "функция $name");
}

function cloud_utf8_char(int $code): string {
  if ($code < 0 || $code > 0x10FFFF) return '';
  if ($code < 0x80) return chr($code);
  if ($code < 0x800) return chr(0xC0 | ($code >> 6)) . chr(0x80 | ($code & 0x3F));
  if ($code < 0x10000) return chr(0xE0 | ($code >> 12)) . chr(0x80 | (($code >> 6) & 0x3F)) . chr(0x80 | ($code & 0x3F));
  return chr(0xF0 | ($code >> 18)) . chr(0x80 | (($code >> 12) & 0x3F)) . chr(0x80 | (($code >> 6) & 0x3F)) . chr(0x80 | ($code & 0x3F));
}

// The statements of an SQL text one by one, each as tokens [kind, text]: w a word, i a quoted
// name, s a string, b a blob, n a number, p punctuation. Comments and spaces are dropped.
function cloud_sql_statements(string $sql): Generator {
  $length = strlen($sql);
  $tokens = [];
  $index = 0;
  while ($index < $length) {
    $char = $sql[$index];
    $next = $index + 1 < $length ? $sql[$index + 1] : '';
    if (strpos(" \t\r\n\f\v", $char) !== false) {
      $index += strspn($sql, " \t\r\n\f\v", $index);
    } elseif ($char === '-' && $next === '-') {
      $end = strpos($sql, "\n", $index);
      $index = $end === false ? $length : $end + 1;
    } elseif ($char === '/' && $next === '*') {
      $end = strpos($sql, '*/', $index + 2);
      $index = $end === false ? $length : $end + 2;
    } elseif ($char === "'") {
      $tokens[] = ['s', cloud_sql_quoted($sql, $index, "'")];
    } elseif ($char === '"' || $char === '`') {
      $tokens[] = ['i', cloud_sql_quoted($sql, $index, $char)];
    } elseif ($char === '[') {
      $end = strpos($sql, ']', $index);
      if ($end === false) throw new CloudFailure(400, 'SQL оборван посередине.');
      $tokens[] = ['i', substr($sql, $index + 1, $end - $index - 1)];
      $index = $end + 1;
    } elseif (($char === 'x' || $char === 'X') && $next === "'") {
      $index++;
      $hex = cloud_sql_quoted($sql, $index, "'");
      if (strlen($hex) % 2 || !preg_match('/^[0-9a-fA-F]*$/D', $hex)) throw new CloudFailure(400, 'Неверный blob в SQL.');
      $tokens[] = ['b', (string) hex2bin($hex)];
    } elseif (preg_match('/\G(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/', $sql, $match, 0, $index)) {
      $tokens[] = ['n', $match[0]];
      $index += strlen($match[0]);
    } elseif (preg_match('/\G[A-Za-z_\x80-\xff][A-Za-z0-9_$\x80-\xff]*/', $sql, $match, 0, $index)) {
      $tokens[] = ['w', $match[0]];
      $index += strlen($match[0]);
    } elseif ($char === ';') {
      if ($tokens) yield $tokens;
      $tokens = [];
      $index++;
    } else {
      $tokens[] = ['p', $char];
      $index++;
    }
  }
  if ($tokens) yield $tokens;
}

// A quoted string or name from $index (at its opening quote); a doubled quote stands for one.
// Moves $index past the closing quote.
function cloud_sql_quoted(string $sql, int &$index, string $quote): string {
  $value = '';
  $from = $index + 1;
  while (true) {
    $end = strpos($sql, $quote, $from);
    if ($end === false) throw new CloudFailure(400, 'SQL оборван посередине.');
    $value .= substr($sql, $from, $end - $from);
    if (($sql[$end + 1] ?? '') === $quote) {
      $value .= $quote;
      $from = $end + 2;
      continue;
    }
    $index = $end + 1;
    return $value;
  }
}
