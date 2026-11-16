WITH targets(kind, id, level) AS (
    SELECT 'project', $2::text, 0 WHERE $2 <> ''
    UNION ALL SELECT 'space', $3::text, 1 WHERE $3 <> ''
    UNION ALL SELECT 'personal', $4::text, 2 WHERE $4 <> ''
), candidates AS (
    SELECT t.level, coalesce(o.rank, 0) AS rank,
           'n:' || p.note_space || ':' || p.note_id AS entry, 0::bigint AS item_index,
           p.note_space, p.note_id, 0::bigint AS favorite
    FROM targets t JOIN v1_control.context_scope_pins p ON p.target_kind=t.kind AND p.target_id=t.id
    LEFT JOIN v1_control.context_order o ON o.target_kind=t.kind AND o.target_id=t.id AND o.entry_kind='note'
        AND ((CASE WHEN o.entry_kind='note' THEN o.entry_ref::jsonb ELSE '{}'::jsonb END)->>'space_id')=p.note_space
        AND ((CASE WHEN o.entry_kind='note' THEN o.entry_ref::jsonb ELSE '{}'::jsonb END)->>'note_id')=p.note_id
    UNION ALL
    SELECT t.level, coalesce(o.rank, 0), 's:' || a.set_id, j.ordinality,
           j.value->>'space_id', j.value->>'note_id', 0::bigint
    FROM targets t JOIN v1_control.context_set_attachments a ON a.target_kind=t.kind AND a.target_id=t.id
    JOIN v1_control.context_sets s ON s.set_id=a.set_id
    CROSS JOIN LATERAL jsonb_array_elements(s.note_refs::jsonb) WITH ORDINALITY j(value, ordinality)
    LEFT JOIN v1_control.context_order o ON o.target_kind=t.kind AND o.target_id=t.id AND o.entry_kind='set' AND o.entry_ref=a.set_id
    UNION ALL
    SELECT 3, rank, 'f:' || space_id || ':' || entity_id, 0::bigint, space_id, entity_id, 1::bigint
    FROM v1_control.favorites WHERE owner_id=$1 AND entity_kind='note'
), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY note_space, note_id ORDER BY level, rank, entry, item_index) AS occurrence
    FROM candidates
), numbered AS (
    SELECT note_space, note_id, favorite,
           row_number() OVER (ORDER BY level, rank, entry, item_index, note_space, note_id) AS position
    FROM ranked WHERE occurrence=1
)
SELECT position, note_space, note_id, favorite FROM numbered WHERE position>$5 ORDER BY position LIMIT $6
