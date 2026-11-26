-- Screen Scout relay schema (D1).
-- Apply with: npx wrangler d1 execute screen-scout-relay --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS usage (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_expires ON usage (expires_at);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  version TEXT NOT NULL DEFAULT 'unknown',
  os TEXT NOT NULL DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen);

-- Update feed: one row per platform ('win', 'mac-arm64', 'mac-x64') pointing
-- at the published installers on GitHub Releases. Populated by
-- `node scripts/upload-update.mjs`.
-- Existing databases: do NOT re-run this file (the unique index would fail
-- before the platform column exists) — apply migrations/0001-*.sql instead.
CREATE TABLE IF NOT EXISTS update_manifest (
  id INTEGER PRIMARY KEY,
  platform TEXT,
  version TEXT NOT NULL,
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  pub_date TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_update_manifest_platform ON update_manifest (platform);
