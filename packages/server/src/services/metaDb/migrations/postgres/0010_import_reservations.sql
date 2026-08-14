-- Import path reservation (#302) — the PostgreSQL twin of the SQLite table pair.
-- See the SQLite migration for why each column exists; the shapes are identical
-- so the shared persistence contract can hold both dialects to one behaviour.
CREATE TABLE import_reservations (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  job_id TEXT NOT NULL,
  upload_ref TEXT NOT NULL,
  fence TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space, upload_ref)
);

CREATE INDEX idx_import_reservations_job ON import_reservations(job_id);

CREATE TABLE import_reservation_paths (
  reservation_id TEXT NOT NULL REFERENCES import_reservations(id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  space TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  target_id TEXT NOT NULL,
  expected_id TEXT,
  ownership TEXT NOT NULL CHECK (ownership IN ('existing-reference', 'fresh-owned')),
  PRIMARY KEY (reservation_id, entry_key),
  UNIQUE (space, destination_path)
);
