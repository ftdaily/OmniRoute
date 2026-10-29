-- Tombstones for rotated API-key secrets: a rotated-out hash stays deniable
-- (401 even with REQUIRE_API_KEY=false) instead of collapsing to anonymous.
CREATE TABLE IF NOT EXISTS retired_api_key_hashes (
  key_hash TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  retired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
