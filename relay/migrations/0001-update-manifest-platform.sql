-- Migration 0001: per-platform update feed (v0.1.2).
-- Run ONCE against the live database, BEFORE deploying the new worker code
-- (the new relay SELECTs the platform column and 503s without it; the old
-- relay keeps working fine with the column present):
--   node relay/node_modules/wrangler/bin/wrangler.js d1 execute screen-scout-relay --remote -y --file=./relay/migrations/0001-update-manifest-platform.sql
-- (Run from the repo root; retry on transient D1 auth errors. Apply the same
-- migration to any staging database before deploying there.)
--
-- Adds the platform column to the existing table, backfills the current
-- single-row (Windows) manifest, then enforces one row per platform. The
-- old relay keeps working throughout: its `WHERE id = 1` query still finds
-- the unchanged win row, so the feed never blinks during the rollout.

ALTER TABLE update_manifest ADD COLUMN platform TEXT;

UPDATE update_manifest SET platform = 'win' WHERE id = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_update_manifest_platform ON update_manifest (platform);
