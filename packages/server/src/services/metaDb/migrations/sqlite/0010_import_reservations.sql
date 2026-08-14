-- Import path reservation (#302): what a Markdown-tree import CLAIMS before it
-- writes anything, so two imports cannot decide the same destination and a
-- crashed run's claim is re-adopted by its retry instead of being guessed at.
--
-- The header is keyed by the staged upload, which is immutable for the life of
-- the job — a retry of the same job reserves once and adopts thereafter, while a
-- different upload aiming at the same path conflicts BEFORE the first write.
CREATE TABLE import_reservations (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  job_id TEXT NOT NULL,
  upload_ref TEXT NOT NULL,
  -- Handed out on reserve/adopt and re-proved by every write. A reclaimed job
  -- gets a NEWER fence, which is what makes the previous run's writes fail.
  fence TEXT NOT NULL,
  -- 'active' while the job may still write; 'closing' once terminal cleanup has
  -- started dropping it. The two statements of a close are one synchronous step,
  -- so 'closing' is only ever observed by a process that DIED between them — and
  -- reserve/adopt refuse such a row instead of reviving a claim already given up.
  status TEXT NOT NULL CHECK (status IN ('active', 'closing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space, upload_ref)
);

CREATE INDEX idx_import_reservations_job ON import_reservations(job_id);

-- One row per planned destination. The UNIQUE on (space, destination_path) is the
-- whole point: it is a DB-level statement that one live reservation owns a path,
-- so a competing import is refused by the database rather than by a race. It is
-- also how a single claim is FOUND — a fenced write addresses this table by
-- (space, destination_path), and that index is what makes the lookup a probe
-- instead of a walk of the whole batch.
--
-- The other predicate is a whole reservation's claims, `WHERE reservation_id = ?`
-- (reading a batch back, and the cascade below). The PRIMARY KEY leads with that
-- column, so its index already serves it, and a separate index on reservation_id
-- would only add a third index insert to every claimed path — 10 000 of them on
-- the supported corpus, in both dialects — for a lookup that is already indexed.
CREATE TABLE import_reservation_paths (
  reservation_id TEXT NOT NULL REFERENCES import_reservations(id) ON DELETE CASCADE,
  -- The row is addressed by the archive member it came from, so an outcome survives
  -- a remint of the id; the PRIMARY KEY is that address.
  entry_key TEXT NOT NULL,
  space TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  -- target_id / expected_id / ownership DESCRIBE the batch — the id the plan meant
  -- to write, the id it expected to already stand there (NULL = it planned to create
  -- the path), and whether that identity is the plan's own or somebody else's. They
  -- are not read back: no write proves itself against them, because the sidecar plan
  -- it re-reads is the authority on ids. What this table arbitrates is the PATH, and
  -- that is also why nothing here ever releases an identity.
  target_id TEXT NOT NULL,
  expected_id TEXT,
  ownership TEXT NOT NULL CHECK (ownership IN ('existing-reference', 'fresh-owned')),
  -- Deliberately NO "did it land" column. Publishing the file and recording that
  -- fact are two writes, and a crash lands between them, so the flag could only
  -- ever repeat the question. The note at the destination is the arbiter, and a
  -- retry re-proves it physically against the plan it re-reads.
  PRIMARY KEY (reservation_id, entry_key),
  UNIQUE (space, destination_path)
);
