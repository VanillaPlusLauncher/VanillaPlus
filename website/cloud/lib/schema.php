<?php
// Tables of the Amethyx server. The same as server/schema.sql and server/files-schema.sql, so a dump
// of the old Cloudflare databases (wrangler d1 export) goes in as it is; this server's own few
// additions come last, marked as such.

if (!defined('AMX')) { http_response_code(404); exit; }

// Raise it when the tables below change: every database is brought up to date on its next request.
const CLOUD_SCHEMA_VERSION = 1;

const CLOUD_MAIN_SCHEMA = <<<'SQL'
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,            -- ms:<uuid>, ely:<uuid> or offline:<lowercase name>
  ns TEXT NOT NULL,               -- ms | ely | offline
  uuid TEXT,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,       -- '' when another account took the name over
  secret_hash TEXT,               -- offline accounts: SHA-256 of the launcher's secret
  skin_hash TEXT,
  skin_model TEXT,
  cape_hash TEXT,
  presence TEXT,                  -- JSON: { status, instance, minecraft, loader, server }
  last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_by_name ON users (ns, name_lower);

-- PNG files by SHA-256, as base64 text.
CREATE TABLE IF NOT EXISTS textures (
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);

-- Proof of a Microsoft or Ely.by account: the launcher "joins" a server with this id, the
-- server asks Mojang or Ely.by whether it did (the same check every Minecraft server makes).
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  ns TEXT NOT NULL,
  name TEXT NOT NULL,
  uuid TEXT NOT NULL,
  server_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_id);

-- Two rows per friendship, one for each side.
CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

-- Messages between friends: text, a picture (screenshot) or an invite to play.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- text | image | invite
  body TEXT NOT NULL,              -- text, or JSON for image / invite
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages (from_id, to_id, id);
CREATE INDEX IF NOT EXISTS messages_unread ON messages (to_id, read_at);

-- Pictures sent in messages (JPEG or PNG as base64), removed after 30 days.
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS images_age ON images (created_at);
-- Tunnels: a friend joins the host's world (open to LAN or own server) through the TunnelRoom relay.
CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tunnels_owner ON tunnels (owner_id);

-- This server's own. A player found by name whatever kind of account they use (/csl), the news
-- of /v1/updates (messages to a player, read marks of their messages), requests per address
-- (the rate limit: the current minute only) and small state (a secret, the last cleanup).
CREATE INDEX IF NOT EXISTS users_by_lower ON users (name_lower);
CREATE INDEX IF NOT EXISTS messages_to_time ON messages (to_id, created_at);
CREATE INDEX IF NOT EXISTS messages_read ON messages (from_id, read_at);
CREATE TABLE IF NOT EXISTS cloud_rate (
  who TEXT NOT NULL,
  bucket TEXT NOT NULL,
  minute INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (who, bucket)
);
CREATE INDEX IF NOT EXISTS cloud_rate_age ON cloud_rate (minute);
CREATE TABLE IF NOT EXISTS cloud_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
SQL;

const CLOUD_FILES_SCHEMA = <<<'SQL'
-- One player's file, by SHA-256. Kept until the last pack naming it expires (an unfinished
-- upload: a day).
CREATE TABLE IF NOT EXISTS blobs (
  owner_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, hash)
);
CREATE INDEX IF NOT EXISTS blobs_age ON blobs (expires_at);

-- The file in parts of up to 1.4 MB, as base64 text (a D1 row holds at most 2 MB).
CREATE TABLE IF NOT EXISTS blob_parts (
  owner_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (owner_id, hash, part)
);

-- The files of one share code: JSON [{ path: "mods/name.jar", hash, size }]. The id is the key
-- the friend's launcher downloads them with.
CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  files TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS packs_age ON packs (expires_at);
CREATE INDEX IF NOT EXISTS packs_owner ON packs (owner_id);
SQL;

// What the import (admin/import) may fill: the old server's tables and their columns, in the order
// of the tables above (an INSERT without a column list follows it).
const CLOUD_TABLES = [
  'main' => [
    'users' => ['id', 'ns', 'uuid', 'name', 'name_lower', 'secret_hash', 'skin_hash', 'skin_model', 'cape_hash', 'presence', 'last_seen', 'created_at'],
    'textures' => ['hash', 'data', 'created_at'],
    'sessions' => ['token_hash', 'user_id', 'expires_at'],
    'challenges' => ['id', 'ns', 'name', 'uuid', 'server_id', 'expires_at'],
    'friend_requests' => ['from_id', 'to_id', 'created_at'],
    'friends' => ['user_id', 'friend_id', 'since'],
    'messages' => ['id', 'from_id', 'to_id', 'kind', 'body', 'created_at', 'read_at'],
    'images' => ['id', 'owner_id', 'to_id', 'type', 'data', 'created_at'],
    'tunnels' => ['id', 'owner_id', 'created_at'],
  ],
  'files' => [
    'blobs' => ['owner_id', 'hash', 'size', 'parts', 'created_at', 'expires_at'],
    'blob_parts' => ['owner_id', 'hash', 'part', 'data'],
    'packs' => ['id', 'owner_id', 'files', 'created_at', 'expires_at'],
  ],
];
