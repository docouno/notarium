WITH RECURSIVE sub(folder_id, updated_seq) AS (
    SELECT folder_id, updated_seq FROM folder_heads
    WHERE space_id = $1 AND folder_id = $2
    UNION ALL
    SELECT fh.folder_id, fh.updated_seq
    FROM sub
    CROSS JOIN folder_heads fh
    WHERE fh.space_id = $1 AND fh.parent_folder_id = sub.folder_id
)
SELECT
    CAST(COALESCE(pkg.max_ap_seq, 0) AS BIGINT),
    CAST(COALESCE(pkg.cnt, 0) AS BIGINT),
    CAST(COALESCE(pkg.max_nh_seq, 0) AS BIGINT),
    CAST(COALESCE((SELECT MAX(updated_seq) FROM sub), 0) AS BIGINT)
FROM (
    SELECT
        MAX(ap.updated_seq) AS max_ap_seq,
        COUNT(*) AS cnt,
        MAX(nh.updated_seq) AS max_nh_seq
    FROM ability_packages ap
    CROSS JOIN note_heads nh
    WHERE ap.space_id = $1
      AND nh.space_id = ap.space_id
      AND nh.note_id = ap.entrypoint_note_id
      AND nh.parent_folder_id IN (SELECT folder_id FROM sub)
) pkg
