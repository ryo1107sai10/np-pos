CREATE TABLE IF NOT EXISTS np_guide_usage (
  store_id TEXT NOT NULL REFERENCES np_stores(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests > 0),
  PRIMARY KEY (store_id, date)
);
