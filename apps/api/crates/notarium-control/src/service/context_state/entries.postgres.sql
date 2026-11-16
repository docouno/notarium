WITH entries AS (
    SELECT 'set'::text AS kind, ''::text AS space, a.set_id AS entity, coalesce(o.rank, 0) AS rank
    FROM v1_control.context_set_attachments a
    LEFT JOIN v1_control.context_order o ON o.target_kind=a.target_kind AND o.target_id=a.target_id AND o.entry_kind='set' AND o.entry_ref=a.set_id
    WHERE a.target_kind=$1 AND a.target_id=$2
    UNION ALL
    SELECT 'note', p.note_space, p.note_id, coalesce(o.rank, 0)
    FROM v1_control.context_scope_pins p
    LEFT JOIN v1_control.context_order o ON o.target_kind=p.target_kind AND o.target_id=p.target_id AND o.entry_kind='note'
        AND ((CASE WHEN o.entry_kind='note' THEN o.entry_ref::jsonb ELSE '{}'::jsonb END)->>'space_id')=p.note_space AND ((CASE WHEN o.entry_kind='note' THEN o.entry_ref::jsonb ELSE '{}'::jsonb END)->>'note_id')=p.note_id
    WHERE p.target_kind=$1 AND p.target_id=$2
)
SELECT kind, space, entity, rank FROM entries WHERE (rank,kind,space,entity)>($3,$4,$5,$6) ORDER BY rank,kind,space,entity LIMIT $7
