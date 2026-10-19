-- Vanilla+ server: skins, capes and friends. Apply with:
--   npx wrangler d1 execute vanillaplus --remote --file=schema.sql

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