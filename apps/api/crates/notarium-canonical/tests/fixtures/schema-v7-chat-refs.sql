DROP INDEX idx_chat_entry_note_refs_created;
DROP INDEX idx_chat_entry_note_refs_target;
ALTER TABLE chat_entry_note_refs DROP COLUMN created_space_seq;
CREATE INDEX idx_chat_entry_note_refs_target
    ON chat_entry_note_refs (space_id, target_space_id, target_note_id, thread_id, entry_seq, ref_ordinal);
