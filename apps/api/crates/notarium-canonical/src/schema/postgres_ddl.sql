-- Canonical storage baseline DDL v1 (PostgreSQL 16 dialect).
-- Executed inside a single validated target schema via search_path.

CREATE TABLE IF NOT EXISTS schema_meta (
    singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    epoch_version INTEGER NOT NULL CHECK (epoch_version >= 1),
    installation_id TEXT NOT NULL,
    migration_state TEXT NOT NULL CHECK (migration_state IN ('migrating', 'ready')),
    manifest_checksum BYTEA NOT NULL CHECK (octet_length(manifest_checksum) = 32),
    initialized_at_sec BIGINT NOT NULL,
    initialized_at_nsec INTEGER NOT NULL CHECK (initialized_at_nsec >= 0 AND initialized_at_nsec < 1000000000),
    updated_at_sec BIGINT NOT NULL,
    updated_at_nsec INTEGER NOT NULL CHECK (updated_at_nsec >= 0 AND updated_at_nsec < 1000000000)
);

CREATE TABLE IF NOT EXISTS spaces (
    space_id TEXT NOT NULL PRIMARY KEY,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    root_folder_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    slug_fold TEXT NOT NULL,
    space_kind TEXT NOT NULL CHECK (space_kind IN ('personal', 'shared')),
    owner_id TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'closing', 'archived')),
    active_epoch BIGINT NOT NULL CHECK (active_epoch >= 0),
    last_seq BIGINT NOT NULL CHECK (last_seq >= 0),
    settings_json TEXT NOT NULL,
    created_at_sec BIGINT NOT NULL,
    created_at_nsec INTEGER NOT NULL CHECK (created_at_nsec >= 0 AND created_at_nsec < 1000000000)
) WITH (fillfactor = 70);

CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_slug_fold
    ON spaces (slug_fold);

CREATE TABLE IF NOT EXISTS folder_heads (
    space_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    parent_folder_id TEXT,
    is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
    slug TEXT NOT NULL,
    slug_fold TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_project INTEGER NOT NULL CHECK (is_project IN (0, 1)),
    project_slug TEXT,
    project_slug_fold TEXT,
    description TEXT,
    cover_note_id TEXT,
    write_lock_json TEXT,
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'trashed', 'purged')),
    rev_seq BIGINT NOT NULL CHECK (rev_seq >= 0),
    head_rev_id TEXT NOT NULL,
    created_seq BIGINT NOT NULL CHECK (created_seq >= 0),
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 0),
    updated_at_sec BIGINT NOT NULL,
    updated_at_nsec INTEGER NOT NULL CHECK (updated_at_nsec >= 0 AND updated_at_nsec < 1000000000),
    PRIMARY KEY (space_id, folder_id),
    CHECK (
        (is_root = 1 AND parent_folder_id IS NULL)
        OR (is_root = 0 AND parent_folder_id IS NOT NULL AND parent_folder_id <> folder_id)
    ),
    CHECK (
        (is_project = 0 AND project_slug IS NULL AND project_slug_fold IS NULL)
        OR (is_project = 1 AND project_slug IS NOT NULL AND project_slug_fold IS NOT NULL)
    ),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id),
    FOREIGN KEY (space_id, parent_folder_id) REFERENCES folder_heads (space_id, folder_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_folder_heads_root
    ON folder_heads (space_id)
    WHERE is_root = 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_folder_heads_active_sibling
    ON folder_heads (space_id, parent_folder_id, slug_fold)
    WHERE lifecycle_state = 'active' AND is_root = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_folder_heads_active_project
    ON folder_heads (space_id, project_slug_fold)
    WHERE lifecycle_state = 'active' AND is_project = 1 AND project_slug_fold IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_folder_heads_parent_lifecycle
    ON folder_heads (space_id, parent_folder_id, lifecycle_state, folder_id);

CREATE INDEX IF NOT EXISTS idx_folder_heads_cover
    ON folder_heads (space_id, cover_note_id)
    WHERE cover_note_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS folder_aliases (
    space_id TEXT NOT NULL,
    old_parent_folder_id TEXT NOT NULL,
    old_slug_fold TEXT NOT NULL,
    target_folder_id TEXT NOT NULL,
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    PRIMARY KEY (space_id, old_parent_folder_id, old_slug_fold, created_seq, target_folder_id),
    FOREIGN KEY (space_id, old_parent_folder_id) REFERENCES folder_heads (space_id, folder_id),
    FOREIGN KEY (space_id, target_folder_id) REFERENCES folder_heads (space_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_folder_aliases_lookup
    ON folder_aliases (space_id, old_parent_folder_id, old_slug_fold, created_seq DESC);

CREATE INDEX IF NOT EXISTS idx_folder_aliases_projection_seq
    ON folder_aliases (space_id, created_seq);

CREATE TABLE IF NOT EXISTS note_heads (
    space_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    parent_folder_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    slug_fold TEXT NOT NULL,
    title TEXT NOT NULL,
    title_fold TEXT NOT NULL,
    doc_class TEXT NOT NULL CHECK (doc_class IN ('user-doc', 'encrypted-note', 'agent-memory', 'skill', 'profile')),
    ability_id TEXT,
    head_rev_id TEXT NOT NULL,
    content_blake3 BYTEA,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'trashed', 'purged')),
    visibility_mask INTEGER NOT NULL DEFAULT 0,
    settlement_successor_id TEXT,
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
    created_at_sec BIGINT NOT NULL,
    created_at_nsec INTEGER NOT NULL CHECK (created_at_nsec >= 0 AND created_at_nsec < 1000000000),
    updated_at_sec BIGINT NOT NULL,
    updated_at_nsec INTEGER NOT NULL CHECK (updated_at_nsec >= 0 AND updated_at_nsec < 1000000000),
    last_actor_id TEXT NOT NULL,
    PRIMARY KEY (space_id, note_id),
    CHECK (
        (lifecycle_state = 'purged' AND content_blake3 IS NULL AND byte_size = 0)
        OR (lifecycle_state <> 'purged' AND content_blake3 IS NOT NULL AND octet_length(content_blake3) = 32)
    ),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id),
    FOREIGN KEY (space_id, parent_folder_id) REFERENCES folder_heads (space_id, folder_id)
) WITH (fillfactor = 80);

CREATE UNIQUE INDEX IF NOT EXISTS uq_note_heads_active_sibling
    ON note_heads (space_id, parent_folder_id, slug_fold)
    WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS idx_note_heads_parent_lifecycle
    ON note_heads (space_id, parent_folder_id, lifecycle_state, note_id);

CREATE INDEX IF NOT EXISTS idx_note_heads_created_seq
    ON note_heads (space_id, created_seq, note_id);

CREATE TABLE IF NOT EXISTS note_aliases (
    space_id TEXT NOT NULL,
    old_parent_folder_id TEXT NOT NULL,
    old_slug_fold TEXT NOT NULL,
    old_title_norm TEXT NOT NULL,
    target_note_id TEXT NOT NULL,
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    PRIMARY KEY (space_id, old_parent_folder_id, old_slug_fold, created_seq, target_note_id),
    FOREIGN KEY (space_id, old_parent_folder_id) REFERENCES folder_heads (space_id, folder_id),
    FOREIGN KEY (space_id, target_note_id) REFERENCES note_heads (space_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_note_aliases_slug_lookup
    ON note_aliases (space_id, old_parent_folder_id, old_slug_fold, created_seq DESC);

CREATE INDEX IF NOT EXISTS idx_note_aliases_title_lookup
    ON note_aliases (space_id, old_title_norm, created_seq DESC);

CREATE INDEX IF NOT EXISTS idx_note_aliases_target
    ON note_aliases (space_id, target_note_id);

CREATE INDEX IF NOT EXISTS idx_note_aliases_projection_seq
    ON note_aliases (space_id, created_seq);

CREATE TABLE IF NOT EXISTS space_field_schemas (
    space_id TEXT NOT NULL,
    schema_rev_id TEXT NOT NULL,
    schema_note_id TEXT NOT NULL,
    is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
    descriptor_msgpack BYTEA NOT NULL,
    descriptor_fingerprint BYTEA NOT NULL CHECK (octet_length(descriptor_fingerprint) = 32),
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    visibility_seq BIGINT NOT NULL CHECK (visibility_seq >= created_seq),
    created_at_sec BIGINT NOT NULL,
    created_at_nsec INTEGER NOT NULL CHECK (created_at_nsec >= 0 AND created_at_nsec < 1000000000),
    PRIMARY KEY (space_id, schema_rev_id),
    FOREIGN KEY (space_id, schema_note_id) REFERENCES note_heads (space_id, note_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_space_field_schemas_current
    ON space_field_schemas (space_id)
    WHERE is_current = 1;

CREATE INDEX IF NOT EXISTS idx_space_field_schemas_vis
    ON space_field_schemas (space_id, visibility_seq DESC);

CREATE TABLE IF NOT EXISTS revisions (
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    rev_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('note', 'folder', 'thread', 'ability', 'rank', 'agent_run')),
    entity_key TEXT NOT NULL,
    space_seq BIGINT NOT NULL CHECK (space_seq >= 0),
    visibility_seq BIGINT NOT NULL CHECK (visibility_seq >= space_seq),
    parent_rev_id TEXT,
    their_rev_id TEXT,
    restored_from_rev_id TEXT,
    content_blake3 BYTEA CHECK (content_blake3 IS NULL OR octet_length(content_blake3) = 32),
    metadata_msgpack BYTEA NOT NULL,
    patch_meta_json TEXT,
    actor_id TEXT NOT NULL,
    session_id TEXT,
    agent_run_id TEXT,
    quarantine_reason TEXT,
    created_at_sec BIGINT NOT NULL,
    created_at_nsec INTEGER NOT NULL CHECK (created_at_nsec >= 0 AND created_at_nsec < 1000000000),
    PRIMARY KEY (space_id, rev_id)
);

CREATE INDEX IF NOT EXISTS idx_revisions_entity_vis_seq
    ON revisions (space_id, entity_type, entity_key, visibility_seq DESC, space_seq DESC);

CREATE INDEX IF NOT EXISTS idx_revisions_agent_run
    ON revisions (space_id, agent_run_id, entity_type, entity_key, space_seq)
    WHERE agent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_revisions_parent_rev
    ON revisions (space_id, parent_rev_id)
    WHERE parent_rev_id IS NOT NULL;

-- A separator below every valid ID byte preserves tuple order in a scalar index.
CREATE INDEX IF NOT EXISTS idx_revisions_projection_rank_key
    ON revisions (space_id, history_incarnation,
        replace(entity_key, ':', chr(31)) COLLATE "C",
        visibility_seq DESC, space_seq DESC)
    WHERE entity_type = 'rank';

CREATE INDEX IF NOT EXISTS idx_revisions_projection_rank_target
    ON revisions (space_id, history_incarnation,
        split_part(entity_key, ':', 3) COLLATE "C",
        replace(entity_key, ':', chr(31)) COLLATE "C",
        visibility_seq DESC, space_seq DESC)
    WHERE entity_type = 'rank';

CREATE TABLE IF NOT EXISTS revision_purge_fences (
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    note_id TEXT NOT NULL,
    purge_seq BIGINT NOT NULL CHECK (purge_seq >= 1),
    old_identity_state TEXT NOT NULL,
    successor_note_id TEXT,
    created_at_sec BIGINT NOT NULL,
    created_at_nsec INTEGER NOT NULL CHECK (created_at_nsec >= 0 AND created_at_nsec < 1000000000),
    PRIMARY KEY (space_id, note_id),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id)
);

CREATE TABLE IF NOT EXISTS ability_packages (
    space_id TEXT NOT NULL,
    ability_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('role', 'skill')),
    slug_fold TEXT NOT NULL,
    entrypoint_note_id TEXT NOT NULL,
    manifest_rev_id TEXT NOT NULL,
    resource_manifest_json TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'trashed', 'purged')),
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
    PRIMARY KEY (space_id, ability_id),
    FOREIGN KEY (space_id, entrypoint_note_id) REFERENCES note_heads (space_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_ability_packages_active_slug
    ON ability_packages (space_id, slug_fold)
    WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS idx_ability_packages_entrypoint
    ON ability_packages (space_id, entrypoint_note_id);

CREATE TABLE IF NOT EXISTS view_rank_overlays (
    space_id TEXT NOT NULL,
    view_note_id TEXT NOT NULL,
    view_key TEXT NOT NULL,
    target_note_id TEXT NOT NULL,
    group_key_msgpack BYTEA NOT NULL,
    group_key_hex TEXT NOT NULL,
    sort_rank_lexo TEXT NOT NULL CHECK (octet_length(sort_rank_lexo) BETWEEN 1 AND 16),
    rank_rev_id TEXT NOT NULL,
    placement_revision TEXT NOT NULL,
    placement_actor_id TEXT NOT NULL,
    placement_run_id TEXT,
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
    PRIMARY KEY (space_id, view_note_id, view_key, target_note_id),
    FOREIGN KEY (space_id, view_note_id) REFERENCES note_heads (space_id, note_id),
    FOREIGN KEY (space_id, target_note_id) REFERENCES note_heads (space_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_view_rank_overlays_order
    ON view_rank_overlays (space_id, view_note_id, view_key, group_key_hex, sort_rank_lexo, target_note_id);

CREATE INDEX IF NOT EXISTS idx_view_rank_overlays_target
    ON view_rank_overlays (space_id, target_note_id);

-- A row marks the complete starting state even when the snapshot has no ranks.
CREATE TABLE IF NOT EXISTS projection_rank_anchors (
    space_id TEXT NOT NULL PRIMARY KEY,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    anchor_seq BIGINT NOT NULL CHECK (anchor_seq >= 0),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id)
);

CREATE TABLE IF NOT EXISTS projection_rank_anchor_rows (
    space_id TEXT NOT NULL,
    view_note_id TEXT COLLATE "C" NOT NULL,
    view_key TEXT COLLATE "C" NOT NULL,
    target_note_id TEXT COLLATE "C" NOT NULL,
    group_key_msgpack BYTEA NOT NULL,
    group_key_hex TEXT NOT NULL,
    sort_rank_lexo TEXT NOT NULL CHECK (octet_length(sort_rank_lexo) BETWEEN 1 AND 16),
    rank_rev_id TEXT NOT NULL,
    placement_revision TEXT NOT NULL,
    placement_actor_id TEXT NOT NULL,
    placement_run_id TEXT,
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
    PRIMARY KEY (space_id, view_note_id, view_key, target_note_id),
    FOREIGN KEY (space_id) REFERENCES projection_rank_anchors (space_id),
    FOREIGN KEY (space_id, view_note_id) REFERENCES note_heads (space_id, note_id),
    FOREIGN KEY (space_id, target_note_id) REFERENCES note_heads (space_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_projection_rank_anchor_target
    ON projection_rank_anchor_rows (space_id, target_note_id, view_note_id, view_key);

CREATE TABLE IF NOT EXISTS blob_catalog (
    space_id TEXT NOT NULL,
    content_blake3 BYTEA NOT NULL CHECK (octet_length(content_blake3) = 32),
    raw_size BIGINT NOT NULL CHECK (raw_size >= 0),
    compressed_size BIGINT NOT NULL CHECK (compressed_size >= 0),
    ref_count BIGINT NOT NULL CHECK (ref_count >= 0),
    current_publication_id TEXT,
    admission_state TEXT NOT NULL CHECK (admission_state IN ('open', 'retiring')),
    blob_state TEXT NOT NULL CHECK (blob_state IN ('staging', 'active', 'quarantined', 'retired', 'corrupt')),
    touched_at_ms BIGINT NOT NULL,
    PRIMARY KEY (space_id, content_blake3)
) WITH (fillfactor = 80);

CREATE INDEX IF NOT EXISTS idx_blob_catalog_zero_ref
    ON blob_catalog (space_id, touched_at_ms)
    WHERE ref_count = 0;

CREATE TABLE IF NOT EXISTS blob_publications (
    space_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    content_blake3 BYTEA NOT NULL CHECK (octet_length(content_blake3) = 32),
    owner_epoch BIGINT NOT NULL CHECK (owner_epoch >= 0),
    codec TEXT NOT NULL CHECK (codec IN ('local_zstd_v1', 's3_chunked_v1')),
    state TEXT NOT NULL CHECK (state IN ('staging', 'active', 'retiring', 'retired', 'corrupt')),
    manifest_sealed INTEGER NOT NULL CHECK (manifest_sealed IN (0, 1)),
    part_count INTEGER NOT NULL CHECK (part_count >= 0),
    raw_size BIGINT NOT NULL CHECK (raw_size >= 0),
    compressed_size BIGINT NOT NULL CHECK (compressed_size >= 0),
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (space_id, publication_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_blob_publications_active_digest
    ON blob_publications (space_id, content_blake3)
    WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_blob_publications_digest_state
    ON blob_publications (space_id, content_blake3, state)
    WHERE state <> 'active';

CREATE TABLE IF NOT EXISTS blob_parts (
    space_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    part_index INTEGER NOT NULL CHECK (part_index >= 0),
    raw_size BIGINT NOT NULL CHECK (raw_size >= 0 AND raw_size <= 4194304),
    compressed_size BIGINT NOT NULL CHECK (compressed_size > 0 AND compressed_size < 8388608),
    part_blake3 BYTEA NOT NULL CHECK (octet_length(part_blake3) = 32),
    physical_key TEXT NOT NULL,
    observed_version_id TEXT,
    upload_confirmed INTEGER NOT NULL CHECK (upload_confirmed IN (0, 1)),
    PRIMARY KEY (space_id, publication_id, part_index),
    FOREIGN KEY (space_id, publication_id) REFERENCES blob_publications (space_id, publication_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_blob_parts_physical_key
    ON blob_parts (space_id, physical_key);

CREATE TABLE IF NOT EXISTS blob_references (
    space_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('note_revision', 'ability_resource', 'chat_entry', 'chat_pending_input', 'collab_snapshot', 'staged_chat')),
    owner_id TEXT NOT NULL,
    owner_rev_id TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    content_blake3 BYTEA NOT NULL CHECK (octet_length(content_blake3) = 32),
    publication_id TEXT NOT NULL,
    created_seq BIGINT NOT NULL CHECK (created_seq >= 0),
    PRIMARY KEY (space_id, owner_kind, owner_rev_id, owner_id, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_blob_references_owner
    ON blob_references (space_id, owner_kind, owner_id);

CREATE INDEX IF NOT EXISTS idx_blob_references_digest
    ON blob_references (space_id, content_blake3);

CREATE TABLE IF NOT EXISTS blob_retirements (
    space_id TEXT NOT NULL,
    retirement_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    owner_epoch BIGINT NOT NULL CHECK (owner_epoch >= 0),
    reason TEXT NOT NULL CHECK (reason IN ('purge', 'gc')),
    purge_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    created_at_ms BIGINT NOT NULL,
    completed_at_ms BIGINT,
    PRIMARY KEY (space_id, retirement_id),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id)
);

CREATE INDEX IF NOT EXISTS idx_blob_retirements_status
    ON blob_retirements (status, space_id);

CREATE TABLE IF NOT EXISTS blob_retirement_targets (
    space_id TEXT NOT NULL,
    retirement_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    part_index INTEGER NOT NULL CHECK (part_index >= 0),
    content_blake3 BYTEA NOT NULL CHECK (octet_length(content_blake3) = 32),
    codec TEXT NOT NULL CHECK (codec IN ('local_zstd_v1', 's3_chunked_v1')),
    physical_key TEXT NOT NULL,
    marker_verified INTEGER NOT NULL CHECK (marker_verified IN (0, 1)),
    data_version_ids_json TEXT,
    versions_deleted INTEGER NOT NULL CHECK (versions_deleted IN (0, 1)),
    target_completed INTEGER NOT NULL CHECK (target_completed IN (0, 1)),
    PRIMARY KEY (space_id, retirement_id, publication_id, part_index),
    FOREIGN KEY (space_id, retirement_id) REFERENCES blob_retirements (space_id, retirement_id)
);

CREATE TABLE IF NOT EXISTS backup_holds (
    backup_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    owner_installation_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('holding', 'pinned', 'spooling', 'spooled')),
    cutoff_seq BIGINT NOT NULL CHECK (cutoff_seq >= 0),
    witness_json TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    owner_generation TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (backup_id, space_id),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id)
);

CREATE INDEX IF NOT EXISTS idx_backup_holds_space
    ON backup_holds (space_id, backup_id);

CREATE TABLE IF NOT EXISTS backup_artifacts (
    artifact_id TEXT NOT NULL PRIMARY KEY,
    backup_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    encoding TEXT NOT NULL CHECK (encoding IN ('sqlite_snapshot_v1', 'postgres_spool_v1')),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    artifact_rel_path TEXT NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    content_blake3 BYTEA NOT NULL CHECK (octet_length(content_blake3) = 32),
    witness_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'aborted')),
    created_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_artifacts_backup
    ON backup_artifacts (backup_id);

CREATE TABLE IF NOT EXISTS command_receipts (
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    command_hash BYTEA NOT NULL CHECK (octet_length(command_hash) = 32),
    status TEXT NOT NULL CHECK (status IN ('pending_purge', 'completed')),
    envelope_version INTEGER NOT NULL CHECK (envelope_version >= 1),
    response_payload_id TEXT,
    sanitized_envelope_msgpack BYTEA NOT NULL,
    canonical_seq BIGINT NOT NULL CHECK (canonical_seq >= 0),
    expires_at_ms BIGINT NOT NULL,
    PRIMARY KEY (space_id, history_incarnation, actor_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_command_receipts_expires
    ON command_receipts (space_id, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_receipt_exception_pointer ON command_receipts (space_id, response_payload_id) WHERE response_payload_id IS NOT NULL AND
            (response_payload_id <> 'rcpt_pay:' || actor_id || ':' || idempotency_key
             OR actor_id LIKE '%:%');

CREATE TABLE IF NOT EXISTS change_commands (
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    command_id TEXT NOT NULL,
    first_seq BIGINT NOT NULL CHECK (first_seq >= 1),
    last_seq BIGINT NOT NULL CHECK (last_seq >= first_seq),
    command_kind TEXT NOT NULL,
    payload_id TEXT,
    committed_at_ms BIGINT NOT NULL,
    PRIMARY KEY (space_id, history_incarnation, command_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_commands_last_seq
    ON change_commands (space_id, history_incarnation, last_seq);

CREATE TABLE IF NOT EXISTS change_log (
    space_id TEXT NOT NULL,
    space_seq BIGINT NOT NULL CHECK (space_seq >= 1),
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    command_id TEXT NOT NULL,
    command_first_seq BIGINT NOT NULL CHECK (command_first_seq >= 1),
    command_last_seq BIGINT NOT NULL CHECK (command_last_seq >= command_first_seq AND space_seq BETWEEN command_first_seq AND command_last_seq),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('note', 'folder', 'thread', 'job', 'ability')),
    entity_id TEXT NOT NULL,
    op_kind TEXT NOT NULL CHECK (op_kind IN ('create', 'edit', 'move', 'rename', 'trash', 'restore', 'purge', 'redact')),
    rev_id TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'trashed', 'purged')),
    doc_class TEXT CHECK (doc_class IS NULL OR doc_class IN ('user-doc', 'encrypted-note', 'agent-memory', 'skill', 'profile')),
    payload_id TEXT,
    committed_at_ms BIGINT NOT NULL,
    PRIMARY KEY (space_id, space_seq)
);

CREATE TABLE IF NOT EXISTS change_payloads (
    space_id TEXT NOT NULL,
    payload_id TEXT NOT NULL,
    codec TEXT NOT NULL CHECK (codec IN ('effect_v1', 'receipt_detail_v1')),
    erased_by_purge INTEGER NOT NULL DEFAULT 0 CHECK (erased_by_purge IN (0, 1)),
    effect_msgpack BYTEA,
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    PRIMARY KEY (space_id, payload_id),
    CHECK (
        (erased_by_purge = 0 AND effect_msgpack IS NOT NULL)
        OR (erased_by_purge = 1 AND effect_msgpack IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS payload_owners (
    space_id TEXT NOT NULL,
    payload_kind TEXT NOT NULL CHECK (payload_kind IN ('change_payload', 'command_receipt', 'content_job', 'materialized_observation', 'board_move_history')),
    payload_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    PRIMARY KEY (space_id, note_id, payload_kind, payload_id)
);

CREATE INDEX IF NOT EXISTS idx_payload_owners_job
    ON payload_owners (space_id, payload_id, note_id) WHERE payload_kind = 'content_job';

CREATE TABLE IF NOT EXISTS agent_run_heads (
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    run_id TEXT NOT NULL,
    run_revision TEXT NOT NULL,
    last_seq BIGINT NOT NULL CHECK (last_seq >= 1),
    updated_at_sec BIGINT NOT NULL,
    updated_at_nsec INTEGER NOT NULL CHECK (updated_at_nsec >= 0 AND updated_at_nsec < 1000000000),
    PRIMARY KEY (space_id, run_id)
) WITH (fillfactor = 70);

CREATE TABLE IF NOT EXISTS board_move_history (
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    command_end_seq BIGINT NOT NULL CHECK (command_end_seq >= 1),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    facts_cutoff_seq BIGINT NOT NULL CHECK (facts_cutoff_seq >= 0),
    actor_id TEXT NOT NULL,
    agent_run_id TEXT,
    view_note_id TEXT NOT NULL,
    view_key TEXT NOT NULL,
    view_rev_id TEXT NOT NULL,
    schema_rev_id TEXT,
    descriptor_fingerprint BYTEA NOT NULL CHECK (octet_length(descriptor_fingerprint) = 32),
    target_note_id TEXT NOT NULL,
    before_placement_revision TEXT,
    after_placement_revision TEXT NOT NULL,
    after_rank_rev_id TEXT NOT NULL,
    physical_precondition_json TEXT NOT NULL,
    before_placement_msgpack BYTEA NOT NULL,
    after_placement_msgpack BYTEA NOT NULL,
    base_order_binding BYTEA NOT NULL CHECK (octet_length(base_order_binding) = 32),
    PRIMARY KEY (space_id, command_end_seq, ordinal),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id)
);

CREATE INDEX IF NOT EXISTS idx_board_move_history_run
    ON board_move_history (space_id, agent_run_id, command_end_seq DESC, ordinal DESC)
    WHERE agent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_board_move_history_target
    ON board_move_history (space_id, target_note_id, command_end_seq DESC);

CREATE INDEX IF NOT EXISTS idx_board_move_history_view
    ON board_move_history (space_id, view_note_id, view_key, command_end_seq DESC);

CREATE TABLE IF NOT EXISTS chat_threads (
    space_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'space_group', 'keeper_log')),
    owner_id TEXT NOT NULL,
    project_folder_id TEXT,
    title TEXT NOT NULL,
    head_leaf_seq BIGINT NOT NULL CHECK (head_leaf_seq >= 0),
    head_rev_id TEXT NOT NULL,
    next_entry_seq BIGINT NOT NULL CHECK (next_entry_seq >= 1),
    active_run_id TEXT,
    ext_space_tainted_mask INTEGER NOT NULL CHECK (ext_space_tainted_mask >= 0),
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
    created_at_sec BIGINT NOT NULL,
    created_at_nsec INTEGER NOT NULL CHECK (created_at_nsec >= 0 AND created_at_nsec < 1000000000),
    updated_at_sec BIGINT NOT NULL,
    updated_at_nsec INTEGER NOT NULL CHECK (updated_at_nsec >= 0 AND updated_at_nsec < 1000000000),
    active_run_epoch BIGINT CHECK (active_run_epoch IS NULL OR active_run_epoch >= 0),
    active_run_generation TEXT,
    PRIMARY KEY (space_id, thread_id),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id),
    FOREIGN KEY (space_id, project_folder_id) REFERENCES folder_heads (space_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_created_seq
    ON chat_threads (space_id, created_seq, thread_id);

CREATE TABLE IF NOT EXISTS chat_entries (
    space_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    entry_seq BIGINT NOT NULL CHECK (entry_seq >= 1),
    parent_seq BIGINT CHECK (parent_seq IS NULL OR (parent_seq >= 1 AND parent_seq < entry_seq)),
    revision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'model', 'tool', 'compaction', 'redacted')),
    tool_call_id TEXT CHECK ((kind = 'tool' AND tool_call_id IS NOT NULL) OR (kind <> 'tool' AND tool_call_id IS NULL)),
    author_id TEXT NOT NULL,
    agent_run_id TEXT,
    inline_text TEXT,
    payload_blake3 BYTEA CHECK (payload_blake3 IS NULL OR octet_length(payload_blake3) = 32),
    referenced_notes_json TEXT NOT NULL,
    ext_space_tainted INTEGER NOT NULL CHECK (ext_space_tainted IN (0, 1)),
    is_chain_node INTEGER NOT NULL CHECK (is_chain_node IN (0, 1)),
    branch_depth INTEGER NOT NULL CHECK (branch_depth >= 0),
    anc_16_seq BIGINT CHECK (anc_16_seq IS NULL OR (anc_16_seq >= 1 AND anc_16_seq < entry_seq)),
    anc_256_seq BIGINT CHECK (anc_256_seq IS NULL OR (anc_256_seq >= 1 AND anc_256_seq < entry_seq)),
    created_space_seq BIGINT NOT NULL CHECK (created_space_seq >= 1),
    redacted_at_seq BIGINT,
    checkpoint_stale INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_stale IN (0, 1)),
    human_origin INTEGER CHECK (human_origin IN (0, 1)),
    body_format INTEGER NOT NULL DEFAULT 0 CHECK (body_format IN (0, 1, 2)),
    provenance_json TEXT,
    PRIMARY KEY (space_id, thread_id, entry_seq),
    CHECK (
        (kind = 'redacted' AND inline_text IS NULL AND payload_blake3 IS NULL AND redacted_at_seq IS NOT NULL)
        OR (
            kind <> 'redacted'
            AND redacted_at_seq IS NULL
            AND (
                (inline_text IS NOT NULL AND octet_length(inline_text) <= 512 AND payload_blake3 IS NULL)
                OR (inline_text IS NULL AND payload_blake3 IS NOT NULL)
            )
        )
    ),
    FOREIGN KEY (space_id, thread_id) REFERENCES chat_threads (space_id, thread_id),
    FOREIGN KEY (space_id, thread_id, parent_seq) REFERENCES chat_entries (space_id, thread_id, entry_seq),
    FOREIGN KEY (space_id, thread_id, anc_16_seq) REFERENCES chat_entries (space_id, thread_id, entry_seq),
    FOREIGN KEY (space_id, thread_id, anc_256_seq) REFERENCES chat_entries (space_id, thread_id, entry_seq)
);

CREATE INDEX IF NOT EXISTS idx_chat_entries_parent
    ON chat_entries (space_id, thread_id, parent_seq)
    WHERE parent_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_entries_compaction
    ON chat_entries (space_id, thread_id, entry_seq)
    WHERE kind = 'compaction';

CREATE INDEX IF NOT EXISTS idx_chat_entries_projection
    ON chat_entries (space_id, thread_id, entry_seq)
    INCLUDE (revision_id, created_space_seq, redacted_at_seq, kind, checkpoint_stale);

CREATE INDEX IF NOT EXISTS idx_chat_entries_created_change
    ON chat_entries (space_id, created_space_seq, thread_id, entry_seq);

CREATE INDEX IF NOT EXISTS idx_chat_entries_redacted_change
    ON chat_entries (space_id, redacted_at_seq, thread_id, entry_seq)
    WHERE redacted_at_seq IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_entry_note_refs (
    space_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    entry_seq BIGINT NOT NULL,
    ref_ordinal BIGINT NOT NULL CHECK (ref_ordinal >= 0),
    target_space_id TEXT NOT NULL,
    target_note_id TEXT NOT NULL,
    created_space_seq BIGINT NOT NULL CHECK (created_space_seq >= 1),
    PRIMARY KEY (space_id, thread_id, entry_seq, ref_ordinal),
    FOREIGN KEY (space_id, thread_id, entry_seq)
        REFERENCES chat_entries (space_id, thread_id, entry_seq) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_entry_note_refs_created
    ON chat_entry_note_refs (space_id, created_space_seq, thread_id, entry_seq, ref_ordinal);

CREATE INDEX IF NOT EXISTS idx_chat_entry_note_refs_target
    ON chat_entry_note_refs (space_id, target_space_id, created_space_seq, thread_id, entry_seq, ref_ordinal);

CREATE TABLE IF NOT EXISTS chat_pending_inputs (
    space_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    input_id TEXT NOT NULL,
    ordinal BIGINT NOT NULL CHECK (ordinal >= 1),
    author_id TEXT NOT NULL,
    inline_text TEXT,
    payload_blake3 BYTEA CHECK (payload_blake3 IS NULL OR octet_length(payload_blake3) = 32),
    queued_base_leaf_seq BIGINT NOT NULL CHECK (queued_base_leaf_seq >= 0),
    in_flight_run_id TEXT NOT NULL,
    mentions_agent INTEGER NOT NULL CHECK (mentions_agent IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'cancelled')),
    enqueued_seq BIGINT NOT NULL CHECK (enqueued_seq >= 1),
    consumed_entry_seq BIGINT,
    ext_space_tainted INTEGER NOT NULL DEFAULT 0 CHECK (ext_space_tainted IN (0, 1)),
    PRIMARY KEY (space_id, thread_id, input_id),
    CHECK (
        (inline_text IS NOT NULL AND octet_length(inline_text) <= 512 AND payload_blake3 IS NULL)
        OR (inline_text IS NULL AND payload_blake3 IS NOT NULL)
    ),
    FOREIGN KEY (space_id, thread_id) REFERENCES chat_threads (space_id, thread_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_pending_inputs_ordinal
    ON chat_pending_inputs (space_id, thread_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_chat_pending_inputs_active
    ON chat_pending_inputs (space_id, thread_id, ordinal)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_chat_pending_inputs_consumed
    ON chat_pending_inputs (space_id, thread_id, consumed_entry_seq)
    WHERE status = 'consumed';

CREATE TABLE IF NOT EXISTS collab_sessions (
    space_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 0),
    lineage_epoch BIGINT NOT NULL CHECK (lineage_epoch >= 0),
    carrier_rev_id TEXT NOT NULL,
    yrs_snapshot_blake3 BYTEA CHECK (yrs_snapshot_blake3 IS NULL OR octet_length(yrs_snapshot_blake3) = 32),
    room_state TEXT NOT NULL CHECK (room_state IN ('closed', 'active', 'fenced')),
    owner_id TEXT,
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
    yrs_snapshot_blob BYTEA,
    PRIMARY KEY (space_id, note_id),
    FOREIGN KEY (space_id, note_id) REFERENCES note_heads (space_id, note_id)
);

CREATE TABLE IF NOT EXISTS collab_update_log (
    space_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 0),
    update_seq BIGINT NOT NULL CHECK (update_seq >= 1),
    update_bytes BYTEA NOT NULL,
    created_at_ms BIGINT NOT NULL,
    PRIMARY KEY (space_id, note_id, lease_epoch, update_seq),
    FOREIGN KEY (space_id, note_id) REFERENCES collab_sessions (space_id, note_id)
);

CREATE TABLE IF NOT EXISTS content_jobs (
    space_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    job_kind TEXT NOT NULL CHECK (job_kind IN ('import', 'export', 'backup', 'restore', 'reindex', 'reembed')),
    payload_msgpack BYTEA,
    payload_erased_by_purge INTEGER NOT NULL DEFAULT 0 CHECK (payload_erased_by_purge IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    lease_owner TEXT,
    lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 0),
    lease_until_ms BIGINT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    completed_units BIGINT NOT NULL DEFAULT 0 CHECK (completed_units >= 0),
    total_units BIGINT CHECK (total_units IS NULL OR total_units >= 0),
    artifacts_json TEXT NOT NULL,
    result_msgpack BYTEA,
    error_ref BYTEA CHECK (error_ref IS NULL OR octet_length(error_ref) = 32),
    created_seq BIGINT NOT NULL CHECK (created_seq >= 1),
    updated_seq BIGINT NOT NULL CHECK (updated_seq >= 1),
    PRIMARY KEY (space_id, job_id),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id)
);

CREATE INDEX IF NOT EXISTS idx_content_jobs_claim
    ON content_jobs (space_id, state, lease_until_ms, job_id);

CREATE TABLE IF NOT EXISTS materialized_observations (
    space_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    inode BIGINT,
    mtime_ns BIGINT,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    blake3_hash BYTEA NOT NULL CHECK (octet_length(blake3_hash) = 32),
    disk_identity BYTEA NOT NULL CHECK (octet_length(disk_identity) = 32),
    observed_revision TEXT NOT NULL,
    applied_seq BIGINT NOT NULL CHECK (applied_seq >= 1),
    PRIMARY KEY (space_id, note_id, rel_path),
    FOREIGN KEY (space_id, note_id) REFERENCES note_heads (space_id, note_id)
);

CREATE TABLE IF NOT EXISTS pending_purges (
    space_id TEXT NOT NULL,
    purge_id TEXT NOT NULL,
    history_incarnation BYTEA NOT NULL CHECK (octet_length(history_incarnation) = 16),
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    command_hash BYTEA NOT NULL CHECK (octet_length(command_hash) = 32),
    old_note_id TEXT NOT NULL,
    new_note_id TEXT,
    new_note_rev_id TEXT,
    canonical_seq BIGINT NOT NULL CHECK (canonical_seq >= 1),
    phase TEXT NOT NULL CHECK (phase IN ('sql_erased', 'cas_retired', 'completed')),
    retirement_ids_json TEXT NOT NULL,
    sanitized_response_msgpack BYTEA NOT NULL,
    last_safe_error TEXT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (space_id, purge_id),
    FOREIGN KEY (space_id) REFERENCES spaces (space_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_purges_phase
    ON pending_purges (space_id, phase);

CREATE TABLE IF NOT EXISTS account_catalog_receipts (
    owner_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    command_key TEXT NOT NULL,
    request_hash BYTEA NOT NULL CHECK (length(request_hash) = 32),
    result_msgpack BYTEA CHECK (length(result_msgpack) BETWEEN 1 AND 4096),
    PRIMARY KEY (owner_id, actor_id, command_key)
);

CREATE TABLE IF NOT EXISTS collab_checkpoints (
    space_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    snapshot_lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (snapshot_lease_epoch >= 0),
    snapshot_update_seq BIGINT NOT NULL DEFAULT 0 CHECK (snapshot_update_seq >= 0),
    carrier_dirty BIGINT NOT NULL DEFAULT 0 CHECK (carrier_dirty IN (0, 1)),
    PRIMARY KEY (space_id, note_id),
    FOREIGN KEY (space_id, note_id) REFERENCES collab_sessions (space_id, note_id) ON DELETE CASCADE
);
