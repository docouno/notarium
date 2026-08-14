DROP INDEX idx_agent_retrievals_owner_session_created;
CREATE INDEX idx_agent_retrievals_owner_session_created
  ON agent_retrievals(owner, session_id, created_at DESC, id DESC);

DROP INDEX idx_agent_retrievals_owner_created;
CREATE INDEX idx_agent_retrievals_owner_created
  ON agent_retrievals(owner, created_at DESC, id DESC);

CREATE INDEX idx_agent_retrievals_owner_outside_created
  ON agent_retrievals(owner, created_at DESC, id DESC)
  WHERE session_id IS NULL;

DROP INDEX idx_note_revisions_agent_session_created;
CREATE INDEX idx_note_revisions_agent_session_created
  ON note_revisions(agent_owner, session_id, created_at DESC, id DESC);

CREATE INDEX idx_note_revisions_agent_created
  ON note_revisions(agent_owner, created_at DESC, id DESC)
  WHERE agent_owner IS NOT NULL;

CREATE INDEX idx_note_revisions_agent_outside_created
  ON note_revisions(agent_owner, created_at DESC, id DESC)
  WHERE session_id IS NULL AND agent_owner IS NOT NULL;

CREATE INDEX idx_agent_retrievals_owner_agent_created
  ON agent_retrievals(owner, agent, created_at DESC, id DESC);

CREATE INDEX idx_note_revisions_agent_owner_name_created
  ON note_revisions(agent_owner, agent_name, created_at DESC, id DESC)
  WHERE integrity = 'trusted';
