PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS np_stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS np_members (
  store_id TEXT NOT NULL REFERENCES np_stores(id),
  uid TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'staff', 'cast', 'trainee')),
  PRIMARY KEY (store_id, uid),
  UNIQUE (store_id, email)
);

CREATE INDEX IF NOT EXISTS np_members_uid ON np_members(uid, store_id);

CREATE TABLE IF NOT EXISTS np_invites (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES np_stores(id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'staff', 'cast', 'trainee')),
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, email)
);

CREATE INDEX IF NOT EXISTS np_invites_email ON np_invites(email, store_id);

CREATE TABLE IF NOT EXISTS np_state_chunks (
  store_id TEXT NOT NULL REFERENCES np_stores(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  payload TEXT NOT NULL,
  PRIMARY KEY (store_id, position)
);

CREATE TABLE IF NOT EXISTS np_operations (
  store_id TEXT NOT NULL REFERENCES np_stores(id),
  operation_id TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, operation_id),
  UNIQUE (store_id, revision)
);
