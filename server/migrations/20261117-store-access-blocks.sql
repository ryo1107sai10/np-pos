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
