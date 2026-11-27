WITH entries AS (
    SELECT 'set'::text COLLATE "C" AS kind, ''::text COLLATE "C" AS space, a.set_id AS entity, coalesce(o.rank, 0) AS rank,
           a.target_space AS target_space, s.owner_id AS set_owner, s.home_space AS set_home
    FROM v1_control.context_set_attachments a
    JOIN v1_control.context_sets s ON s.set_id=a.set_id
    LEFT JOIN v1_control.context_order o ON o.target_kind=a.target_kind AND o.target_id=a.target_id AND o.entry_kind='set' AND o.entry_ref=a.set_id
    WHERE a.target_kind=$1 AND a.target_id=$2 AND s.home_space = ANY($8)
    UNION ALL
    SELECT 'note'::text COLLATE "C", p.note_space, p.note_id, coalesce(o.rank, 0), ''::text COLLATE "C", ''::text COLLATE "C", ''::text COLLATE "C"
    FROM v1_control.context_scope_pins p
    LEFT JOIN v1_control.context_order o ON o.target_kind=p.target_kind AND o.target_id=p.target_id AND o.entry_kind='note'
        AND o.entry_ref=('{"space_id":"' || p.note_space || '","note_id":"' || p.note_id || '"}')
    WHERE p.target_kind=$1 AND p.target_id=$2 AND p.note_space = ANY($8)
)
SELECT kind, space, entity, rank, target_space, set_owner, set_home FROM entries WHERE (rank,kind,space,entity)>($3,$4 COLLATE "C",$5 COLLATE "C",$6 COLLATE "C") ORDER BY rank,kind,space,entity LIMIT $7
