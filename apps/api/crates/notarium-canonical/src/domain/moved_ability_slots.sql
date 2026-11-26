WITH RECURSIVE moved_folders(folder_id) AS (
    SELECT folder_id FROM folder_heads WHERE space_id = $1 AND folder_id = $2
    UNION
    SELECT child.folder_id FROM moved_folders AS moved
    CROSS JOIN folder_heads AS child
    WHERE child.space_id = $1 AND child.parent_folder_id = moved.folder_id
),
moved_names(slug_fold) AS (
    SELECT DISTINCT package.slug_fold
    FROM moved_folders AS moved
    CROSS JOIN note_heads AS note
    CROSS JOIN ability_packages AS package
    WHERE note.space_id = $1
      AND note.parent_folder_id = moved.folder_id
      AND package.space_id = note.space_id
      AND package.entrypoint_note_id = note.note_id
      AND package.lifecycle_state = 'active'
),
ancestry(ability_id, slug_fold, folder_id, parent_folder_id, is_project) AS (
    SELECT package.ability_id, package.slug_fold, folder.folder_id, folder.parent_folder_id, folder.is_project
    FROM moved_names AS moved
    CROSS JOIN ability_packages AS package
    CROSS JOIN note_heads AS note
    CROSS JOIN folder_heads AS folder
    WHERE package.space_id = $1
      AND package.slug_fold = moved.slug_fold
      AND package.lifecycle_state = 'active'
      AND note.space_id = package.space_id
      AND note.note_id = package.entrypoint_note_id
      AND folder.space_id = note.space_id
      AND folder.folder_id = note.parent_folder_id
    UNION
    SELECT ancestry.ability_id, ancestry.slug_fold, parent.folder_id, parent.parent_folder_id, parent.is_project
    FROM ancestry
    CROSS JOIN folder_heads AS parent
    WHERE parent.space_id = $1 AND parent.folder_id = ancestry.parent_folder_id
),
destination_slots(slug_fold) AS (
    SELECT slug_fold FROM ancestry
    GROUP BY ability_id, slug_fold
    HAVING COALESCE(MAX(CASE WHEN is_project = 1 THEN folder_id END), '') = $3
)
SELECT CAST(CASE
    WHEN EXISTS (
        SELECT 1 FROM destination_slots GROUP BY slug_fold HAVING COUNT(*) > 1
    ) THEN 2
    WHEN EXISTS (SELECT 1 FROM moved_names) THEN 1
    ELSE 0
END AS BIGINT)
