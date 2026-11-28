SELECT entry_seq, CAST(branch_depth AS INTEGER)
FROM chat_entries INDEXED BY idx_chat_entries_compaction
WHERE space_id = $1 AND thread_id = $2
  AND kind = 'compaction' AND checkpoint_stale = 0
  AND entry_seq <= $3
ORDER BY entry_seq DESC
LIMIT $4
