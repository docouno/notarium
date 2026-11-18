WITH RECURSIVE subtree(folder_id, depth) AS (
    SELECT $2::text, 0::bigint
    UNION ALL
    SELECT child.folder_id, parent.depth + 1
    FROM subtree AS parent
    CROSS JOIN LATERAL (
        SELECT folder_id FROM folder_heads
        WHERE space_id = $1 AND parent_folder_id = parent.folder_id
          AND lifecycle_state = 'active'
        OFFSET 0
    ) AS child
    WHERE parent.depth < $3
)
SELECT EXISTS (SELECT 1 FROM subtree WHERE depth = $3)
