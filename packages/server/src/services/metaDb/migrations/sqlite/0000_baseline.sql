CREATE TABLE meta_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE note_identity (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  created_at TEXT,
  materialized INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  space TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_note_identity_space_path
  ON note_identity(space, file_path);

CREATE TABLE revision_blobs (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL
);

CREATE TABLE note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  space TEXT NOT NULL,
  base_rev INTEGER,
  their_rev INTEGER,
  source_rev INTEGER,
  kind TEXT NOT NULL,
  principal TEXT,
  content_hash TEXT,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  chars_added INTEGER,
  chars_removed INTEGER,
  class TEXT,
  slug TEXT
);

CREATE INDEX idx_note_revisions_note
  ON note_revisions(note_id, id);

CREATE INDEX idx_note_revisions_space_created
  ON note_revisions(space, created_at);

CREATE INDEX idx_note_revisions_space_id
  ON note_revisions(space, id);

CREATE TABLE revision_purge_fences (
  kind TEXT NOT NULL CHECK (kind IN ('note', 'space')),
  entity_id TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);

CREATE TRIGGER trg_revision_append_lifecycle
  BEFORE INSERT ON note_revisions
  WHEN EXISTS (
    SELECT 1
    FROM revision_purge_fences
    WHERE (kind = 'space' AND entity_id = NEW.space)
       OR (kind = 'note' AND entity_id = NEW.note_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'revision target was permanently purged');
END;

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  notes_dir TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aliases TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  archived_by TEXT
);

CREATE TABLE users (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  personal_space TEXT
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user
  ON sessions(username);

CREATE TABLE pats (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  spaces TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_pats_user
  ON pats(username);

CREATE TABLE space_members (
  space TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space, username)
);

CREATE INDEX idx_space_members_user
  ON space_members(username);

CREATE TABLE one_time_tokens (
  id_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_one_time_user
  ON one_time_tokens(username);

CREATE TABLE mcp_bookmarks (
  principal_id TEXT NOT NULL,
  space TEXT NOT NULL,
  last_rev TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, space)
);

CREATE TABLE mcp_dedup (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  note_id TEXT NOT NULL,
  version_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX idx_mcp_dedup_created
  ON mcp_dedup(created_at);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  path TEXT NOT NULL,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL,
  aliases TEXT,
  type TEXT NOT NULL DEFAULT 'project',
  path_aliases TEXT
);

CREATE UNIQUE INDEX idx_folders_space_slug
  ON folders(space, slug)
  WHERE type = 'project';

CREATE UNIQUE INDEX idx_folders_space_path
  ON folders(space, path);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  activated_at TEXT
);

CREATE INDEX idx_oauth_clients_pending
  ON oauth_clients(created_at)
  WHERE activated_at IS NULL;

CREATE TABLE oauth_auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  username TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  spaces TEXT
);

CREATE TABLE oauth_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  username TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refresh_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  spaces TEXT
);

CREATE INDEX idx_oauth_access_user
  ON oauth_access_tokens(username);

CREATE TABLE oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  username TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rotated_to TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  spaces TEXT
);

CREATE INDEX idx_oauth_refresh_user
  ON oauth_refresh_tokens(username);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  principal TEXT NOT NULL,
  params TEXT,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  phase TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at TEXT NOT NULL,
  locked_at TEXT,
  locked_by TEXT,
  artifact_ref TEXT,
  artifact_bytes INTEGER,
  artifact_name TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT
);

CREATE INDEX idx_jobs_claim
  ON jobs(status, run_at);

CREATE INDEX idx_jobs_space
  ON jobs(space, created_at);

CREATE INDEX idx_jobs_expires
  ON jobs(expires_at);

CREATE TABLE favorites (
  owner TEXT NOT NULL,
  space TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rank INTEGER,
  PRIMARY KEY (owner, space, kind, entity_id)
);

CREATE INDEX idx_favorites_owner_space_order
  ON favorites(owner, space, rank, created_at DESC);

CREATE INDEX idx_favorites_space_entity
  ON favorites(space, kind, entity_id);

CREATE TABLE context_sets (
  id TEXT PRIMARY KEY,
  home_space TEXT NOT NULL,
  name TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_context_sets_home
  ON context_sets(home_space, created_at DESC);

CREATE TABLE context_set_attachments (
  set_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_space TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (set_id, target_kind, target_id)
);

CREATE INDEX idx_context_set_attach_target
  ON context_set_attachments(target_kind, target_id);

CREATE INDEX idx_context_set_attach_space
  ON context_set_attachments(target_space);

CREATE TABLE context_scope_pins (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_space TEXT NOT NULL,
  note_space TEXT NOT NULL,
  note_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id, note_id)
);

CREATE INDEX idx_context_scope_pins_target
  ON context_scope_pins(target_kind, target_id);

CREATE INDEX idx_context_scope_pins_space
  ON context_scope_pins(target_space);

CREATE TABLE context_order (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_space TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  entry_ref TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (target_kind, target_id, entry_kind, entry_ref)
);

CREATE INDEX idx_context_order_target
  ON context_order(target_kind, target_id);

CREATE INDEX idx_context_order_space
  ON context_order(target_space);

CREATE TABLE agent_retrievals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  principal TEXT NOT NULL,
  agent TEXT,
  tool TEXT NOT NULL,
  query TEXT NOT NULL,
  project TEXT,
  class_filter TEXT,
  result_count INTEGER NOT NULL,
  top_score REAL,
  hits TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_agent_retrievals_owner_created
  ON agent_retrievals(owner, created_at);

CREATE INDEX idx_agent_retrievals_owner_query
  ON agent_retrievals(owner, tool, query);
