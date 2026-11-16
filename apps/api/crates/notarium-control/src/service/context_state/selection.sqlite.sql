WITH targets(kind, id, level) AS (
    SELECT 'project', $2, 0 WHERE $2 <> ''
    UNION ALL SELECT 'space', $3, 1 WHERE $3 <> ''
    UNION ALL SELECT 'personal', $4, 2 WHERE $4 <> ''
), candidates AS (
    SELECT t.level, coalesce(o.rank, 0) AS rank,
           'n:' || p.note_space || ':' || p.note_id AS entry, 0 AS item_index,
           p.note_space, p.note_id, 0 AS favorite
    FROM targets t JOIN context_scope_pins p ON p.target_kind=t.kind AND p.target_id=t.id
    LEFT JOIN context_order o ON o.target_kind=t.kind AND o.target_id=t.id AND o.entry_kind='note'
        AND json_extract(CASE WHEN o.entry_kind='note' THEN o.entry_ref ELSE '{}' END, '$.space_id')=p.note_space
        AND json_extract(CASE WHEN o.entry_kind='note' THEN o.entry_ref ELSE '{}' END, '$.note_id')=p.note_id
    UNION ALL
    SELECT t.level, coalesce(o.rank, 0), 's:' || a.set_id, cast(j.key AS INTEGER),
           json_extract(j.value, '$.space_id'), json_extract(j.value, '$.note_id'), 0
    FROM targets t JOIN context_set_attachments a ON a.target_kind=t.kind AND a.target_id=t.id
    JOIN context_sets s ON s.set_id=a.set_id JOIN json_each(s.note_refs) j
    LEFT JOIN context_order o ON o.target_kind=t.kind AND o.target_id=t.id AND o.entry_kind='set' AND o.entry_ref=a.set_id
    UNION ALL
    SELECT 3, rank, 'f:' || space_id || ':' || entity_id, 0, space_id, entity_id, 1
    FROM favorites WHERE owner_id=$1 AND entity_kind='note'
), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY note_space, note_id ORDER BY level, rank, entry, item_index) AS occurrence
    FROM candidates
), numbered AS (
    SELECT note_space, note_id, favorite,
           row_number() OVER (ORDER BY level, rank, entry, item_index, note_space, note_id) AS position
    FROM ranked WHERE occurrence=1
)
SELECT position, note_space, note_id, favorite FROM numbered WHERE position>$5 ORDER BY position LIMIT $6
