CREATE TABLE IF NOT EXISTS np_line_settings (
  store_id TEXT PRIMARY KEY REFERENCES np_stores(id),
  configuration_id TEXT NOT NULL,
  destination_hash TEXT,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  extension INTEGER NOT NULL CHECK(extension IN (0,1)),
  low_stock INTEGER NOT NULL CHECK(low_stock IN (0,1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS np_line_jobs (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES np_stores(id),
  event_key TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('test','extension','low-stock')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','failed','expired','cancelled')),
  created_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  finished_at INTEGER,
  UNIQUE (store_id, event_key)
);

CREATE INDEX IF NOT EXISTS np_line_jobs_ready ON np_line_jobs(status, available_at, expires_at);
CREATE INDEX IF NOT EXISTS np_line_jobs_history ON np_line_jobs(store_id, created_at DESC);
