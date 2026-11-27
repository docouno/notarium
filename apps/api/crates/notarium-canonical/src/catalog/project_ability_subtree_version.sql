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
    FROM sub
    CROSS JOIN note_heads nh
    CROSS JOIN ability_packages ap
    WHERE nh.space_id = $1
      AND nh.parent_folder_id = sub.folder_id
      AND ap.space_id = nh.space_id
      AND ap.entrypoint_note_id = nh.note_id
) pkg
