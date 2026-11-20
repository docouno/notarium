(r.target_space_id, r.created_space_seq) <= ($2, $3)
AND (r.target_space_id, r.created_space_seq, r.thread_id, r.entry_seq, r.ref_ordinal)
    > ($2, $4, $5, $6, $7)
ORDER BY r.target_space_id, r.created_space_seq, r.thread_id, r.entry_seq, r.ref_ordinal
LIMIT $8
