CREATE INDEX idx_note_revisions_base_rev ON note_revisions(base_rev);

CREATE INDEX idx_note_revisions_their_rev ON note_revisions(their_rev);

CREATE INDEX idx_note_revisions_source_rev ON note_revisions(source_rev);

CREATE INDEX idx_context_scope_pins_note ON context_scope_pins(note_space, note_id);

-- The DEFAULT backfills, then goes: a fence written without a space must FAIL, not become a
-- global one. The pre-#327 writer fails one step earlier — its ON CONFLICT (kind, entity_id)
-- matches no constraint once the primary key moves. canon: docs/meta-db.md
ALTER TABLE revision_purge_fences ADD COLUMN space TEXT NOT NULL DEFAULT '';

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
       SELECT 1
       FROM revision_blobs
       WHERE hash = NEW.content_hash
     ) THEN
    RAISE EXCEPTION 'revision content blob is missing: %', NEW.content_hash
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;
