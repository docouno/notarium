SELECT CAST(1 AS BIGINT)
FROM ability_packages AS package
CROSS JOIN note_heads AS note
WHERE package.space_id = $1
  AND package.slug_fold = $2
  AND package.lifecycle_state = 'active'
  AND package.ability_id <> $3
  AND note.space_id = package.space_id
  AND note.note_id = package.entrypoint_note_id
  AND (
      WITH RECURSIVE anc(folder_id, parent_folder_id, is_project) AS (
          SELECT f.folder_id, f.parent_folder_id, f.is_project
          FROM folder_heads AS f
          WHERE f.space_id = $1 AND f.folder_id = note.parent_folder_id
          UNION ALL
          SELECT p.folder_id, p.parent_folder_id, p.is_project
          FROM anc
          CROSS JOIN folder_heads AS p
          WHERE anc.is_project = 0
            AND anc.parent_folder_id IS NOT NULL
            AND p.space_id = $1
            AND p.folder_id = anc.parent_folder_id
      )
      SELECT COALESCE(MAX(CASE WHEN is_project = 1 THEN folder_id END), '') FROM anc
  ) = $4
LIMIT 1
