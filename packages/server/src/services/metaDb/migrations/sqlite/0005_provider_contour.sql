-- The provider contour: the master-key witness, the owner-keyed registry a call is
-- addressed by, and the journal every call is recorded in. One carrier because it is
-- one subsystem — the tables reference each other and no supported deployment has
-- ever had a subset of them.
--
-- Secrets live here only as reversible envelopes; the key material itself is
-- filesystem state and this table is its witness, not its store.

CREATE TABLE secret_keyring (
  key_id     TEXT PRIMARY KEY,
  canary     TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('active', 'readable')),
  generation INTEGER NOT NULL UNIQUE CHECK (generation > 0),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK (
    length(key_id) = 27
    AND substr(key_id, 1, 3) = 'ck_'
    AND substr(key_id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (state <> 'active' OR retired_at IS NULL)
);

CREATE UNIQUE INDEX secret_keyring_one_active
  ON secret_keyring (state)
  WHERE state = 'active' AND retired_at IS NULL;

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  secret TEXT NOT NULL,
  origin TEXT NOT NULL,
  injection TEXT NOT NULL DEFAULT '{"header":"","prefix":""}',
  disabled_at TEXT,
  rpm INTEGER,
  tpm INTEGER,
  consent_epoch INTEGER NOT NULL DEFAULT 0,
  runtime_epoch INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner, name)
);

CREATE INDEX idx_credentials_owner ON credentials(owner);
CREATE INDEX idx_credentials_owner_page
  ON credentials(owner, name COLLATE BINARY, id COLLATE BINARY);

CREATE TABLE provider_resources (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  wire TEXT NOT NULL,
  base_url TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  allow_private_network INTEGER NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '[]',
  default_model TEXT,
  credential_id TEXT,
  consent_epoch INTEGER NOT NULL DEFAULT 0,
  runtime_epoch INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  last_check TEXT NOT NULL DEFAULT '{}',
  first_byte_timeout_ms INTEGER,
  call_timeout_ms INTEGER,
  UNIQUE (owner, name),
  FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE RESTRICT
);

CREATE INDEX idx_provider_resources_owner ON provider_resources(owner);
CREATE INDEX idx_provider_resources_credential ON provider_resources(credential_id);
CREATE INDEX idx_provider_resources_owner_page
  ON provider_resources(owner, name COLLATE BINARY, id COLLATE BINARY);
CREATE INDEX idx_provider_resources_effective_page
  ON provider_resources(name COLLATE BINARY, id COLLATE BINARY);

CREATE TABLE provider_attachments (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_space TEXT NOT NULL,
  state TEXT NOT NULL,
  resource_epoch INTEGER,
  credential_epoch INTEGER,
  disclosure_snapshot TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (resource_id, target_kind, target_id),
  FOREIGN KEY (resource_id) REFERENCES provider_resources(id) ON DELETE CASCADE
);

-- `target_space` deliberately has no FK to spaces. The provider writer enters the
-- explicit Space lifecycle fence before these tiers; purge deletes by this index.
-- A FK would take an implicit parent lock from below the ladder and deadlock with
-- purgeSpace. canon: docs/meta-db.md#source-of-truth
CREATE INDEX idx_provider_attachments_target_space
  ON provider_attachments(target_space, created_at COLLATE BINARY, id COLLATE BINARY);
CREATE INDEX idx_provider_attachments_effective
  ON provider_attachments(target_space, state, resource_id);

-- The provider call journal: one row per request the executor was allowed to send.
-- Owner-keyed and cross-Space, so `purgeSpace` does NOT sweep it — the question
-- "did that Space's content leave through this resource" is asked after the Space is
-- gone. There are no prompt or response columns, and there never will be.
--
-- `resource_id` and `credential_id` are historical snapshots with NO foreign key:
-- the audit outlives what it names, and a RESTRICT would turn a credential delete
-- into a lie while a CASCADE would erase the evidence.
CREATE TABLE provider_call_log (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  principal TEXT NOT NULL,
  agent TEXT,
  resource_id TEXT NOT NULL,
  credential_id TEXT,
  host TEXT NOT NULL,
  spaces TEXT NOT NULL DEFAULT '[]',
  job_id TEXT,
  job_call_key TEXT,
  attempt_no INTEGER,
  delivery_state TEXT NOT NULL,
  retry_safe INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  -- Counters as the wire reported them, source included. NULL is "spend unknown",
  -- which is not zero: a stream that broke off still cost what it cost.
  token_usage TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  -- The send-fence key. All three are NULL for an interactive call, and NULLs are
  -- distinct here, so those rows never collide. For a durable job call this is also
  -- the index the fence reads the latest attempt by: an equality on the first two
  -- columns with the third ordered descending.
  UNIQUE (job_id, job_call_key, attempt_no)
);

CREATE INDEX idx_provider_call_log_owner ON provider_call_log(owner, created_at);
-- Terminal retention walks oldest settled rows in bounded batches. `job_id` keeps
-- the live-job guard covered; in-flight rows have no settled_at and never enter this
-- maintenance index.
CREATE INDEX idx_provider_call_log_retention
  ON provider_call_log(settled_at, id, job_id) WHERE settled_at IS NOT NULL;
