CREATE TABLE IF NOT EXISTS np_auto_extension_schedule (
  store_id TEXT PRIMARY KEY REFERENCES np_stores(id),
  next_at INTEGER CHECK(next_at >= 0)
);

CREATE INDEX IF NOT EXISTS np_auto_extension_due ON np_auto_extension_schedule(next_at,store_id) WHERE next_at IS NOT NULL;
