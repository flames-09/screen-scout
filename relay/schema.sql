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
