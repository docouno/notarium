CREATE TABLE ability_create_operations (
  id TEXT PRIMARY KEY,
  actor_digest TEXT NOT NULL,
  idempotency_digest TEXT,
  request_fingerprint TEXT NOT NULL,
  space TEXT NOT NULL,
  package_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  target_path TEXT NOT NULL,
  availability_required INTEGER NOT NULL CHECK (availability_required IN (0, 1)),
  stage_binding TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN (
      'accepted',
      'physical-published',
      'metadata-committed',
      'succeeded',
      'rejected',
      'failed-recoverable'
    )
  ),
  prepared_evidence TEXT NOT NULL,
  physical_receipt TEXT,
  terminal_result TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space, package_id),
  UNIQUE (note_id)
);

CREATE UNIQUE INDEX idx_ability_create_operations_replay
  ON ability_create_operations(actor_digest, idempotency_digest)
  WHERE idempotency_digest IS NOT NULL;

CREATE INDEX idx_ability_create_operations_recovery
  ON ability_create_operations(phase, created_at, id);

CREATE TRIGGER trg_ability_create_operations_delete_space
AFTER DELETE ON spaces
BEGIN
  DELETE FROM ability_create_operations WHERE space = OLD.id;
END;
