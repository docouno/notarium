SELECT EXISTS (
    SELECT 1 FROM chat_entry_note_refs
    WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3 AND ref_ordinal = $4
      AND target_space_id = $5 AND target_note_id = $6 AND created_space_seq = $7
)
