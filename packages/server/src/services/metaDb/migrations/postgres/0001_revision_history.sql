ALTER TABLE note_revisions
  ADD COLUMN agent_owner TEXT,
  ADD COLUMN agent_name TEXT,
  ADD COLUMN session_id TEXT,
  ADD COLUMN session_name TEXT,
  ADD COLUMN session_attach TEXT
    CHECK (session_attach IS NULL OR session_attach IN ('declared', 'inferred')),
  ADD COLUMN integrity TEXT,
  ADD COLUMN entry_role TEXT,
  ADD COLUMN state_format TEXT
    CHECK (
      state_format IS NULL OR
      state_format IN ('markdown-v1', 'markdown-v2', 'skill-markdown-v1', 'opaque-v1')
    ),
  ADD COLUMN semantic_fingerprint TEXT,
  ADD COLUMN restore_safety TEXT
    CHECK (restore_safety IN ('safe', 'blocked', 'unknown'));

UPDATE note_revisions SET integrity = 'trusted';

UPDATE note_revisions AS revisions
   SET entry_role = CASE
     WHEN revisions.base_rev IS NULL
      AND revisions.id = first_entries.first_id
       THEN CASE WHEN revisions.kind = 'external' THEN 'baseline' ELSE 'origin' END
     ELSE 'change'
   END
  FROM (
    SELECT space, note_id, MIN(id) AS first_id
      FROM note_revisions
     GROUP BY space, note_id
  ) AS first_entries
 WHERE first_entries.space = revisions.space
   AND first_entries.note_id = revisions.note_id;

ALTER TABLE note_revisions
  ALTER COLUMN integrity SET NOT NULL,
  ALTER COLUMN entry_role SET NOT NULL,
  ADD CHECK (integrity IN ('trusted', 'quarantined')),
  ADD CHECK (entry_role IN ('origin', 'baseline', 'change'));

ALTER TABLE revision_blobs
  ALTER COLUMN content TYPE BYTEA
  USING convert_to(content, 'UTF8');

CREATE INDEX idx_note_revisions_base_rev
  ON note_revisions(base_rev);

CREATE INDEX idx_note_revisions_their_rev
  ON note_revisions(their_rev);

CREATE INDEX idx_note_revisions_source_rev
  ON note_revisions(source_rev);

CREATE INDEX idx_note_revisions_agent_session_created
  ON note_revisions(agent_owner, session_id, created_at DESC, id DESC);

CREATE INDEX idx_note_revisions_agent_created
  ON note_revisions(agent_owner, created_at DESC, id DESC)
  WHERE agent_owner IS NOT NULL;

CREATE INDEX idx_note_revisions_agent_outside_created
  ON note_revisions(agent_owner, created_at DESC, id DESC)
  WHERE session_id IS NULL AND agent_owner IS NOT NULL;

CREATE INDEX idx_note_revisions_agent_owner_name_created
  ON note_revisions(agent_owner, agent_name, created_at DESC, id DESC)
  WHERE integrity = 'trusted';

CREATE INDEX idx_context_scope_pins_note
  ON context_scope_pins(note_space, note_id);

ALTER TABLE revision_purge_fences
  ADD COLUMN space TEXT NOT NULL DEFAULT '';

UPDATE revision_purge_fences SET space = entity_id WHERE kind = 'space';

ALTER TABLE revision_purge_fences ALTER COLUMN space DROP DEFAULT;
ALTER TABLE revision_purge_fences DROP CONSTRAINT revision_purge_fences_pkey;
ALTER TABLE revision_purge_fences ADD PRIMARY KEY (kind, entity_id, space);

CREATE OR REPLACE FUNCTION enforce_revision_append_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fence_kind TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtext('notarium:revision:space'),
    hashtext(NEW.space)
  );
  PERFORM pg_advisory_xact_lock(
    hashtext('notarium:revision:note'),
    hashtext(NEW.note_id) & 63
  );

  IF NEW.content_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('notarium:revision:blob'),
      hashtext(NEW.content_hash) & 63
    );
  END IF;

  SELECT kind
    INTO fence_kind
    FROM revision_purge_fences
   WHERE (kind = 'space' AND entity_id = NEW.space)
      OR (kind = 'note' AND entity_id = NEW.note_id AND space IN ('', NEW.space))
   LIMIT 1;

  IF fence_kind IS NOT NULL THEN
    RAISE EXCEPTION 'revision target was permanently purged: %', fence_kind
      USING ERRCODE = '55000';
  END IF;

  IF NEW.content_hash IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM revision_blobs WHERE hash = NEW.content_hash
     ) THEN
    RAISE EXCEPTION 'revision content blob is missing: %', NEW.content_hash
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_revision_purge_protocol()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('notarium.revision_purge_protocol', true)
       IS DISTINCT FROM 'space-scoped-cas-v1' THEN
    RAISE EXCEPTION 'revision purge requires a fenced writer'
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TABLE revision_heads (
  space TEXT NOT NULL,
  note_id TEXT NOT NULL,
  revision_id BIGINT NOT NULL UNIQUE,
  semantic_fingerprint TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('live', 'deleted')),
  PRIMARY KEY (space, note_id)
);

INSERT INTO revision_heads (note_id, space, revision_id, semantic_fingerprint, lifecycle)
SELECT DISTINCT ON (space, note_id)
       note_id,
       space,
       id,
       semantic_fingerprint,
       CASE WHEN kind = 'delete' THEN 'deleted' ELSE 'live' END
  FROM note_revisions
 WHERE integrity = 'trusted'
 ORDER BY space, note_id, id DESC;

CREATE INDEX idx_revision_heads_space
  ON revision_heads(space, revision_id);

CREATE FUNCTION advance_revision_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.integrity <> 'trusted' THEN
    RETURN NEW;
  END IF;
  INSERT INTO revision_heads
    (note_id, space, revision_id, semantic_fingerprint, lifecycle)
  VALUES (
    NEW.note_id,
    NEW.space,
    NEW.id,
    NEW.semantic_fingerprint,
    CASE WHEN NEW.kind = 'delete' THEN 'deleted' ELSE 'live' END
  )
  ON CONFLICT (space, note_id) DO UPDATE SET
    revision_id = EXCLUDED.revision_id,
    semantic_fingerprint = EXCLUDED.semantic_fingerprint,
    lifecycle = EXCLUDED.lifecycle;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_revision_head_advance
AFTER INSERT ON note_revisions
FOR EACH ROW
EXECUTE FUNCTION advance_revision_head();
