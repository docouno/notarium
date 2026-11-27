SELECT DISTINCT visibility_seq FROM revisions INDEXED BY idx_revisions_agent_run
WHERE space_id = ?1
  AND history_incarnation = ?2
  AND agent_run_id IS NOT NULL
  AND agent_run_id = ?3
