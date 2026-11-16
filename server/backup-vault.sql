CREATE TABLE IF NOT EXISTS np_backup_vault_objects (
  id TEXT PRIMARY KEY,
  object_key TEXT UNIQUE,
  backup_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 8388640)
);

CREATE INDEX IF NOT EXISTS np_backup_vault_retention ON np_backup_vault_objects(backup_day,created_at);

CREATE TABLE IF NOT EXISTS np_backup_vault_chunks (
  object_id TEXT NOT NULL REFERENCES np_backup_vault_objects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (object_id,position)
);
