CREATE SCHEMA IF NOT EXISTS v1_control;
CREATE TABLE v1_control.v1_storage_epoch (
    singleton BIGINT NOT NULL PRIMARY KEY CHECK (singleton = 1),
    epoch_version BIGINT NOT NULL CHECK (epoch_version > 0),
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('migrating', 'ready')),
    installation_id TEXT COLLATE "C" NOT NULL,
    receipt_sha256 BYTEA CHECK (length(receipt_sha256) = 32),
    receipt_json TEXT COLLATE "C" CHECK (octet_length(receipt_json) <= 1048576)
);
CREATE TABLE v1_control.users (
    user_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, username TEXT COLLATE "C" NOT NULL UNIQUE,
    email TEXT COLLATE "C" UNIQUE, display_name TEXT COLLATE "C" NOT NULL,
    password_hash TEXT COLLATE "C" CHECK (length(password_hash) <= 1024),
    is_admin BIGINT NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
    disabled_at BIGINT, personal_space_id TEXT COLLATE "C" UNIQUE,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    metadata_revision BIGINT NOT NULL DEFAULT 0 CHECK (metadata_revision >= 0),
    auth_version BIGINT NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
    created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(user_id),0) <= 2048),
    CHECK (coalesce(octet_length(username),0) <= 2048),
    CHECK (coalesce(octet_length(email),0) <= 2048),
    CHECK (coalesce(octet_length(personal_space_id),0) <= 2048)
);
CREATE TABLE v1_control.user_oidc_identities (
    issuer TEXT COLLATE "C" NOT NULL, subject TEXT COLLATE "C" NOT NULL,
    user_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), created_at BIGINT NOT NULL,
    PRIMARY KEY (issuer, subject),
    CHECK (coalesce(octet_length(issuer),0) + coalesce(octet_length(subject),0) <= 2048),
    CHECK (coalesce(octet_length(user_id),0) <= 2048)
);
CREATE INDEX oidc_user ON v1_control.user_oidc_identities(user_id);
CREATE TABLE v1_control.space_admission (
    space_id TEXT COLLATE "C" NOT NULL PRIMARY KEY,
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending','active','closing','archived')),
    admission_epoch BIGINT NOT NULL DEFAULT 0 CHECK (admission_epoch >= 0),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    CHECK (coalesce(octet_length(space_id),0) <= 2048)
);
CREATE TABLE v1_control.space_members (
    space_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.space_admission(space_id),
    user_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id),
    role TEXT COLLATE "C" NOT NULL CHECK (role IN ('owner','editor','viewer')),
    admission TEXT COLLATE "C" NOT NULL CHECK (admission IN ('pending','active')),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0), created_at BIGINT NOT NULL,
    PRIMARY KEY (space_id,user_id),
    CHECK (coalesce(octet_length(space_id),0) + coalesce(octet_length(user_id),0) <= 2048),
    CHECK (coalesce(octet_length(user_id),0) + coalesce(octet_length(space_id),0) <= 2048)
);
CREATE INDEX member_user ON v1_control.space_members(user_id,space_id);
CREATE TABLE v1_control.sessions (
    session_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, token_hash BYTEA NOT NULL UNIQUE CHECK (length(token_hash)=32),
    user_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL, last_used_at BIGINT NOT NULL, revoked_at BIGINT,
    auth_version BIGINT NOT NULL CHECK (auth_version >= 0),
    CHECK (coalesce(octet_length(session_id),0) + 8 <= 2048),
    CHECK (coalesce(octet_length(token_hash),0) <= 2048),
    CHECK (coalesce(octet_length(user_id),0) + 8 <= 2048)
);
CREATE INDEX session_by_user ON v1_control.sessions(user_id,revoked_at);
CREATE INDEX session_expiry ON v1_control.sessions(expires_at);
CREATE INDEX session_revoked ON v1_control.sessions(revoked_at,session_id) WHERE revoked_at IS NOT NULL;
CREATE TABLE v1_control.one_time_tokens (
    token_hash BYTEA NOT NULL PRIMARY KEY CHECK (length(token_hash)=32),
    user_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id),
    purpose TEXT COLLATE "C" NOT NULL CHECK (purpose IN ('invite','reset')),
    expires_at BIGINT NOT NULL, used_at BIGINT, created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(token_hash),0) <= 2048),
    CHECK (coalesce(octet_length(user_id),0) + coalesce(octet_length(purpose),0) + 8 <= 2048)
);
CREATE INDEX one_time_user ON v1_control.one_time_tokens(user_id,purpose,expires_at);
CREATE INDEX one_time_expiry ON v1_control.one_time_tokens(expires_at);
CREATE TABLE v1_control.pats (
    token_id TEXT COLLATE "C" NOT NULL PRIMARY KEY CHECK (length(token_id)=12),
    secret_hash BYTEA NOT NULL CHECK (length(secret_hash)=32),
    user_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), name TEXT COLLATE "C" NOT NULL,
    scope TEXT COLLATE "C" NOT NULL CHECK (scope IN ('read','write')), selected_spaces TEXT COLLATE "C",
    expires_at BIGINT, last_used_at BIGINT, revoked_at BIGINT, created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(token_id),0) <= 2048),
    CHECK (coalesce(octet_length(user_id),0) + coalesce(octet_length(token_id),0) <= 2048)
);
CREATE INDEX pat_user ON v1_control.pats(user_id,token_id);
CREATE TABLE v1_control.oauth_clients (
    client_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('dcr','cimd')),
    redirect_uris TEXT COLLATE "C" NOT NULL CHECK (length(redirect_uris)<=8192), client_name TEXT COLLATE "C" NOT NULL,
    metadata_uri TEXT COLLATE "C", metadata_digest BYTEA CHECK (length(metadata_digest)=32),
    cache_expires_at BIGINT, activated_at BIGINT, created_at BIGINT NOT NULL, last_seen_at BIGINT,
    CHECK (coalesce(octet_length(client_id),0) <= 2048),
    CHECK (coalesce(octet_length(kind),0) + 16 <= 2048)
);
CREATE INDEX client_pending ON v1_control.oauth_clients(kind,activated_at,created_at);
CREATE INDEX client_kind_cache ON v1_control.oauth_clients(kind,cache_expires_at,created_at);
CREATE TABLE v1_control.oauth_grants (
    grant_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, user_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id),
    client_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.oauth_clients(client_id), resource_uri TEXT COLLATE "C" NOT NULL,
    scope TEXT COLLATE "C" NOT NULL CHECK (scope IN ('read','write')), selected_spaces TEXT COLLATE "C",
    revoked_at BIGINT, revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0), created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(grant_id),0) <= 2048),
    CHECK (coalesce(octet_length(user_id),0) + coalesce(octet_length(client_id),0) <= 2048),
    CHECK (coalesce(octet_length(client_id),0) <= 2048)
);
CREATE INDEX grant_user ON v1_control.oauth_grants(user_id,client_id);
CREATE INDEX grant_client ON v1_control.oauth_grants(client_id);
CREATE TABLE v1_control.oauth_auth_codes (
    code_hash BYTEA NOT NULL PRIMARY KEY CHECK (length(code_hash)=32),
    grant_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.oauth_grants(grant_id),
    client_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.oauth_clients(client_id),
    redirect_uri TEXT COLLATE "C" NOT NULL, resource_uri TEXT COLLATE "C" NOT NULL,
    code_challenge TEXT COLLATE "C" NOT NULL CHECK (length(code_challenge)=43),
    method TEXT COLLATE "C" NOT NULL CHECK (method='S256'),
    offline_access BIGINT NOT NULL CHECK (offline_access IN (0,1)),
    expires_at BIGINT NOT NULL, used_at BIGINT, created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(code_hash),0) <= 2048),
    CHECK (coalesce(octet_length(client_id),0) <= 2048)
);
CREATE INDEX code_expiry ON v1_control.oauth_auth_codes(expires_at);
CREATE INDEX code_client ON v1_control.oauth_auth_codes(client_id);
CREATE TABLE v1_control.oauth_refresh_families (
    family_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, grant_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.oauth_grants(grant_id),
    revoked_at BIGINT, reason_code TEXT COLLATE "C", created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(family_id),0) + 8 <= 2048),
    CHECK (coalesce(octet_length(grant_id),0) <= 2048)
);
CREATE INDEX family_grant ON v1_control.oauth_refresh_families(grant_id);
CREATE INDEX family_revoked ON v1_control.oauth_refresh_families(revoked_at,family_id) WHERE revoked_at IS NOT NULL;
CREATE INDEX family_created ON v1_control.oauth_refresh_families(created_at,family_id) WHERE revoked_at IS NULL;
CREATE TABLE v1_control.oauth_refresh_tokens (
    token_id TEXT COLLATE "C" NOT NULL PRIMARY KEY CHECK (length(token_id)=12),
    token_hash BYTEA NOT NULL CHECK (length(token_hash)=32),
    family_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.oauth_refresh_families(family_id),
    client_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.oauth_clients(client_id),
    issued_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT, revoked_at BIGINT,
    rotated_to TEXT COLLATE "C" REFERENCES v1_control.oauth_refresh_tokens(token_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    CHECK (coalesce(octet_length(token_id),0) <= 2048),
    CHECK (coalesce(octet_length(family_id),0) <= 2048),
    CHECK (coalesce(octet_length(client_id),0) <= 2048),
    CHECK (coalesce(octet_length(rotated_to),0) <= 2048)
);
CREATE INDEX refresh_family ON v1_control.oauth_refresh_tokens(family_id);
CREATE INDEX refresh_expiry ON v1_control.oauth_refresh_tokens(expires_at);
CREATE INDEX refresh_client ON v1_control.oauth_refresh_tokens(client_id);
CREATE INDEX refresh_rotated_to ON v1_control.oauth_refresh_tokens(rotated_to);
CREATE TABLE v1_control.oauth_access_tokens (
    token_id TEXT COLLATE "C" NOT NULL PRIMARY KEY CHECK (length(token_id)=12),
    token_hash BYTEA NOT NULL CHECK (length(token_hash)=32),
    grant_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.oauth_grants(grant_id),
    family_id TEXT COLLATE "C" REFERENCES v1_control.oauth_refresh_families(family_id),
    refresh_id TEXT COLLATE "C" REFERENCES v1_control.oauth_refresh_tokens(token_id) ON DELETE SET NULL, resource_uri TEXT COLLATE "C" NOT NULL,
    scope TEXT COLLATE "C" NOT NULL CHECK (scope IN ('read','write')), selected_spaces TEXT COLLATE "C",
    issued_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, revoked_at BIGINT, last_used_at BIGINT,
    CHECK (coalesce(octet_length(token_id),0) <= 2048),
    CHECK (coalesce(octet_length(grant_id),0) <= 2048),
    CHECK (coalesce(octet_length(family_id),0) <= 2048),
    CHECK (coalesce(octet_length(refresh_id),0) <= 2048)
);
CREATE INDEX access_grant ON v1_control.oauth_access_tokens(grant_id);
CREATE INDEX access_family ON v1_control.oauth_access_tokens(family_id);
CREATE INDEX access_refresh ON v1_control.oauth_access_tokens(refresh_id);
CREATE INDEX access_expiry ON v1_control.oauth_access_tokens(expires_at);
CREATE TABLE v1_control.secret_keyring (
    key_id TEXT COLLATE "C" NOT NULL PRIMARY KEY CHECK (length(key_id)=27),
    key_hash TEXT COLLATE "C" NOT NULL CHECK (length(key_hash)=71 AND key_hash ~ '^sha256:[0-9a-f]{64}$'),
    generation BIGINT NOT NULL UNIQUE CHECK (generation > 0),
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('active','readable')),
    canary TEXT COLLATE "C" NOT NULL CHECK (length(canary)<=1024), created_at BIGINT NOT NULL, retired_at BIGINT,
    CHECK (coalesce(octet_length(key_id),0) <= 2048),
    CHECK (coalesce(octet_length(state),0) <= 2048)
);
CREATE UNIQUE INDEX active_key ON v1_control.secret_keyring(state) WHERE state='active' AND retired_at IS NULL;
CREATE TABLE v1_control.oidc_transactions (
    transaction_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, state_hash BYTEA NOT NULL UNIQUE CHECK (length(state_hash)=32),
    nonce_hash BYTEA NOT NULL CHECK (length(nonce_hash)=32),
    flow_context_hash BYTEA NOT NULL CHECK (length(flow_context_hash)=32),
    key_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.secret_keyring(key_id), issuer TEXT COLLATE "C" NOT NULL,
    client_id TEXT COLLATE "C" NOT NULL, redirect_uri TEXT COLLATE "C" NOT NULL,
    purpose TEXT COLLATE "C" NOT NULL CHECK (purpose IN ('login','link')),
    bound_user TEXT COLLATE "C" REFERENCES v1_control.users(user_id), browser_binding_hash BYTEA NOT NULL CHECK (length(browser_binding_hash)=32),
    expires_at BIGINT NOT NULL, consumed_at BIGINT, created_at BIGINT NOT NULL,
    CHECK ((purpose='login' AND bound_user IS NULL) OR (purpose='link' AND bound_user IS NOT NULL)),
    CHECK (coalesce(octet_length(transaction_id),0) <= 2048),
    CHECK (coalesce(octet_length(state_hash),0) <= 2048)
);
CREATE INDEX oidc_expiry ON v1_control.oidc_transactions(expires_at);
CREATE TABLE v1_control.credentials (
    id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), name TEXT COLLATE "C" NOT NULL,
    kind TEXT COLLATE "C" NOT NULL, secret TEXT COLLATE "C" NOT NULL CHECK (length(secret)<=65536), injection TEXT COLLATE "C" NOT NULL,
    disabled_at BIGINT, rpm BIGINT CHECK (rpm>0), tpm BIGINT CHECK (tpm>0),
    consent_epoch BIGINT NOT NULL CHECK (consent_epoch>=0), runtime_epoch BIGINT NOT NULL CHECK (runtime_epoch>=0),
    revision BIGINT NOT NULL CHECK (revision>=0), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE(owner_id,name),
    CHECK (coalesce(octet_length(id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(name),0) <= 2048)
);
CREATE TABLE v1_control.provider_resources (
    id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), name TEXT COLLATE "C" NOT NULL,
    wire TEXT COLLATE "C" NOT NULL CHECK (octet_length(wire) BETWEEN 1 AND 64), base_url TEXT COLLATE "C" NOT NULL,
    headers TEXT COLLATE "C" NOT NULL CHECK (length(headers)<=65536), credential_id TEXT COLLATE "C" REFERENCES v1_control.credentials(id) ON DELETE RESTRICT,
    consent_epoch BIGINT NOT NULL CHECK (consent_epoch>=0), runtime_epoch BIGINT NOT NULL CHECK (runtime_epoch>=0),
    default_model TEXT COLLATE "C", timeouts TEXT COLLATE "C" NOT NULL, rpm BIGINT CHECK (rpm>0), tpm BIGINT CHECK (tpm>0),
    disabled_at BIGINT, revision BIGINT NOT NULL CHECK (revision>=0), UNIQUE(owner_id,name),
    CHECK (coalesce(octet_length(id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(name),0) <= 2048),
    CHECK (coalesce(octet_length(credential_id),0) <= 2048)
);
CREATE INDEX resource_credential ON v1_control.provider_resources(credential_id);
CREATE TABLE v1_control.provider_models (
    resource_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.provider_resources(id) ON DELETE CASCADE,
    model_id TEXT COLLATE "C" NOT NULL, wire_model_name TEXT COLLATE "C" NOT NULL,
    kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('completion','embedding')),
    tokenizer_profile TEXT COLLATE "C" NOT NULL, max_input BIGINT NOT NULL CHECK (max_input>0),
    max_output BIGINT NOT NULL CHECK (max_output>=0), dimension BIGINT CHECK (dimension>0),
    capabilities TEXT COLLATE "C" NOT NULL, revision BIGINT NOT NULL CHECK (revision>=0),
    PRIMARY KEY(resource_id,model_id), CHECK ((kind='embedding')=(dimension IS NOT NULL)),
    CHECK (coalesce(octet_length(resource_id),0) + coalesce(octet_length(model_id),0) <= 2048)
);
CREATE TABLE v1_control.provider_attachments (
    id TEXT COLLATE "C" NOT NULL PRIMARY KEY, resource_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.provider_resources(id),
    target_kind TEXT COLLATE "C" NOT NULL CHECK (target_kind IN ('personal','space','project')),
    target_owner TEXT COLLATE "C", target_space TEXT COLLATE "C" NOT NULL, target_project TEXT COLLATE "C",
    resource_epoch BIGINT NOT NULL CHECK (resource_epoch>=0), credential_epoch BIGINT CHECK (credential_epoch>=0),
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending','approved','revoked')),
    disclosure TEXT COLLATE "C" NOT NULL, expires_at BIGINT, revision BIGINT NOT NULL CHECK (revision>=0),
    CHECK ((target_kind='personal')=(target_owner IS NOT NULL)),
    CHECK ((target_kind='project')=(target_project IS NOT NULL)),
    CHECK (coalesce(octet_length(id),0) <= 2048),
    CHECK (coalesce(octet_length(resource_id),0) + coalesce(octet_length(id),0) <= 2048),
    CHECK (coalesce(octet_length(resource_id),0) + coalesce(octet_length(target_owner),0) + coalesce(octet_length(target_space),0) <= 2048),
    CHECK (coalesce(octet_length(resource_id),0) + coalesce(octet_length(target_space),0) <= 2048),
    CHECK (coalesce(octet_length(resource_id),0) + coalesce(octet_length(target_space),0) + coalesce(octet_length(target_project),0) <= 2048),
    CHECK (coalesce(octet_length(target_space),0) + coalesce(octet_length(state),0) + coalesce(octet_length(resource_id),0) <= 2048)
);
CREATE UNIQUE INDEX attachment_personal ON v1_control.provider_attachments(resource_id,target_owner,target_space) WHERE target_kind='personal';
CREATE UNIQUE INDEX attachment_space ON v1_control.provider_attachments(resource_id,target_space) WHERE target_kind='space';
CREATE UNIQUE INDEX attachment_project ON v1_control.provider_attachments(resource_id,target_space,target_project) WHERE target_kind='project';
CREATE INDEX attachment_target ON v1_control.provider_attachments(target_space,state,resource_id);
CREATE INDEX attachment_resource ON v1_control.provider_attachments(resource_id,id);
CREATE TABLE v1_control.provider_preferences (
    owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), scope_kind TEXT COLLATE "C" NOT NULL CHECK (scope_kind IN ('personal','space','project')),
    scope_id TEXT COLLATE "C" NOT NULL, model_kind TEXT COLLATE "C" NOT NULL DEFAULT 'completion' CHECK (model_kind IN ('completion','embedding')),
    resource_id TEXT COLLATE "C" NOT NULL, model_id TEXT COLLATE "C" NOT NULL,
    revision BIGINT NOT NULL CHECK (revision>=0), PRIMARY KEY(owner_id,scope_kind,scope_id,model_kind),
    FOREIGN KEY(resource_id,model_id) REFERENCES v1_control.provider_models(resource_id,model_id),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(scope_kind),0) + coalesce(octet_length(scope_id),0) + coalesce(octet_length(model_kind),0) <= 2048),
    CHECK (coalesce(octet_length(resource_id),0) + coalesce(octet_length(model_id),0) <= 2048)
);
CREATE INDEX preference_scope ON v1_control.provider_preferences(scope_kind,scope_id,model_kind,owner_id);
CREATE INDEX preference_model ON v1_control.provider_preferences(resource_id,model_id);
CREATE TABLE v1_control.provider_budget_buckets (
    budget_kind TEXT COLLATE "C" NOT NULL CHECK (budget_kind IN ('resource','credential','space')),
    budget_owner TEXT COLLATE "C" NOT NULL, window_start_ms BIGINT NOT NULL, window_end_ms BIGINT NOT NULL,
    rpm_used BIGINT NOT NULL CHECK (rpm_used>=0), tpm_reserved BIGINT NOT NULL CHECK (tpm_reserved>=0),
    tpm_exact BIGINT NOT NULL CHECK (tpm_exact>=0), PRIMARY KEY(budget_kind,budget_owner,window_start_ms),
    CHECK (window_end_ms>window_start_ms),
    CHECK (coalesce(octet_length(budget_kind),0) + coalesce(octet_length(budget_owner),0) + 8 <= 2048)
);
CREATE INDEX budget_bucket_expiry ON v1_control.provider_budget_buckets(window_end_ms);
CREATE TABLE v1_control.provider_call_log (
    call_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL, principal TEXT COLLATE "C" NOT NULL, run_id TEXT COLLATE "C",
    scope_id TEXT COLLATE "C" NOT NULL, intent_key TEXT COLLATE "C" NOT NULL, request_hash BYTEA NOT NULL CHECK (length(request_hash)=32),
    resource_id TEXT COLLATE "C" NOT NULL, credential_id TEXT COLLATE "C", policy_epochs TEXT COLLATE "C" NOT NULL, participating_spaces TEXT COLLATE "C" NOT NULL,
    model_id TEXT COLLATE "C", reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens>=0), bucket_keys TEXT COLLATE "C" NOT NULL,
    delivery_state TEXT COLLATE "C" NOT NULL CHECK (delivery_state IN ('intent','sending','settled')),
    outcome TEXT COLLATE "C" CHECK (outcome IN ('completed','not_sent','unknown','failed','cancelled')),
    usage_source TEXT COLLATE "C" NOT NULL CHECK (usage_source IN ('exact','unknown','estimate')),
    input_tokens BIGINT CHECK (input_tokens>=0), output_tokens BIGINT CHECK (output_tokens>=0),
    diagnostic TEXT COLLATE "C", dispatch_owner TEXT COLLATE "C", created_at BIGINT NOT NULL, settled_at BIGINT,
    UNIQUE(principal,scope_id,intent_key),
    CHECK (coalesce(octet_length(call_id),0) <= 2048),
    CHECK (coalesce(octet_length(principal),0) + coalesce(octet_length(scope_id),0) + coalesce(octet_length(intent_key),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + 8 + coalesce(octet_length(call_id),0) <= 2048),
    CHECK (coalesce(octet_length(delivery_state),0) + 8 + coalesce(octet_length(call_id),0) <= 2048)
);
CREATE INDEX call_owner ON v1_control.provider_call_log(owner_id,created_at,call_id);
CREATE INDEX call_pending ON v1_control.provider_call_log(delivery_state,created_at,call_id);
CREATE INDEX call_settled ON v1_control.provider_call_log(delivery_state,settled_at,call_id);
CREATE TABLE v1_control.ability_availability (
    placement TEXT COLLATE "C" NOT NULL, ability_id TEXT COLLATE "C" NOT NULL,
    mode TEXT COLLATE "C" NOT NULL CHECK (mode IN ('all-projects','selected-projects')),
    enabled BIGINT NOT NULL CHECK (enabled IN (0,1)), revision BIGINT NOT NULL CHECK (revision>=0),
    PRIMARY KEY(placement,ability_id),
    CHECK (coalesce(octet_length(placement),0) + coalesce(octet_length(ability_id),0) <= 2048)
);
CREATE TABLE v1_control.ability_project_bindings (
    placement TEXT COLLATE "C" NOT NULL, ability_id TEXT COLLATE "C" NOT NULL, target_space TEXT COLLATE "C" NOT NULL, project_id TEXT COLLATE "C" NOT NULL,
    PRIMARY KEY(placement,ability_id,target_space,project_id),
    FOREIGN KEY(placement,ability_id) REFERENCES v1_control.ability_availability(placement,ability_id) ON DELETE CASCADE,
    CHECK (coalesce(octet_length(placement),0) + coalesce(octet_length(ability_id),0) + coalesce(octet_length(target_space),0) + coalesce(octet_length(project_id),0) <= 2048),
    CHECK (coalesce(octet_length(target_space),0) + coalesce(octet_length(project_id),0) <= 2048)
);
CREATE INDEX ability_project ON v1_control.ability_project_bindings(target_space,project_id);
CREATE TABLE v1_control.ability_preferences (
    owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), ability_id TEXT COLLATE "C" NOT NULL, placement TEXT COLLATE "C" NOT NULL,
    enabled BIGINT NOT NULL CHECK (enabled IN (0,1)), revision BIGINT NOT NULL CHECK (revision>=0),
    PRIMARY KEY(owner_id,ability_id,placement),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(ability_id),0) + coalesce(octet_length(placement),0) <= 2048)
);
CREATE TABLE v1_control.ability_placement_trail (
    source_placement TEXT COLLATE "C" NOT NULL, ability_id TEXT COLLATE "C" NOT NULL, destination_placement TEXT COLLATE "C" NOT NULL,
    destination_id TEXT COLLATE "C" NOT NULL, manifest_ref TEXT COLLATE "C" NOT NULL, created_at BIGINT NOT NULL,
    PRIMARY KEY(source_placement,ability_id),
    CHECK (source_placement<>destination_placement OR ability_id<>destination_id),
    CHECK (coalesce(octet_length(source_placement),0) + coalesce(octet_length(ability_id),0) <= 2048)
);
CREATE TABLE v1_control.favorites (
    owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), space_id TEXT COLLATE "C" NOT NULL,
    entity_kind TEXT COLLATE "C" NOT NULL CHECK (entity_kind IN ('note','folder')), entity_id TEXT COLLATE "C" NOT NULL,
    rank BIGINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(owner_id,space_id,entity_kind,entity_id),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(space_id),0) + coalesce(octet_length(entity_kind),0) + coalesce(octet_length(entity_id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(space_id),0) + 8 + coalesce(octet_length(entity_id),0) <= 2048)
);
CREATE INDEX favorite_order ON v1_control.favorites(owner_id,rank,space_id,entity_kind,entity_id);
CREATE TABLE v1_control.context_sets (
    set_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), home_space TEXT COLLATE "C" NOT NULL,
    name TEXT COLLATE "C" NOT NULL, note_refs TEXT COLLATE "C" NOT NULL CHECK (length(note_refs)<=65536),
    revision BIGINT NOT NULL CHECK (revision>=0), created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(set_id),0) <= 2048),
    CHECK (coalesce(octet_length(home_space),0) + coalesce(octet_length(set_id),0) <= 2048)
);
CREATE INDEX context_home ON v1_control.context_sets(home_space,set_id);
CREATE TABLE v1_control.context_set_attachments (
    set_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.context_sets(set_id) ON DELETE CASCADE,
    target_kind TEXT COLLATE "C" NOT NULL CHECK (target_kind IN ('personal','space','project')), target_id TEXT COLLATE "C" NOT NULL,
    target_space TEXT COLLATE "C" NOT NULL, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), revision BIGINT NOT NULL CHECK (revision>=0),
    PRIMARY KEY(set_id,target_kind,target_id),
    CHECK (target_kind<>'personal' OR target_id=owner_id),
    CHECK (coalesce(octet_length(set_id),0) + coalesce(octet_length(target_kind),0) + coalesce(octet_length(target_id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(target_kind),0) + coalesce(octet_length(target_id),0) + coalesce(octet_length(set_id),0) <= 2048)
);
CREATE INDEX context_attachment_target ON v1_control.context_set_attachments(target_kind,target_id,set_id);
CREATE TABLE v1_control.context_scope_pins (
    owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), target_kind TEXT COLLATE "C" NOT NULL CHECK (target_kind IN ('personal','space','project')),
    target_id TEXT COLLATE "C" NOT NULL, target_space TEXT COLLATE "C" NOT NULL, note_space TEXT COLLATE "C" NOT NULL, note_id TEXT COLLATE "C" NOT NULL,
    revision BIGINT NOT NULL CHECK (revision>=0), created_at BIGINT NOT NULL,
    PRIMARY KEY(owner_id,target_kind,target_id,note_space,note_id),
    CHECK (target_kind<>'personal' OR target_id=owner_id),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(target_kind),0) + coalesce(octet_length(target_id),0) + coalesce(octet_length(note_space),0) + coalesce(octet_length(note_id),0) <= 2048),
    CHECK (coalesce(octet_length(target_space),0) + coalesce(octet_length(note_space),0) <= 2048)
);
CREATE INDEX context_pin_space ON v1_control.context_scope_pins(target_space,note_space);
CREATE INDEX context_pin_target ON v1_control.context_scope_pins(target_kind,target_id,note_space,note_id);
CREATE UNIQUE INDEX context_shared_pin ON v1_control.context_scope_pins(target_kind,target_id,note_space,note_id) WHERE target_kind<>'personal';
CREATE TABLE v1_control.context_order (
    owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), target_kind TEXT COLLATE "C" NOT NULL CHECK (target_kind IN ('personal','space','project')),
    target_id TEXT COLLATE "C" NOT NULL, target_space TEXT COLLATE "C" NOT NULL, entry_kind TEXT COLLATE "C" NOT NULL CHECK (entry_kind IN ('set','note')),
    entry_ref TEXT COLLATE "C" NOT NULL, rank BIGINT NOT NULL, revision BIGINT NOT NULL CHECK (revision>=0),
    PRIMARY KEY(owner_id,target_kind,target_id,entry_kind,entry_ref),
    CHECK (target_kind<>'personal' OR target_id=owner_id),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(target_kind),0) + coalesce(octet_length(target_id),0) + coalesce(octet_length(entry_kind),0) + coalesce(octet_length(entry_ref),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(target_kind),0) + coalesce(octet_length(target_id),0) + 8 + coalesce(octet_length(entry_ref),0) <= 2048)
);
CREATE INDEX context_order_target ON v1_control.context_order(target_kind,target_id,rank,entry_kind,entry_ref);
CREATE UNIQUE INDEX context_shared_order ON v1_control.context_order(target_kind,target_id,entry_kind,entry_ref) WHERE target_kind<>'personal';
CREATE TABLE v1_control.agent_episodes (
    episode_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), name TEXT COLLATE "C",
    parent_id TEXT COLLATE "C" REFERENCES v1_control.agent_episodes(episode_id) DEFERRABLE INITIALLY DEFERRED, active_role TEXT COLLATE "C", project_space TEXT COLLATE "C", project_folder TEXT COLLATE "C",
    lifecycle TEXT COLLATE "C" NOT NULL CHECK (lifecycle IN ('active','sleeping','closed')),
    revision BIGINT NOT NULL CHECK (revision>=0), created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL,
    closed_at BIGINT, calls BIGINT NOT NULL DEFAULT 0 CHECK (calls>=0),
    CHECK ((project_space IS NULL)=(project_folder IS NULL)),
    CHECK (coalesce(octet_length(episode_id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(name),0) + coalesce(octet_length(lifecycle),0) + 8 + coalesce(octet_length(episode_id),0) <= 2048)
);
CREATE INDEX episode_owner_name ON v1_control.agent_episodes(owner_id,name,lifecycle,last_seen_at,episode_id);
CREATE TABLE v1_control.mcp_delta_owner_cursors (
    owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), space_id TEXT COLLATE "C" NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (length(history_incarnation)=16),
    acked_space_seq BIGINT NOT NULL CHECK (acked_space_seq>=0), updated_at BIGINT NOT NULL,
    PRIMARY KEY(owner_id,space_id),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(space_id),0) <= 2048),
    CHECK (coalesce(octet_length(space_id),0) <= 2048)
);
CREATE INDEX owner_cursor_space ON v1_control.mcp_delta_owner_cursors(space_id);
CREATE TABLE v1_control.mcp_delta_session_cursors (
    episode_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.agent_episodes(episode_id) ON DELETE CASCADE, space_id TEXT COLLATE "C" NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (length(history_incarnation)=16),
    acked_space_seq BIGINT NOT NULL CHECK (acked_space_seq>=0), updated_at BIGINT NOT NULL,
    PRIMARY KEY(episode_id,space_id),
    CHECK (coalesce(octet_length(episode_id),0) + coalesce(octet_length(space_id),0) <= 2048),
    CHECK (coalesce(octet_length(space_id),0) <= 2048)
);
CREATE INDEX episode_cursor_space ON v1_control.mcp_delta_session_cursors(space_id);
CREATE TABLE v1_control.agent_telemetry_config (
    singleton BIGINT NOT NULL PRIMARY KEY CHECK (singleton=1), detailed_enabled BIGINT NOT NULL DEFAULT 0 CHECK (detailed_enabled IN (0,1)),
    compact_retention_days BIGINT NOT NULL DEFAULT 90 CHECK (compact_retention_days>0),
    detailed_retention_days BIGINT NOT NULL DEFAULT 30 CHECK (detailed_retention_days>0 AND detailed_retention_days<=compact_retention_days),
    version BIGINT NOT NULL CHECK (version>=0), updated_at BIGINT NOT NULL
);
CREATE TABLE v1_control.agent_calls (
    call_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), principal TEXT COLLATE "C" NOT NULL, agent TEXT COLLATE "C",
    transport TEXT COLLATE "C" NOT NULL, request_id TEXT COLLATE "C" NOT NULL, episode_id TEXT COLLATE "C" REFERENCES v1_control.agent_episodes(episode_id),
    tool TEXT COLLATE "C" NOT NULL, effect TEXT COLLATE "C" NOT NULL, domain TEXT COLLATE "C" NOT NULL, started_at BIGINT NOT NULL,
    finished_at BIGINT, duration_ms BIGINT CHECK (duration_ms>=0), outcome TEXT COLLATE "C", reason TEXT COLLATE "C",
    input_bytes BIGINT NOT NULL CHECK (input_bytes>=0), output_bytes BIGINT CHECK (output_bytes>=0),
    summaries TEXT COLLATE "C" NOT NULL CHECK (length(summaries)<=4096), fingerprint BYTEA NOT NULL CHECK (length(fingerprint)=32),
    projection_version BIGINT NOT NULL CHECK (projection_version>=0), redacted BIGINT NOT NULL CHECK (redacted IN (0,1)),
    truncated BIGINT NOT NULL CHECK (truncated IN (0,1)), detail_capture_failed BIGINT NOT NULL CHECK (detail_capture_failed IN (0,1)),
    CHECK (coalesce(octet_length(call_id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + 8 + coalesce(octet_length(call_id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(episode_id),0) + 8 + coalesce(octet_length(call_id),0) <= 2048)
);
CREATE INDEX agent_call_owner ON v1_control.agent_calls(owner_id,started_at,call_id);
CREATE INDEX agent_call_episode ON v1_control.agent_calls(owner_id,episode_id,started_at,call_id);
CREATE INDEX agent_call_retention ON v1_control.agent_calls(finished_at,call_id);
CREATE INDEX agent_call_pending ON v1_control.agent_calls(finished_at,started_at);
CREATE TABLE v1_control.agent_call_details (
    call_id TEXT COLLATE "C" NOT NULL PRIMARY KEY REFERENCES v1_control.agent_calls(call_id) ON DELETE CASCADE,
    payload TEXT COLLATE "C" NOT NULL CHECK (length(payload)<=65536), created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(call_id),0) <= 2048)
);
CREATE INDEX detail_expiry ON v1_control.agent_call_details(expires_at);
CREATE INDEX detail_created ON v1_control.agent_call_details(created_at,call_id);
CREATE TABLE v1_control.agent_retrievals (
    retrieval_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), principal TEXT COLLATE "C" NOT NULL, agent TEXT COLLATE "C",
    call_id TEXT COLLATE "C" REFERENCES v1_control.agent_calls(call_id), tool TEXT COLLATE "C" NOT NULL, query_summary TEXT COLLATE "C" NOT NULL CHECK (length(query_summary)<=4096),
    filters TEXT COLLATE "C" NOT NULL CHECK (length(filters)<=4096), hit_refs TEXT COLLATE "C" NOT NULL CHECK (length(hit_refs)<=65536),
    result_count BIGINT NOT NULL CHECK (result_count>=0), top_score DOUBLE PRECISION CHECK (top_score BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308), created_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(retrieval_id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + 8 + coalesce(octet_length(retrieval_id),0) <= 2048),
    CHECK (coalesce(octet_length(call_id),0) <= 2048)
);
CREATE INDEX retrieval_retention ON v1_control.agent_retrievals(created_at,retrieval_id);
CREATE INDEX retrieval_owner ON v1_control.agent_retrievals(owner_id,created_at,retrieval_id);
CREATE INDEX retrieval_call ON v1_control.agent_retrievals(call_id);
CREATE TABLE v1_control.mcp_dedup (
    owner TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), actor TEXT COLLATE "C" NOT NULL, request_key TEXT COLLATE "C" NOT NULL,
    request_hash BYTEA NOT NULL CHECK (length(request_hash)=32), operation TEXT COLLATE "C" NOT NULL,
    safe_result TEXT COLLATE "C" NOT NULL CHECK (length(safe_result)<=65536), effect TEXT COLLATE "C" NOT NULL, expires_at BIGINT NOT NULL,
    PRIMARY KEY(owner,actor,request_key),
    CHECK (coalesce(octet_length(owner),0) + coalesce(octet_length(actor),0) + coalesce(octet_length(request_key),0) <= 2048)
);
CREATE INDEX dedup_expiry ON v1_control.mcp_dedup(expires_at);
CREATE TABLE v1_control.agent_schedules (
    schedule_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, owner_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), space_id TEXT COLLATE "C" NOT NULL,
    project_folder_id TEXT COLLATE "C", title TEXT COLLATE "C" NOT NULL, init_prompt TEXT COLLATE "C" NOT NULL, cron_expr TEXT COLLATE "C" NOT NULL, timezone TEXT COLLATE "C" NOT NULL, approved_role TEXT COLLATE "C" NOT NULL,
    paused_reason TEXT COLLATE "C" CHECK (paused_reason IN ('owner_revoked','role_changed','space_unavailable','budget_exceeded','manual')),
    write_class_mask BIGINT NOT NULL CHECK (write_class_mask=1), budgets TEXT COLLATE "C" NOT NULL,
    misfire_policy TEXT COLLATE "C" NOT NULL CHECK (misfire_policy='coalesce_latest'), next_slot_utc_ms BIGINT NOT NULL,
    deleted_at BIGINT, config_revision BIGINT NOT NULL CHECK (config_revision>=0), revision BIGINT NOT NULL CHECK (revision>=0), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    CHECK (octet_length(title) BETWEEN 1 AND 512),
    CHECK ((deleted_at IS NULL AND octet_length(init_prompt) BETWEEN 1 AND 32768) OR (deleted_at IS NOT NULL AND octet_length(init_prompt) <= 32768)),
    CHECK (coalesce(octet_length(schedule_id),0) <= 2048),
    CHECK (8 + coalesce(octet_length(paused_reason),0) + 8 + coalesce(octet_length(schedule_id),0) <= 2048),
    CHECK (coalesce(octet_length(owner_id),0) + coalesce(octet_length(space_id),0) + coalesce(octet_length(schedule_id),0) <= 2048)
);
CREATE INDEX schedule_due ON v1_control.agent_schedules(deleted_at,paused_reason,next_slot_utc_ms,schedule_id);
CREATE INDEX schedule_deleted ON v1_control.agent_schedules(deleted_at,updated_at,schedule_id);
CREATE INDEX schedule_owner ON v1_control.agent_schedules(owner_id,space_id,schedule_id);
CREATE TABLE v1_control.agent_schedule_runs (
    run_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, schedule_id TEXT COLLATE "C" NOT NULL REFERENCES v1_control.agent_schedules(schedule_id) ON DELETE RESTRICT,
    slot_utc_ms BIGINT NOT NULL, lease_epoch BIGINT NOT NULL CHECK (lease_epoch>0),
    claim_request_hash BYTEA NOT NULL CHECK (length(claim_request_hash)=32),
    claimed_schedule_revision BIGINT NOT NULL CHECK (claimed_schedule_revision>=0), reserved_next_slot BIGINT NOT NULL,
    status TEXT COLLATE "C" NOT NULL CHECK (status IN ('claimed','running','succeeded','failed','unknown')),
    started_at BIGINT NOT NULL, finished_at BIGINT, safe_result TEXT COLLATE "C" CHECK (length(safe_result)<=4096),
    owner_auth_version BIGINT NOT NULL CHECK (owner_auth_version>=0), config_revision BIGINT NOT NULL CHECK (config_revision>=0),
    admission_epoch BIGINT NOT NULL CHECK (admission_epoch>=0), history_scope TEXT COLLATE "C" NOT NULL, expires_at BIGINT NOT NULL CHECK (expires_at>started_at),
    UNIQUE(schedule_id,slot_utc_ms), CHECK (reserved_next_slot>slot_utc_ms),
    CHECK (octet_length(history_scope)<=2048),
    CHECK (coalesce(octet_length(run_id),0) <= 2048),
    CHECK (coalesce(octet_length(schedule_id),0) + 8 <= 2048),
    CHECK (coalesce(octet_length(schedule_id),0) + coalesce(octet_length(status),0) + 8 + coalesce(octet_length(run_id),0) <= 2048)
);
CREATE INDEX schedule_run_status ON v1_control.agent_schedule_runs(schedule_id,status,slot_utc_ms,run_id);
CREATE INDEX schedule_run_retention ON v1_control.agent_schedule_runs(status,finished_at,run_id);
CREATE TABLE v1_control.control_commands (
    owner TEXT COLLATE "C" NOT NULL REFERENCES v1_control.users(user_id), actor TEXT COLLATE "C" NOT NULL, command_key TEXT COLLATE "C" NOT NULL,
    request_hash BYTEA NOT NULL CHECK (length(request_hash)=32), target TEXT COLLATE "C" NOT NULL,
    expected BIGINT NOT NULL CHECK (expected>=0), result_revision BIGINT CHECK (result_revision>=0),
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending','committed')), safe_result TEXT COLLATE "C" CHECK (length(safe_result)<=65536),
    expires_at BIGINT NOT NULL, PRIMARY KEY(owner,actor,command_key),
    CHECK (coalesce(octet_length(owner),0) + coalesce(octet_length(actor),0) + coalesce(octet_length(command_key),0) <= 2048),
    CHECK (coalesce(octet_length(state),0) + 8 <= 2048)
);
CREATE INDEX command_pending ON v1_control.control_commands(state,expires_at);
CREATE TABLE v1_control.control_operations (
    operation_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, command_key TEXT COLLATE "C" NOT NULL UNIQUE,
    kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('create-space','lifecycle')), target_space TEXT COLLATE "C" NOT NULL,
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending','canonical','committed')),
    payload_hash BYTEA NOT NULL CHECK (length(payload_hash)=32), payload TEXT COLLATE "C" NOT NULL CHECK (length(payload)<=65536),
    canonical_receipt TEXT COLLATE "C" CHECK (length(canonical_receipt)<=65536), next_action TEXT COLLATE "C" NOT NULL, updated_at BIGINT NOT NULL,
    CHECK (coalesce(octet_length(operation_id),0) <= 2048),
    CHECK (coalesce(octet_length(command_key),0) <= 2048),
    CHECK (coalesce(octet_length(state),0) + 8 <= 2048)
);
CREATE INDEX operation_state_time ON v1_control.control_operations(state,updated_at);
CREATE TABLE v1_control.revocation_events (
    event_id TEXT COLLATE "C" NOT NULL PRIMARY KEY, selector TEXT COLLATE "C" NOT NULL CHECK (length(selector)<=4096), reason TEXT COLLATE "C" NOT NULL,
    authority_version BIGINT NOT NULL CHECK (authority_version>=0), committed_at BIGINT NOT NULL,
    delivered_at BIGINT, attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts>=0),
    CHECK (coalesce(octet_length(event_id),0) <= 2048),
    CHECK (8 + 8 + coalesce(octet_length(event_id),0) <= 2048)
);
CREATE INDEX revocation_pending ON v1_control.revocation_events(delivered_at,committed_at,event_id);
