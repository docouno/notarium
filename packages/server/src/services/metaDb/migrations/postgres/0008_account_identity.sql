-- Account identity — the PostgreSQL twin of the SQLite carrier. See that file for
-- why each step exists; the shapes are identical so the shared persistence contract
-- holds both dialects to one behaviour. Requires PostgreSQL 13 or newer: the id
-- backfill uses the built-in gen_random_uuid().
--
-- Every backfill rewrites only a value that resolves to a live user; an orphaned
-- attribution and the literals `ui` / `@system` stay byte-for-byte.

-- 1. `users` is the only table rebuilt (its primary key moves from username to id).
--    Dropping the old table takes its two lifecycle triggers with it; they are
--    recreated after repopulation, otherwise the BEFORE INSERT gate would refuse a
--    user bound to a non-active personal space and abort the ladder. The constraints
--    take their final names back once the old table is gone.
CREATE TABLE users_after_identity (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  admin BOOLEAN NOT NULL DEFAULT FALSE,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  personal_space TEXT
);

INSERT INTO users_after_identity
  (id, username, email, display_name, password_hash, admin, disabled_at, created_at, personal_space)
SELECT substring(replace(gen_random_uuid()::text, '-', '') from 1 for 16),
       username,
       NULL,
       display_name,
       password_hash,
       admin,
       disabled_at,
       created_at,
       personal_space
  FROM users;

DROP TABLE users;

ALTER TABLE users_after_identity RENAME TO users;
ALTER TABLE users RENAME CONSTRAINT users_after_identity_pkey TO users_pkey;
ALTER TABLE users RENAME CONSTRAINT users_after_identity_username_key TO users_username_key;
ALTER TABLE users RENAME CONSTRAINT users_after_identity_email_key TO users_email_key;

CREATE TRIGGER trg_lifecycle_personal_space_update
BEFORE UPDATE OF personal_space ON users
FOR EACH ROW
WHEN (OLD.personal_space IS DISTINCT FROM NEW.personal_space)
EXECUTE FUNCTION enforce_active_space_columns('personal_space');

CREATE TRIGGER trg_lifecycle_personal_space_insert
BEFORE INSERT ON users
FOR EACH ROW EXECUTE FUNCTION enforce_active_space_columns('personal_space');

-- 2. Bare username as a key: renamed in place, then moved. Indexes, the composite
--    primary key and trigger column lists follow the attribute number; no plpgsql
--    body in this ladder names `username`, which is what makes the rename safe here.
ALTER TABLE sessions RENAME COLUMN username TO user_id;

UPDATE sessions
   SET user_id = users.id
  FROM users
 WHERE users.username = sessions.user_id;

ALTER TABLE pats RENAME COLUMN username TO user_id;

UPDATE pats
   SET user_id = users.id
  FROM users
 WHERE users.username = pats.user_id;

ALTER TABLE space_members RENAME COLUMN username TO user_id;

UPDATE space_members
   SET user_id = users.id
  FROM users
 WHERE users.username = space_members.user_id;

ALTER TABLE one_time_tokens RENAME COLUMN username TO user_id;

UPDATE one_time_tokens
   SET user_id = users.id
  FROM users
 WHERE users.username = one_time_tokens.user_id;

ALTER TABLE oauth_auth_codes RENAME COLUMN username TO user_id;

UPDATE oauth_auth_codes
   SET user_id = users.id
  FROM users
 WHERE users.username = oauth_auth_codes.user_id;

ALTER TABLE oauth_access_tokens RENAME COLUMN username TO user_id;

UPDATE oauth_access_tokens
   SET user_id = users.id
  FROM users
 WHERE users.username = oauth_access_tokens.user_id;

ALTER TABLE oauth_refresh_tokens RENAME COLUMN username TO user_id;

UPDATE oauth_refresh_tokens
   SET user_id = users.id
  FROM users
 WHERE users.username = oauth_refresh_tokens.user_id;

-- 3. Bare username as an owner key; the column keeps its name because it also holds
--    the `@system` literal. `backup_generation_freeze.owner` is a lease token, not a user.
UPDATE agent_sessions
   SET owner = users.id
  FROM users
 WHERE users.username = agent_sessions.owner;

UPDATE agent_retrievals
   SET owner = users.id
  FROM users
 WHERE users.username = agent_retrievals.owner;

UPDATE agent_calls
   SET owner = users.id
  FROM users
 WHERE users.username = agent_calls.owner;

UPDATE agent_session_cleanup_markers
   SET owner = users.id
  FROM users
 WHERE users.username = agent_session_cleanup_markers.owner;

UPDATE mcp_delta_owner_cursors
   SET owner = users.id
  FROM users
 WHERE users.username = mcp_delta_owner_cursors.owner;

UPDATE ability_preferences
   SET owner = users.id
  FROM users
 WHERE users.username = ability_preferences.owner;

UPDATE credentials
   SET owner = users.id
  FROM users
 WHERE users.username = credentials.owner;

UPDATE provider_resources
   SET owner = users.id
  FROM users
 WHERE users.username = provider_resources.owner;

UPDATE provider_call_log
   SET owner = users.id
  FROM users
 WHERE users.username = provider_call_log.owner;

UPDATE note_revisions
   SET agent_owner = users.id
  FROM users
 WHERE users.username = note_revisions.agent_owner;

-- 4. The principal string. The name is the second colon segment; the tail after it is
--    kept whole by offset rather than re-split — split_part would cut it at the next
--    colon. A `pat:`/`oauth:` row without a tail is not one of these forms and stays.
--    Rewriting `note_revisions.principal` trips the Activity invalidation trigger on
--    purpose — the projection rebuilds once with id keys.
UPDATE note_revisions
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(note_revisions.principal, 1, 5) = 'user:'
   AND users.username = substr(note_revisions.principal, 6);

UPDATE note_revisions
   SET principal = 'pat:' || users.id
       || substr(note_revisions.principal, 5 + length(split_part(note_revisions.principal, ':', 2)))
  FROM users
 WHERE substr(note_revisions.principal, 1, 4) = 'pat:'
   AND position(':' IN substr(note_revisions.principal, 5)) > 0
   AND users.username = split_part(note_revisions.principal, ':', 2);

UPDATE note_revisions
   SET principal = 'oauth:' || users.id
       || substr(note_revisions.principal, 7 + length(split_part(note_revisions.principal, ':', 2)))
  FROM users
 WHERE substr(note_revisions.principal, 1, 6) = 'oauth:'
   AND position(':' IN substr(note_revisions.principal, 7)) > 0
   AND users.username = split_part(note_revisions.principal, ':', 2);

UPDATE jobs
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(jobs.principal, 1, 5) = 'user:'
   AND users.username = substr(jobs.principal, 6);

UPDATE jobs
   SET principal = 'pat:' || users.id
       || substr(jobs.principal, 5 + length(split_part(jobs.principal, ':', 2)))
  FROM users
 WHERE substr(jobs.principal, 1, 4) = 'pat:'
   AND position(':' IN substr(jobs.principal, 5)) > 0
   AND users.username = split_part(jobs.principal, ':', 2);

UPDATE jobs
   SET principal = 'oauth:' || users.id
       || substr(jobs.principal, 7 + length(split_part(jobs.principal, ':', 2)))
  FROM users
 WHERE substr(jobs.principal, 1, 6) = 'oauth:'
   AND position(':' IN substr(jobs.principal, 7)) > 0
   AND users.username = split_part(jobs.principal, ':', 2);

UPDATE favorites
   SET owner = 'user:' || users.id
  FROM users
 WHERE substr(favorites.owner, 1, 5) = 'user:'
   AND users.username = substr(favorites.owner, 6);

UPDATE favorites
   SET owner = 'pat:' || users.id
       || substr(favorites.owner, 5 + length(split_part(favorites.owner, ':', 2)))
  FROM users
 WHERE substr(favorites.owner, 1, 4) = 'pat:'
   AND position(':' IN substr(favorites.owner, 5)) > 0
   AND users.username = split_part(favorites.owner, ':', 2);

UPDATE favorites
   SET owner = 'oauth:' || users.id
       || substr(favorites.owner, 7 + length(split_part(favorites.owner, ':', 2)))
  FROM users
 WHERE substr(favorites.owner, 1, 6) = 'oauth:'
   AND position(':' IN substr(favorites.owner, 7)) > 0
   AND users.username = split_part(favorites.owner, ':', 2);

UPDATE agent_retrievals
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(agent_retrievals.principal, 1, 5) = 'user:'
   AND users.username = substr(agent_retrievals.principal, 6);

UPDATE agent_retrievals
   SET principal = 'pat:' || users.id
       || substr(agent_retrievals.principal, 5 + length(split_part(agent_retrievals.principal, ':', 2)))
  FROM users
 WHERE substr(agent_retrievals.principal, 1, 4) = 'pat:'
   AND position(':' IN substr(agent_retrievals.principal, 5)) > 0
   AND users.username = split_part(agent_retrievals.principal, ':', 2);

UPDATE agent_retrievals
   SET principal = 'oauth:' || users.id
       || substr(agent_retrievals.principal, 7 + length(split_part(agent_retrievals.principal, ':', 2)))
  FROM users
 WHERE substr(agent_retrievals.principal, 1, 6) = 'oauth:'
   AND position(':' IN substr(agent_retrievals.principal, 7)) > 0
   AND users.username = split_part(agent_retrievals.principal, ':', 2);

UPDATE agent_calls
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(agent_calls.principal, 1, 5) = 'user:'
   AND users.username = substr(agent_calls.principal, 6);

UPDATE agent_calls
   SET principal = 'pat:' || users.id
       || substr(agent_calls.principal, 5 + length(split_part(agent_calls.principal, ':', 2)))
  FROM users
 WHERE substr(agent_calls.principal, 1, 4) = 'pat:'
   AND position(':' IN substr(agent_calls.principal, 5)) > 0
   AND users.username = split_part(agent_calls.principal, ':', 2);

UPDATE agent_calls
   SET principal = 'oauth:' || users.id
       || substr(agent_calls.principal, 7 + length(split_part(agent_calls.principal, ':', 2)))
  FROM users
 WHERE substr(agent_calls.principal, 1, 6) = 'oauth:'
   AND position(':' IN substr(agent_calls.principal, 7)) > 0
   AND users.username = split_part(agent_calls.principal, ':', 2);

UPDATE provider_call_log
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(provider_call_log.principal, 1, 5) = 'user:'
   AND users.username = substr(provider_call_log.principal, 6);

UPDATE provider_call_log
   SET principal = 'pat:' || users.id
       || substr(provider_call_log.principal, 5 + length(split_part(provider_call_log.principal, ':', 2)))
  FROM users
 WHERE substr(provider_call_log.principal, 1, 4) = 'pat:'
   AND position(':' IN substr(provider_call_log.principal, 5)) > 0
   AND users.username = split_part(provider_call_log.principal, ':', 2);

UPDATE provider_call_log
   SET principal = 'oauth:' || users.id
       || substr(provider_call_log.principal, 7 + length(split_part(provider_call_log.principal, ':', 2)))
  FROM users
 WHERE substr(provider_call_log.principal, 1, 6) = 'oauth:'
   AND position(':' IN substr(provider_call_log.principal, 7)) > 0
   AND users.username = split_part(provider_call_log.principal, ':', 2);

UPDATE spaces
   SET archived_by = 'user:' || users.id
  FROM users
 WHERE substr(spaces.archived_by, 1, 5) = 'user:'
   AND users.username = substr(spaces.archived_by, 6);

UPDATE spaces
   SET archived_by = 'pat:' || users.id
       || substr(spaces.archived_by, 5 + length(split_part(spaces.archived_by, ':', 2)))
  FROM users
 WHERE substr(spaces.archived_by, 1, 4) = 'pat:'
   AND position(':' IN substr(spaces.archived_by, 5)) > 0
   AND users.username = split_part(spaces.archived_by, ':', 2);

UPDATE spaces
   SET archived_by = 'oauth:' || users.id
       || substr(spaces.archived_by, 7 + length(split_part(spaces.archived_by, ':', 2)))
  FROM users
 WHERE substr(spaces.archived_by, 1, 6) = 'oauth:'
   AND position(':' IN substr(spaces.archived_by, 7)) > 0
   AND users.username = split_part(spaces.archived_by, ':', 2);

UPDATE space_lifecycle
   SET changed_by = 'user:' || users.id
  FROM users
 WHERE substr(space_lifecycle.changed_by, 1, 5) = 'user:'
   AND users.username = substr(space_lifecycle.changed_by, 6);

UPDATE space_lifecycle
   SET changed_by = 'pat:' || users.id
       || substr(space_lifecycle.changed_by, 5 + length(split_part(space_lifecycle.changed_by, ':', 2)))
  FROM users
 WHERE substr(space_lifecycle.changed_by, 1, 4) = 'pat:'
   AND position(':' IN substr(space_lifecycle.changed_by, 5)) > 0
   AND users.username = split_part(space_lifecycle.changed_by, ':', 2);

UPDATE space_lifecycle
   SET changed_by = 'oauth:' || users.id
       || substr(space_lifecycle.changed_by, 7 + length(split_part(space_lifecycle.changed_by, ':', 2)))
  FROM users
 WHERE substr(space_lifecycle.changed_by, 1, 6) = 'oauth:'
   AND position(':' IN substr(space_lifecycle.changed_by, 7)) > 0
   AND users.username = split_part(space_lifecycle.changed_by, ':', 2);

-- 5. The principal inside prepared evidence, read back on replay: top-level for a
--    restore, under `attribution` for an ability create. The text column round-trips
--    through jsonb, which may reserialize the document; replay compares against the
--    value it reads, not against a byte image, so that is safe. The WHERE proves the
--    path holds a resolvable value before jsonb_set could create it.
UPDATE restore_operations
   SET prepared_evidence = jsonb_set(
         prepared_evidence::jsonb,
         '{principalId}',
         to_jsonb('user:' || users.id)
       )::text
  FROM users
 WHERE substr(restore_operations.prepared_evidence::jsonb ->> 'principalId', 1, 5) = 'user:'
   AND users.username = substr(restore_operations.prepared_evidence::jsonb ->> 'principalId', 6);

UPDATE restore_operations
   SET prepared_evidence = jsonb_set(
         prepared_evidence::jsonb,
         '{principalId}',
         to_jsonb(
           'pat:' || users.id || substr(
             restore_operations.prepared_evidence::jsonb ->> 'principalId',
             5 + length(split_part(restore_operations.prepared_evidence::jsonb ->> 'principalId', ':', 2))
           )
         )
       )::text
  FROM users
 WHERE substr(restore_operations.prepared_evidence::jsonb ->> 'principalId', 1, 4) = 'pat:'
   AND position(':' IN substr(restore_operations.prepared_evidence::jsonb ->> 'principalId', 5)) > 0
   AND users.username = split_part(restore_operations.prepared_evidence::jsonb ->> 'principalId', ':', 2);

UPDATE restore_operations
   SET prepared_evidence = jsonb_set(
         prepared_evidence::jsonb,
         '{principalId}',
         to_jsonb(
           'oauth:' || users.id || substr(
             restore_operations.prepared_evidence::jsonb ->> 'principalId',
             7 + length(split_part(restore_operations.prepared_evidence::jsonb ->> 'principalId', ':', 2))
           )
         )
       )::text
  FROM users
 WHERE substr(restore_operations.prepared_evidence::jsonb ->> 'principalId', 1, 6) = 'oauth:'
   AND position(':' IN substr(restore_operations.prepared_evidence::jsonb ->> 'principalId', 7)) > 0
   AND users.username = split_part(restore_operations.prepared_evidence::jsonb ->> 'principalId', ':', 2);

UPDATE ability_create_operations
   SET prepared_evidence = jsonb_set(
         prepared_evidence::jsonb,
         '{attribution,principal}',
         to_jsonb('user:' || users.id)
       )::text
  FROM users
 WHERE substr(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', 1, 5) = 'user:'
   AND users.username = substr(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', 6);

UPDATE ability_create_operations
   SET prepared_evidence = jsonb_set(
         prepared_evidence::jsonb,
         '{attribution,principal}',
         to_jsonb(
           'pat:' || users.id || substr(
             ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}',
             5 + length(split_part(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', ':', 2))
           )
         )
       )::text
  FROM users
 WHERE substr(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', 1, 4) = 'pat:'
   AND position(':' IN substr(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', 5)) > 0
   AND users.username = split_part(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', ':', 2);

UPDATE ability_create_operations
   SET prepared_evidence = jsonb_set(
         prepared_evidence::jsonb,
         '{attribution,principal}',
         to_jsonb(
           'oauth:' || users.id || substr(
             ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}',
             7 + length(split_part(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', ':', 2))
           )
         )
       )::text
  FROM users
 WHERE substr(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', 1, 6) = 'oauth:'
   AND position(':' IN substr(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', 7)) > 0
   AND users.username = split_part(ability_create_operations.prepared_evidence::jsonb #>> '{attribution,principal}', ':', 2);

-- 6. The idempotency cache keys its scope by the principal string and expires within a
--    day; an empty table is honest where half-rewritten keys would not be.
DELETE FROM mcp_dedup;
