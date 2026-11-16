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
