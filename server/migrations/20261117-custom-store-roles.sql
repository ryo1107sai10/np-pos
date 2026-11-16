CREATE TABLE IF NOT EXISTS np_member_role_profiles (
  store_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  PRIMARY KEY (store_id, uid),
  FOREIGN KEY (store_id, uid) REFERENCES np_members(store_id, uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS np_member_role_profiles_profile
  ON np_member_role_profiles(store_id, profile_id);

CREATE TABLE IF NOT EXISTS np_invite_role_profiles (
  invite_id TEXT PRIMARY KEY REFERENCES np_invites(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL
);
