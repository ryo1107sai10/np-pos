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

CREATE TABLE IF NOT EXISTS np_audit_events (
  store_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  payload TEXT NOT NULL,
  PRIMARY KEY (store_id, revision),
  FOREIGN KEY (store_id, operation_id) REFERENCES np_operations(store_id, operation_id)
);

CREATE TABLE IF NOT EXISTS np_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS np_groups_owner ON np_groups(owner_uid, created_at);

CREATE TABLE IF NOT EXISTS np_group_stores (
  store_id TEXT PRIMARY KEY REFERENCES np_stores(id),
  group_id TEXT NOT NULL REFERENCES np_groups(id)
);

CREATE INDEX IF NOT EXISTS np_group_stores_group ON np_group_stores(group_id, store_id);

CREATE TABLE IF NOT EXISTS np_group_members (
  group_id TEXT NOT NULL REFERENCES np_groups(id),
  uid TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('manager', 'staff')),
  PRIMARY KEY (group_id, uid),
  UNIQUE (group_id, email)
);

CREATE INDEX IF NOT EXISTS np_group_members_uid ON np_group_members(uid, group_id);

CREATE TABLE IF NOT EXISTS np_group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES np_groups(id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('manager', 'staff')),
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, email)
);

CREATE INDEX IF NOT EXISTS np_group_invites_email ON np_group_invites(email, group_id);

CREATE VIEW IF NOT EXISTS np_store_access AS
  SELECT store_id, uid, role FROM np_members
  UNION ALL
  SELECT gs.store_id, gm.uid, gm.role
    FROM np_group_stores gs JOIN np_group_members gm ON gm.group_id = gs.group_id
    WHERE NOT EXISTS (
      SELECT 1 FROM np_members m WHERE m.store_id = gs.store_id AND m.uid = gm.uid
    );

CREATE TABLE IF NOT EXISTS np_guide_usage (
  store_id TEXT NOT NULL REFERENCES np_stores(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests > 0),
  PRIMARY KEY (store_id, date)
);

CREATE TABLE IF NOT EXISTS np_store_access_blocks (
  store_id TEXT NOT NULL REFERENCES np_stores(id),
  uid TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  invite_id TEXT,
  PRIMARY KEY (store_id, uid)
);

CREATE INDEX IF NOT EXISTS np_store_access_blocks_email ON np_store_access_blocks(store_id, email);

CREATE TRIGGER IF NOT EXISTS np_store_access_block_removes_membership
AFTER INSERT ON np_store_access_blocks BEGIN
  DELETE FROM np_members WHERE store_id = NEW.store_id AND uid = NEW.uid;
  DELETE FROM np_invites WHERE store_id = NEW.store_id AND email = NEW.email;
END;

DROP VIEW IF EXISTS np_store_access;

CREATE VIEW np_store_access AS
  SELECT a.store_id, a.uid, a.email, a.role, a.source FROM (
    SELECT store_id, uid, email, role, 'direct' AS source FROM np_members
    UNION ALL
    SELECT gs.store_id, gm.uid, gm.email, gm.role, 'group' AS source
      FROM np_group_stores gs JOIN np_group_members gm ON gm.group_id = gs.group_id
      WHERE NOT EXISTS (
        SELECT 1 FROM np_members m WHERE m.store_id = gs.store_id AND m.uid = gm.uid
      )
  ) a WHERE NOT EXISTS (
    SELECT 1 FROM np_store_access_blocks b WHERE b.store_id = a.store_id AND (b.uid = a.uid OR b.email = a.email)
  );
