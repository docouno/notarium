CREATE TABLE agent_calls (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  principal TEXT NOT NULL,
  agent TEXT,
  transport TEXT NOT NULL CHECK (transport = 'mcp'),
  request_id TEXT,
  session_id TEXT,
  session_name TEXT,
  session_attach TEXT CHECK (session_attach IS NULL OR session_attach IN ('declared', 'inferred')),
  tool TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('read', 'mutation', 'control')),
  domain TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN (
      'success',
      'invalid_arguments',
      'denied',
      'tool_error',
      'internal_error'
    )
  ),
  reason_code TEXT,
  input_bytes INTEGER NOT NULL CHECK (input_bytes >= 0),
  output_bytes INTEGER CHECK (output_bytes IS NULL OR output_bytes >= 0),
  input_shape TEXT NOT NULL,
  issue_summary TEXT,
  target_summary TEXT,
  result_summary TEXT,
  fingerprint TEXT NOT NULL,
  projection_version INTEGER NOT NULL CHECK (projection_version >= 1),
  redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  detail_capture_failed INTEGER NOT NULL DEFAULT 0 CHECK (detail_capture_failed IN (0, 1))
);

CREATE INDEX idx_agent_calls_owner_started
  ON agent_calls(owner, started_at DESC, id DESC);

CREATE INDEX idx_agent_calls_owner_session_started
  ON agent_calls(owner, session_id, started_at DESC, id DESC);

CREATE INDEX idx_agent_calls_owner_session_outcome_started
  ON agent_calls(owner, session_id, outcome, started_at DESC, id DESC);

CREATE INDEX idx_agent_calls_owner_outside_started
  ON agent_calls(owner, started_at DESC, id DESC)
  WHERE session_id IS NULL;

CREATE INDEX idx_agent_calls_owner_tool_started
  ON agent_calls(owner, tool, started_at DESC, id DESC);

CREATE INDEX idx_agent_calls_owner_outcome_started
  ON agent_calls(owner, outcome, started_at DESC, id DESC);

CREATE INDEX idx_agent_calls_owner_agent_started
  ON agent_calls(owner, agent, started_at DESC, id DESC)
  WHERE outcome IS NOT NULL AND agent IS NOT NULL AND agent != '';

CREATE INDEX idx_agent_calls_owner_fingerprint_started
  ON agent_calls(owner, fingerprint, tool, COALESCE(agent, principal), started_at DESC, id DESC)
  WHERE outcome = 'invalid_arguments';

CREATE INDEX idx_agent_calls_in_progress
  ON agent_calls(started_at)
  WHERE outcome IS NULL;

CREATE INDEX idx_agent_calls_outside_expiry
  ON agent_calls(COALESCE(finished_at, started_at), id)
  WHERE session_id IS NULL;

CREATE INDEX idx_agent_calls_complete_start
  ON agent_calls(owner, session_id)
  WHERE tool = 'start_session' AND outcome = 'success'
    AND json_extract(result_summary, '$."session.state"') IN ('new', 'forked');

CREATE TABLE agent_call_details (
  agent_call_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_call_details_expires
  ON agent_call_details(expires_at);

CREATE TABLE agent_telemetry_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  detailed_enabled INTEGER NOT NULL CHECK (detailed_enabled IN (0, 1)),
  compact_retention_days INTEGER NOT NULL CHECK (compact_retention_days IN (30, 90, 180, 365)),
  detailed_retention_days INTEGER NOT NULL CHECK (detailed_retention_days IN (7, 30, 90)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  CHECK (detailed_retention_days <= compact_retention_days)
);

INSERT INTO agent_telemetry_config
  (singleton, detailed_enabled, compact_retention_days, detailed_retention_days, version, updated_at)
VALUES (1, 0, 90, 30, 1, '1970-01-01T00:00:00.000Z');

CREATE TABLE agent_session_cleanup_markers (
  owner TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('retention', 'human-delete')),
  accepted_at TEXT NOT NULL,
  cleanup_pending INTEGER NOT NULL CHECK (cleanup_pending IN (0, 1)),
  PRIMARY KEY (owner, session_id)
);

CREATE INDEX idx_agent_session_cleanup_pending
  ON agent_session_cleanup_markers(cleanup_pending, accepted_at);

ALTER TABLE agent_retrievals ADD COLUMN agent_call_id TEXT;
ALTER TABLE note_revisions ADD COLUMN agent_call_id TEXT;

CREATE INDEX idx_agent_retrievals_agent_call
  ON agent_retrievals(agent_call_id);

CREATE INDEX idx_note_revisions_agent_call
  ON note_revisions(agent_call_id);

CREATE INDEX idx_agent_retrievals_legacy_owner_agent
  ON agent_retrievals(owner, agent)
  WHERE agent_call_id IS NULL AND agent IS NOT NULL AND agent != '';

CREATE INDEX idx_note_revisions_legacy_owner_agent
  ON note_revisions(agent_owner, agent_name)
  WHERE agent_call_id IS NULL AND integrity = 'trusted'
    AND agent_name IS NOT NULL AND agent_name != '';
