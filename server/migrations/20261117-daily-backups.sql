CREATE TABLE IF NOT EXISTS np_backup_jobs (
  backup_day TEXT NOT NULL,
  store_id TEXT NOT NULL REFERENCES np_stores(id),
  phase TEXT NOT NULL DEFAULT 'capture' CHECK(phase IN ('capture','snapshot','ledger','publish','complete')),
  snapshot_revision INTEGER,
  captured_at INTEGER,
  stage_cursor INTEGER NOT NULL DEFAULT 0,
  stage_count INTEGER NOT NULL DEFAULT 0,
  ledger_cursor INTEGER NOT NULL DEFAULT 0,
  part_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (backup_day, store_id)
);

CREATE INDEX IF NOT EXISTS np_backup_jobs_pending ON np_backup_jobs(phase, backup_day, retry_at, lease_until);

CREATE TABLE IF NOT EXISTS np_backup_stage (
  sequence INTEGER PRIMARY KEY,
  backup_day TEXT NOT NULL,
  store_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  ordinal INTEGER,
  payload TEXT NOT NULL,
  FOREIGN KEY (backup_day, store_id) REFERENCES np_backup_jobs(backup_day, store_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS np_backup_stage_scope ON np_backup_stage(backup_day, store_id, sequence);
