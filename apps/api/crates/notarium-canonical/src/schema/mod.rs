pub mod manifest;
pub(crate) mod migrate;

use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    epoch::{DatabaseState, DatabaseWitness, SUPPORTED_V1_EPOCH},
    error::PortError,
    ids::{ContentDigest, InstallationId},
};
use sqlx::{PgConnection, Row, SqliteConnection};

use crate::{
    codec::{encode_timestamp_parts, internal_not_committed, now_utc_timestamp},
    schema::manifest::{
        CANONICAL_SCHEMA_VERSION, CANONICAL_TABLES, LogicalColKind, expected_index_names,
        expected_table_names, manifest_checksum,
    },
};

pub const SQLITE_BASELINE_DDL: &str = include_str!("sqlite_ddl.sql");
pub const POSTGRES_BASELINE_DDL: &str = include_str!("postgres_ddl.sql");

/// Splits embedded SQL scripts into individual top-level statements (`;` outside quotes).
pub fn split_sql_statements(script: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut chars = script.chars().peekable();

    while let Some(ch) = chars.next() {
        if !in_single_quote && ch == '-' && chars.peek() == Some(&'-') {
            for next in chars.by_ref() {
                if next == '\n' {
                    current.push('\n');
                    break;
                }
            }
            continue;
        }
        if ch == '\'' {
            if in_single_quote && chars.peek() == Some(&'\'') {
                current.push('\'');
                current.push('\'');
                chars.next();
                continue;
            }
            in_single_quote = !in_single_quote;
            current.push(ch);
            continue;
        }
        if ch == ';' && !in_single_quote {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                statements.push(trimmed.to_owned());
            }
            current.clear();
            continue;
        }
        current.push(ch);
    }
    let tail = current.trim();
    if !tail.is_empty() {
        statements.push(tail.to_owned());
    }
    statements
}

/// Initializes or validates the SQLite canonical baseline schema inside an exclusive transaction.
pub async fn bootstrap_sqlite_schema(
    conn: &mut SqliteConnection,
    expected_installation: &InstallationId,
) -> Result<DatabaseWitness, PortError> {
    let expected_checksum = manifest_checksum();

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_bootstrap_begin", err.to_string()))?;

    let outcome = bootstrap_sqlite_inner(conn, expected_installation, expected_checksum).await;
    match outcome {
        Ok(witness) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_bootstrap_commit", err.to_string())
                })?;
            Ok(witness)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

async fn bootstrap_sqlite_inner(
    conn: &mut SqliteConnection,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    let existing_tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_inspect_tables", err.to_string()))?;

    let has_schema_meta = existing_tables.iter().any(|name| name == "schema_meta");
    if !existing_tables.is_empty() && !has_schema_meta {
        return Err(internal_not_committed(
            "sqlite_unrecognized_schema",
            "tables exist without schema_meta witness",
        ));
    }

    if has_schema_meta {
        migrate::sqlite(conn, expected_installation, expected_checksum).await?;
        let witness =
            inspect_sqlite_schema_meta(conn, expected_installation, expected_checksum).await?;
        verify_sqlite_catalog(conn).await?;
        return Ok(witness);
    }

    let (now_sec, now_nsec) = encode_timestamp_parts(now_utc_timestamp()?);
    for stmt in split_sql_statements(SQLITE_BASELINE_DDL) {
        sqlx::query(sqlx::AssertSqlSafe(stmt))
            .execute(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_ddl_exec", err.to_string()))?;
    }

    sqlx::query(
        "INSERT INTO schema_meta (
            singleton_id, schema_version, epoch_version, installation_id,
            migration_state, manifest_checksum,
            initialized_at_sec, initialized_at_nsec, updated_at_sec, updated_at_nsec
        ) VALUES (1, ?, ?, ?, 'migrating', ?, ?, ?, ?, ?)",
    )
    .bind(i64::from(CANONICAL_SCHEMA_VERSION))
    .bind(i64::from(SUPPORTED_V1_EPOCH))
    .bind(expected_installation.as_str())
    .bind(expected_checksum.as_bytes().as_slice())
    .bind(now_sec)
    .bind(now_nsec)
    .bind(now_sec)
    .bind(now_nsec)
    .execute(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_insert_schema_meta", err.to_string()))?;

    verify_sqlite_catalog(conn).await?;

    sqlx::query("UPDATE schema_meta SET migration_state = 'ready' WHERE singleton_id = 1")
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_mark_ready", err.to_string()))?;

    inspect_sqlite_schema_meta(conn, expected_installation, expected_checksum).await
}

async fn inspect_sqlite_schema_meta(
    conn: &mut SqliteConnection,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    let row = sqlx::query(
        "SELECT schema_version, epoch_version, installation_id, migration_state, manifest_checksum
         FROM schema_meta WHERE singleton_id = 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_read_schema_meta", err.to_string()))?
    .ok_or_else(|| {
        internal_not_committed("sqlite_missing_schema_meta_row", "singleton row 1 absent")
    })?;

    let schema_version: i64 = row.get("schema_version");
    let epoch_version: i64 = row.get("epoch_version");
    let installation_raw: String = row.get("installation_id");
    let migration_state: String = row.get("migration_state");
    let checksum_bytes: Vec<u8> = row.get("manifest_checksum");

    validate_meta_fields(
        schema_version,
        epoch_version,
        &installation_raw,
        &migration_state,
        &checksum_bytes,
        expected_installation,
        expected_checksum,
    )
}

/// Initializes or validates the PostgreSQL canonical baseline schema inside an advisory-locked transaction.
pub async fn bootstrap_postgres_schema(
    conn: &mut PgConnection,
    schema_name: &str,
    expected_installation: &InstallationId,
) -> Result<DatabaseWitness, PortError> {
    let schema_name = crate::config::validate_pg_schema_name(schema_name)?;
    let expected_checksum = manifest_checksum();

    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_bootstrap_begin", err.to_string()))?;

    let outcome =
        bootstrap_postgres_inner(conn, schema_name, expected_installation, expected_checksum).await;

    match outcome {
        Ok(witness) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|err| internal_not_committed("pg_bootstrap_commit", err.to_string()))?;
            Ok(witness)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

async fn bootstrap_postgres_inner(
    conn: &mut PgConnection,
    schema_name: &str,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 7311229))")
        .bind(schema_name)
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_bootstrap_snapshot_fence", err.to_string()))?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 20261115))")
        .bind(schema_name)
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_migration_lock", err.to_string()))?;

    let create_schema_sql = format!("CREATE SCHEMA IF NOT EXISTS \"{schema_name}\"");
    sqlx::query(sqlx::AssertSqlSafe(create_schema_sql))
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_create_schema", err.to_string()))?;

    let set_path_sql = format!("SET LOCAL search_path TO \"{schema_name}\"");
    sqlx::query(sqlx::AssertSqlSafe(set_path_sql))
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_set_search_path", err.to_string()))?;

    let existing_tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    )
    .bind(schema_name)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_inspect_tables", err.to_string()))?;

    let has_schema_meta = existing_tables.iter().any(|t| t == "schema_meta");
    if !existing_tables.is_empty() && !has_schema_meta {
        return Err(internal_not_committed(
            "pg_unrecognized_schema",
            "tables exist without schema_meta witness",
        ));
    }

    if has_schema_meta {
        migrate::postgres(conn, expected_installation, expected_checksum).await?;
        let witness =
            inspect_postgres_schema_meta(conn, expected_installation, expected_checksum).await?;
        verify_postgres_catalog(conn, schema_name).await?;
        ensure_postgres_helper_routines(conn).await?;
        return Ok(witness);
    }

    let (now_sec, now_nsec) = encode_timestamp_parts(now_utc_timestamp()?);
    for stmt in split_sql_statements(POSTGRES_BASELINE_DDL) {
        sqlx::query(sqlx::AssertSqlSafe(stmt))
            .execute(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("pg_ddl_exec", err.to_string()))?;
    }
    ensure_postgres_helper_routines(conn).await?;

    sqlx::query(
        "INSERT INTO schema_meta (
            singleton_id, schema_version, epoch_version, installation_id,
            migration_state, manifest_checksum,
            initialized_at_sec, initialized_at_nsec, updated_at_sec, updated_at_nsec
        ) VALUES (1, $1, $2, $3, 'migrating', $4, $5, $6, $5, $6)",
    )
    .bind(CANONICAL_SCHEMA_VERSION as i32)
    .bind(SUPPORTED_V1_EPOCH as i32)
    .bind(expected_installation.as_str())
    .bind(expected_checksum.as_bytes().as_slice())
    .bind(now_sec)
    .bind(now_nsec)
    .execute(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_insert_schema_meta", err.to_string()))?;

    verify_postgres_catalog(conn, schema_name).await?;

    sqlx::query("UPDATE schema_meta SET migration_state = 'ready' WHERE singleton_id = 1")
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_mark_ready", err.to_string()))?;

    inspect_postgres_schema_meta(conn, expected_installation, expected_checksum).await
}

async fn ensure_postgres_helper_routines(conn: &mut PgConnection) -> Result<(), PortError> {
    const PG_FAST_ROLLBACK_FN_SQL: &str = r#"
CREATE OR REPLACE FUNCTION notarium_pg_fast_rollback_prep_v1(
    p_space_id TEXT,
    p_inc BYTEA,
    p_actor_id TEXT,
    p_idemp_key TEXT,
    p_run_id TEXT,
    p_exp_nids TEXT[]
) RETURNS TABLE (
    o_kind INT4,
    t1 TEXT, t2 TEXT, t3 TEXT, t4 TEXT, t5 TEXT, t6 TEXT, t7 TEXT, t8 TEXT, t9 TEXT,
    t10 TEXT, t11 TEXT, t12 TEXT, t13 TEXT, t14 TEXT, t15 TEXT, t16 TEXT, t17 TEXT, t18 TEXT,
    i1 BIGINT, i2 BIGINT, i3 INT4,
    b1 BYTEA, b2 BYTEA, b3 BYTEA
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    WITH sp_row AS (
        SELECT
            s.history_incarnation AS s_inc,
            s.root_folder_id AS s_root,
            s.space_kind AS s_kind,
            s.lifecycle_state AS s_lc,
            s.active_epoch AS s_epoch,
            s.last_seq AS s_last_seq,
            cr.command_hash AS cr_hash,
            cr.status AS cr_status,
            cr.response_payload_id AS cr_rpid,
            CASE
                WHEN cr.command_hash IS NULL THEN arh.history_incarnation
                WHEN cr.response_payload_id IS NOT NULL
                     AND COALESCE(cp.erased_by_purge, 1) = 0
                     AND cp.effect_msgpack IS NOT NULL THEN cp.effect_msgpack
                ELSE cr.sanitized_envelope_msgpack
            END AS b3_payload,
            (
                (CASE WHEN EXISTS(SELECT 1 FROM board_move_history WHERE space_id = p_space_id) THEN 1 ELSE 0 END)
                | (CASE WHEN EXISTS(SELECT 1 FROM revision_purge_fences WHERE space_id = p_space_id) THEN 2 ELSE 0 END)
                | (CASE WHEN EXISTS(SELECT 1 FROM collab_sessions WHERE space_id = p_space_id) THEN 4 ELSE 0 END)
                | (CASE WHEN EXISTS(SELECT 1 FROM view_rank_overlays WHERE space_id = p_space_id) THEN 8 ELSE 0 END)
                | (CASE WHEN EXISTS(SELECT 1 FROM space_field_schemas WHERE space_id = p_space_id AND is_current = 1) THEN 16 ELSE 0 END)
                | (CASE WHEN COALESCE(rf.is_root, 0) <> 0 THEN 64 ELSE 0 END)
                | (CASE WHEN COALESCE(rf.is_project, 0) <> 0 THEN 128 ELSE 0 END)
                | (CASE WHEN EXISTS(
                    SELECT 1 FROM revisions rx
                    WHERE rx.space_id = p_space_id
                      AND rx.agent_run_id = p_run_id
                      AND rx.agent_run_id IS NOT NULL
                      AND rx.entity_type = 'note'
                      AND NOT (rx.entity_key = ANY(p_exp_nids))
                ) THEN 512 ELSE 0 END)
            )::INT4 AS flags,
            arh.run_revision AS run_rev,
            rf.folder_id AS rf_id,
            rf.parent_folder_id AS rf_parent,
            rf.slug AS rf_slug,
            rf.slug_fold AS rf_slug_fold,
            rf.display_name AS rf_display_name,
            rf.project_slug AS rf_project_slug,
            rf.project_slug_fold AS rf_project_slug_fold,
            rf.description AS rf_description,
            rf.cover_note_id AS rf_cover,
            rf.write_lock_json AS rf_write_lock,
            rf.lifecycle_state AS rf_lc,
            rf.head_rev_id AS rf_head_rev
        FROM spaces s
        LEFT JOIN command_receipts cr
            ON cr.space_id = s.space_id AND cr.history_incarnation = p_inc
           AND cr.actor_id = p_actor_id AND cr.idempotency_key = p_idemp_key
        LEFT JOIN LATERAL (
            SELECT cp_inner.erased_by_purge, cp_inner.effect_msgpack
            FROM change_payloads cp_inner
            WHERE cr.response_payload_id IS NOT NULL
              AND cp_inner.space_id = s.space_id
              AND cp_inner.payload_id = cr.response_payload_id
            LIMIT 1
        ) cp ON TRUE
        LEFT JOIN agent_run_heads arh
            ON arh.space_id = s.space_id AND arh.run_id = p_run_id
        LEFT JOIN folder_heads rf
            ON rf.space_id = s.space_id AND rf.folder_id = s.root_folder_id
        WHERE s.space_id = p_space_id
    ),
    rev_win AS (
        SELECT
            r.entity_key,
            r.rev_id,
            r.space_seq,
            r.content_blake3,
            r.metadata_msgpack,
            MIN(r.space_seq) FILTER (WHERE r.agent_run_id = p_run_id) OVER (PARTITION BY r.entity_key) AS first_run_seq,
            MAX(r.space_seq) FILTER (WHERE r.agent_run_id IS DISTINCT FROM p_run_id) OVER (PARTITION BY r.entity_key) AS max_other_seq
        FROM sp_row sp
        JOIN revisions r
          ON r.space_id = p_space_id AND r.entity_type = 'note' AND r.entity_key = ANY(p_exp_nids)
        WHERE sp.cr_hash IS NULL AND (sp.flags & 543) = 0
    ),
    note_revs AS (
        SELECT DISTINCT ON (rw.entity_key)
            rw.entity_key,
            rw.rev_id AS source_rev_id,
            rw.metadata_msgpack AS source_meta,
            rw.first_run_seq,
            (rw.max_other_seq IS NOT NULL AND rw.first_run_seq IS NOT NULL AND rw.max_other_seq > rw.first_run_seq) AS has_foreign,
            CASE
                WHEN rw.first_run_seq IS NOT NULL
                 AND NOT (rw.max_other_seq IS NOT NULL AND rw.max_other_seq > rw.first_run_seq)
                 AND rw.space_seq < rw.first_run_seq
                THEN rw.rev_id
                ELSE NULL
            END AS pre_rev_id,
            CASE
                WHEN rw.first_run_seq IS NOT NULL
                 AND NOT (rw.max_other_seq IS NOT NULL AND rw.max_other_seq > rw.first_run_seq)
                 AND rw.space_seq < rw.first_run_seq
                THEN rw.content_blake3
                ELSE NULL
            END AS pre_digest,
            CASE
                WHEN rw.first_run_seq IS NOT NULL
                 AND NOT (rw.max_other_seq IS NOT NULL AND rw.max_other_seq > rw.first_run_seq)
                 AND rw.space_seq < rw.first_run_seq
                THEN rw.metadata_msgpack
                ELSE NULL
            END AS pre_meta
        FROM rev_win rw
        ORDER BY
            rw.entity_key,
            (rw.first_run_seq IS NOT NULL AND rw.space_seq < rw.first_run_seq) DESC,
            rw.space_seq DESC
    ),
    heads AS (
        SELECT nh.note_id, nh.parent_folder_id, nh.slug, nh.slug_fold, nh.title, nh.doc_class,
               nh.ability_id, nh.head_rev_id, nh.content_blake3, nh.byte_size, nh.lifecycle_state, nh.visibility_mask
        FROM sp_row sp
        JOIN note_heads nh
          ON nh.space_id = p_space_id AND nh.note_id = ANY(p_exp_nids)
        WHERE sp.cr_hash IS NULL AND (sp.flags & 543) = 0
    ),
    digests AS (
        SELECT pre_digest AS d FROM note_revs WHERE pre_digest IS NOT NULL
        UNION
        SELECT content_blake3 AS d FROM heads WHERE content_blake3 IS NOT NULL
    ),
    cat AS (
        SELECT bc.content_blake3, bc.admission_state, bc.blob_state, bc.current_publication_id
        FROM blob_catalog bc
        JOIN digests dg ON bc.content_blake3 = dg.d
        WHERE bc.space_id = p_space_id
    )
    SELECT
        0::INT4,
        s_root, s_kind, s_lc, cr_status, cr_rpid, run_rev,
        rf_id, rf_parent, rf_slug, rf_slug_fold, rf_display_name,
        rf_project_slug, rf_project_slug_fold, rf_description,
        rf_cover, rf_write_lock, rf_lc, rf_head_rev,
        s_epoch, s_last_seq, flags,
        s_inc, cr_hash, b3_payload
    FROM sp_row
    UNION ALL
    SELECT
        1::INT4,
        entity_key, pre_rev_id, CASE WHEN pre_rev_id IS NULL AND NOT has_foreign THEN source_rev_id END, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        COALESCE(first_run_seq, -1)::BIGINT, 0::BIGINT, (CASE WHEN has_foreign THEN 1 ELSE 0 END)::INT4,
        pre_digest, pre_meta, CASE WHEN pre_rev_id IS NULL AND NOT has_foreign THEN source_meta END
    FROM note_revs
    UNION ALL
    SELECT
        2::INT4,
        note_id, parent_folder_id, slug, slug_fold, title, doc_class,
        ability_id, head_rev_id, lifecycle_state, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        byte_size, 0::BIGINT, visibility_mask,
        content_blake3, NULL::BYTEA, NULL::BYTEA
    FROM heads
    UNION ALL
    SELECT
        3::INT4,
        admission_state, blob_state, current_publication_id, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        0::BIGINT, 0::BIGINT, 0::INT4,
        content_blake3, NULL::BYTEA, NULL::BYTEA
    FROM cat;
END;
$$;

CREATE OR REPLACE FUNCTION notarium_pg_fast_rollback_apply_v1(
    p_space_id TEXT,
    p_inc BYTEA,
    p_epoch BIGINT,
    p_expected_before BIGINT,
    p_max_allowed_before BIGINT,
    p_delta BIGINT,
    p_first_seq BIGINT,
    p_vis_seq BIGINT,
    p_sec BIGINT,
    p_nsec INT4,
    p_now_ms BIGINT,
    p_expires_ms BIGINT,
    p_actor_id TEXT,
    p_idemp_key TEXT,
    p_cmd_hash BYTEA,
    p_cmd_id TEXT,
    p_run_id TEXT,
    p_new_run_rev TEXT,
    p_run_meta BYTEA,
    p_owner_key TEXT,
    p_effect_pid TEXT,
    p_effect_codec TEXT,
    p_effect_blob BYTEA,
    p_resp_pid TEXT,
    p_resp_blob BYTEA,
    p_sanitized_blob BYTEA,
    p_noop_folder_id TEXT,
    p_has_full BOOL,
    p_has_trash BOOL,
    p_owner_nids TEXT[],
    p_chk_folders TEXT[],
    p_chk_slug_folds TEXT[],
    p_cat_digests BYTEA[],
    p_cat_deltas BIGINT[],
    p_m_is_full BOOL[],
    p_m_nids TEXT[],
    p_m_parents TEXT[],
    p_m_slugs TEXT[],
    p_m_slug_folds TEXT[],
    p_m_titles TEXT[],
    p_m_title_folds TEXT[],
    p_m_doc_classes TEXT[],
    p_m_abilities TEXT[],
    p_m_revs TEXT[],
    p_m_parent_revs TEXT[],
    p_m_restored_revs TEXT[],
    p_m_digests BYTEA[],
    p_m_pub_ids TEXT[],
    p_m_byte_sizes BIGINT[],
    p_m_lifecycles TEXT[],
    p_m_vis_masks INT4[],
    p_m_sseqs BIGINT[],
    p_m_metas BYTEA[],
    p_m_op_kinds TEXT[]
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_pre_code BIGINT;
    v_cat_ok BIGINT;
    v_bumped BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(current_schema(), 7311229));
    PERFORM 1
    FROM spaces
    WHERE space_id = p_space_id
      AND history_incarnation = p_inc
      AND active_epoch = p_epoch
      AND lifecycle_state = 'active'
      AND last_seq = p_expected_before
      AND last_seq <= p_max_allowed_before
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    SELECT
        CASE
            WHEN EXISTS (
                SELECT 1 FROM command_receipts
                WHERE space_id = p_space_id
                  AND history_incarnation = p_inc
                  AND actor_id = p_actor_id
                  AND idempotency_key = p_idemp_key
            ) OR EXISTS (
                SELECT 1 FROM collab_sessions WHERE space_id = p_space_id
            ) OR EXISTS (
                SELECT 1 FROM revision_purge_fences WHERE space_id = p_space_id
            ) THEN 0::BIGINT
            ELSE COALESCE((
                SELECT -u.idx
                FROM UNNEST(p_chk_folders, p_chk_slug_folds) WITH ORDINALITY AS u(parent_folder_id, slug_fold, idx)
                JOIN note_heads nh
                  ON nh.space_id = p_space_id
                 AND nh.parent_folder_id = u.parent_folder_id
                 AND nh.slug_fold = u.slug_fold
                 AND nh.lifecycle_state = 'active'
                WHERE NOT (nh.note_id = ANY(p_owner_nids))
                ORDER BY u.idx
                LIMIT 1
            ), 1::BIGINT)
        END
    INTO v_pre_code;

    IF v_pre_code <= 0 THEN
        RETURN v_pre_code;
    END IF;

    IF p_has_full AND p_has_trash THEN
        UPDATE note_heads AS nh
        SET head_rev_id = u.rev_id,
            lifecycle_state = 'trashed',
            updated_seq = p_vis_seq,
            updated_at_sec = p_sec,
            updated_at_nsec = p_nsec,
            last_actor_id = p_actor_id
        FROM UNNEST(p_m_nids, p_m_revs, p_m_op_kinds) AS u(nid, rev_id, op_kind)
        WHERE u.op_kind = 'trash'
          AND nh.space_id = p_space_id
          AND nh.note_id = u.nid;
    END IF;

    WITH muts AS MATERIALIZED (
        SELECT *
        FROM UNNEST(
            p_m_is_full, p_m_nids, p_m_parents, p_m_slugs, p_m_slug_folds,
            p_m_titles, p_m_title_folds, p_m_doc_classes, p_m_abilities,
            p_m_revs, p_m_parent_revs, p_m_restored_revs, p_m_digests, p_m_pub_ids,
            p_m_byte_sizes, p_m_lifecycles, p_m_vis_masks, p_m_sseqs, p_m_metas, p_m_op_kinds
        ) AS t(
            is_full, nid, parent_id, slug, slug_fold,
            title, title_fold, doc_class, ability_id,
            rev_id, parent_rev, restored_rev, digest, pub_id,
            byte_size, lifecycle_state, vis_mask, sseq, meta, op_kind
        )
    ),
    w_cat AS (
        UPDATE blob_catalog AS bc
        SET ref_count = bc.ref_count + u.delta,
            touched_at_ms = p_now_ms
        FROM UNNEST(p_cat_digests, p_cat_deltas) AS u(digest, delta)
        WHERE bc.space_id = p_space_id
          AND bc.content_blake3 = u.digest
          AND bc.admission_state = 'open'
          AND bc.blob_state = 'active'
        RETURNING 1
    ),
    w_nh AS (
        UPDATE note_heads AS nh
        SET parent_folder_id = CASE WHEN m.is_full THEN m.parent_id ELSE nh.parent_folder_id END,
            slug = CASE WHEN m.is_full THEN m.slug ELSE nh.slug END,
            slug_fold = CASE WHEN m.is_full THEN m.slug_fold ELSE nh.slug_fold END,
            title = m.title,
            title_fold = m.title_fold,
            doc_class = m.doc_class,
            ability_id = m.ability_id,
            head_rev_id = m.rev_id,
            content_blake3 = m.digest,
            byte_size = m.byte_size,
            lifecycle_state = m.lifecycle_state,
            visibility_mask = m.vis_mask,
            updated_seq = p_vis_seq,
            updated_at_sec = p_sec,
            updated_at_nsec = p_nsec,
            last_actor_id = p_actor_id
        FROM muts m
        WHERE (NOT (p_has_full AND p_has_trash) OR m.op_kind <> 'trash')
          AND nh.space_id = p_space_id
          AND nh.note_id = m.nid
    ),
    w_br AS (
        INSERT INTO blob_references (
            space_id, owner_kind, owner_id, owner_rev_id, resource_key,
            content_blake3, publication_id, created_seq
        )
        SELECT p_space_id, 'note_revision', m.nid, m.rev_id, 'carrier',
               m.digest, m.pub_id, m.sseq
        FROM muts m
        WHERE m.digest IS NOT NULL AND m.pub_id IS NOT NULL
    ),
    w_rv AS (
        INSERT INTO revisions (
            space_id, history_incarnation, rev_id, entity_type, entity_key,
            space_seq, visibility_seq, parent_rev_id, their_rev_id, restored_from_rev_id,
            content_blake3, metadata_msgpack, patch_meta_json, actor_id, session_id,
            agent_run_id, quarantine_reason, created_at_sec, created_at_nsec
        )
        SELECT
            p_space_id, p_inc, m.rev_id, 'note', m.nid,
            m.sseq, p_vis_seq, m.parent_rev, NULL, m.restored_rev,
            m.digest, m.meta, NULL, p_actor_id, NULL,
            NULL, NULL, p_sec, p_nsec
        FROM muts m
        UNION ALL
        SELECT
            p_space_id, p_inc, p_new_run_rev, 'agent_run', p_run_id,
            p_vis_seq, p_vis_seq, NULL, NULL, NULL,
            NULL, p_run_meta, NULL, p_actor_id, NULL,
            p_run_id, NULL, p_sec, p_nsec
    ),
    w_arh AS (
        UPDATE agent_run_heads
        SET history_incarnation = p_inc,
            run_revision = p_new_run_rev,
            last_seq = p_vis_seq,
            updated_at_sec = p_sec,
            updated_at_nsec = p_nsec
        WHERE space_id = p_space_id AND run_id = p_run_id
    ),
    w_cp AS (
        INSERT INTO change_payloads (space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq)
        VALUES
            (p_space_id, p_effect_pid, p_effect_codec, 0, p_effect_blob, p_vis_seq),
            (p_space_id, p_resp_pid, 'receipt_detail_v1', 0, p_resp_blob, p_vis_seq)
    ),
    w_cc AS (
        INSERT INTO change_commands (
            space_id, history_incarnation, command_id, first_seq, last_seq,
            command_kind, payload_id, committed_at_ms
        ) VALUES (
            p_space_id, p_inc, p_cmd_id, p_first_seq, p_vis_seq,
            'rollback_agent_run', p_effect_pid, p_now_ms
        )
    ),
    w_cl AS (
        INSERT INTO change_log (
            space_id, space_seq, history_incarnation, command_id,
            command_first_seq, command_last_seq, entity_type, entity_id,
            op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
        )
        SELECT
            p_space_id, m.sseq, p_inc, p_cmd_id,
            p_first_seq, p_vis_seq, 'note', m.nid,
            m.op_kind, m.rev_id, m.lifecycle_state, m.doc_class, p_effect_pid, p_now_ms
        FROM muts m
        UNION ALL
        SELECT
            p_space_id, p_first_seq, p_inc, p_cmd_id,
            p_first_seq, p_vis_seq, 'folder', p_noop_folder_id,
            'edit', p_new_run_rev, 'active', NULL, p_effect_pid, p_now_ms
        WHERE p_noop_folder_id IS NOT NULL
    ),
    w_cr AS (
        INSERT INTO command_receipts (
            space_id, history_incarnation, actor_id, idempotency_key, command_hash,
            status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
            canonical_seq, expires_at_ms
        ) VALUES (
            p_space_id, p_inc, p_actor_id, p_idemp_key, p_cmd_hash,
            'completed', 1, p_resp_pid, p_sanitized_blob,
            p_vis_seq, p_expires_ms
        )
    ),
    w_po AS (
        INSERT INTO payload_owners (space_id, payload_kind, payload_id, note_id)
        SELECT p_space_id, k.pkind, k.pid, u.nid
        FROM UNNEST(p_owner_nids) AS u(nid)
        CROSS JOIN (
            VALUES
                ('change_payload', p_effect_pid),
                ('command_receipt', p_owner_key)
        ) AS k(pkind, pid)
    ),
    w_sp AS (
        UPDATE spaces
        SET last_seq = last_seq + p_delta
        WHERE space_id = p_space_id
          AND history_incarnation = p_inc
          AND active_epoch = p_epoch
          AND last_seq = p_expected_before
          AND last_seq <= p_max_allowed_before
        RETURNING 1
    )
    SELECT
        (SELECT count(*) FROM w_cat),
        (SELECT count(*) FROM w_sp)
    INTO v_cat_ok, v_bumped;

    IF v_cat_ok <> COALESCE(cardinality(p_cat_digests), 0) THEN
        RAISE EXCEPTION 'NOTARIUM_RB_FALLBACK_0';
    END IF;

    IF v_bumped <> 1 THEN
        RAISE EXCEPTION 'notarium_pg_fast_rollback_space_bump_failed';
    END IF;

    RETURN 1;
END;
$$;
"#;

    let full_sql = format!("{PG_FAST_ROLLBACK_FN_SQL}\n{PG_LEAN_ROLLBACK_COMMIT_FN_SQL}");
    sqlx::raw_sql(sqlx::AssertSqlSafe(full_sql))
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_helper_routines_exec", err.to_string()))?;
    Ok(())
}

pub(crate) const PG_LEAN_ROLLBACK_READ_SQL: &str = r#"
WITH run_notes AS MATERIALIZED (
    SELECT entity_key, MIN(space_seq) AS first_seq
    FROM revisions
    WHERE space_id = $1 AND agent_run_id = $2 AND entity_type = 'note'
    GROUP BY entity_key
)
SELECT s.root_folder_id, s.space_kind, h.note_id, h.slug, h.slug_fold,
       h.head_rev_id, h.lifecycle_state, h.content_blake3,
       CASE WHEN prior.space_seq IS NULL THEN (
           SELECT cur.metadata_msgpack FROM revisions cur
           WHERE cur.space_id = $1 AND cur.rev_id = h.head_rev_id
             AND cur.entity_type = 'note' AND cur.entity_key = h.note_id
       ) END AS created_metadata,
       r.first_seq, prior.space_seq, prior.rev_id,
       CASE WHEN prior.space_seq < r.first_seq THEN prior.metadata_msgpack END AS prior_metadata,
       b.content_blake3 AS publication_digest, b.current_publication_id,
       cs.lease_epoch AS room_lease, cs.lineage_epoch AS room_lineage,
       (cs.note_id IS NULL OR (cs.room_state = 'closed' AND cs.owner_id IS NULL
           AND cs.carrier_rev_id = h.head_rev_id AND COALESCE(ck.carrier_dirty, 0) = 0
           AND NOT EXISTS(SELECT 1 FROM collab_update_log u WHERE u.space_id = cs.space_id AND u.note_id = cs.note_id))) AS room_writable
FROM spaces s
JOIN agent_run_heads a ON a.space_id = s.space_id AND a.run_id = $2
JOIN run_notes r ON r.entity_key = ANY($3::text[])
JOIN LATERAL (
    SELECT nh.* FROM note_heads nh WHERE nh.space_id = $1 AND nh.note_id = r.entity_key LIMIT 1
) h ON h.parent_folder_id = s.root_folder_id
LEFT JOIN collab_sessions cs ON cs.space_id = s.space_id AND cs.note_id = h.note_id
LEFT JOIN collab_checkpoints ck ON ck.space_id = cs.space_id AND ck.note_id = cs.note_id
LEFT JOIN LATERAL (
    SELECT v.space_seq, v.rev_id, v.metadata_msgpack, v.content_blake3
    FROM revisions v
    WHERE v.space_id = $1 AND v.entity_type = 'note' AND v.entity_key = r.entity_key
      AND v.agent_run_id IS DISTINCT FROM $2
    ORDER BY v.visibility_seq DESC, v.space_seq DESC
    LIMIT 1
) prior ON true
LEFT JOIN blob_catalog b ON b.space_id = s.space_id
      AND b.content_blake3 = CASE
          WHEN prior.space_seq IS NULL THEN h.content_blake3
          WHEN prior.space_seq < r.first_seq THEN prior.content_blake3 END
      AND b.admission_state = 'open' AND b.blob_state = 'active'
WHERE s.space_id = $1 AND s.history_incarnation = $4 AND s.active_epoch = $5
  AND s.lifecycle_state = 'active'
  AND a.history_incarnation = $4 AND a.run_revision = $6
  AND (SELECT count(*) FROM run_notes) = cardinality($3::text[])
  AND h.doc_class = 'user-doc' AND h.ability_id IS NULL AND h.visibility_mask >= 0
ORDER BY r.entity_key COLLATE "C"
"#;

pub(crate) const PG_LEAN_ROLLBACK_COMMIT_CALL_SQL: &str = "
SELECT notarium_pg_lean_commit_v3(
    $1, $2, $3, $4, $5, $6, $7, $8,
    $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    $21, $22, $23, $24, $25, $26, $27::TEXT[],
    $28::TEXT[], $29::TEXT[], $30::BYTEA[], $31::TEXT[], $32::BIGINT[],
    $33::TEXT[], $34::TEXT[], $35::TEXT[], $36::TEXT[], $37::BYTEA[], $38::BIGINT[], $39::BYTEA[], $40::TEXT[], $41::TEXT[],
    $42,
    $43::BYTEA[], $44::BIGINT[],
    $45::TEXT[], $46::TEXT[],
    $47::TEXT[], $48::TEXT[], $49::TEXT[], $50::TEXT[], $51::BYTEA[], $52::BIGINT[], $53::INT4[],
    $54::TEXT[], $55::TEXT[], $56::TEXT[], $57::TEXT[], $58::TEXT[], $59::TEXT[], $60::TEXT[], $61::BYTEA[], $62::BIGINT[], $63::TEXT[], $64::INT4[],
    $65::TEXT[], $66::TEXT[], $67::TEXT[], $68::TEXT[], $69, $70, $71::BIGINT[], $72::BIGINT[]
)
";

const PG_LEAN_ROLLBACK_COMMIT_FN_SQL: &str = r#"
DO $cleanup$
DECLARE old_signature regprocedure;
BEGIN
    FOR old_signature IN
        SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname = 'notarium_pg_lean_commit_v3'
          AND p.pronargs IN (69, 70)
    LOOP
        EXECUTE format('DROP FUNCTION %s', old_signature);
    END LOOP;
END;
$cleanup$;

CREATE OR REPLACE FUNCTION notarium_pg_lean_commit_v3(
    p_space_id TEXT,
    p_inc BYTEA,
    p_delta BIGINT,
    p_off_run_vis INT4,
    p_off_eff_first INT4,
    p_off_eff_vis INT4,
    p_off_resp_vis INT4,
    p_off_san_vis INT4,
    p_sec BIGINT,
    p_nsec INT4,
    p_now_ms BIGINT,
    p_expires_ms BIGINT,
    p_actor_id TEXT,
    p_idemp_key TEXT,
    p_cmd_hash BYTEA,
    p_cmd_id TEXT,
    p_run_id TEXT,
    p_exp_run_rev TEXT,
    p_new_run_rev TEXT,
    p_run_meta BYTEA,
    p_eff_pid TEXT,
    p_eff_blob BYTEA,
    p_resp_pid TEXT,
    p_resp_blob BYTEA,
    p_san_blob BYTEA,
    p_noop_folder TEXT,
    p_elig_nids TEXT[],
    p_br_nids TEXT[],
    p_br_revs TEXT[],
    p_br_digs BYTEA[],
    p_br_pubs TEXT[],
    p_br_rel_seqs BIGINT[],
    p_m_nids TEXT[],
    p_m_revs TEXT[],
    p_m_prev_revs TEXT[],
    p_m_rest_revs TEXT[],
    p_m_digs BYTEA[],
    p_m_rel_seqs BIGINT[],
    p_m_metas BYTEA[],
    p_m_lc TEXT[],
    p_m_ops TEXT[],
    p_owner_key TEXT,
    p_cat_digs BYTEA[],
    p_cat_deltas BIGINT[],
    p_tr_nids TEXT[],
    p_tr_revs TEXT[],
    p_hot_nids TEXT[],
    p_hot_t TEXT[],
    p_hot_tf TEXT[],
    p_hot_revs TEXT[],
    p_hot_digs BYTEA[],
    p_hot_bs BIGINT[],
    p_hot_vm INT4[],
    p_fl_nids TEXT[],
    p_fl_pf TEXT[],
    p_fl_s TEXT[],
    p_fl_sf TEXT[],
    p_fl_t TEXT[],
    p_fl_tf TEXT[],
    p_fl_revs TEXT[],
    p_fl_digs BYTEA[],
    p_fl_bs BIGINT[],
    p_fl_lc TEXT[],
    p_fl_vm INT4[],
    p_cat_pubs TEXT[],
    p_all_nids TEXT[],
    p_all_exp_revs TEXT[],
    p_all_exp_lcs TEXT[],
    p_root_folder_id TEXT,
    p_writer_epoch BIGINT,
    p_room_leases BIGINT[],
    p_room_lineages BIGINT[]
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_ok BOOL;
    v_base_seq BIGINT;
    v_exp_epoch BIGINT;
    v_first_seq BIGINT;
    v_vis_seq BIGINT;
    v_first_be BYTEA;
    v_vis_be BYTEA;
    v_cat_cnt INT4;
    v_mutated_rooms TEXT[];
    v_released_digests BYTEA[];
    v_room_count BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(current_schema(), 7311229));
    PERFORM 1 FROM spaces WHERE space_id = p_space_id AND active_epoch = p_writer_epoch FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    SELECT
        (
            s.history_incarnation = p_inc
            AND s.lifecycle_state = 'active'
            AND s.active_epoch = p_writer_epoch
            AND s.root_folder_id = p_root_folder_id
            AND NOT EXISTS(SELECT 1 FROM UNNEST(p_fl_pf) AS dest(folder) WHERE dest.folder IS DISTINCT FROM p_root_folder_id)
            AND s.last_seq >= 0
            AND p_delta >= 1
            AND s.last_seq <= (9223372036854775807 - p_delta)
            AND arh.history_incarnation = p_inc
            AND arh.run_revision = p_exp_run_rev
            AND (
                SELECT COUNT(*)
                FROM UNNEST(p_all_nids, p_all_exp_revs, p_all_exp_lcs, p_room_leases, p_room_lineages)
                     AS e(nid, exp_rev, exp_lc, room_lease, room_lineage)
                JOIN note_heads nh ON nh.space_id = p_space_id AND nh.note_id = e.nid
                LEFT JOIN collab_sessions cs ON cs.space_id = nh.space_id AND cs.note_id = nh.note_id
                LEFT JOIN collab_checkpoints ck ON ck.space_id = cs.space_id AND ck.note_id = cs.note_id
                WHERE nh.head_rev_id = e.exp_rev
                  AND cs.lease_epoch IS NOT DISTINCT FROM e.room_lease
                  AND cs.lineage_epoch IS NOT DISTINCT FROM e.room_lineage
                  AND (cs.note_id IS NULL OR (cs.room_state = 'closed' AND cs.owner_id IS NULL
                       AND cs.carrier_rev_id = e.exp_rev AND COALESCE(ck.carrier_dirty, 0) = 0
                       AND NOT EXISTS(SELECT 1 FROM collab_update_log u WHERE u.space_id = cs.space_id AND u.note_id = cs.note_id)))
                  AND nh.lifecycle_state = e.exp_lc
                  AND nh.parent_folder_id = p_root_folder_id
                  AND nh.doc_class = 'user-doc'
                  AND nh.ability_id IS NULL
                  AND nh.visibility_mask >= 0
            ) = cardinality(p_all_nids)
            AND NOT EXISTS(SELECT 1 FROM command_receipts WHERE space_id = p_space_id AND history_incarnation = p_inc AND actor_id = p_actor_id AND idempotency_key = p_idemp_key)
            AND NOT EXISTS(SELECT 1 FROM board_move_history WHERE space_id = p_space_id AND agent_run_id = p_run_id)
            AND NOT EXISTS(SELECT 1 FROM board_move_history WHERE space_id = p_space_id AND target_note_id = ANY(p_all_nids))
            AND NOT EXISTS(SELECT 1 FROM revision_purge_fences WHERE space_id = p_space_id AND note_id = ANY(p_all_nids))
            AND NOT EXISTS(SELECT 1 FROM view_rank_overlays WHERE space_id = p_space_id AND target_note_id = ANY(p_all_nids))
            AND NOT EXISTS(SELECT 1 FROM space_field_schemas WHERE space_id = p_space_id AND is_current = 1)
            AND EXISTS(SELECT 1 FROM folder_heads WHERE space_id = p_space_id AND folder_id = p_root_folder_id
                AND is_root = 1 AND lifecycle_state = 'active' AND write_lock_json IS NULL)
            AND NOT (
                COALESCE(cardinality(p_fl_nids), 0) > 0 AND EXISTS (
                    SELECT 1
                    FROM UNNEST(p_fl_pf, p_fl_sf, p_fl_lc) AS c(pf, sf, lc)
                    JOIN note_heads ox
                      ON ox.space_id = p_space_id
                     AND ox.parent_folder_id = c.pf
                     AND ox.slug_fold = c.sf
                     AND ox.lifecycle_state = 'active'
                    WHERE c.lc = 'active' AND NOT (ox.note_id = ANY(p_elig_nids))
                )
            )
        ),
        s.last_seq,
        s.active_epoch
    INTO v_ok, v_base_seq, v_exp_epoch
    FROM spaces s
    LEFT JOIN agent_run_heads arh ON arh.space_id = s.space_id AND arh.run_id = p_run_id
    WHERE s.space_id = p_space_id;

    IF NOT COALESCE(v_ok, false) THEN
        RETURN 0;
    END IF;

    v_first_seq := v_base_seq + 1;
    v_vis_seq := v_base_seq + p_delta;
    v_first_be := int8send(v_first_seq);
    v_vis_be := int8send(v_vis_seq);

    -- Phase A: Execute all 7 INSERTs in a single multi-CTE statement (1 SPI snapshot/executor cycle).
    WITH ins_br AS (
        INSERT INTO blob_references (
            space_id, owner_kind, owner_id, owner_rev_id, resource_key,
            content_blake3, publication_id, created_seq
        )
        SELECT p_space_id, 'note_revision', u.nid, u.rev, 'carrier',
               u.dig, u.pub, v_base_seq + u.rel_seq
        FROM UNNEST(p_br_nids, p_br_revs, p_br_digs, p_br_pubs, p_br_rel_seqs)
             AS u(nid, rev, dig, pub, rel_seq)
    ),
    ins_rev AS (
        INSERT INTO revisions (
            space_id, history_incarnation, rev_id, entity_type, entity_key,
            space_seq, visibility_seq, parent_rev_id, their_rev_id, restored_from_rev_id,
            content_blake3, metadata_msgpack, patch_meta_json, actor_id, session_id,
            agent_run_id, quarantine_reason, created_at_sec, created_at_nsec
        )
        SELECT p_space_id, p_inc, u.rev, 'note', u.nid,
               v_base_seq + u.rel_seq, v_vis_seq, u.prev_rev, NULL, u.rest_rev,
               u.dig, u.meta, NULL, p_actor_id, NULL,
               NULL, NULL, p_sec, p_nsec
        FROM UNNEST(p_m_nids, p_m_revs, p_m_prev_revs, p_m_rest_revs, p_m_digs, p_m_rel_seqs, p_m_metas)
             AS u(nid, rev, prev_rev, rest_rev, dig, rel_seq, meta)
        UNION ALL
        SELECT p_space_id, p_inc, p_new_run_rev, 'agent_run', p_run_id,
               v_vis_seq, v_vis_seq, NULL, NULL, NULL,
               NULL, overlay(p_run_meta placing v_vis_be from p_off_run_vis for 8), NULL, p_actor_id, NULL,
               p_run_id, NULL, p_sec, p_nsec
    ),
    ins_cp AS (
        INSERT INTO change_payloads (space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq)
        VALUES
            (
                p_space_id,
                p_eff_pid,
                'effect_v1',
                0,
                overlay(
                    overlay(p_eff_blob placing v_first_be from p_off_eff_first for 8)
                    placing v_vis_be from p_off_eff_vis for 8
                ),
                v_vis_seq
            ),
            (
                p_space_id,
                p_resp_pid,
                'receipt_detail_v1',
                0,
                overlay(p_resp_blob placing v_vis_be from p_off_resp_vis for 8),
                v_vis_seq
            )
    ),
    ins_cc AS (
        INSERT INTO change_commands (
            space_id, history_incarnation, command_id, first_seq, last_seq,
            command_kind, payload_id, committed_at_ms
        )
        VALUES (p_space_id, p_inc, p_cmd_id, v_first_seq, v_vis_seq, 'rollback_agent_run', p_eff_pid, p_now_ms)
    ),
    ins_cl AS (
        INSERT INTO change_log (
            space_id, space_seq, history_incarnation, command_id,
            command_first_seq, command_last_seq, entity_type, entity_id,
            op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
        )
        SELECT
            p_space_id, v_first_seq, p_inc, p_cmd_id,
            v_first_seq, v_vis_seq, 'folder', p_noop_folder,
            'edit', p_new_run_rev, 'active', NULL, p_eff_pid, p_now_ms
        WHERE p_noop_folder IS NOT NULL
        UNION ALL
        SELECT
            p_space_id, v_base_seq + u.rel_seq, p_inc, p_cmd_id,
            v_first_seq, v_vis_seq, 'note', u.nid,
            u.op, u.rev, u.lc, 'user-doc', p_eff_pid, p_now_ms
        FROM UNNEST(p_m_nids, p_m_revs, p_m_lc, p_m_rel_seqs, p_m_ops) AS u(nid, rev, lc, rel_seq, op)
        WHERE p_noop_folder IS NULL
    ),
    ins_po AS (
        INSERT INTO payload_owners (space_id, payload_kind, payload_id, note_id)
        SELECT p_space_id, k.pkind, k.pid, u.nid
        FROM (
            VALUES
                ('change_payload', p_eff_pid),
                ('command_receipt', p_owner_key)
        ) AS k(pkind, pid)
        CROSS JOIN UNNEST(p_elig_nids) AS u(nid)
    )
    INSERT INTO command_receipts (
        space_id, history_incarnation, actor_id, idempotency_key, command_hash,
        status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
        canonical_seq, expires_at_ms
    )
    VALUES (
        p_space_id, p_inc, p_actor_id, p_idemp_key, p_cmd_hash,
        'completed', 1, p_resp_pid, overlay(p_san_blob placing v_vis_be from p_off_san_vis for 8),
        v_vis_seq, p_expires_ms
    );

    -- Phase B: Execute pre-sliced UPDATEs last.
    IF COALESCE(cardinality(p_cat_digs), 0) > 0 THEN
        UPDATE blob_catalog AS bc
        SET ref_count = bc.ref_count + u.delta,
            touched_at_ms = p_now_ms
        FROM UNNEST(p_cat_digs, p_cat_deltas, p_cat_pubs) AS u(dig, delta, pub)
        WHERE bc.space_id = p_space_id
          AND bc.content_blake3 = u.dig
          AND bc.current_publication_id = u.pub
          AND bc.admission_state = 'open'
          AND bc.blob_state = 'active';
        GET DIAGNOSTICS v_cat_cnt = ROW_COUNT;
        IF v_cat_cnt <> cardinality(p_cat_digs) THEN
            RAISE EXCEPTION 'NOTARIUM_RB_FALLBACK_0';
        END IF;
    END IF;

    IF COALESCE(cardinality(p_tr_nids), 0) > 0 THEN
        UPDATE note_heads AS nh
        SET head_rev_id = u.rev,
            lifecycle_state = 'trashed',
            updated_seq = v_vis_seq,
            updated_at_sec = p_sec,
            updated_at_nsec = p_nsec,
            last_actor_id = p_actor_id
        FROM UNNEST(p_tr_nids, p_tr_revs) AS u(nid, rev)
        WHERE nh.space_id = p_space_id AND nh.note_id = u.nid;
    END IF;

    IF COALESCE(cardinality(p_hot_nids), 0) > 0 THEN
        UPDATE note_heads AS nh
        SET title = u.t,
            title_fold = u.tf,
            head_rev_id = u.rev,
            content_blake3 = u.dig,
            byte_size = u.bs,
            visibility_mask = u.vm,
            updated_seq = v_vis_seq,
            updated_at_sec = p_sec,
            updated_at_nsec = p_nsec,
            last_actor_id = p_actor_id
        FROM UNNEST(p_hot_nids, p_hot_t, p_hot_tf, p_hot_revs, p_hot_digs, p_hot_bs, p_hot_vm)
             AS u(nid, t, tf, rev, dig, bs, vm)
        WHERE nh.space_id = p_space_id AND nh.note_id = u.nid;
    END IF;

    IF COALESCE(cardinality(p_fl_nids), 0) > 0 THEN
        UPDATE note_heads AS nh
        SET parent_folder_id = u.pf,
            slug = u.s,
            slug_fold = u.sf,
            title = u.t,
            title_fold = u.tf,
            doc_class = 'user-doc',
            ability_id = NULL,
            head_rev_id = u.rev,
            content_blake3 = u.dig,
            byte_size = u.bs,
            lifecycle_state = u.lc,
            visibility_mask = u.vm,
            updated_seq = v_vis_seq,
            updated_at_sec = p_sec,
            updated_at_nsec = p_nsec,
            last_actor_id = p_actor_id
        FROM UNNEST(p_fl_nids, p_fl_pf, p_fl_s, p_fl_sf, p_fl_t, p_fl_tf, p_fl_revs, p_fl_digs, p_fl_bs, p_fl_lc, p_fl_vm)
             AS u(nid, pf, s, sf, t, tf, rev, dig, bs, lc, vm)
        WHERE nh.space_id = p_space_id AND nh.note_id = u.nid;
    END IF;

    -- A direct carrier revision starts a new lineage for each existing closed room.
    -- No-ops, skipped notes and notes without a session have no durable room effect.
    SELECT ARRAY(
        SELECT r.nid FROM unnest(p_all_nids, p_room_leases) AS r(nid, lease)
        WHERE r.lease IS NOT NULL AND r.nid = ANY(p_m_nids)
    ) INTO v_mutated_rooms;
    IF cardinality(v_mutated_rooms) > 0 THEN
        UPDATE collab_sessions AS cs
        SET lineage_epoch = cs.lineage_epoch + 1, carrier_rev_id = m.rev,
            updated_seq = v_vis_seq, yrs_snapshot_blob = NULL, yrs_snapshot_blake3 = NULL
        FROM unnest(p_m_nids, p_m_revs) AS m(nid, rev)
        WHERE cs.space_id = p_space_id AND cs.note_id = m.nid
          AND cs.note_id = ANY(v_mutated_rooms);
        GET DIAGNOSTICS v_room_count = ROW_COUNT;
        IF v_room_count <> cardinality(v_mutated_rooms) THEN
            RAISE EXCEPTION 'NOTARIUM_RB_FALLBACK_0';
        END IF;

        DELETE FROM collab_checkpoints WHERE space_id = p_space_id AND note_id = ANY(v_mutated_rooms);
        WITH released AS (
            DELETE FROM blob_references
            WHERE space_id = p_space_id AND owner_kind = 'collab_snapshot' AND owner_id = ANY(v_mutated_rooms)
            RETURNING content_blake3
        )
        SELECT ARRAY(SELECT DISTINCT content_blake3 FROM released) INTO v_released_digests;

        -- Use a new statement snapshot after both new revision refs and released snapshot refs.
        IF cardinality(v_released_digests) > 0 THEN
            WITH remaining AS MATERIALIZED (
                SELECT r.content_blake3, count(*) AS refs
                FROM blob_references r
                WHERE r.space_id = p_space_id AND r.content_blake3 = ANY(v_released_digests)
                GROUP BY r.content_blake3
            )
            UPDATE blob_catalog AS b
            SET ref_count = COALESCE(t.refs, 0), touched_at_ms = p_now_ms
            FROM unnest(v_released_digests) AS d(digest)
            LEFT JOIN remaining t ON t.content_blake3 = d.digest
            WHERE b.space_id = p_space_id AND b.content_blake3 = d.digest;
        END IF;
    END IF;

    UPDATE agent_run_heads
    SET history_incarnation = p_inc,
        run_revision = p_new_run_rev,
        last_seq = v_vis_seq,
        updated_at_sec = p_sec,
        updated_at_nsec = p_nsec
    WHERE space_id = p_space_id AND run_id = p_run_id;

    UPDATE spaces
    SET last_seq = v_vis_seq
    WHERE space_id = p_space_id
      AND history_incarnation = p_inc
      AND active_epoch = v_exp_epoch
      AND last_seq = v_base_seq;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOTARIUM_RB_FALLBACK_0';
    END IF;

    RETURN v_vis_seq;
END;
$$;
"#;

async fn inspect_postgres_schema_meta(
    conn: &mut PgConnection,
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    let row = sqlx::query(
        "SELECT schema_version, epoch_version, installation_id, migration_state, manifest_checksum
         FROM schema_meta WHERE singleton_id = 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_read_schema_meta", err.to_string()))?
    .ok_or_else(|| {
        internal_not_committed("pg_missing_schema_meta_row", "singleton row 1 absent")
    })?;

    let schema_version: i32 = row.get("schema_version");
    let epoch_version: i32 = row.get("epoch_version");
    let installation_raw: String = row.get("installation_id");
    let migration_state: String = row.get("migration_state");
    let checksum_bytes: Vec<u8> = row.get("manifest_checksum");

    validate_meta_fields(
        i64::from(schema_version),
        i64::from(epoch_version),
        &installation_raw,
        &migration_state,
        &checksum_bytes,
        expected_installation,
        expected_checksum,
    )
}

fn validate_meta_fields(
    schema_version: i64,
    epoch_version: i64,
    installation_raw: &str,
    migration_state: &str,
    checksum_bytes: &[u8],
    expected_installation: &InstallationId,
    expected_checksum: ContentDigest,
) -> Result<DatabaseWitness, PortError> {
    if epoch_version != i64::from(SUPPORTED_V1_EPOCH) {
        return Err(internal_not_committed(
            "unsupported_epoch_version",
            format!("epoch_version={epoch_version}"),
        ));
    }
    if schema_version != i64::from(CANONICAL_SCHEMA_VERSION) {
        return Err(internal_not_committed(
            "unsupported_schema_version",
            format!("schema_version={schema_version}, supported={CANONICAL_SCHEMA_VERSION}"),
        ));
    }
    let installation_id = InstallationId::parse(installation_raw).map_err(|_| {
        internal_not_committed(
            "invalid_installation_id",
            "schema_meta.installation_id malformed",
        )
    })?;
    if &installation_id != expected_installation {
        return Err(internal_not_committed(
            "installation_mismatch",
            format!("expected {expected_installation}, found {installation_id}"),
        ));
    }
    let state = match migration_state {
        "ready" => DatabaseState::Ready,
        "migrating" => {
            return Err(internal_not_committed(
                "incomplete_migration_state",
                "schema_meta.migration_state is still 'migrating'",
            ));
        }
        other => {
            return Err(internal_not_committed(
                "invalid_migration_state",
                format!("unexpected migration_state '{other}'"),
            ));
        }
    };
    if checksum_bytes != expected_checksum.as_bytes() {
        return Err(internal_not_committed(
            "schema_checksum_mismatch",
            "schema_meta.manifest_checksum does not match canonical manifest",
        ));
    }
    Ok(DatabaseWitness {
        epoch_version: SUPPORTED_V1_EPOCH,
        installation_id,
        state,
    })
}

/// Verifies that the live SQLite database catalog matches `CANONICAL_TABLES` with zero virtual/shadow tables.
pub async fn verify_sqlite_catalog(conn: &mut SqliteConnection) -> Result<(), PortError> {
    let rows = sqlx::query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_catalog_tables", err.to_string()))?;

    let mut observed_tables = BTreeSet::new();
    for row in &rows {
        let name: String = row.get("name");
        let sql: Option<String> = row.get("sql");
        if sql
            .as_deref()
            .is_some_and(|text| text.to_ascii_uppercase().contains("VIRTUAL TABLE"))
        {
            return Err(internal_not_committed(
                "sqlite_forbidden_virtual_table",
                format!("virtual table '{name}' is forbidden"),
            ));
        }
        observed_tables.insert(name);
    }

    let expected_tables: BTreeSet<String> = expected_table_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    if observed_tables != expected_tables {
        return Err(internal_not_committed(
            "sqlite_table_mismatch",
            format!("expected {expected_tables:?}, observed {observed_tables:?}"),
        ));
    }

    for spec in CANONICAL_TABLES {
        let pragma_sql = format!("PRAGMA table_info(\"{}\")", spec.name);
        let col_rows = sqlx::query(sqlx::AssertSqlSafe(pragma_sql))
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_table_info", err.to_string()))?;

        if col_rows.len() != spec.columns.len() {
            return Err(internal_not_committed(
                "sqlite_column_count_mismatch",
                format!(
                    "table {} expected {} columns, found {}",
                    spec.name,
                    spec.columns.len(),
                    col_rows.len()
                ),
            ));
        }

        let mut pk_by_pos = BTreeMap::<i64, String>::new();
        for (col_row, col_spec) in col_rows.iter().zip(spec.columns.iter()) {
            let name: String = col_row.get("name");
            let col_type: String = col_row.get("type");
            let notnull: i64 = col_row.get("notnull");
            let pk_pos: i64 = col_row.get("pk");

            if name != col_spec.name {
                return Err(internal_not_committed(
                    "sqlite_column_name_mismatch",
                    format!(
                        "table {}: expected {}, found {name}",
                        spec.name, col_spec.name
                    ),
                ));
            }
            let expected_type = match col_spec.kind {
                LogicalColKind::Int => "INTEGER",
                LogicalColKind::Text => "TEXT",
                LogicalColKind::Bytes => "BLOB",
            };
            if col_type.to_ascii_uppercase() != expected_type {
                return Err(internal_not_committed(
                    "sqlite_column_type_mismatch",
                    format!(
                        "table {}.{}: expected {expected_type}, found {col_type}",
                        spec.name, name
                    ),
                ));
            }
            let is_nullable = notnull == 0 && pk_pos == 0;
            if is_nullable != col_spec.nullable {
                return Err(internal_not_committed(
                    "sqlite_column_nullability_mismatch",
                    format!(
                        "table {}.{}: expected nullable={}, found {is_nullable}",
                        spec.name, name, col_spec.nullable
                    ),
                ));
            }
            if pk_pos > 0 {
                pk_by_pos.insert(pk_pos, name);
            }
        }

        let observed_pk: Vec<&str> = pk_by_pos.values().map(String::as_str).collect();
        if observed_pk.as_slice() != spec.primary_key {
            return Err(internal_not_committed(
                "sqlite_pk_mismatch",
                format!(
                    "table {}: expected PK {:?}, found {observed_pk:?}",
                    spec.name, spec.primary_key
                ),
            ));
        }
    }

    let without_rowid: i64 = sqlx::query_scalar(
        "SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = 'blob_catalog'",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_catalog_layout", err.to_string()))?;
    if without_rowid != 1 {
        return Err(internal_not_committed(
            "sqlite_catalog_layout",
            "blob_catalog requires WITHOUT ROWID",
        ));
    }

    let idx_rows: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("sqlite_catalog_indexes", err.to_string()))?;

    let observed_indexes: BTreeSet<&str> = idx_rows.iter().map(String::as_str).collect();
    let expected_indexes = expected_index_names();
    if observed_indexes != expected_indexes {
        return Err(internal_not_committed(
            "sqlite_index_mismatch",
            format!("expected {expected_indexes:?}, observed {observed_indexes:?}"),
        ));
    }

    Ok(())
}

/// Verifies that the live PostgreSQL catalog matches `CANONICAL_TABLES` including `spaces` `fillfactor=70`.
pub async fn verify_postgres_catalog(
    conn: &mut PgConnection,
    schema_name: &str,
) -> Result<(), PortError> {
    let observed_tables_vec: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    )
    .bind(schema_name)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_catalog_tables", err.to_string()))?;

    let observed_tables: BTreeSet<&str> = observed_tables_vec.iter().map(String::as_str).collect();
    let expected_tables = expected_table_names();
    if observed_tables != expected_tables {
        return Err(internal_not_committed(
            "pg_table_mismatch",
            format!("expected {expected_tables:?}, observed {observed_tables:?}"),
        ));
    }

    for spec in CANONICAL_TABLES {
        let col_rows = sqlx::query(
            "SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position ASC",
        )
        .bind(schema_name)
        .bind(spec.name)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_table_columns", err.to_string()))?;

        if col_rows.len() != spec.columns.len() {
            return Err(internal_not_committed(
                "pg_column_count_mismatch",
                format!(
                    "table {} expected {} columns, found {}",
                    spec.name,
                    spec.columns.len(),
                    col_rows.len()
                ),
            ));
        }

        for (col_row, col_spec) in col_rows.iter().zip(spec.columns.iter()) {
            let name: String = col_row.get("column_name");
            let data_type: String = col_row.get("data_type");
            let is_nullable_raw: String = col_row.get("is_nullable");
            if name != col_spec.name {
                return Err(internal_not_committed(
                    "pg_column_name_mismatch",
                    format!(
                        "table {}: expected {}, found {name}",
                        spec.name, col_spec.name
                    ),
                ));
            }
            let type_ok = match col_spec.kind {
                LogicalColKind::Int => data_type == "integer" || data_type == "bigint",
                LogicalColKind::Text => data_type == "text",
                LogicalColKind::Bytes => data_type == "bytea",
            };
            if !type_ok {
                return Err(internal_not_committed(
                    "pg_column_type_mismatch",
                    format!(
                        "table {}.{}: unexpected PG type {data_type}",
                        spec.name, name
                    ),
                ));
            }
            let is_nullable = is_nullable_raw == "YES";
            if is_nullable != col_spec.nullable {
                return Err(internal_not_committed(
                    "pg_column_nullability_mismatch",
                    format!(
                        "table {}.{}: expected nullable={}, found {is_nullable}",
                        spec.name, name, col_spec.nullable
                    ),
                ));
            }
        }

        let pk_cols: Vec<String> = sqlx::query_scalar(
            "SELECT a.attname
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
             WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
             ORDER BY k.ord ASC",
        )
        .bind(schema_name)
        .bind(spec.name)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_table_pk", err.to_string()))?;

        let observed_pk: Vec<&str> = pk_cols.iter().map(String::as_str).collect();
        if observed_pk.as_slice() != spec.primary_key {
            return Err(internal_not_committed(
                "pg_pk_mismatch",
                format!(
                    "table {}: expected PK {:?}, found {observed_pk:?}",
                    spec.name, spec.primary_key
                ),
            ));
        }
    }

    // Verify all explicit non-PK indexes match the semantic manifest (and last_seq is unindexed).
    let idx_rows: Vec<String> = sqlx::query_scalar(
        "SELECT ci.relname
         FROM pg_index i
         JOIN pg_class ct ON ct.oid = i.indrelid
         JOIN pg_class ci ON ci.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = ct.relnamespace
         WHERE n.nspname = $1 AND NOT i.indisprimary",
    )
    .bind(schema_name)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_catalog_indexes", err.to_string()))?;

    let observed_indexes: BTreeSet<&str> = idx_rows.iter().map(String::as_str).collect();
    let expected_indexes = expected_index_names();
    if observed_indexes != expected_indexes {
        return Err(internal_not_committed(
            "pg_index_mismatch",
            format!("expected {expected_indexes:?}, observed {observed_indexes:?}"),
        ));
    }

    // Verify HOT-friendly fillfactor settings on spaces and note_heads.
    for (relname, expected_opt, err_code) in [
        ("spaces", "fillfactor=70", "pg_spaces_fillfactor_mismatch"),
        (
            "note_heads",
            "fillfactor=80",
            "pg_note_heads_fillfactor_mismatch",
        ),
    ] {
        let reloptions: Option<Vec<String>> = sqlx::query_scalar(
            "SELECT c.reloptions
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2",
        )
        .bind(schema_name)
        .bind(relname)
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_table_reloptions", err.to_string()))?;

        let has_expected = reloptions
            .unwrap_or_default()
            .iter()
            .any(|opt| opt == expected_opt);
        if !has_expected {
            return Err(internal_not_committed(
                err_code,
                format!("{relname} table is missing {expected_opt}"),
            ));
        }
    }

    Ok(())
}
