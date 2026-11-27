WITH entries AS (
    SELECT 'set' AS kind, '' AS space, a.set_id AS entity, coalesce(o.rank, 0) AS rank,
           a.target_space AS target_space, s.owner_id AS set_owner, s.home_space AS set_home
    FROM context_set_attachments a INDEXED BY context_attachment_target
    CROSS JOIN context_sets s
    LEFT JOIN context_order o ON o.target_kind=a.target_kind AND o.target_id=a.target_id AND o.entry_kind='set' AND o.entry_ref=a.set_id
    WHERE s.set_id=a.set_id AND a.target_kind=$1 AND a.target_id=$2 AND instr($8, '|' || s.home_space || '|') > 0
    UNION ALL
    SELECT 'note', p.note_space, p.note_id, coalesce(o.rank, 0), '', '', ''
    FROM context_scope_pins p INDEXED BY context_pin_target
    LEFT JOIN context_order o ON o.target_kind=p.target_kind AND o.target_id=p.target_id AND o.entry_kind='note'
        AND o.entry_ref=('{"space_id":"' || p.note_space || '","note_id":"' || p.note_id || '"}')
    WHERE p.target_kind=$1 AND p.target_id=$2 AND instr($8, '|' || p.note_space || '|') > 0
)
SELECT kind, space, entity, rank, target_space, set_owner, set_home FROM entries WHERE (rank,kind,space,entity)>($3,$4,$5,$6) ORDER BY rank,kind,space,entity LIMIT $7
