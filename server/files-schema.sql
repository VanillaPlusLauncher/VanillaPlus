-- Files of share codes (mods, resource packs and shaders that are on neither Modrinth nor
-- CurseForge), in their own database so they never crowd out accounts and friends. Apply with:
--   npx wrangler d1 execute amethyx-files --remote --file=files-schema.sql

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
