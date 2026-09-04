-- Account identity: a user gains a stable opaque id, the username becomes a mutable
-- unique attribute beside an optional unique email, and every carrier that keyed a
-- row by username now keys it by that id. One carrier for one subsystem — nothing
-- else on disk knows a username, so this is a meta-DB-only transition that runs once.
--
-- The rule for every backfill below: a value is rewritten only where it resolves to
-- a live user. An orphaned attribution (an account that vanished outside the product)
-- stays byte-for-byte, and so do the literals `ui` (auth-less journal writes) and
-- `@system` (the auth-less agent owner) — none of them has a row to resolve to.

-- 1. `users` is the ONLY table rebuilt: its primary key moves from username to id.
--    The two lifecycle gates travel with the rename and die with the drop, so they are
--    recreated AFTER repopulation — the BEFORE INSERT gate would refuse every user
--    bound to a non-active personal space and abort the whole ladder. `id` carries an
--    explicit NOT NULL: on a rowid table a TEXT PRIMARY KEY still admits NULL.
ALTER TABLE users RENAME TO users_before_identity;

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  personal_space TEXT
);

INSERT INTO users
  (id, username, email, display_name, password_hash, admin, disabled_at, created_at, personal_space)
SELECT lower(hex(randomblob(8))),
       username,
       NULL,
       display_name,
       password_hash,
       admin,
       disabled_at,
       created_at,
       personal_space
  FROM users_before_identity;

DROP TABLE users_before_identity;

CREATE TRIGGER trg_lifecycle_personal_space_update
BEFORE UPDATE OF personal_space ON users
WHEN NEW.personal_space IS NOT NULL
AND NEW.personal_space IS NOT OLD.personal_space
AND EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.personal_space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects personal-space binding');
END;

CREATE TRIGGER trg_lifecycle_personal_space_insert
BEFORE INSERT ON users
WHEN NEW.personal_space IS NOT NULL
AND EXISTS (
  SELECT 1 FROM space_lifecycle
   WHERE space = NEW.personal_space AND phase <> 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'space lifecycle rejects personal-space binding');
END;

-- 2. Bare username as a key: the column is renamed in place (RENAME COLUMN carries
--    the name into the primary key, the indexes and every trigger body), then the
--    value is moved. The join IS the resolvability condition — an unmatched name is
--    not in the update at all, so a NOT NULL column never receives a NULL.
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

-- 3. Bare username as an owner key: the column keeps its name because it also holds
--    the `@system` literal, which the join leaves alone. `backup_generation_freeze.owner`
--    is NOT here — despite its name it holds a randomUUID lease token, never a user.
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

-- 4. The principal string: `user:<name>` (no tail by construction), `pat:<name>:<tail>`
--    and `oauth:<name>:<tail>`. Exactly the second segment is replaced; the tail is
--    kept whole because it may itself contain colons. Scheme tests use substr rather
--    than LIKE: LIKE is case-insensitive and treats `_` as a wildcard. A `pat:`/`oauth:`
--    row without a tail is not one of these forms and stays as it is, like any unknown
--    scheme. Rewriting `note_revisions.principal` trips the Activity invalidation
--    trigger on purpose — the projection rebuilds once with id keys.
UPDATE note_revisions
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(note_revisions.principal, 1, 5) = 'user:'
   AND users.username = substr(note_revisions.principal, 6);

UPDATE note_revisions
   SET principal = 'pat:' || users.id
       || substr(note_revisions.principal, 4 + instr(substr(note_revisions.principal, 5), ':'))
  FROM users
 WHERE substr(note_revisions.principal, 1, 4) = 'pat:'
   AND instr(substr(note_revisions.principal, 5), ':') > 0
   AND users.username = substr(note_revisions.principal, 5, instr(substr(note_revisions.principal, 5), ':') - 1);

UPDATE note_revisions
   SET principal = 'oauth:' || users.id
       || substr(note_revisions.principal, 6 + instr(substr(note_revisions.principal, 7), ':'))
  FROM users
 WHERE substr(note_revisions.principal, 1, 6) = 'oauth:'
   AND instr(substr(note_revisions.principal, 7), ':') > 0
   AND users.username = substr(note_revisions.principal, 7, instr(substr(note_revisions.principal, 7), ':') - 1);

UPDATE jobs
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(jobs.principal, 1, 5) = 'user:'
   AND users.username = substr(jobs.principal, 6);

UPDATE jobs
   SET principal = 'pat:' || users.id
       || substr(jobs.principal, 4 + instr(substr(jobs.principal, 5), ':'))
  FROM users
 WHERE substr(jobs.principal, 1, 4) = 'pat:'
   AND instr(substr(jobs.principal, 5), ':') > 0
   AND users.username = substr(jobs.principal, 5, instr(substr(jobs.principal, 5), ':') - 1);

UPDATE jobs
   SET principal = 'oauth:' || users.id
       || substr(jobs.principal, 6 + instr(substr(jobs.principal, 7), ':'))
  FROM users
 WHERE substr(jobs.principal, 1, 6) = 'oauth:'
   AND instr(substr(jobs.principal, 7), ':') > 0
   AND users.username = substr(jobs.principal, 7, instr(substr(jobs.principal, 7), ':') - 1);

UPDATE favorites
   SET owner = 'user:' || users.id
  FROM users
 WHERE substr(favorites.owner, 1, 5) = 'user:'
   AND users.username = substr(favorites.owner, 6);

UPDATE favorites
   SET owner = 'pat:' || users.id
       || substr(favorites.owner, 4 + instr(substr(favorites.owner, 5), ':'))
  FROM users
 WHERE substr(favorites.owner, 1, 4) = 'pat:'
   AND instr(substr(favorites.owner, 5), ':') > 0
   AND users.username = substr(favorites.owner, 5, instr(substr(favorites.owner, 5), ':') - 1);

UPDATE favorites
   SET owner = 'oauth:' || users.id
       || substr(favorites.owner, 6 + instr(substr(favorites.owner, 7), ':'))
  FROM users
 WHERE substr(favorites.owner, 1, 6) = 'oauth:'
   AND instr(substr(favorites.owner, 7), ':') > 0
   AND users.username = substr(favorites.owner, 7, instr(substr(favorites.owner, 7), ':') - 1);

UPDATE agent_retrievals
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(agent_retrievals.principal, 1, 5) = 'user:'
   AND users.username = substr(agent_retrievals.principal, 6);

UPDATE agent_retrievals
   SET principal = 'pat:' || users.id
       || substr(agent_retrievals.principal, 4 + instr(substr(agent_retrievals.principal, 5), ':'))
  FROM users
 WHERE substr(agent_retrievals.principal, 1, 4) = 'pat:'
   AND instr(substr(agent_retrievals.principal, 5), ':') > 0
   AND users.username = substr(agent_retrievals.principal, 5, instr(substr(agent_retrievals.principal, 5), ':') - 1);

UPDATE agent_retrievals
   SET principal = 'oauth:' || users.id
       || substr(agent_retrievals.principal, 6 + instr(substr(agent_retrievals.principal, 7), ':'))
  FROM users
 WHERE substr(agent_retrievals.principal, 1, 6) = 'oauth:'
   AND instr(substr(agent_retrievals.principal, 7), ':') > 0
   AND users.username = substr(agent_retrievals.principal, 7, instr(substr(agent_retrievals.principal, 7), ':') - 1);

UPDATE agent_calls
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(agent_calls.principal, 1, 5) = 'user:'
   AND users.username = substr(agent_calls.principal, 6);

UPDATE agent_calls
   SET principal = 'pat:' || users.id
       || substr(agent_calls.principal, 4 + instr(substr(agent_calls.principal, 5), ':'))
  FROM users
 WHERE substr(agent_calls.principal, 1, 4) = 'pat:'
   AND instr(substr(agent_calls.principal, 5), ':') > 0
   AND users.username = substr(agent_calls.principal, 5, instr(substr(agent_calls.principal, 5), ':') - 1);

UPDATE agent_calls
   SET principal = 'oauth:' || users.id
       || substr(agent_calls.principal, 6 + instr(substr(agent_calls.principal, 7), ':'))
  FROM users
 WHERE substr(agent_calls.principal, 1, 6) = 'oauth:'
   AND instr(substr(agent_calls.principal, 7), ':') > 0
   AND users.username = substr(agent_calls.principal, 7, instr(substr(agent_calls.principal, 7), ':') - 1);

UPDATE provider_call_log
   SET principal = 'user:' || users.id
  FROM users
 WHERE substr(provider_call_log.principal, 1, 5) = 'user:'
   AND users.username = substr(provider_call_log.principal, 6);

UPDATE provider_call_log
   SET principal = 'pat:' || users.id
       || substr(provider_call_log.principal, 4 + instr(substr(provider_call_log.principal, 5), ':'))
  FROM users
 WHERE substr(provider_call_log.principal, 1, 4) = 'pat:'
   AND instr(substr(provider_call_log.principal, 5), ':') > 0
   AND users.username = substr(provider_call_log.principal, 5, instr(substr(provider_call_log.principal, 5), ':') - 1);

UPDATE provider_call_log
   SET principal = 'oauth:' || users.id
       || substr(provider_call_log.principal, 6 + instr(substr(provider_call_log.principal, 7), ':'))
  FROM users
 WHERE substr(provider_call_log.principal, 1, 6) = 'oauth:'
   AND instr(substr(provider_call_log.principal, 7), ':') > 0
   AND users.username = substr(provider_call_log.principal, 7, instr(substr(provider_call_log.principal, 7), ':') - 1);

UPDATE spaces
   SET archived_by = 'user:' || users.id
  FROM users
 WHERE substr(spaces.archived_by, 1, 5) = 'user:'
   AND users.username = substr(spaces.archived_by, 6);

UPDATE spaces
   SET archived_by = 'pat:' || users.id
       || substr(spaces.archived_by, 4 + instr(substr(spaces.archived_by, 5), ':'))
  FROM users
 WHERE substr(spaces.archived_by, 1, 4) = 'pat:'
   AND instr(substr(spaces.archived_by, 5), ':') > 0
   AND users.username = substr(spaces.archived_by, 5, instr(substr(spaces.archived_by, 5), ':') - 1);

UPDATE spaces
   SET archived_by = 'oauth:' || users.id
       || substr(spaces.archived_by, 6 + instr(substr(spaces.archived_by, 7), ':'))
  FROM users
 WHERE substr(spaces.archived_by, 1, 6) = 'oauth:'
   AND instr(substr(spaces.archived_by, 7), ':') > 0
   AND users.username = substr(spaces.archived_by, 7, instr(substr(spaces.archived_by, 7), ':') - 1);

UPDATE space_lifecycle
   SET changed_by = 'user:' || users.id
  FROM users
 WHERE substr(space_lifecycle.changed_by, 1, 5) = 'user:'
   AND users.username = substr(space_lifecycle.changed_by, 6);

UPDATE space_lifecycle
   SET changed_by = 'pat:' || users.id
       || substr(space_lifecycle.changed_by, 4 + instr(substr(space_lifecycle.changed_by, 5), ':'))
  FROM users
 WHERE substr(space_lifecycle.changed_by, 1, 4) = 'pat:'
   AND instr(substr(space_lifecycle.changed_by, 5), ':') > 0
   AND users.username = substr(space_lifecycle.changed_by, 5, instr(substr(space_lifecycle.changed_by, 5), ':') - 1);

UPDATE space_lifecycle
   SET changed_by = 'oauth:' || users.id
       || substr(space_lifecycle.changed_by, 6 + instr(substr(space_lifecycle.changed_by, 7), ':'))
  FROM users
 WHERE substr(space_lifecycle.changed_by, 1, 6) = 'oauth:'
   AND instr(substr(space_lifecycle.changed_by, 7), ':') > 0
   AND users.username = substr(space_lifecycle.changed_by, 7, instr(substr(space_lifecycle.changed_by, 7), ':') - 1);

-- 5. The principal inside prepared evidence, read back when an interrupted operation
--    is replayed. The path is exactly the one the replay reads: a restore keeps it at
--    the top level, an ability create nests it under `attribution`. json_set would
--    silently create a missing path, so the WHERE proves the value exists first.
UPDATE restore_operations
   SET prepared_evidence = json_set(prepared_evidence, '$.principalId', 'user:' || users.id)
  FROM users
 WHERE substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 1, 5) = 'user:'
   AND users.username = substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 6);

UPDATE restore_operations
   SET prepared_evidence = json_set(
         prepared_evidence,
         '$.principalId',
         'pat:' || users.id || substr(
           json_extract(restore_operations.prepared_evidence, '$.principalId'),
           4 + instr(substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 5), ':')
         )
       )
  FROM users
 WHERE substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 1, 4) = 'pat:'
   AND instr(substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 5), ':') > 0
   AND users.username = substr(
         json_extract(restore_operations.prepared_evidence, '$.principalId'),
         5,
         instr(substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 5), ':') - 1
       );

UPDATE restore_operations
   SET prepared_evidence = json_set(
         prepared_evidence,
         '$.principalId',
         'oauth:' || users.id || substr(
           json_extract(restore_operations.prepared_evidence, '$.principalId'),
           6 + instr(substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 7), ':')
         )
       )
  FROM users
 WHERE substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 1, 6) = 'oauth:'
   AND instr(substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 7), ':') > 0
   AND users.username = substr(
         json_extract(restore_operations.prepared_evidence, '$.principalId'),
         7,
         instr(substr(json_extract(restore_operations.prepared_evidence, '$.principalId'), 7), ':') - 1
       );

UPDATE ability_create_operations
   SET prepared_evidence = json_set(prepared_evidence, '$.attribution.principal', 'user:' || users.id)
  FROM users
 WHERE substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 1, 5) = 'user:'
   AND users.username = substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 6);

UPDATE ability_create_operations
   SET prepared_evidence = json_set(
         prepared_evidence,
         '$.attribution.principal',
         'pat:' || users.id || substr(
           json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'),
           4 + instr(substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 5), ':')
         )
       )
  FROM users
 WHERE substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 1, 4) = 'pat:'
   AND instr(substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 5), ':') > 0
   AND users.username = substr(
         json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'),
         5,
         instr(substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 5), ':') - 1
       );

UPDATE ability_create_operations
   SET prepared_evidence = json_set(
         prepared_evidence,
         '$.attribution.principal',
         'oauth:' || users.id || substr(
           json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'),
           6 + instr(substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 7), ':')
         )
       )
  FROM users
 WHERE substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 1, 6) = 'oauth:'
   AND instr(substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 7), ':') > 0
   AND users.username = substr(
         json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'),
         7,
         instr(substr(json_extract(ability_create_operations.prepared_evidence, '$.attribution.principal'), 7), ':') - 1
       );

-- 6. The idempotency cache keys its scope by the principal string and expires within a
--    day; an empty table is honest where half-rewritten keys would not be. A write
--    replayed across the upgrade runs again instead of returning its recorded outcome.
DELETE FROM mcp_dedup;
