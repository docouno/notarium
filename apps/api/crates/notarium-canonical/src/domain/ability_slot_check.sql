WITH RECURSIVE ancestry(ability_id, folder_id, parent_folder_id, is_project) AS (
    SELECT package.ability_id, folder.folder_id, folder.parent_folder_id, folder.is_project
    FROM ability_packages AS package
    JOIN note_heads AS note
        ON note.space_id = package.space_id AND note.note_id = package.entrypoint_note_id
    JOIN folder_heads AS folder
        ON folder.space_id = note.space_id AND folder.folder_id = note.parent_folder_id
    WHERE package.space_id = $1 AND package.slug_fold = $2
        AND package.lifecycle_state = 'active' AND package.ability_id <> $3
    UNION
    SELECT ancestry.ability_id, parent.folder_id, parent.parent_folder_id, parent.is_project
    FROM ancestry
    JOIN folder_heads AS parent
        ON parent.space_id = $1 AND parent.folder_id = ancestry.parent_folder_id
)
SELECT CAST(1 AS BIGINT) FROM ancestry
GROUP BY ability_id
HAVING COALESCE(MAX(CASE WHEN is_project = 1 THEN folder_id END), '') = $4
LIMIT 1
