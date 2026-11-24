CREATE TABLE v1_storage_epoch (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    epoch_version INTEGER NOT NULL CHECK (epoch_version > 0),
    state TEXT NOT NULL CHECK (state IN ('migrating', 'ready')),
    installation_id TEXT NOT NULL,
    receipt_sha256 BLOB CHECK (length(receipt_sha256) = 32),
    receipt_json TEXT CHECK (length(CAST(receipt_json AS BLOB)) <= 1048576),
    CHECK (instr(state,char(0))=0),
    CHECK (instr(installation_id,char(0))=0),
    CHECK (instr(receipt_json,char(0))=0)
) STRICT;
CREATE TABLE users (
    user_id TEXT NOT NULL PRIMARY KEY, username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE, display_name TEXT NOT NULL,
    password_hash TEXT CHECK (length(password_hash) <= 1024),
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
    disabled_at INTEGER, personal_space_id TEXT UNIQUE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK (metadata_revision >= 0),
    auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
    created_at INTEGER NOT NULL,
    CHECK (instr(user_id,char(0))=0),
    CHECK (instr(username,char(0))=0),
    CHECK (instr(email,char(0))=0),
    CHECK (instr(display_name,char(0))=0),
    CHECK (instr(password_hash,char(0))=0),
    CHECK (instr(personal_space_id,char(0))=0),
    CHECK (coalesce(length(CAST(user_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(username AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(email AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(personal_space_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE TABLE user_oidc_identities (
    issuer TEXT NOT NULL, subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id), created_at INTEGER NOT NULL,
    PRIMARY KEY (issuer, subject),
    CHECK (instr(issuer,char(0))=0),
    CHECK (instr(subject,char(0))=0),
    CHECK (instr(user_id,char(0))=0),
    CHECK (coalesce(length(CAST(issuer AS BLOB)),0) + coalesce(length(CAST(subject AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(user_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX oidc_user ON user_oidc_identities(user_id);
CREATE TABLE space_admission (
    space_id TEXT NOT NULL PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('pending','active','closing','archived')),
    admission_epoch INTEGER NOT NULL DEFAULT 0 CHECK (admission_epoch >= 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    CHECK (instr(space_id,char(0))=0),
    CHECK (instr(state,char(0))=0),
    CHECK (coalesce(length(CAST(space_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE TABLE space_members (
    space_id TEXT NOT NULL REFERENCES space_admission(space_id),
    user_id TEXT NOT NULL REFERENCES users(user_id),
    role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
    admission TEXT NOT NULL CHECK (admission IN ('pending','active')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), created_at INTEGER NOT NULL,
    PRIMARY KEY (space_id,user_id),
    CHECK (instr(space_id,char(0))=0),
    CHECK (instr(user_id,char(0))=0),
    CHECK (instr(role,char(0))=0),
    CHECK (instr(admission,char(0))=0),
    CHECK (coalesce(length(CAST(space_id AS BLOB)),0) + coalesce(length(CAST(user_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(user_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX member_user ON space_members(user_id,space_id);
CREATE TABLE sessions (
    session_id TEXT NOT NULL PRIMARY KEY, token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash)=32),
    user_id TEXT NOT NULL REFERENCES users(user_id), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER,
    auth_version INTEGER NOT NULL CHECK (auth_version >= 0),
    CHECK (instr(session_id,char(0))=0),
    CHECK (instr(user_id,char(0))=0),
    CHECK (coalesce(length(CAST(session_id AS BLOB)),0) + 8 <= 2048),
    CHECK (coalesce(length(CAST(token_hash AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(user_id AS BLOB)),0) + 8 <= 2048)
) STRICT;
CREATE INDEX session_by_user ON sessions(user_id,revoked_at);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE INDEX session_revoked ON sessions(revoked_at,session_id) WHERE revoked_at IS NOT NULL;
CREATE TABLE one_time_tokens (
    token_hash BLOB NOT NULL PRIMARY KEY CHECK (length(token_hash)=32),
    user_id TEXT NOT NULL REFERENCES users(user_id),
    purpose TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
    expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL,
    CHECK (instr(user_id,char(0))=0),
    CHECK (instr(purpose,char(0))=0),
    CHECK (coalesce(length(CAST(token_hash AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(user_id AS BLOB)),0) + coalesce(length(CAST(purpose AS BLOB)),0) + 8 <= 2048)
) STRICT;
CREATE INDEX one_time_user ON one_time_tokens(user_id,purpose,expires_at);
CREATE INDEX one_time_expiry ON one_time_tokens(expires_at);
CREATE TABLE pats (
    token_id TEXT NOT NULL PRIMARY KEY CHECK (length(token_id)=12),
    secret_hash BLOB NOT NULL CHECK (length(secret_hash)=32),
    user_id TEXT NOT NULL REFERENCES users(user_id), name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read','write')), selected_spaces TEXT,
    expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL,
    CHECK (instr(token_id,char(0))=0),
    CHECK (instr(user_id,char(0))=0),
    CHECK (instr(name,char(0))=0),
    CHECK (instr(scope,char(0))=0),
    CHECK (instr(selected_spaces,char(0))=0),
    CHECK (coalesce(length(CAST(token_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(user_id AS BLOB)),0) + coalesce(length(CAST(token_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX pat_user ON pats(user_id,token_id);
CREATE TABLE oauth_clients (
    client_id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dcr','cimd')),
    redirect_uris TEXT NOT NULL CHECK (length(redirect_uris)<=8192), client_name TEXT NOT NULL,
    metadata_uri TEXT, metadata_digest BLOB CHECK (length(metadata_digest)=32),
    cache_expires_at INTEGER, activated_at INTEGER, created_at INTEGER NOT NULL, last_seen_at INTEGER,
    CHECK (instr(client_id,char(0))=0),
    CHECK (instr(kind,char(0))=0),
    CHECK (instr(redirect_uris,char(0))=0),
    CHECK (instr(client_name,char(0))=0),
    CHECK (instr(metadata_uri,char(0))=0),
    CHECK (coalesce(length(CAST(client_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(kind AS BLOB)),0) + 16 <= 2048)
) STRICT;
CREATE INDEX client_pending ON oauth_clients(kind,activated_at,created_at);
CREATE INDEX client_kind_cache ON oauth_clients(kind,cache_expires_at,created_at);
CREATE TABLE oauth_grants (
    grant_id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id),
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id), resource_uri TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read','write')), selected_spaces TEXT,
    revoked_at INTEGER, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), created_at INTEGER NOT NULL,
    CHECK (instr(grant_id,char(0))=0),
    CHECK (instr(user_id,char(0))=0),
    CHECK (instr(client_id,char(0))=0),
    CHECK (instr(resource_uri,char(0))=0),
    CHECK (instr(scope,char(0))=0),
    CHECK (instr(selected_spaces,char(0))=0),
    CHECK (coalesce(length(CAST(grant_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(user_id AS BLOB)),0) + coalesce(length(CAST(client_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(client_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX grant_user ON oauth_grants(user_id,client_id);
CREATE INDEX grant_client ON oauth_grants(client_id);
CREATE TABLE oauth_auth_codes (
    code_hash BLOB NOT NULL PRIMARY KEY CHECK (length(code_hash)=32),
    grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id),
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
    redirect_uri TEXT NOT NULL, resource_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL CHECK (length(code_challenge)=43),
    method TEXT NOT NULL CHECK (method='S256'),
    offline_access INTEGER NOT NULL CHECK (offline_access IN (0,1)),
    expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL,
    CHECK (instr(grant_id,char(0))=0),
    CHECK (instr(client_id,char(0))=0),
    CHECK (instr(redirect_uri,char(0))=0),
    CHECK (instr(resource_uri,char(0))=0),
    CHECK (instr(code_challenge,char(0))=0),
    CHECK (instr(method,char(0))=0),
    CHECK (coalesce(length(CAST(code_hash AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(client_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX code_expiry ON oauth_auth_codes(expires_at);
CREATE INDEX code_client ON oauth_auth_codes(client_id);
CREATE TABLE oauth_refresh_families (
    family_id TEXT NOT NULL PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id),
    revoked_at INTEGER, reason_code TEXT, created_at INTEGER NOT NULL,
    CHECK (instr(family_id,char(0))=0),
    CHECK (instr(grant_id,char(0))=0),
    CHECK (instr(reason_code,char(0))=0),
    CHECK (coalesce(length(CAST(family_id AS BLOB)),0) + 8 <= 2048),
    CHECK (coalesce(length(CAST(grant_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX family_grant ON oauth_refresh_families(grant_id);
CREATE INDEX family_revoked ON oauth_refresh_families(revoked_at,family_id) WHERE revoked_at IS NOT NULL;
CREATE INDEX family_created ON oauth_refresh_families(created_at,family_id) WHERE revoked_at IS NULL;
CREATE TABLE oauth_refresh_tokens (
    token_id TEXT NOT NULL PRIMARY KEY CHECK (length(token_id)=12),
    token_hash BLOB NOT NULL CHECK (length(token_hash)=32),
    family_id TEXT NOT NULL REFERENCES oauth_refresh_families(family_id),
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER,
    rotated_to TEXT REFERENCES oauth_refresh_tokens(token_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    CHECK (instr(token_id,char(0))=0),
    CHECK (instr(family_id,char(0))=0),
    CHECK (instr(client_id,char(0))=0),
    CHECK (instr(rotated_to,char(0))=0),
    CHECK (coalesce(length(CAST(token_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(family_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(client_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(rotated_to AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX refresh_family ON oauth_refresh_tokens(family_id);
CREATE INDEX refresh_expiry ON oauth_refresh_tokens(expires_at);
CREATE INDEX refresh_client ON oauth_refresh_tokens(client_id);
CREATE INDEX refresh_rotated_to ON oauth_refresh_tokens(rotated_to);
CREATE TABLE oauth_access_tokens (
    token_id TEXT NOT NULL PRIMARY KEY CHECK (length(token_id)=12),
    token_hash BLOB NOT NULL CHECK (length(token_hash)=32),
    grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id),
    family_id TEXT REFERENCES oauth_refresh_families(family_id),
    refresh_id TEXT REFERENCES oauth_refresh_tokens(token_id) ON DELETE SET NULL, resource_uri TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read','write')), selected_spaces TEXT,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER,
    CHECK (instr(token_id,char(0))=0),
    CHECK (instr(grant_id,char(0))=0),
    CHECK (instr(family_id,char(0))=0),
    CHECK (instr(refresh_id,char(0))=0),
    CHECK (instr(resource_uri,char(0))=0),
    CHECK (instr(scope,char(0))=0),
    CHECK (instr(selected_spaces,char(0))=0),
    CHECK (coalesce(length(CAST(token_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(grant_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(family_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(refresh_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX access_grant ON oauth_access_tokens(grant_id);
CREATE INDEX access_family ON oauth_access_tokens(family_id);
CREATE INDEX access_refresh ON oauth_access_tokens(refresh_id);
CREATE INDEX access_expiry ON oauth_access_tokens(expires_at);
CREATE TABLE secret_keyring (
    key_id TEXT NOT NULL PRIMARY KEY CHECK (length(key_id)=27),
    key_hash TEXT NOT NULL CHECK (length(key_hash)=71 AND substr(key_hash,1,7)='sha256:' AND substr(key_hash,8) NOT GLOB '*[^0-9a-f]*'),
    generation INTEGER NOT NULL UNIQUE CHECK (generation > 0),
    state TEXT NOT NULL CHECK (state IN ('active','readable')),
    canary TEXT NOT NULL CHECK (length(canary)<=1024), created_at INTEGER NOT NULL, retired_at INTEGER,
    CHECK (instr(key_id,char(0))=0),
    CHECK (instr(key_hash,char(0))=0),
    CHECK (instr(state,char(0))=0),
    CHECK (instr(canary,char(0))=0),
    CHECK (coalesce(length(CAST(key_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(state AS BLOB)),0) <= 2048)
) STRICT;
CREATE UNIQUE INDEX active_key ON secret_keyring(state) WHERE state='active' AND retired_at IS NULL;
CREATE TABLE oidc_transactions (
    transaction_id TEXT NOT NULL PRIMARY KEY, state_hash BLOB NOT NULL UNIQUE CHECK (length(state_hash)=32),
    nonce_hash BLOB NOT NULL CHECK (length(nonce_hash)=32),
    flow_context_hash BLOB NOT NULL CHECK (length(flow_context_hash)=32),
    key_id TEXT NOT NULL REFERENCES secret_keyring(key_id), issuer TEXT NOT NULL,
    client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('login','link')),
    bound_user TEXT REFERENCES users(user_id), browser_binding_hash BLOB NOT NULL CHECK (length(browser_binding_hash)=32),
    expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL,
    CHECK ((purpose='login' AND bound_user IS NULL) OR (purpose='link' AND bound_user IS NOT NULL)),
    CHECK (instr(transaction_id,char(0))=0),
    CHECK (instr(key_id,char(0))=0),
    CHECK (instr(issuer,char(0))=0),
    CHECK (instr(client_id,char(0))=0),
    CHECK (instr(redirect_uri,char(0))=0),
    CHECK (instr(purpose,char(0))=0),
    CHECK (instr(bound_user,char(0))=0),
    CHECK (coalesce(length(CAST(transaction_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(state_hash AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX oidc_expiry ON oidc_transactions(expires_at);
CREATE TABLE credentials (
    id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), name TEXT NOT NULL,
    kind TEXT NOT NULL, secret TEXT NOT NULL CHECK (length(secret)<=65536), injection TEXT NOT NULL,
    disabled_at INTEGER, rpm INTEGER CHECK (rpm>0), tpm INTEGER CHECK (tpm>0),
    consent_epoch INTEGER NOT NULL CHECK (consent_epoch>=0), runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch>=0),
    revision INTEGER NOT NULL CHECK (revision>=0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(owner_id,name),
    CHECK (instr(id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(name,char(0))=0),
    CHECK (instr(kind,char(0))=0),
    CHECK (instr(secret,char(0))=0),
    CHECK (instr(injection,char(0))=0),
    CHECK (coalesce(length(CAST(id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(name AS BLOB)),0) <= 2048)
) STRICT;
CREATE TABLE provider_resources (
    id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), name TEXT NOT NULL,
    wire TEXT NOT NULL CHECK (length(CAST(wire AS BLOB)) BETWEEN 1 AND 64), base_url TEXT NOT NULL,
    headers TEXT NOT NULL CHECK (length(headers)<=65536), credential_id TEXT REFERENCES credentials(id) ON DELETE RESTRICT,
    consent_epoch INTEGER NOT NULL CHECK (consent_epoch>=0), runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch>=0),
    default_model TEXT, timeouts TEXT NOT NULL, rpm INTEGER CHECK (rpm>0), tpm INTEGER CHECK (tpm>0),
    disabled_at INTEGER, revision INTEGER NOT NULL CHECK (revision>=0), UNIQUE(owner_id,name),
    CHECK (instr(id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(name,char(0))=0),
    CHECK (instr(wire,char(0))=0),
    CHECK (instr(base_url,char(0))=0),
    CHECK (instr(headers,char(0))=0),
    CHECK (instr(credential_id,char(0))=0),
    CHECK (instr(default_model,char(0))=0),
    CHECK (instr(timeouts,char(0))=0),
    CHECK (coalesce(length(CAST(id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(name AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(credential_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX resource_credential ON provider_resources(credential_id);
CREATE TABLE provider_models (
    resource_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL, wire_model_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('completion','embedding')),
    tokenizer_profile TEXT NOT NULL, max_input INTEGER NOT NULL CHECK (max_input>0),
    max_output INTEGER NOT NULL CHECK (max_output>=0), dimension INTEGER CHECK (dimension>0),
    capabilities TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision>=0),
    PRIMARY KEY(resource_id,model_id), CHECK ((kind='embedding')=(dimension IS NOT NULL)),
    CHECK (instr(resource_id,char(0))=0),
    CHECK (instr(model_id,char(0))=0),
    CHECK (instr(wire_model_name,char(0))=0),
    CHECK (instr(kind,char(0))=0),
    CHECK (instr(tokenizer_profile,char(0))=0),
    CHECK (instr(capabilities,char(0))=0),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(model_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE TABLE provider_attachments (
    id TEXT NOT NULL PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES provider_resources(id),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('personal','space','project')),
    target_owner TEXT, target_space TEXT NOT NULL, target_project TEXT,
    resource_epoch INTEGER NOT NULL CHECK (resource_epoch>=0), credential_epoch INTEGER CHECK (credential_epoch>=0),
    state TEXT NOT NULL CHECK (state IN ('pending','approved','revoked')),
    disclosure TEXT NOT NULL, expires_at INTEGER, revision INTEGER NOT NULL CHECK (revision>=0),
    CHECK ((target_kind='personal')=(target_owner IS NOT NULL)),
    CHECK ((target_kind='project')=(target_project IS NOT NULL)),
    CHECK (instr(id,char(0))=0),
    CHECK (instr(resource_id,char(0))=0),
    CHECK (instr(target_kind,char(0))=0),
    CHECK (instr(target_owner,char(0))=0),
    CHECK (instr(target_space,char(0))=0),
    CHECK (instr(target_project,char(0))=0),
    CHECK (instr(state,char(0))=0),
    CHECK (instr(disclosure,char(0))=0),
    CHECK (coalesce(length(CAST(id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(target_owner AS BLOB)),0) + coalesce(length(CAST(target_space AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(target_space AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(target_project AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(state AS BLOB)),0) + coalesce(length(CAST(resource_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE UNIQUE INDEX attachment_personal ON provider_attachments(resource_id,target_owner,target_space) WHERE target_kind='personal';
CREATE UNIQUE INDEX attachment_space ON provider_attachments(resource_id,target_space) WHERE target_kind='space';
CREATE UNIQUE INDEX attachment_project ON provider_attachments(resource_id,target_space,target_project) WHERE target_kind='project';
CREATE INDEX attachment_target ON provider_attachments(target_space,state,resource_id);
CREATE INDEX attachment_resource ON provider_attachments(resource_id,id);
CREATE TABLE provider_preferences (
    owner_id TEXT NOT NULL REFERENCES users(user_id), scope_kind TEXT NOT NULL CHECK (scope_kind IN ('personal','space','project')),
    scope_id TEXT NOT NULL, model_kind TEXT NOT NULL DEFAULT 'completion' CHECK (model_kind IN ('completion','embedding')),
    resource_id TEXT NOT NULL, model_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision>=0), PRIMARY KEY(owner_id,scope_kind,scope_id,model_kind),
    FOREIGN KEY(resource_id,model_id) REFERENCES provider_models(resource_id,model_id),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(scope_kind,char(0))=0),
    CHECK (instr(scope_id,char(0))=0),
    CHECK (instr(model_kind,char(0))=0),
    CHECK (instr(resource_id,char(0))=0),
    CHECK (instr(model_id,char(0))=0),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(scope_kind AS BLOB)),0) + coalesce(length(CAST(scope_id AS BLOB)),0) + coalesce(length(CAST(model_kind AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(model_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX preference_scope ON provider_preferences(scope_kind,scope_id,model_kind,owner_id);
CREATE INDEX preference_model ON provider_preferences(resource_id,model_id);
CREATE TABLE provider_budget_buckets (
    budget_kind TEXT NOT NULL CHECK (budget_kind IN ('resource','credential','space')),
    budget_owner TEXT NOT NULL, window_start_ms INTEGER NOT NULL, window_end_ms INTEGER NOT NULL,
    rpm_used INTEGER NOT NULL CHECK (rpm_used>=0), tpm_reserved INTEGER NOT NULL CHECK (tpm_reserved>=0),
    tpm_exact INTEGER NOT NULL CHECK (tpm_exact>=0), PRIMARY KEY(budget_kind,budget_owner,window_start_ms),
    CHECK (window_end_ms>window_start_ms),
    CHECK (instr(budget_kind,char(0))=0),
    CHECK (instr(budget_owner,char(0))=0),
    CHECK (coalesce(length(CAST(budget_kind AS BLOB)),0) + coalesce(length(CAST(budget_owner AS BLOB)),0) + 8 <= 2048)
) STRICT;
CREATE INDEX budget_bucket_expiry ON provider_budget_buckets(window_end_ms);
CREATE TABLE provider_call_log (
    call_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, principal TEXT NOT NULL, run_id TEXT,
    scope_id TEXT NOT NULL, intent_key TEXT NOT NULL, request_hash BLOB NOT NULL CHECK (length(request_hash)=32),
    resource_id TEXT NOT NULL, credential_id TEXT, policy_epochs TEXT NOT NULL, participating_spaces TEXT NOT NULL,
    model_id TEXT, reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens>=0), bucket_keys TEXT NOT NULL,
    delivery_state TEXT NOT NULL CHECK (delivery_state IN ('intent','sending','settled')),
    outcome TEXT CHECK (outcome IN ('completed','not_sent','unknown','failed','cancelled')),
    usage_source TEXT NOT NULL CHECK (usage_source IN ('exact','unknown','estimate')),
    input_tokens INTEGER CHECK (input_tokens>=0), output_tokens INTEGER CHECK (output_tokens>=0),
    diagnostic TEXT, dispatch_owner TEXT, created_at INTEGER NOT NULL, settled_at INTEGER,
    UNIQUE(principal,scope_id,intent_key),
    CHECK (instr(call_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(principal,char(0))=0),
    CHECK (instr(run_id,char(0))=0),
    CHECK (instr(scope_id,char(0))=0),
    CHECK (instr(intent_key,char(0))=0),
    CHECK (instr(resource_id,char(0))=0),
    CHECK (instr(credential_id,char(0))=0),
    CHECK (instr(policy_epochs,char(0))=0),
    CHECK (instr(participating_spaces,char(0))=0),
    CHECK (instr(model_id,char(0))=0),
    CHECK (instr(bucket_keys,char(0))=0),
    CHECK (instr(delivery_state,char(0))=0),
    CHECK (instr(outcome,char(0))=0),
    CHECK (instr(usage_source,char(0))=0),
    CHECK (instr(diagnostic,char(0))=0),
    CHECK (instr(dispatch_owner,char(0))=0),
    CHECK (coalesce(length(CAST(call_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(principal AS BLOB)),0) + coalesce(length(CAST(scope_id AS BLOB)),0) + coalesce(length(CAST(intent_key AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + 8 + coalesce(length(CAST(call_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(delivery_state AS BLOB)),0) + 8 + coalesce(length(CAST(call_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX call_owner ON provider_call_log(owner_id,created_at,call_id);
CREATE INDEX call_pending ON provider_call_log(delivery_state,created_at,call_id);
CREATE INDEX call_settled ON provider_call_log(delivery_state,settled_at,call_id);
CREATE INDEX call_run ON provider_call_log(run_id,call_id);
CREATE TABLE ability_availability (
    placement TEXT NOT NULL, ability_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('all-projects','selected-projects')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), revision INTEGER NOT NULL CHECK (revision>=0),
    PRIMARY KEY(placement,ability_id),
    CHECK (instr(placement,char(0))=0),
    CHECK (instr(ability_id,char(0))=0),
    CHECK (instr(mode,char(0))=0),
    CHECK (coalesce(length(CAST(placement AS BLOB)),0) + coalesce(length(CAST(ability_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE TABLE ability_project_bindings (
    placement TEXT NOT NULL, ability_id TEXT NOT NULL, target_space TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY(placement,ability_id,target_space,project_id),
    FOREIGN KEY(placement,ability_id) REFERENCES ability_availability(placement,ability_id) ON DELETE CASCADE,
    CHECK (instr(placement,char(0))=0),
    CHECK (instr(ability_id,char(0))=0),
    CHECK (instr(target_space,char(0))=0),
    CHECK (instr(project_id,char(0))=0),
    CHECK (coalesce(length(CAST(placement AS BLOB)),0) + coalesce(length(CAST(ability_id AS BLOB)),0) + coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(project_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(project_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX ability_project ON ability_project_bindings(target_space,project_id);
CREATE TABLE ability_preferences (
    owner_id TEXT NOT NULL REFERENCES users(user_id), ability_id TEXT NOT NULL, placement TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), revision INTEGER NOT NULL CHECK (revision>=0),
    PRIMARY KEY(owner_id,ability_id,placement),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(ability_id,char(0))=0),
    CHECK (instr(placement,char(0))=0),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(ability_id AS BLOB)),0) + coalesce(length(CAST(placement AS BLOB)),0) <= 2048)
) STRICT;
CREATE TABLE ability_placement_trail (
    source_placement TEXT NOT NULL, ability_id TEXT NOT NULL, destination_placement TEXT NOT NULL,
    destination_id TEXT NOT NULL, manifest_ref TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(source_placement,ability_id),
    CHECK (source_placement<>destination_placement OR ability_id<>destination_id),
    CHECK (instr(source_placement,char(0))=0),
    CHECK (instr(ability_id,char(0))=0),
    CHECK (instr(destination_placement,char(0))=0),
    CHECK (instr(destination_id,char(0))=0),
    CHECK (instr(manifest_ref,char(0))=0),
    CHECK (coalesce(length(CAST(source_placement AS BLOB)),0) + coalesce(length(CAST(ability_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE TABLE favorites (
    owner_id TEXT NOT NULL REFERENCES users(user_id), space_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('note','folder')), entity_id TEXT NOT NULL,
    rank INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,space_id,entity_kind,entity_id),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(space_id,char(0))=0),
    CHECK (instr(entity_kind,char(0))=0),
    CHECK (instr(entity_id,char(0))=0),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) + coalesce(length(CAST(entity_kind AS BLOB)),0) + coalesce(length(CAST(entity_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) + 8 + coalesce(length(CAST(entity_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX favorite_order ON favorites(owner_id,rank,space_id,entity_kind,entity_id);
CREATE TABLE context_sets (
    set_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), home_space TEXT NOT NULL,
    name TEXT NOT NULL, note_refs TEXT NOT NULL CHECK (length(note_refs)<=65536),
    revision INTEGER NOT NULL CHECK (revision>=0), created_at INTEGER NOT NULL,
    CHECK (instr(set_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(home_space,char(0))=0),
    CHECK (instr(name,char(0))=0),
    CHECK (instr(note_refs,char(0))=0),
    CHECK (coalesce(length(CAST(set_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(home_space AS BLOB)),0) + coalesce(length(CAST(set_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX context_home ON context_sets(home_space,set_id);
CREATE TABLE context_set_attachments (
    set_id TEXT NOT NULL REFERENCES context_sets(set_id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('personal','space','project')), target_id TEXT NOT NULL,
    target_space TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(user_id), revision INTEGER NOT NULL CHECK (revision>=0),
    PRIMARY KEY(set_id,target_kind,target_id),
    CHECK (instr(set_id,char(0))=0),
    CHECK (instr(target_kind,char(0))=0),
    CHECK (instr(target_id,char(0))=0),
    CHECK (instr(target_space,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (target_kind<>'personal' OR target_id=owner_id),
    CHECK (coalesce(length(CAST(set_id AS BLOB)),0) + coalesce(length(CAST(target_kind AS BLOB)),0) + coalesce(length(CAST(target_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(target_kind AS BLOB)),0) + coalesce(length(CAST(target_id AS BLOB)),0) + coalesce(length(CAST(set_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX context_attachment_target ON context_set_attachments(target_kind,target_id,set_id);
CREATE TABLE context_scope_pins (
    owner_id TEXT NOT NULL REFERENCES users(user_id), target_kind TEXT NOT NULL CHECK (target_kind IN ('personal','space','project')),
    target_id TEXT NOT NULL, target_space TEXT NOT NULL, note_space TEXT NOT NULL, note_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision>=0), created_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,target_kind,target_id,note_space,note_id),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(target_kind,char(0))=0),
    CHECK (instr(target_id,char(0))=0),
    CHECK (instr(target_space,char(0))=0),
    CHECK (instr(note_space,char(0))=0),
    CHECK (instr(note_id,char(0))=0),
    CHECK (target_kind<>'personal' OR target_id=owner_id),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(target_kind AS BLOB)),0) + coalesce(length(CAST(target_id AS BLOB)),0) + coalesce(length(CAST(note_space AS BLOB)),0) + coalesce(length(CAST(note_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(note_space AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX context_pin_space ON context_scope_pins(target_space,note_space);
CREATE INDEX context_pin_target ON context_scope_pins(target_kind,target_id,note_space,note_id);
CREATE UNIQUE INDEX context_shared_pin ON context_scope_pins(target_kind,target_id,note_space,note_id) WHERE target_kind<>'personal';
CREATE TABLE context_order (
    owner_id TEXT NOT NULL REFERENCES users(user_id), target_kind TEXT NOT NULL CHECK (target_kind IN ('personal','space','project')),
    target_id TEXT NOT NULL, target_space TEXT NOT NULL, entry_kind TEXT NOT NULL CHECK (entry_kind IN ('set','note')),
    entry_ref TEXT NOT NULL, rank INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision>=0),
    PRIMARY KEY(owner_id,target_kind,target_id,entry_kind,entry_ref),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(target_kind,char(0))=0),
    CHECK (instr(target_id,char(0))=0),
    CHECK (instr(target_space,char(0))=0),
    CHECK (instr(entry_kind,char(0))=0),
    CHECK (instr(entry_ref,char(0))=0),
    CHECK (target_kind<>'personal' OR target_id=owner_id),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(target_kind AS BLOB)),0) + coalesce(length(CAST(target_id AS BLOB)),0) + coalesce(length(CAST(entry_kind AS BLOB)),0) + coalesce(length(CAST(entry_ref AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(target_kind AS BLOB)),0) + coalesce(length(CAST(target_id AS BLOB)),0) + 8 + coalesce(length(CAST(entry_ref AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX context_order_target ON context_order(target_kind,target_id,rank,entry_kind,entry_ref);
CREATE UNIQUE INDEX context_shared_order ON context_order(target_kind,target_id,entry_kind,entry_ref) WHERE target_kind<>'personal';
CREATE TABLE agent_episodes (
    episode_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), name TEXT,
    parent_id TEXT REFERENCES agent_episodes(episode_id) DEFERRABLE INITIALLY DEFERRED, active_role TEXT, project_space TEXT, project_folder TEXT,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','sleeping','closed')),
    revision INTEGER NOT NULL CHECK (revision>=0), created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    closed_at INTEGER, calls INTEGER NOT NULL DEFAULT 0 CHECK (calls>=0),
    CHECK ((project_space IS NULL)=(project_folder IS NULL)),
    CHECK (instr(episode_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(name,char(0))=0),
    CHECK (instr(parent_id,char(0))=0),
    CHECK (instr(active_role,char(0))=0),
    CHECK (instr(project_space,char(0))=0),
    CHECK (instr(project_folder,char(0))=0),
    CHECK (instr(lifecycle,char(0))=0),
    CHECK (coalesce(length(CAST(episode_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(name AS BLOB)),0) + coalesce(length(CAST(lifecycle AS BLOB)),0) + 8 + coalesce(length(CAST(episode_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX episode_owner_name ON agent_episodes(owner_id,name,lifecycle,last_seen_at,episode_id);
CREATE TABLE mcp_delta_owner_cursors (
    owner_id TEXT NOT NULL REFERENCES users(user_id), space_id TEXT NOT NULL,
    history_incarnation BLOB NOT NULL CHECK (length(history_incarnation)=16),
    acked_space_seq INTEGER NOT NULL CHECK (acked_space_seq>=0), updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,space_id),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(space_id,char(0))=0),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(space_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX owner_cursor_space ON mcp_delta_owner_cursors(space_id);
CREATE TABLE mcp_delta_session_cursors (
    episode_id TEXT NOT NULL REFERENCES agent_episodes(episode_id) ON DELETE CASCADE, space_id TEXT NOT NULL,
    history_incarnation BLOB NOT NULL CHECK (length(history_incarnation)=16),
    acked_space_seq INTEGER NOT NULL CHECK (acked_space_seq>=0), updated_at INTEGER NOT NULL,
    PRIMARY KEY(episode_id,space_id),
    CHECK (instr(episode_id,char(0))=0),
    CHECK (instr(space_id,char(0))=0),
    CHECK (coalesce(length(CAST(episode_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(space_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX episode_cursor_space ON mcp_delta_session_cursors(space_id);
CREATE TABLE agent_telemetry_config (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton=1), detailed_enabled INTEGER NOT NULL DEFAULT 0 CHECK (detailed_enabled IN (0,1)),
    compact_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (compact_retention_days>0),
    detailed_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (detailed_retention_days>0 AND detailed_retention_days<=compact_retention_days),
    version INTEGER NOT NULL CHECK (version>=0), updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE agent_calls (
    call_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), principal TEXT NOT NULL, agent TEXT,
    transport TEXT NOT NULL, request_id TEXT NOT NULL, episode_id TEXT REFERENCES agent_episodes(episode_id),
    tool TEXT NOT NULL, effect TEXT NOT NULL, domain TEXT NOT NULL, started_at INTEGER NOT NULL,
    finished_at INTEGER, duration_ms INTEGER CHECK (duration_ms>=0), outcome TEXT, reason TEXT,
    input_bytes INTEGER NOT NULL CHECK (input_bytes>=0), output_bytes INTEGER CHECK (output_bytes>=0),
    summaries TEXT NOT NULL CHECK (length(summaries)<=4096), fingerprint BLOB NOT NULL CHECK (length(fingerprint)=32),
    projection_version INTEGER NOT NULL CHECK (projection_version>=0), redacted INTEGER NOT NULL CHECK (redacted IN (0,1)),
    truncated INTEGER NOT NULL CHECK (truncated IN (0,1)), detail_capture_failed INTEGER NOT NULL CHECK (detail_capture_failed IN (0,1)),
    CHECK (instr(call_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(principal,char(0))=0),
    CHECK (instr(agent,char(0))=0),
    CHECK (instr(transport,char(0))=0),
    CHECK (instr(request_id,char(0))=0),
    CHECK (instr(episode_id,char(0))=0),
    CHECK (instr(tool,char(0))=0),
    CHECK (instr(effect,char(0))=0),
    CHECK (instr(domain,char(0))=0),
    CHECK (instr(outcome,char(0))=0),
    CHECK (instr(reason,char(0))=0),
    CHECK (instr(summaries,char(0))=0),
    CHECK (coalesce(length(CAST(call_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + 8 + coalesce(length(CAST(call_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(episode_id AS BLOB)),0) + 8 + coalesce(length(CAST(call_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX agent_call_owner ON agent_calls(owner_id,started_at,call_id);
CREATE INDEX agent_call_episode ON agent_calls(owner_id,episode_id,started_at,call_id);
CREATE INDEX agent_call_retention ON agent_calls(finished_at,call_id);
CREATE INDEX agent_call_pending ON agent_calls(finished_at,started_at);
CREATE TABLE agent_call_details (
    call_id TEXT NOT NULL PRIMARY KEY REFERENCES agent_calls(call_id) ON DELETE CASCADE,
    payload TEXT NOT NULL CHECK (length(payload)<=65536), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    CHECK (instr(call_id,char(0))=0),
    CHECK (instr(payload,char(0))=0),
    CHECK (coalesce(length(CAST(call_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX detail_expiry ON agent_call_details(expires_at);
CREATE INDEX detail_created ON agent_call_details(created_at,call_id);
CREATE TABLE agent_retrievals (
    retrieval_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), principal TEXT NOT NULL, agent TEXT,
    call_id TEXT REFERENCES agent_calls(call_id), tool TEXT NOT NULL, query_summary TEXT NOT NULL CHECK (length(query_summary)<=4096),
    filters TEXT NOT NULL CHECK (length(filters)<=4096), hit_refs TEXT NOT NULL CHECK (length(hit_refs)<=65536),
    result_count INTEGER NOT NULL CHECK (result_count>=0), top_score REAL CHECK (top_score BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308), created_at INTEGER NOT NULL,
    CHECK (instr(retrieval_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(principal,char(0))=0),
    CHECK (instr(agent,char(0))=0),
    CHECK (instr(call_id,char(0))=0),
    CHECK (instr(tool,char(0))=0),
    CHECK (instr(query_summary,char(0))=0),
    CHECK (instr(filters,char(0))=0),
    CHECK (instr(hit_refs,char(0))=0),
    CHECK (coalesce(length(CAST(retrieval_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + 8 + coalesce(length(CAST(retrieval_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(call_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX retrieval_retention ON agent_retrievals(created_at,retrieval_id);
CREATE INDEX retrieval_owner ON agent_retrievals(owner_id,created_at,retrieval_id);
CREATE INDEX retrieval_call ON agent_retrievals(call_id);
CREATE TABLE mcp_dedup (
    owner TEXT NOT NULL REFERENCES users(user_id), actor TEXT NOT NULL, request_key TEXT NOT NULL,
    request_hash BLOB NOT NULL CHECK (length(request_hash)=32), operation TEXT NOT NULL,
    safe_result TEXT NOT NULL CHECK (length(safe_result)<=65536), effect TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(owner,actor,request_key),
    CHECK (instr(owner,char(0))=0),
    CHECK (instr(actor,char(0))=0),
    CHECK (instr(request_key,char(0))=0),
    CHECK (instr(operation,char(0))=0),
    CHECK (instr(safe_result,char(0))=0),
    CHECK (instr(effect,char(0))=0),
    CHECK (coalesce(length(CAST(owner AS BLOB)),0) + coalesce(length(CAST(actor AS BLOB)),0) + coalesce(length(CAST(request_key AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX dedup_expiry ON mcp_dedup(expires_at);
CREATE TABLE agent_schedules (
    schedule_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), space_id TEXT NOT NULL,
    project_folder_id TEXT, title TEXT NOT NULL, init_prompt TEXT NOT NULL, cron_expr TEXT NOT NULL, timezone TEXT NOT NULL, approved_role TEXT NOT NULL,
    paused_reason TEXT CHECK (paused_reason IN ('owner_revoked','role_changed','space_unavailable','budget_exceeded','manual')),
    write_class_mask INTEGER NOT NULL CHECK (write_class_mask=1), budgets TEXT NOT NULL,
    misfire_policy TEXT NOT NULL CHECK (misfire_policy='coalesce_latest'), next_slot_utc_ms INTEGER NOT NULL,
    deleted_at INTEGER, config_revision INTEGER NOT NULL CHECK (config_revision>=0), revision INTEGER NOT NULL CHECK (revision>=0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK (instr(schedule_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(space_id,char(0))=0),
    CHECK (instr(project_folder_id,char(0))=0),
    CHECK (instr(title,char(0))=0 AND length(CAST(title AS BLOB)) BETWEEN 1 AND 512),
    CHECK (instr(init_prompt,char(0))=0 AND ((deleted_at IS NULL AND length(CAST(init_prompt AS BLOB)) BETWEEN 1 AND 32768) OR (deleted_at IS NOT NULL AND length(CAST(init_prompt AS BLOB)) <= 32768))),
    CHECK (instr(cron_expr,char(0))=0),
    CHECK (instr(timezone,char(0))=0),
    CHECK (instr(approved_role,char(0))=0),
    CHECK (instr(paused_reason,char(0))=0),
    CHECK (instr(budgets,char(0))=0),
    CHECK (instr(misfire_policy,char(0))=0),
    CHECK (coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048),
    CHECK (8 + coalesce(length(CAST(paused_reason AS BLOB)),0) + 8 + coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) + coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX schedule_due ON agent_schedules(deleted_at,paused_reason,next_slot_utc_ms,schedule_id);
CREATE INDEX schedule_deleted ON agent_schedules(deleted_at,updated_at,schedule_id);
CREATE INDEX schedule_owner ON agent_schedules(owner_id,space_id,schedule_id);
CREATE TABLE agent_schedule_runs (
    run_id TEXT NOT NULL PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES agent_schedules(schedule_id) ON DELETE RESTRICT,
    slot_utc_ms INTEGER NOT NULL, lease_epoch INTEGER NOT NULL CHECK (lease_epoch>0),
    claim_request_hash BLOB NOT NULL CHECK (length(claim_request_hash)=32),
    claimed_schedule_revision INTEGER NOT NULL CHECK (claimed_schedule_revision>=0), reserved_next_slot INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('claimed','running','succeeded','failed','unknown')),
    started_at INTEGER NOT NULL, finished_at INTEGER, safe_result TEXT CHECK (length(safe_result)<=4096),
    owner_auth_version INTEGER NOT NULL CHECK (owner_auth_version>=0), config_revision INTEGER NOT NULL CHECK (config_revision>=0),
    admission_epoch INTEGER NOT NULL CHECK (admission_epoch>=0), history_scope TEXT NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at>started_at),
    UNIQUE(schedule_id,slot_utc_ms), CHECK (reserved_next_slot>slot_utc_ms),
    CHECK (instr(run_id,char(0))=0),
    CHECK (instr(schedule_id,char(0))=0),
    CHECK (instr(history_scope,char(0))=0 AND length(CAST(history_scope AS BLOB))<=2048),
    CHECK (instr(status,char(0))=0),
    CHECK (instr(safe_result,char(0))=0),
    CHECK (coalesce(length(CAST(run_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(schedule_id AS BLOB)),0) + 8 <= 2048),
    CHECK (coalesce(length(CAST(schedule_id AS BLOB)),0) + coalesce(length(CAST(status AS BLOB)),0) + 8 + coalesce(length(CAST(run_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX schedule_run_status ON agent_schedule_runs(schedule_id,status,slot_utc_ms,run_id);
CREATE INDEX schedule_run_retention ON agent_schedule_runs(status,finished_at,run_id);
CREATE TABLE control_commands (
    owner TEXT NOT NULL REFERENCES users(user_id), actor TEXT NOT NULL, command_key TEXT NOT NULL,
    request_hash BLOB NOT NULL CHECK (length(request_hash)=32), target TEXT NOT NULL,
    expected INTEGER NOT NULL CHECK (expected>=0), result_revision INTEGER CHECK (result_revision>=0),
    state TEXT NOT NULL CHECK (state IN ('pending','committed')), safe_result TEXT CHECK (length(safe_result)<=65536),
    expires_at INTEGER NOT NULL, PRIMARY KEY(owner,actor,command_key),
    CHECK (instr(owner,char(0))=0),
    CHECK (instr(actor,char(0))=0),
    CHECK (instr(command_key,char(0))=0),
    CHECK (instr(target,char(0))=0),
    CHECK (instr(state,char(0))=0),
    CHECK (instr(safe_result,char(0))=0),
    CHECK (coalesce(length(CAST(owner AS BLOB)),0) + coalesce(length(CAST(actor AS BLOB)),0) + coalesce(length(CAST(command_key AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(state AS BLOB)),0) + 8 <= 2048)
) STRICT;
CREATE INDEX command_pending ON control_commands(state,expires_at);
CREATE TABLE control_operations (
    operation_id TEXT NOT NULL PRIMARY KEY, command_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('create-space','lifecycle')), target_space TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','canonical','committed')),
    payload_hash BLOB NOT NULL CHECK (length(payload_hash)=32), payload TEXT NOT NULL CHECK (length(payload)<=65536),
    canonical_receipt TEXT CHECK (length(canonical_receipt)<=65536), next_action TEXT NOT NULL, updated_at INTEGER NOT NULL,
    CHECK (instr(operation_id,char(0))=0),
    CHECK (instr(command_key,char(0))=0),
    CHECK (instr(kind,char(0))=0),
    CHECK (instr(target_space,char(0))=0),
    CHECK (instr(state,char(0))=0),
    CHECK (instr(payload,char(0))=0),
    CHECK (instr(canonical_receipt,char(0))=0),
    CHECK (instr(next_action,char(0))=0),
    CHECK (coalesce(length(CAST(operation_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(command_key AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(state AS BLOB)),0) + 8 <= 2048)
) STRICT;
CREATE INDEX operation_state_time ON control_operations(state,updated_at);
CREATE TABLE revocation_events (
    event_id TEXT NOT NULL PRIMARY KEY, selector TEXT NOT NULL CHECK (length(selector)<=4096), reason TEXT NOT NULL,
    authority_version INTEGER NOT NULL CHECK (authority_version>=0), committed_at INTEGER NOT NULL,
    delivered_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
    CHECK (instr(event_id,char(0))=0),
    CHECK (instr(selector,char(0))=0),
    CHECK (instr(reason,char(0))=0),
    CHECK (coalesce(length(CAST(event_id AS BLOB)),0) <= 2048),
    CHECK (8 + 8 + coalesce(length(CAST(event_id AS BLOB)),0) <= 2048)
) STRICT;
CREATE INDEX revocation_pending ON revocation_events(delivered_at,committed_at,event_id);
