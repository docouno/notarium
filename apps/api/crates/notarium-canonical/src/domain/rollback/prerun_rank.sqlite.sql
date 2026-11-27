SELECT metadata_msgpack FROM revisions INDEXED BY idx_revisions_entity_vis_seq
WHERE space_id = ?1 AND history_incarnation = ?2
  AND entity_type = 'rank' AND entity_key = ?3
  AND (agent_run_id IS NULL OR agent_run_id != ?4)
  AND space_seq < ?5
  AND visibility_seq NOT IN (
      SELECT visibility_seq FROM revisions INDEXED BY idx_revisions_agent_run
      WHERE space_id = ?1
        AND history_incarnation = ?2
        AND agent_run_id IS NOT NULL
        AND agent_run_id = ?4
  )
ORDER BY visibility_seq DESC, space_seq DESC
LIMIT 1
