CREATE OR REPLACE FUNCTION enforce_revision_space_lifecycle()
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
