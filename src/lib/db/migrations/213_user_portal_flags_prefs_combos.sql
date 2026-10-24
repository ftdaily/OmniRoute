-- Portal flags on api_keys + owner-scoped portal tables (p3 scoped-user-portal).
-- All additive, idempotent via IF NOT EXISTS. No global behavior change.
ALTER TABLE api_keys ADD COLUMN portal_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN user_combos_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN portal_session_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS key_preferences (
  key_id TEXT PRIMARY KEY,
  disabled_models TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_combos (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (key_id, name)
);
