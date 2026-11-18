DROP INDEX IF EXISTS idx_blob_references_owner;
DROP INDEX IF EXISTS idx_blob_references_digest;
CREATE INDEX idx_blob_references_non_note_owner
    ON blob_references (space_id, owner_kind, owner_id)
    WHERE owner_kind <> 'note_revision';
