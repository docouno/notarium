ALTER TABLE note_identity
  ADD COLUMN address_revision BIGINT NOT NULL DEFAULT 1
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
  address_revision BIGINT NOT NULL CHECK (address_revision > 0),
  proof_revision BIGINT NOT NULL CHECK (proof_revision > 0),
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
  address_revision BIGINT NOT NULL,
  proof_revision BIGINT NOT NULL,
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
  generation BIGINT NOT NULL CHECK (generation > 0),
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

CREATE FUNCTION seed_space_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO space_lifecycle
    (space, phase, generation, cleanup_manifest, changed_at, changed_by)
  VALUES (
    NEW.id,
    CASE WHEN NEW.archived_at IS NULL THEN 'active' ELSE 'archived' END,
    1,
    NULL,
    COALESCE(NEW.archived_at, NEW.created_at),
    NEW.archived_by
  )
  ON CONFLICT (space) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_space_lifecycle_seed
AFTER INSERT ON spaces
FOR EACH ROW
EXECUTE FUNCTION seed_space_lifecycle();

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
  id BIGSERIAL PRIMARY KEY,
  space TEXT NOT NULL,
  generation BIGINT NOT NULL,
  kind TEXT NOT NULL,
  operation_id TEXT,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE causal_outbox_deliveries (
  subscriber_id TEXT NOT NULL,
  event_id BIGINT NOT NULL REFERENCES causal_outbox(id) ON DELETE CASCADE,
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
  generation BIGINT NOT NULL CHECK (generation > 0),
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
  generation BIGINT NOT NULL CHECK (generation > 0),
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

UPDATE context_set_attachments AS attachments
   SET home_space = context_sets.home_space
  FROM context_sets
 WHERE context_sets.id = attachments.set_id;

CREATE INDEX idx_context_set_attach_home_space
  ON context_set_attachments(home_space);

CREATE FUNCTION lock_space_lifecycle(space_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_phase TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtext('notarium:causal:space-lifecycle'),
    hashtext(to_json(ARRAY[space_id, space_id]::text[])::text)
  );
  SELECT phase INTO lifecycle_phase
    FROM space_lifecycle
   WHERE space = space_id;
  RETURN lifecycle_phase;
END;
$$;

CREATE FUNCTION require_active_space(space_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_phase TEXT;
BEGIN
  lifecycle_phase := lock_space_lifecycle(space_id);
  IF lifecycle_phase IS NOT NULL AND lifecycle_phase <> 'active' THEN
    RAISE EXCEPTION 'space lifecycle rejects write: %', lifecycle_phase
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE FUNCTION enforce_active_space_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  space_id TEXT;
BEGIN
  FOR space_id IN
    SELECT DISTINCT to_jsonb(NEW) ->> column_name
      FROM unnest(TG_ARGV) AS columns(column_name)
     WHERE to_jsonb(NEW) ->> column_name IS NOT NULL
     ORDER BY 1
  LOOP
    PERFORM require_active_space(space_id);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_active_project_space()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  project_space TEXT;
BEGIN
  SELECT space INTO project_space
    FROM folders
   WHERE id = NEW.project AND type = 'project';
  IF project_space IS NOT NULL THEN
    PERFORM require_active_space(project_space);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_active_space_list()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  encoded TEXT;
  old_encoded TEXT;
  space_id TEXT;
BEGIN
  encoded := to_jsonb(NEW) ->> TG_ARGV[0];
  IF encoded IS NULL THEN
    RETURN NEW;
  END IF;
  old_encoded := CASE
    WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> TG_ARGV[0]
    ELSE NULL
  END;
  FOR space_id IN
    SELECT DISTINCT value
      FROM jsonb_array_elements_text(encoded::jsonb) AS grants(value)
     WHERE old_encoded IS NULL
        OR NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(old_encoded::jsonb) AS old_grants(old_value)
           WHERE old_value = value
        )
     ORDER BY value
  LOOP
    PERFORM require_active_space(space_id);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_identity_space_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_phase TEXT;
BEGIN
  lifecycle_phase := lock_space_lifecycle(NEW.space);
  IF lifecycle_phase IS NOT NULL
     AND lifecycle_phase <> 'active'
     AND NOT EXISTS (
       SELECT 1 FROM restore_operations
        WHERE space = NEW.space
          AND note_id = NEW.id
          AND target_path = NEW.file_path
          AND phase = 'physical-published'
     ) THEN
    RAISE EXCEPTION 'space lifecycle rejects identity write: %', lifecycle_phase
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_revision_space_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_phase TEXT;
BEGIN
  lifecycle_phase := lock_space_lifecycle(NEW.space);
  IF EXISTS (
    SELECT 1 FROM revision_purge_fences
     WHERE (kind = 'space' AND entity_id = NEW.space)
        OR (kind = 'note' AND entity_id = NEW.note_id AND space IN ('', NEW.space))
  ) THEN
    RAISE EXCEPTION 'revision target was permanently purged: %',
      CASE
        WHEN EXISTS (
          SELECT 1 FROM revision_purge_fences
           WHERE kind = 'space' AND entity_id = NEW.space
        ) THEN 'space'
        ELSE 'note'
      END
      USING ERRCODE = '55000';
  END IF;
  IF lifecycle_phase IS NOT NULL
     AND lifecycle_phase <> 'active'
     AND NOT EXISTS (
       SELECT 1 FROM restore_operations
        WHERE space = NEW.space
          AND note_id = NEW.note_id
          AND source_revision_id = NEW.source_rev::text
          AND phase = 'physical-published'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM ability_create_operations operation
         JOIN note_identity identity
           ON identity.id = operation.note_id AND identity.space = operation.space
        WHERE operation.space = NEW.space
          AND operation.note_id = NEW.note_id
          AND operation.target_path = identity.file_path
          AND operation.phase = 'physical-published'
          AND NEW.kind = 'write'
          AND NEW.entry_role = 'origin'
     ) THEN
    RAISE EXCEPTION 'space lifecycle rejects revision append: %', lifecycle_phase
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lifecycle_revision_insert
BEFORE INSERT ON note_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_revision_space_lifecycle();

CREATE TRIGGER trg_lifecycle_identity_insert
BEFORE INSERT ON note_identity
FOR EACH ROW EXECUTE FUNCTION enforce_identity_space_lifecycle();

CREATE TRIGGER trg_lifecycle_folders_insert
BEFORE INSERT ON folders
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('space');

CREATE TRIGGER trg_lifecycle_favorites_insert
BEFORE INSERT ON favorites
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('space');

CREATE TRIGGER trg_lifecycle_context_sets_insert
BEFORE INSERT ON context_sets
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('home_space');

CREATE TRIGGER trg_lifecycle_context_attachments_insert
BEFORE INSERT ON context_set_attachments
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('home_space', 'target_space');

CREATE TRIGGER trg_lifecycle_context_pins_insert
BEFORE INSERT ON context_scope_pins
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('target_space');

CREATE TRIGGER trg_lifecycle_context_order_insert
BEFORE INSERT ON context_order
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('target_space');

CREATE TRIGGER trg_lifecycle_members_insert
BEFORE INSERT ON space_members
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('space');

CREATE TRIGGER trg_lifecycle_jobs_insert
BEFORE INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('space');

CREATE TRIGGER trg_lifecycle_owner_cursor_insert
BEFORE INSERT ON mcp_delta_owner_cursors
FOR EACH ROW EXECUTE FUNCTION enforce_active_project_space();

CREATE TRIGGER trg_lifecycle_session_cursor_insert
BEFORE INSERT ON mcp_delta_session_cursors
FOR EACH ROW EXECUTE FUNCTION enforce_active_project_space();

CREATE TRIGGER trg_lifecycle_personal_space_update
BEFORE UPDATE OF personal_space ON users
FOR EACH ROW
WHEN (OLD.personal_space IS DISTINCT FROM NEW.personal_space)
EXECUTE FUNCTION enforce_active_space_columns('personal_space');

CREATE TRIGGER trg_lifecycle_personal_space_insert
BEFORE INSERT ON users
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('personal_space');

CREATE TRIGGER trg_lifecycle_pat_spaces_insert
BEFORE INSERT ON pats
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');

CREATE TRIGGER trg_lifecycle_pat_spaces_update
BEFORE UPDATE OF spaces ON pats
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');

CREATE TRIGGER trg_lifecycle_oauth_code_spaces_insert
BEFORE INSERT ON oauth_auth_codes
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');

CREATE TRIGGER trg_lifecycle_oauth_access_spaces_insert
BEFORE INSERT ON oauth_access_tokens
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');

CREATE TRIGGER trg_lifecycle_oauth_refresh_spaces_insert
BEFORE INSERT ON oauth_refresh_tokens
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');

CREATE TRIGGER trg_lifecycle_oauth_code_spaces_update
BEFORE UPDATE OF spaces ON oauth_auth_codes
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');

CREATE TRIGGER trg_lifecycle_oauth_access_spaces_update
BEFORE UPDATE OF spaces ON oauth_access_tokens
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');

CREATE TRIGGER trg_lifecycle_oauth_refresh_spaces_update
BEFORE UPDATE OF spaces ON oauth_refresh_tokens
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_list('spaces');
