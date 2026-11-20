-- Board moves can belong to the run or reference a note touched through its revisions.
WITH touched(note_id) AS (
    SELECT DISTINCT entity_key FROM revisions
    WHERE space_id = ?1 AND agent_run_id = ?2 AND entity_type = 'note'
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM board_move_history WHERE space_id = ?1) THEN EXISTS (
    SELECT 1 FROM board_move_history WHERE space_id = ?1 AND agent_run_id = ?2
    UNION ALL
    SELECT 1 FROM touched t CROSS JOIN board_move_history b
    WHERE b.space_id = ?1 AND b.target_note_id = t.note_id
    UNION ALL
    SELECT 1 FROM touched t CROSS JOIN board_move_history b
    WHERE b.space_id = ?1 AND b.view_note_id = t.note_id
) ELSE FALSE END
