CREATE TABLE IF NOT EXISTS np_line_pairings (
  store_id TEXT PRIMARY KEY REFERENCES np_stores(id),
  id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  destination_id TEXT
);

CREATE TABLE IF NOT EXISTS np_line_destinations (
  store_id TEXT PRIMARY KEY REFERENCES np_stores(id),
  pairing_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  label TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL
);
