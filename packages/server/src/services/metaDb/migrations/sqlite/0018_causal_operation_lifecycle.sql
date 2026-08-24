DROP TRIGGER trg_lifecycle_revision_insert;

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
