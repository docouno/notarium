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

ALTER TABLE agent_retrievals ADD COLUMN session_id TEXT;
ALTER TABLE agent_retrievals ADD COLUMN session_name TEXT;
ALTER TABLE agent_retrievals ADD COLUMN session_attach TEXT
  CHECK (session_attach IS NULL OR session_attach IN ('declared', 'inferred'));

CREATE INDEX idx_agent_retrievals_owner_session_created
  ON agent_retrievals(owner, session_id, created_at DESC);

ALTER TABLE note_revisions ADD COLUMN agent_owner TEXT;
ALTER TABLE note_revisions ADD COLUMN agent_name TEXT;
ALTER TABLE note_revisions ADD COLUMN session_id TEXT;
ALTER TABLE note_revisions ADD COLUMN session_name TEXT;
ALTER TABLE note_revisions ADD COLUMN session_attach TEXT
  CHECK (session_attach IS NULL OR session_attach IN ('declared', 'inferred'));

CREATE INDEX idx_note_revisions_agent_session_created
  ON note_revisions(agent_owner, session_id, created_at DESC);

CREATE UNIQUE INDEX idx_folders_id_type
  ON folders(id, type);

CREATE TABLE mcp_delta_owner_cursors (
  owner TEXT NOT NULL,
  project TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'project' CHECK (project_type = 'project'),
  last_rev TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, project),
  FOREIGN KEY (project, project_type) REFERENCES folders(id, type) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_delta_owner_project
  ON mcp_delta_owner_cursors(project);

CREATE TABLE mcp_delta_session_cursors (
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'project' CHECK (project_type = 'project'),
  last_rev TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, project),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (project, project_type) REFERENCES folders(id, type) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_delta_session_project
  ON mcp_delta_session_cursors(project);

-- `folders` is a shared project/folder registry. A project can be unmarked by
-- flipping the same row to type='folder', so delete its cursor children before
-- the composite FK observes the referenced-key update. The FK's referenced-key
-- lock also serializes a concurrent cursor insert against this type change.
CREATE FUNCTION cascade_agent_delta_project_retype()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.type = 'project' AND NEW.type IS DISTINCT FROM 'project' THEN
    DELETE FROM mcp_delta_owner_cursors WHERE project = OLD.id;
    DELETE FROM mcp_delta_session_cursors WHERE project = OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agent_delta_project_retype
  BEFORE UPDATE OF type ON folders
  FOR EACH ROW
  EXECUTE FUNCTION cascade_agent_delta_project_retype();

-- The old actor key was the acting credential, and its scope key evolved from a
-- space id/slug to a project id. Principal ids have a stable grammar; resolve
-- every live scope to a project and collapse one owner's credentials to the
-- furthest revision. Unresolvable legacy rows remain inert in mcp_bookmarks.
-- @system is deliberately outside the username grammar: an AUTH_MODE switch
-- must not merge the authless host's cursor with a password user's state.
-- Keep mcp_bookmarks inert for one compatibility window; current code never
-- reads or writes it after this migration.
WITH parsed AS (
  SELECT
    principal_id AS actor_key,
    CASE
      WHEN principal_id = 'ui' THEN '@system'
      WHEN principal_id LIKE 'pat:%:%' THEN split_part(principal_id, ':', 2)
      WHEN principal_id LIKE 'oauth:%:%' THEN split_part(principal_id, ':', 2)
      ELSE NULL
    END AS owner,
    space AS legacy_key,
    last_rev,
    updated_at
  FROM mcp_bookmarks
),
candidates AS (
  SELECT
    parsed.*, folders.id AS project
  FROM parsed
  JOIN folders ON folders.id = parsed.legacy_key AND folders.type = 'project'
  UNION
  SELECT
    parsed.*, folders.id AS project
  FROM parsed
  JOIN folders
    ON folders.space = parsed.legacy_key AND folders.path = '' AND folders.type = 'project'
  UNION
  SELECT
    parsed.*, folders.id AS project
  FROM parsed
  JOIN spaces
    ON spaces.slug = parsed.legacy_key
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(COALESCE(spaces.aliases, '[]')::jsonb) AS alias(value)
       WHERE alias.value = parsed.legacy_key
    )
  JOIN folders ON folders.space = spaces.id AND folders.path = '' AND folders.type = 'project'
),
resolved AS (
  SELECT
    actor_key,
    owner,
    legacy_key,
    last_rev,
    updated_at,
    MIN(project) AS project
  FROM candidates
  GROUP BY actor_key, owner, legacy_key, last_rev, updated_at
  HAVING COUNT(DISTINCT project) = 1
)
INSERT INTO mcp_delta_owner_cursors (owner, project, last_rev, updated_at)
SELECT
  owner,
  project,
  MAX(last_rev::BIGINT)::TEXT,
  MAX(updated_at)
FROM resolved
WHERE owner IS NOT NULL AND owner != '' AND project IS NOT NULL
GROUP BY owner, project;
