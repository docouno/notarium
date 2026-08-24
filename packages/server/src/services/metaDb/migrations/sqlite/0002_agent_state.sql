CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  named INTEGER NOT NULL CHECK (named IN (0, 1)),
  parent_id TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  calls INTEGER NOT NULL CHECK (calls >= 1),
  role TEXT,
  role_locator TEXT,
  role_context_project_id TEXT,
  project_id TEXT,
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

DROP INDEX idx_agent_retrievals_owner_created;

CREATE INDEX idx_agent_retrievals_owner_created
  ON agent_retrievals(owner, created_at DESC, id DESC);

CREATE INDEX idx_agent_retrievals_owner_session_created
  ON agent_retrievals(owner, session_id, created_at DESC, id DESC);

CREATE INDEX idx_agent_retrievals_owner_outside_created
  ON agent_retrievals(owner, created_at DESC, id DESC)
  WHERE session_id IS NULL;

CREATE INDEX idx_agent_retrievals_owner_agent_created
  ON agent_retrievals(owner, agent, created_at DESC, id DESC);

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

CREATE TRIGGER trg_agent_delta_project_retype
  BEFORE UPDATE OF type ON folders
  WHEN OLD.type = 'project' AND NEW.type != 'project'
BEGIN
  DELETE FROM mcp_delta_owner_cursors WHERE project = OLD.id;
  DELETE FROM mcp_delta_session_cursors WHERE project = OLD.id;
END;

WITH parsed AS (
  SELECT
    principal_id AS actor_key,
    CASE
      WHEN principal_id = 'ui' THEN '@system'
      WHEN principal_id LIKE 'pat:%:%'
        THEN substr(principal_id, 5, instr(substr(principal_id, 5), ':') - 1)
      WHEN principal_id LIKE 'oauth:%:%'
        THEN substr(principal_id, 7, instr(substr(principal_id, 7), ':') - 1)
      ELSE NULL
    END AS owner,
    space AS legacy_key,
    last_rev,
    updated_at
  FROM mcp_bookmarks
), candidates AS (
  SELECT parsed.*, folders.id AS project
    FROM parsed
    JOIN folders ON folders.id = parsed.legacy_key AND folders.type = 'project'
  UNION
  SELECT parsed.*, folders.id AS project
    FROM parsed
    JOIN folders
      ON folders.space = parsed.legacy_key AND folders.path = '' AND folders.type = 'project'
  UNION
  SELECT parsed.*, folders.id AS project
    FROM parsed
    JOIN spaces
      ON spaces.slug = parsed.legacy_key
      OR EXISTS (
        SELECT 1 FROM json_each(COALESCE(spaces.aliases, '[]'))
         WHERE value = parsed.legacy_key
      )
    JOIN folders ON folders.space = spaces.id AND folders.path = '' AND folders.type = 'project'
), resolved AS (
  SELECT actor_key,
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
SELECT owner,
       project,
       CAST(MAX(CAST(last_rev AS INTEGER)) AS TEXT),
       MAX(updated_at)
  FROM resolved
 WHERE owner IS NOT NULL AND owner != '' AND project IS NOT NULL
 GROUP BY owner, project;

DROP TABLE mcp_bookmarks;

CREATE TABLE ability_availability (
  home_space TEXT NOT NULL,
  package_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('all-projects', 'selected-projects')),
  registry_note_id TEXT,
  PRIMARY KEY (home_space, package_id)
);

CREATE TABLE ability_project_bindings (
  home_space TEXT NOT NULL,
  package_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (home_space, package_id, project_id),
  FOREIGN KEY (home_space, package_id)
    REFERENCES ability_availability(home_space, package_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX idx_ability_project_bindings_project
  ON ability_project_bindings(project_id);

CREATE INDEX idx_ability_availability_registry_note
  ON ability_availability(home_space, registry_note_id);

CREATE TRIGGER trg_ability_bindings_delete_project
AFTER DELETE ON folders
BEGIN
  DELETE FROM ability_project_bindings WHERE project_id = OLD.id;
END;

CREATE TRIGGER trg_ability_bindings_retype_project
AFTER UPDATE OF type, space ON folders
WHEN NEW.type <> 'project' OR NEW.space <> OLD.space
BEGIN
  DELETE FROM ability_project_bindings WHERE project_id = OLD.id;
END;

CREATE TRIGGER trg_ability_availability_delete_space
AFTER DELETE ON spaces
BEGIN
  DELETE FROM ability_project_bindings WHERE home_space = OLD.id;
  DELETE FROM ability_availability WHERE home_space = OLD.id;
END;

CREATE TABLE ability_preferences (
  owner TEXT NOT NULL,
  locator TEXT NOT NULL,
  space_id TEXT,
  registry_note_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, locator),
  CHECK ((space_id IS NULL) = (registry_note_id IS NULL))
);

CREATE INDEX ability_preferences_lifecycle
  ON ability_preferences(space_id, registry_note_id);

CREATE INDEX ability_preferences_locator
  ON ability_preferences(locator);

CREATE TABLE ability_placement_trail (
  from_locator TEXT PRIMARY KEY,
  to_locator TEXT NOT NULL,
  space_id TEXT NOT NULL,
  registry_note_id TEXT NOT NULL,
  manifest_note_id TEXT NOT NULL,
  CHECK (from_locator <> to_locator)
);

CREATE INDEX ability_placement_trail_to
  ON ability_placement_trail(to_locator);

CREATE INDEX ability_placement_trail_space
  ON ability_placement_trail(space_id);

CREATE TABLE ability_create_operations (
  id TEXT PRIMARY KEY,
  actor_digest TEXT NOT NULL,
  idempotency_digest TEXT,
  request_fingerprint TEXT NOT NULL,
  space TEXT NOT NULL,
  package_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  target_path TEXT NOT NULL,
  availability_required INTEGER NOT NULL CHECK (availability_required IN (0, 1)),
  stage_binding TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN (
      'accepted',
      'physical-published',
      'metadata-committed',
      'succeeded',
      'rejected',
      'failed-recoverable'
    )
  ),
  prepared_evidence TEXT NOT NULL,
  physical_receipt TEXT,
  terminal_result TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (space, package_id),
  UNIQUE (note_id)
);

CREATE UNIQUE INDEX idx_ability_create_operations_replay
  ON ability_create_operations(actor_digest, idempotency_digest)
  WHERE idempotency_digest IS NOT NULL AND phase <> 'rejected';

CREATE INDEX idx_ability_create_operations_recovery
  ON ability_create_operations(phase, created_at, id);

CREATE TRIGGER trg_ability_create_operations_delete_space
AFTER DELETE ON spaces
BEGIN
  DELETE FROM ability_create_operations WHERE space = OLD.id;
END;
