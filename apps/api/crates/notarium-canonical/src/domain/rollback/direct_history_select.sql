WITH touched AS (
    SELECT entity_key, MIN(space_seq) AS first_seq FROM revisions
    WHERE space_id = $1 AND agent_run_id = $2 AND entity_type = 'note'
    GROUP BY entity_key
)
SELECT t.entity_key, t.first_seq, COALESCE(p.space_seq > t.first_seq, FALSE),
       CASE WHEN p.space_seq < t.first_seq THEN p.rev_id END,
       CASE WHEN p.space_seq < t.first_seq THEN p.metadata_msgpack END,
       CASE WHEN p.space_seq < t.first_seq THEN p.created_at_sec END,
       CASE WHEN p.space_seq < t.first_seq THEN p.created_at_nsec END,
       CASE WHEN p.rev_id IS NULL THEN (
           SELECT hrev.metadata_msgpack FROM note_heads h
           JOIN revisions hrev ON hrev.space_id = h.space_id AND hrev.rev_id = h.head_rev_id
           WHERE h.space_id = $1 AND h.note_id = t.entity_key
             AND hrev.entity_type = 'note' AND hrev.entity_key = t.entity_key
       ) END
FROM touched t
