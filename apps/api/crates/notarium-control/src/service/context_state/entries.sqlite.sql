WITH entries AS (
    SELECT 'set' AS kind, '' AS space, a.set_id AS entity, coalesce(o.rank, 0) AS rank
    FROM context_set_attachments a
    LEFT JOIN context_order o ON o.target_kind=a.target_kind AND o.target_id=a.target_id AND o.entry_kind='set' AND o.entry_ref=a.set_id
    WHERE a.target_kind=$1 AND a.target_id=$2
    UNION ALL
    SELECT 'note', p.note_space, p.note_id, coalesce(o.rank, 0)
    FROM context_scope_pins p
    LEFT JOIN context_order o ON o.target_kind=p.target_kind AND o.target_id=p.target_id AND o.entry_kind='note'
        AND json_extract(CASE WHEN o.entry_kind='note' THEN o.entry_ref ELSE '{}' END, '$.space_id')=p.note_space AND json_extract(CASE WHEN o.entry_kind='note' THEN o.entry_ref ELSE '{}' END, '$.note_id')=p.note_id
    WHERE p.target_kind=$1 AND p.target_id=$2
)
SELECT kind, space, entity, rank FROM entries WHERE (rank,kind,space,entity)>($3,$4,$5,$6) ORDER BY rank,kind,space,entity LIMIT $7
