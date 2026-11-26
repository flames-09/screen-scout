-- Migration 0002: allow one row per platform in update_manifest (v0.1.2).
-- Run ONCE against the live database, after migration 0001:
--   node relay/node_modules/wrangler/bin/wrangler.js d1 execute screen-scout-relay --remote -y --file=./relay/migrations/0002-update-manifest-drop-id-check.sql
-- (Run from the repo root; retry on transient D1 auth errors.)
--
-- The original table was created with `id INTEGER PRIMARY KEY CHECK (id = 1)`
-- and SQLite cannot drop a CHECK constraint in place, so this rebuilds the
-- table with a plain id (auto-assigned for non-win rows). The win row keeps
-- id = 1, so even the old relay's `WHERE id = 1` query keeps working before
-- and after the swap. Only the brief moment between DROP and RENAME can
-- 503 the updates feed; chat traffic is unaffected.

CREATE TABLE update_manifest_new (
  id INTEGER PRIMARY KEY,
  platform TEXT,
  version TEXT NOT NULL,
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  pub_date TEXT NOT NULL
);

INSERT INTO update_manifest_new (id, platform, version, url, sha256, size_bytes, notes, pub_date)
SELECT id, platform, version, url, sha256, size_bytes, notes, pub_date FROM update_manifest;

DROP TABLE update_manifest;

ALTER TABLE update_manifest_new RENAME TO update_manifest;

CREATE UNIQUE INDEX IF NOT EXISTS idx_update_manifest_platform ON update_manifest (platform);
