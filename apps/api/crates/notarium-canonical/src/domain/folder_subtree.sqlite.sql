WITH RECURSIVE subtree(folder_id, depth) AS (
    SELECT ?2, 0
    UNION ALL
    SELECT child.folder_id, parent.depth + 1
    FROM subtree AS parent
    CROSS JOIN folder_heads AS child INDEXED BY idx_folder_heads_parent_lifecycle
    WHERE parent.depth < ?3
      AND child.space_id = ?1 AND child.parent_folder_id = parent.folder_id
      AND child.lifecycle_state = 'active'
)
SELECT EXISTS (SELECT 1 FROM subtree WHERE depth = ?3)
