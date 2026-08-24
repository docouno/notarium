ALTER TABLE note_identity
  ADD COLUMN address_revision INTEGER NOT NULL DEFAULT 1
  CHECK (address_revision > 0);

ALTER TABLE note_identity
  ADD COLUMN legacy_name_aliases TEXT NOT NULL DEFAULT '[]';

ALTER TABLE note_identity
  ADD COLUMN settlement_successor_id TEXT;

CREATE UNIQUE INDEX idx_note_identity_live_space_path
  ON note_identity(space, file_path)
  WHERE deleted_at IS NULL;

CREATE TABLE note_owner_proofs (
  note_id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  address_revision INTEGER NOT NULL CHECK (address_revision > 0),
  proof_revision INTEGER NOT NULL CHECK (proof_revision > 0),
  source_hash TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space, receipt_id)
);

CREATE INDEX idx_note_owner_proofs_space
  ON note_owner_proofs(space, note_id);

CREATE TABLE owner_proof_receipts (
  space TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  address_revision INTEGER NOT NULL,
  proof_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space, receipt_id)
);

CREATE INDEX idx_owner_proof_receipts_note
  ON owner_proof_receipts(space, note_id, proof_revision);

CREATE TABLE space_lifecycle (
  space TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (
    phase IN (
      'active',
      'closing',
      'archived',
      'purge-intent',
      'metadata-cleaned',
      'physical-cleaned',
      'purged'
    )
  ),
  generation INTEGER NOT NULL CHECK (generation > 0),
  cleanup_manifest TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT
);

INSERT INTO space_lifecycle (space, phase, generation, cleanup_manifest, changed_at, changed_by)
SELECT id,
       CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END,
       1,
       NULL,
       COALESCE(archived_at, created_at),
       archived_by
  FROM spaces;

CREATE TRIGGER trg_space_lifecycle_seed
AFTER INSERT ON spaces
FOR EACH ROW
BEGIN
  INSERT OR IGNORE INTO space_lifecycle
    (space, phase, generation, cleanup_manifest, changed_at, changed_by)
  VALUES (
    NEW.id,
    CASE WHEN NEW.archived_at IS NULL THEN 'active' ELSE 'archived' END,
    1,
    NULL,
    COALESCE(NEW.archived_at, NEW.created_at),
    NEW.archived_by
  );
END;

CREATE TABLE restore_operations (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  note_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  actor_digest TEXT NOT NULL,
  idempotency_digest TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  stage_binding TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN (
      'staged',
      'prepared',
      'physical-published',
      'metadata-committed',
      'succeeded',
      'rejected',
      'failed-recoverable'
    )
  ),
  source_revision_id TEXT,
  expected_head_revision_id TEXT,
  target_path TEXT,
  prepared_evidence TEXT,
  physical_receipt TEXT,
  terminal_result TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (actor_digest, endpoint, idempotency_digest)
);

CREATE INDEX idx_restore_operations_recovery
  ON restore_operations(space, phase, created_at, id);

CREATE TABLE restore_operation_notes (
  operation_id TEXT NOT NULL REFERENCES restore_operations(id) ON DELETE CASCADE,
  space TEXT NOT NULL,
  note_id TEXT NOT NULL,
  PRIMARY KEY (operation_id, note_id)
);

CREATE INDEX idx_restore_operation_notes_note
  ON restore_operation_notes(space, note_id, operation_id);

CREATE TABLE causal_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  operation_id TEXT,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE causal_outbox_deliveries (
  subscriber_id TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES causal_outbox(id) ON DELETE CASCADE,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, event_id)
);

CREATE INDEX idx_causal_outbox_deliveries_event
  ON causal_outbox_deliveries(event_id, subscriber_id);

CREATE INDEX idx_causal_outbox_pending
  ON causal_outbox(id)
  WHERE acknowledged_at IS NULL;

CREATE TABLE installation_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  phase TEXT NOT NULL CHECK (
    phase IN ('candidate-ready', 'publishing-active', 'active-installed')
  ),
  active_key_id TEXT,
  active_hash TEXT,
  candidate_key_id TEXT,
  candidate_hash TEXT,
  changed_at TEXT NOT NULL,
  CHECK (
    (active_key_id IS NULL AND active_hash IS NULL)
    OR (active_key_id IS NOT NULL AND active_hash IS NOT NULL)
  ),
  CHECK (
    (candidate_key_id IS NULL AND candidate_hash IS NULL)
    OR (candidate_key_id IS NOT NULL AND candidate_hash IS NOT NULL)
  ),
  CHECK (
    phase <> 'active-installed'
    OR (
      active_key_id IS NOT NULL
      AND candidate_key_id IS NULL
      AND candidate_hash IS NULL
    )
  ),
  CHECK (phase = 'active-installed' OR candidate_key_id IS NOT NULL)
);

CREATE TABLE backup_generation_freeze (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  key_id TEXT NOT NULL,
  active_hash TEXT NOT NULL,
  candidate_key_id TEXT,
  candidate_hash TEXT,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (
    (candidate_key_id IS NULL AND candidate_hash IS NULL)
    OR (candidate_key_id IS NOT NULL AND candidate_hash IS NOT NULL)
  ),
  CHECK (expires_at > heartbeat_at)
);

ALTER TABLE context_set_attachments
  ADD COLUMN home_space TEXT;

UPDATE context_set_attachments
   SET home_space = (
     SELECT home_space FROM context_sets WHERE id = context_set_attachments.set_id
   );

CREATE INDEX idx_context_set_attach_home_space
  ON context_set_attachments(home_space);

CREATE TRIGGER trg_lifecycle_revision_insert
BEFORE INSERT ON note_revisions
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.space AND phase <> 'active'
)
AND NOT EXISTS (
  SELECT 1 FROM revision_purge_fences
   WHERE (kind = 'space' AND entity_id = NEW.space)
      OR (kind = 'note' AND entity_id = NEW.note_id AND space IN ('', NEW.space))
)
AND NOT EXISTS (
  SELECT 1 FROM restore_operations
   WHERE space = NEW.space
     AND note_id = NEW.note_id
     AND source_revision_id = CAST(NEW.source_rev AS TEXT)
     AND phase = 'physical-published'
)
AND NOT EXISTS (
  SELECT 1 FROM ability_create_operations
   WHERE space = NEW.space
     AND note_id = NEW.note_id
     AND target_path = (
       SELECT file_path FROM note_identity
        WHERE id = NEW.note_id AND space = NEW.space
     )
     AND phase = 'physical-published'
     AND NEW.kind = 'write'
     AND NEW.entry_role = 'origin'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects revision append');
END;

CREATE TRIGGER trg_lifecycle_identity_insert
BEFORE INSERT ON note_identity
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.space AND phase <> 'active'
)
AND NOT EXISTS (
  SELECT 1 FROM restore_operations
   WHERE space = NEW.space
     AND note_id = NEW.id
     AND target_path = NEW.file_path
     AND phase = 'physical-published'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects identity write');
END;

CREATE TRIGGER trg_lifecycle_folders_insert
BEFORE INSERT ON folders
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects folder write');
END;

CREATE TRIGGER trg_lifecycle_favorites_insert
BEFORE INSERT ON favorites
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects favorite write');
END;

CREATE TRIGGER trg_lifecycle_context_sets_insert
BEFORE INSERT ON context_sets
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.home_space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects context-set write');
END;

CREATE TRIGGER trg_lifecycle_context_attachments_insert
BEFORE INSERT ON context_set_attachments
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space IN (NEW.home_space, NEW.target_space) AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects context attachment');
END;

CREATE TRIGGER trg_lifecycle_context_pins_insert
BEFORE INSERT ON context_scope_pins
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.target_space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects context pin');
END;

CREATE TRIGGER trg_lifecycle_context_order_insert
BEFORE INSERT ON context_order
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.target_space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects context order');
END;

CREATE TRIGGER trg_lifecycle_members_insert
BEFORE INSERT ON space_members
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects membership write');
END;

CREATE TRIGGER trg_lifecycle_jobs_insert
BEFORE INSERT ON jobs
WHEN EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects job enqueue');
END;

CREATE TRIGGER trg_lifecycle_owner_cursor_insert
BEFORE INSERT ON mcp_delta_owner_cursors
WHEN EXISTS (
  SELECT 1
    FROM folders
    JOIN space_lifecycle ON space_lifecycle.space = folders.space
   WHERE folders.id = NEW.project AND space_lifecycle.phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects cursor write');
END;

CREATE TRIGGER trg_lifecycle_session_cursor_insert
BEFORE INSERT ON mcp_delta_session_cursors
WHEN EXISTS (
  SELECT 1
    FROM folders
    JOIN space_lifecycle ON space_lifecycle.space = folders.space
   WHERE folders.id = NEW.project AND space_lifecycle.phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects cursor write');
END;

CREATE TRIGGER trg_lifecycle_personal_space_update
BEFORE UPDATE OF personal_space ON users
WHEN NEW.personal_space IS NOT NULL
AND NEW.personal_space IS NOT OLD.personal_space
AND EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.personal_space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects personal-space binding');
END;

CREATE TRIGGER trg_lifecycle_personal_space_insert
BEFORE INSERT ON users
WHEN NEW.personal_space IS NOT NULL
AND EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.personal_space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects personal-space binding');
END;

CREATE TRIGGER trg_lifecycle_pat_spaces_insert
BEFORE INSERT ON pats
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects PAT grant');
END;

CREATE TRIGGER trg_lifecycle_pat_spaces_update
BEFORE UPDATE OF spaces ON pats
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(OLD.spaces, '[]')) AS old_grant
       WHERE old_grant.value = grant.value
    )
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects PAT grant');
END;

CREATE TRIGGER trg_lifecycle_oauth_code_spaces_insert
BEFORE INSERT ON oauth_auth_codes
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects OAuth grant');
END;

CREATE TRIGGER trg_lifecycle_oauth_access_spaces_insert
BEFORE INSERT ON oauth_access_tokens
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects OAuth grant');
END;

CREATE TRIGGER trg_lifecycle_oauth_refresh_spaces_insert
BEFORE INSERT ON oauth_refresh_tokens
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects OAuth grant');
END;

CREATE TRIGGER trg_lifecycle_oauth_code_spaces_update
BEFORE UPDATE OF spaces ON oauth_auth_codes
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(OLD.spaces, '[]')) AS old_grant
       WHERE old_grant.value = grant.value
    )
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects OAuth grant');
END;

CREATE TRIGGER trg_lifecycle_oauth_access_spaces_update
BEFORE UPDATE OF spaces ON oauth_access_tokens
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(OLD.spaces, '[]')) AS old_grant
       WHERE old_grant.value = grant.value
    )
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects OAuth grant');
END;

CREATE TRIGGER trg_lifecycle_oauth_refresh_spaces_update
BEFORE UPDATE OF spaces ON oauth_refresh_tokens
WHEN NEW.spaces IS NOT NULL
AND EXISTS (
  SELECT 1 FROM json_each(NEW.spaces) AS grant
  JOIN space_lifecycle ON space_lifecycle.space = grant.value
  WHERE space_lifecycle.phase <> 'active'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(OLD.spaces, '[]')) AS old_grant
       WHERE old_grant.value = grant.value
    )
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects OAuth grant');
END;
