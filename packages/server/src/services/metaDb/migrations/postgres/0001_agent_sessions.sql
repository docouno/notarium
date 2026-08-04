CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  named BOOLEAN NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  calls BIGINT NOT NULL CHECK (calls >= 1),
  FOREIGN KEY (parent_id) REFERENCES agent_sessions(id) ON DELETE SET NULL
);

CREATE INDEX idx_agent_sessions_owner_seen
  ON agent_sessions(owner, last_seen_at DESC);

CREATE INDEX idx_agent_sessions_owner_name_seen
  ON agent_sessions(owner, name, last_seen_at DESC);

CREATE INDEX idx_agent_sessions_seen
  ON agent_sessions(last_seen_at);
