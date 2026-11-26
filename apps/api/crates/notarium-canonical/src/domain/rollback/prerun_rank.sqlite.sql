SELECT metadata_msgpack FROM revisions
WHERE space_id = ?1 AND history_incarnation = ?2
  AND entity_type = 'rank' AND entity_key = ?3
  AND (agent_run_id IS NULL OR agent_run_id != ?4)
  AND space_seq < ?5
  AND NOT EXISTS (
      SELECT 1 FROM revisions r2 INDEXED BY idx_revisions_agent_run
      WHERE r2.space_id = revisions.space_id
        AND r2.history_incarnation = revisions.history_incarnation
        AND r2.visibility_seq = revisions.visibility_seq
        AND r2.agent_run_id IS NOT NULL
        AND r2.agent_run_id = ?4
  )
ORDER BY visibility_seq DESC, space_seq DESC
LIMIT 1
