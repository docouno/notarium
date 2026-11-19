//! Schema upgrades run inside the bootstrap transaction. The incoming witness
//! must identify the exact schema this migration understands.
mod compactions;

use super::{POSTGRES_BASELINE_DDL, SQLITE_BASELINE_DDL, split_sql_statements};
use crate::codec::internal_not_committed;
use crate::schema::manifest::CANONICAL_SCHEMA_VERSION;
use notarium_core::{
    epoch::SUPPORTED_V1_EPOCH,
    error::PortError,
    ids::{ContentDigest, InstallationId},
};
use sqlx::{PgConnection, SqliteConnection};

pub(crate) const V1_HASH: &str = "3992ad6e8c888cc7ed98c9dd45e9463bf3334c5617b9c7c416334bc312398c69";

pub(crate) const V2_HASH: &str = "4375964fa9cf7de29749e52c6387a9f72d1a4538fb9f97240a9fe356061bdbdf";

pub(crate) const V3_HASH: &str = "ca79d3e2db2eed95fb8b0e503340139b3fd166b51340e6676d37ca0411fed4dc";

pub(crate) const V4_HASH: &str = "23fda6322e7820fdb9b60bd67192098e3d472c074f655a9d0edceaa7e3fb66e0";

pub(crate) const V5_HASH: &str = "e32b31f85aeb41b99c19c355bad2f9103eac552a0fe4b9c1ebb149892a7d9774";

pub(crate) const V6_HASH: &str = "f91526e264d8000bf5d72a4efcb4e9701b350636c37da24d2b34bb19f50a8772";

pub(crate) const V7_HASH: &str = "244ce610feed9e389063805c0c36190633a082df2b743fbf340c40418797e2a0";

pub(crate) fn recognized_predecessor(version: i64, hash: &[u8]) -> bool {
    match version {
        1 => hex::encode(hash) == V1_HASH,
        2 => hex::encode(hash) == V2_HASH,
        3 => hex::encode(hash) == V3_HASH,
        4 => hex::encode(hash) == V4_HASH,
        5 => hex::encode(hash) == V5_HASH,
        6 => hex::encode(hash) == V6_HASH,
        7 => hex::encode(hash) == V7_HASH,
        _ => false,
    }
}

const READ_WITNESS: &str = "SELECT CAST(schema_version AS BIGINT), manifest_checksum
    FROM schema_meta
    WHERE singleton_id = 1 AND installation_id = $1 AND epoch_version = $2 AND migration_state = 'ready'";
const WRITE_WITNESS: &str = "UPDATE schema_meta
    SET schema_version = $1, manifest_checksum = $2, updated_at_sec = $3, updated_at_nsec = $4
    WHERE singleton_id = 1";
const MIGRATE_PENDING_INPUTS: [&str; 3] = [
    "ALTER TABLE chat_pending_inputs ADD COLUMN ext_space_tainted INTEGER NOT NULL DEFAULT 0
     CHECK (ext_space_tainted IN (0, 1))",
    "UPDATE chat_pending_inputs SET inline_text = '', payload_blake3 = NULL WHERE status <> 'pending'",
    "UPDATE chat_pending_inputs SET ext_space_tainted = 1 WHERE status = 'pending'
     AND EXISTS (
         SELECT 1 FROM chat_threads t JOIN spaces s ON s.space_id = t.space_id
         WHERE t.space_id = chat_pending_inputs.space_id AND t.thread_id = chat_pending_inputs.thread_id
           AND t.kind <> 'space_group' AND s.space_kind <> 'shared'
     )",
];

const ADD_HOLD_GENERATION: &str =
    "ALTER TABLE backup_holds ADD COLUMN owner_generation TEXT NOT NULL DEFAULT ''";
const MIGRATE_CHAT_HISTORY: [&str; 5] = [
    "ALTER TABLE chat_threads ADD COLUMN active_run_generation TEXT",
    "ALTER TABLE chat_entries ADD COLUMN human_origin INTEGER CHECK (human_origin IN (0, 1))",
    "ALTER TABLE chat_entries ADD COLUMN body_format INTEGER NOT NULL DEFAULT 0 CHECK (body_format IN (0, 1, 2))",
    "ALTER TABLE chat_entries ADD COLUMN provenance_json TEXT",
    "UPDATE chat_entries SET human_origin = CASE WHEN kind = 'human' THEN 1 ELSE 0 END WHERE kind <> 'redacted'",
];

// A legacy snapshot covered an unknown prefix. Keep every delta and require a
// newer lease to establish coverage. A room with only deltas has no snapshot.
const BACKFILL_CHECKPOINTS: &str = "INSERT INTO collab_checkpoints
    (space_id, note_id, snapshot_lease_epoch, snapshot_update_seq, carrier_dirty)
    SELECT s.space_id, s.note_id,
           CASE WHEN s.yrs_snapshot_blob IS NULL THEN 0 ELSE s.lease_epoch END,
           CASE WHEN s.yrs_snapshot_blob IS NULL THEN 0 ELSE 9223372036854775807 END, 1
    FROM collab_sessions s
    WHERE s.yrs_snapshot_blob IS NOT NULL OR EXISTS (
        SELECT 1 FROM collab_update_log u WHERE u.space_id=s.space_id AND u.note_id=s.note_id
    )";

// One earlier PostgreSQL v2 baseline attached the catalog receipt limit to
// job results. The corrected v2 baseline already has the intended constraints.
const NORMALIZE_PG_V2: &str = "DO $migration$
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint
            WHERE conrelid='content_jobs'::regclass AND conname='content_jobs_result_msgpack_check'
              AND contype='c') THEN
            ALTER TABLE content_jobs DROP CONSTRAINT content_jobs_result_msgpack_check;
            ALTER TABLE account_catalog_receipts ADD CONSTRAINT account_catalog_receipts_result_msgpack_check
                CHECK (length(result_msgpack) BETWEEN 1 AND 4096);
        END IF;
    END $migration$";

fn baseline_statement(ddl: &str, prefix: &str) -> Result<String, PortError> {
    split_sql_statements(ddl)
        .into_iter()
        .find(|s| s.starts_with(prefix))
        .ok_or_else(|| internal_not_committed("migration_missing_ddl", prefix))
}

fn create_new_table(ddl: &str, table: &str) -> Result<String, PortError> {
    let prefix = format!("CREATE TABLE IF NOT EXISTS {table} (");
    Ok(baseline_statement(ddl, &prefix)?.replacen("CREATE TABLE IF NOT EXISTS", "CREATE TABLE", 1))
}

async fn upgrade_sqlite_catalog(conn: &mut SqliteConnection) -> Result<(), PortError> {
    let create = create_new_table(SQLITE_BASELINE_DDL, "blob_catalog")?;
    let zero_ref = baseline_statement(
        SQLITE_BASELINE_DDL,
        "CREATE INDEX IF NOT EXISTS idx_blob_catalog_zero_ref",
    )?;
    // No foreign key targets blob_catalog. Keep its logical key and every
    // publication, count and lifecycle field while rebuilding the primary tree.
    for sql in [
        "ALTER TABLE blob_catalog RENAME TO blob_catalog_v3", &create,
        "INSERT INTO blob_catalog(space_id, content_blake3, raw_size, compressed_size, ref_count,
            current_publication_id, admission_state, blob_state, touched_at_ms)
         SELECT space_id, content_blake3, raw_size, compressed_size, ref_count,
            current_publication_id, admission_state, blob_state, touched_at_ms FROM blob_catalog_v3",
        "DROP TABLE blob_catalog_v3", &zero_ref,
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn).await
            .map_err(|e| internal_not_committed("migration_v4_blob_catalog", e.to_string()))?;
    }
    Ok(())
}

async fn upgrade_owners_v5(conn: &mut crate::sql_exec::BackendConn<'_>) -> Result<(), PortError> {
    use crate::sql_exec::BackendConn;
    let fail = |e: sqlx::Error| internal_not_committed("migration_v5_ownership", e.to_string());
    match conn {
        BackendConn::Sqlite(c) => {
            let create = create_new_table(SQLITE_BASELINE_DDL, "payload_owners")?;
            let job = baseline_statement(
                SQLITE_BASELINE_DDL,
                "CREATE INDEX IF NOT EXISTS idx_payload_owners_job",
            )?;
            let odd = baseline_statement(
                SQLITE_BASELINE_DDL,
                "CREATE INDEX IF NOT EXISTS idx_receipt_exception_pointer",
            )?;
            for statement in [
                "ALTER TABLE payload_owners RENAME TO payload_owners_v4",
                &create,
                "INSERT INTO payload_owners(space_id,payload_kind,payload_id,note_id)
                 SELECT space_id,payload_kind,payload_id,note_id FROM payload_owners_v4",
                "DROP TABLE payload_owners_v4",
                &job,
                &odd,
            ] {
                sqlx::query(sqlx::AssertSqlSafe(statement))
                    .execute(&mut **c)
                    .await
                    .map_err(fail)?;
            }
        }
        BackendConn::Postgres(c) => {
            sqlx::query(
                "ALTER TABLE payload_owners DROP CONSTRAINT payload_owners_pkey,
                         ADD PRIMARY KEY (space_id, note_id, payload_kind, payload_id)",
            )
            .execute(&mut **c)
            .await
            .map_err(fail)?;
            let odd = baseline_statement(
                POSTGRES_BASELINE_DDL,
                "CREATE INDEX IF NOT EXISTS idx_receipt_exception_pointer",
            )?;
            sqlx::query(sqlx::AssertSqlSafe(odd))
                .execute(&mut **c)
                .await
                .map_err(fail)?;
            let job = baseline_statement(
                POSTGRES_BASELINE_DDL,
                "CREATE INDEX IF NOT EXISTS idx_payload_owners_job",
            )?;
            sqlx::query(sqlx::AssertSqlSafe(job))
                .execute(&mut **c)
                .await
                .map_err(fail)?;
        }
    }
    Ok(())
}

macro_rules! upgrade {
    ($name:ident, $connection:ty, $variant:ident, $ddl:ident, $pg_v2:expr $(, $catalog:ident)?) => {
        pub(super) async fn $name(
            conn: &mut $connection,
            installation: &InstallationId,
            checksum: ContentDigest,
        ) -> Result<(), PortError> {
            let previous: Option<(i64, Vec<u8>)> = sqlx::query_as(READ_WITNESS)
                .bind(installation.as_str())
                .bind(SUPPORTED_V1_EPOCH as i32)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| internal_not_committed("migration_read_witness", e.to_string()))?;
            let Some((version, hash)) = previous else {
                return Ok(());
            };
            if !recognized_predecessor(version, &hash) {
                return Ok(());
            }
            if version == 1 {
                sqlx::query(sqlx::AssertSqlSafe(create_new_table(
                    $ddl,
                    "account_catalog_receipts",
                )?))
                .execute(&mut *conn)
                .await
                .map_err(|e| internal_not_committed("migration_add_table", e.to_string()))?;
                for sql in MIGRATE_PENDING_INPUTS {
                    sqlx::query(sql).execute(&mut *conn).await.map_err(|e| {
                        internal_not_committed("migration_pending_input_provenance", e.to_string())
                    })?;
                }
            } else if version == 2 && let Some(sql) = $pg_v2 {
                sqlx::query(sql).execute(&mut *conn).await.map_err(|e| {
                    internal_not_committed("migration_v2_receipt_constraint", e.to_string())
                })?;
            }
            if version < 3 {
                sqlx::query(sqlx::AssertSqlSafe(create_new_table(
                    $ddl,
                    "collab_checkpoints",
                )?))
                .execute(&mut *conn)
                .await
                .map_err(|e| internal_not_committed("migration_add_table", e.to_string()))?;
                for sql in [ADD_HOLD_GENERATION, BACKFILL_CHECKPOINTS] {
                    sqlx::query(sql).execute(&mut *conn).await.map_err(|e| {
                        internal_not_committed("migration_v3_runtime_state", e.to_string())
                    })?;
                }
            }
            if version < 4 {
                $($catalog(&mut *conn).await?;)?
                sqlx::query("DROP INDEX IF EXISTS idx_blob_references_non_note_owner")
                    .execute(&mut *conn).await
                    .map_err(|e| internal_not_committed("migration_v4_drop_index", e.to_string()))?;
                for prefix in [
                    "CREATE INDEX IF NOT EXISTS idx_blob_references_owner",
                    "CREATE INDEX IF NOT EXISTS idx_blob_references_digest",
                ] {
                    let sql = baseline_statement($ddl, prefix)?;
                    sqlx::query(sqlx::AssertSqlSafe(sql)).execute(&mut *conn).await
                        .map_err(|e| internal_not_committed("migration_v4_reference_index", e.to_string()))?;
                }
                compactions::scrub(&mut crate::sql_exec::BackendConn::$variant(conn)).await?;
            }
            if version < 5 {
                upgrade_owners_v5(&mut crate::sql_exec::BackendConn::$variant(conn)).await?;
            }
            if version < 6 {
                // Both global and per-Space pending checks can seek by status.
                let index = baseline_statement($ddl, "CREATE INDEX IF NOT EXISTS idx_blob_retirements_status")?;
                sqlx::query("DROP INDEX idx_blob_retirements_status")
                    .execute(&mut *conn).await
                    .map_err(|e| internal_not_committed("migration_v6_drop_retirement_index", e.to_string()))?;
                sqlx::query(sqlx::AssertSqlSafe(index)).execute(&mut *conn).await
                    .map_err(|e| internal_not_committed("migration_v6_retirement_index", e.to_string()))?;
            }
            if version < 7 {
                let add_epoch = if stringify!($variant) == "Sqlite" {
                    "ALTER TABLE chat_threads ADD COLUMN active_run_epoch INTEGER CHECK (active_run_epoch IS NULL OR active_run_epoch >= 0)"
                } else {
                    "ALTER TABLE chat_threads ADD COLUMN active_run_epoch BIGINT CHECK (active_run_epoch IS NULL OR active_run_epoch >= 0)"
                };
                for sql in std::iter::once(add_epoch).chain(MIGRATE_CHAT_HISTORY) {
                    sqlx::query(sql).execute(&mut *conn).await.map_err(|e| {
                        internal_not_committed("migration_v7_chat_history", e.to_string())
                    })?;
                }
                sqlx::query(sqlx::AssertSqlSafe(baseline_statement(
                    $ddl,
                    "CREATE INDEX IF NOT EXISTS idx_chat_pending_inputs_consumed",
                )?))
                .execute(&mut *conn)
                .await
                .map_err(|e| internal_not_committed("migration_v7_chat_handoff_index", e.to_string()))?;
            }
            sqlx::query("DROP INDEX IF EXISTS uq_ability_packages_active_slug")
                .execute(&mut *conn)
                .await
                .map_err(|e| internal_not_committed("migration_v8_ability_slot_drop", e.to_string()))?;
            sqlx::query(sqlx::AssertSqlSafe(baseline_statement(
                $ddl,
                "CREATE INDEX IF NOT EXISTS idx_ability_packages_active_slug",
            )?))
            .execute(&mut *conn)
            .await
            .map_err(|e| internal_not_committed("migration_v8_ability_slot_index", e.to_string()))?;
            let (sec, nsec) =
                crate::codec::encode_timestamp_parts(crate::codec::now_utc_timestamp()?);
            sqlx::query(WRITE_WITNESS)
                .bind(CANONICAL_SCHEMA_VERSION as i32)
                .bind(checksum.as_bytes().as_slice())
                .bind(sec)
                .bind(nsec)
                .execute(&mut *conn)
                .await
                .map_err(|e| internal_not_committed("migration_update_witness", e.to_string()))?;
            Ok(())
        }
    };
}
upgrade!(
    sqlite,
    SqliteConnection,
    Sqlite,
    SQLITE_BASELINE_DDL,
    None::<&'static str>,
    upgrade_sqlite_catalog
);
upgrade!(
    postgres,
    PgConnection,
    Postgres,
    POSTGRES_BASELINE_DDL,
    Some(NORMALIZE_PG_V2)
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::bootstrap_sqlite_schema;
    use sqlx::{Connection, Row};

    async fn restore_chat_schema_v6(db: &mut SqliteConnection) {
        sqlx::raw_sql(include_str!("../../tests/fixtures/chat-schema-v6-only.sql"))
            .execute(db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn v7_upgrades_only_the_ability_slot_index() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        let installation = InstallationId::from_bytes([7; 16]);
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        sqlx::raw_sql(
            "DROP INDEX idx_ability_packages_active_slug;
             CREATE UNIQUE INDEX uq_ability_packages_active_slug
                ON ability_packages(space_id,slug_fold) WHERE lifecycle_state='active'",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("UPDATE schema_meta SET schema_version=7, manifest_checksum=$1")
            .bind(hex::decode(V7_HASH).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        let index_state: (i64, i64) = sqlx::query_as(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='uq_ability_packages_active_slug'),
                    EXISTS(SELECT 1 FROM pragma_index_list('ability_packages')
                           WHERE name='idx_ability_packages_active_slug' AND [unique]=0)",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(index_state, (0, 1));
        let version: i64 = sqlx::query_scalar("SELECT schema_version FROM schema_meta")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(version, i64::from(CANONICAL_SCHEMA_VERSION));
    }

    #[tokio::test]
    async fn v6_upgrade_backfills_live_authorship_without_guessing_tombstones() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        let installation = InstallationId::from_bytes([6; 16]);
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        restore_chat_schema_v6(&mut db).await;
        sqlx::query("UPDATE schema_meta SET schema_version=6, manifest_checksum=$1")
            .bind(hex::decode(V6_HASH).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::raw_sql(
            "INSERT INTO spaces VALUES('space',zeroblob(16),'root','home','home','personal','owner','active',1,4,'{}',0,0);
             INSERT INTO chat_threads VALUES('space',zeroblob(16),'thread','personal','owner',NULL,'Chat',3,'rev',4,NULL,0,1,4,0,0,0,0);
             INSERT INTO chat_entries(
                 space_id, thread_id, entry_seq, parent_seq, revision_id, kind, author_id,
                 inline_text, referenced_notes_json, ext_space_tainted, is_chain_node,
                 branch_depth, created_space_seq, redacted_at_seq
             ) VALUES
                 ('space','thread',1,NULL,'a','human','owner','hello','[]',0,1,0,1,NULL),
                 ('space','thread',2,1,'b','model','owner','answer','[]',0,1,1,2,NULL),
                 ('space','thread',3,2,'c','redacted','owner',NULL,'[]',0,1,2,3,4);",
        ).execute(&mut db).await.unwrap();
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        let entries: Vec<(String, Option<i32>, i32, Option<String>)> = sqlx::query_as(
            "SELECT kind, human_origin, body_format, provenance_json FROM chat_entries ORDER BY entry_seq",
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(
            entries,
            [
                ("human".into(), Some(1), 0, None),
                ("model".into(), Some(0), 0, None),
                ("redacted".into(), None, 0, None),
            ]
        );
    }

    #[tokio::test]
    async fn v5_retirement_upgrade_preserves_rows_and_indexes_global_pending_work() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        let installation = InstallationId::from_bytes([5; 16]);
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        restore_chat_schema_v6(&mut db).await;
        sqlx::raw_sql(
            "DROP INDEX idx_blob_retirements_status;
             CREATE INDEX idx_blob_retirements_status ON blob_retirements(space_id, status);
             UPDATE schema_meta SET schema_version=5,
                 manifest_checksum=X'E32B31F85AEB41B99C19C355BAD2F9103EAC552A0FE4B9C1EBB149892A7D9774';
             INSERT INTO spaces VALUES('space',zeroblob(16),'root','s','s','personal',
                 'owner','active',0,0,'{}',0,0);",
        )
        .execute(&mut db).await.unwrap();
        sqlx::raw_sql(
            "WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<256)
             INSERT INTO blob_retirements SELECT 'space',printf('retirement-%d',n),zeroblob(16),0,
                 'gc',NULL,'completed',0,1 FROM ids;
             INSERT INTO blob_retirements VALUES('space','last',zeroblob(16),0,'gc',NULL,'pending',0,NULL);",
        ).execute(&mut db).await.unwrap();

        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        let counts: (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE status='pending') FROM blob_retirements",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(counts, (257, 1));
        let columns: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_index_info('idx_blob_retirements_status') ORDER BY seqno",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(columns, ["status", "space_id"]);
        let plan = sqlx::query(
            "EXPLAIN QUERY PLAN SELECT 1 FROM blob_retirements WHERE status='pending' LIMIT 1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        let detail: String = plan.get("detail");
        assert!(
            detail.contains("SEARCH") && detail.contains("idx_blob_retirements_status (status=?)"),
            "{detail}"
        );
    }

    #[tokio::test]
    async fn v4_owner_lookup_upgrade_preserves_explicit_rows_and_receipts() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        let installation = InstallationId::from_bytes([4; 16]);
        for sql in split_sql_statements(SQLITE_BASELINE_DDL) {
            if sql.starts_with("CREATE INDEX IF NOT EXISTS idx_payload_owners_job")
                || sql.starts_with("CREATE INDEX IF NOT EXISTS idx_receipt_exception_pointer")
            {
                continue;
            }
            let sql = if sql.starts_with("CREATE TABLE IF NOT EXISTS payload_owners (") {
                sql.replace(
                    "space_id, note_id, payload_kind, payload_id",
                    "space_id, payload_kind, payload_id, note_id",
                )
                .replace(" WITHOUT ROWID", "")
            } else {
                sql
            };
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut db)
                .await
                .unwrap();
        }
        restore_chat_schema_v6(&mut db).await;
        sqlx::query("INSERT INTO schema_meta VALUES(1,4,1,$1,'ready',$2,0,0,0,0)")
            .bind(installation.as_str())
            .bind(hex::decode(V4_HASH).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO payload_owners VALUES
            ('s','change_payload','e','n'), ('s','command_receipt','p:k','n'), ('s','content_job','j','other');
            INSERT INTO command_receipts VALUES ('s',zeroblob(16),'p','k',zeroblob(32),'completed',1,'historic-pointer',X'05',1,1);
            CREATE TEMP TABLE before_owners AS SELECT * FROM payload_owners;
            CREATE TEMP TABLE before_receipts AS SELECT * FROM command_receipts;")
            .execute(&mut db).await.unwrap();
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        for (live, snapshot) in [
            ("payload_owners", "before_owners"),
            ("command_receipts", "before_receipts"),
        ] {
            for (a, b) in [(live, snapshot), (snapshot, live)] {
                let sql =
                    format!("SELECT COUNT(*) FROM (SELECT * FROM {a} EXCEPT SELECT * FROM {b})");
                assert_eq!(
                    sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
                        .fetch_one(&mut db)
                        .await
                        .unwrap(),
                    0
                );
            }
        }
        let plan=sqlx::query("EXPLAIN QUERY PLAN SELECT payload_id FROM payload_owners WHERE space_id='s' AND note_id='n'")
            .fetch_one(&mut db).await.unwrap();
        assert!(
            plan.get::<String, _>(3)
                .contains("PRIMARY KEY (space_id=? AND note_id=?)")
        );
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn v3_catalog_rebuild_preserves_rows_and_uses_selective_reference_indexes() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        let installation = InstallationId::from_bytes([3; 16]);
        for sql in split_sql_statements(SQLITE_BASELINE_DDL) {
            let sql = if sql.starts_with("CREATE TABLE IF NOT EXISTS blob_catalog (") {
                sql.replace(" WITHOUT ROWID", "")
            } else {
                sql
            };
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut db)
                .await
                .unwrap();
        }
        restore_chat_schema_v6(&mut db).await;
        sqlx::raw_sql(include_str!(
            "../../tests/fixtures/schema-v3-reference-index.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO schema_meta VALUES(1,3,1,$1,'ready',$2,0,0,0,0)")
            .bind(installation.as_str())
            .bind(hex::decode(V3_HASH).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO blob_catalog VALUES
            ('s',zeroblob(32),1024,63,2,'pub','open','active',391),
            ('t',zeroblob(32),1024,63,0,NULL,'retiring','quarantined',492);
            INSERT INTO blob_references VALUES
            ('s','note_revision','note','r1','',zeroblob(32),'pub',11),
            ('s','note_revision','note','r2','',zeroblob(32),'pub',12);
            CREATE TEMP TABLE old_catalog AS SELECT * FROM blob_catalog;
            CREATE TEMP TABLE old_refs AS SELECT * FROM blob_references;
            CREATE TRIGGER abort_witness BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT,'fault'); END;")
            .execute(&mut db).await.unwrap();
        assert!(
            bootstrap_sqlite_schema(&mut db, &installation)
                .await
                .is_err()
        );
        let layout = "SELECT wr FROM pragma_table_list WHERE schema='main' AND name='blob_catalog'";
        assert_eq!(
            sqlx::query_scalar::<_, i64>(layout)
                .fetch_one(&mut db)
                .await
                .unwrap(),
            0
        );
        sqlx::query("DROP TRIGGER abort_witness")
            .execute(&mut db)
            .await
            .unwrap();
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(layout)
                .fetch_one(&mut db)
                .await
                .unwrap(),
            1
        );
        for (actual, before) in [
            ("blob_catalog", "old_catalog"),
            ("blob_references", "old_refs"),
        ] {
            for (lhs, rhs) in [(actual, before), (before, actual)] {
                let sql = format!(
                    "SELECT count(*) FROM (SELECT * FROM {lhs} EXCEPT SELECT * FROM {rhs})"
                );
                assert_eq!(
                    sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
                        .fetch_one(&mut db)
                        .await
                        .unwrap(),
                    0
                );
            }
        }
        for (statement, lookup) in [
            (
                "EXPLAIN QUERY PLAN DELETE FROM blob_references WHERE space_id='s' AND owner_kind='note_revision' AND owner_id='note' RETURNING content_blake3",
                "idx_blob_references_owner (space_id=? AND owner_kind=? AND owner_id=?)",
            ),
            (
                "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM blob_references WHERE space_id='s' AND content_blake3=zeroblob(32)",
                "idx_blob_references_digest (space_id=? AND content_blake3=?)",
            ),
        ] {
            let rows = sqlx::query(statement).fetch_all(&mut db).await.unwrap();
            assert!(
                rows.iter()
                    .any(|r| r.get::<String, _>("detail").contains(lookup)),
                "missing indexed lookup {lookup}"
            );
        }
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn previous_schema_upgrades_atomically_and_preserves_queue_provenance() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        for sql in split_sql_statements(SQLITE_BASELINE_DDL) {
            if sql.starts_with("CREATE TABLE IF NOT EXISTS account_catalog_receipts")
                || sql.starts_with("CREATE TABLE IF NOT EXISTS collab_checkpoints")
            {
                continue;
            }
            let old = if sql.starts_with("CREATE TABLE IF NOT EXISTS chat_pending_inputs")
                || sql.starts_with("CREATE TABLE IF NOT EXISTS backup_holds")
            {
                sql.lines()
                    .filter(|l| !l.contains("ext_space_tainted") && !l.contains("owner_generation"))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                sql
            };
            sqlx::query(sqlx::AssertSqlSafe(old))
                .execute(&mut db)
                .await
                .unwrap();
        }
        restore_chat_schema_v6(&mut db).await;
        let install = InstallationId::from_bytes([4; 16]);
        sqlx::query("INSERT INTO schema_meta VALUES(1,1,1,$1,'ready',$2,0,0,0,0)")
            .bind(install.as_str())
            .bind(hex::decode(V1_HASH).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO spaces VALUES('space',zeroblob(16),'root','home','home','personal','owner','active',1,2,'{}',0,0)").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO chat_threads VALUES ('space',zeroblob(16),'thread','personal','owner',NULL,'',0,'rev',1,NULL,0,1,2,0,0,0,0)").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO chat_pending_inputs VALUES ('space','thread','input1',1,'owner','keep',NULL,0,'run',0,'pending',1,NULL),('space','thread','input2',2,'owner','erase',NULL,0,'run',0,'consumed',2,1)").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO command_receipts VALUES ('space',zeroblob(16),'owner','legacy',zeroblob(32),'completed',1,NULL,X'8181',2,9999)").execute(&mut db).await.unwrap();
        sqlx::raw_sql(include_str!("../../tests/fixtures/legacy-collab.sql"))
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER fail_upgrade BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT,'fault'); END").execute(&mut db).await.unwrap();
        assert!(bootstrap_sqlite_schema(&mut db, &install).await.is_err());
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='account_catalog_receipts'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(count, 0);
        sqlx::query("DROP TRIGGER fail_upgrade")
            .execute(&mut db)
            .await
            .unwrap();
        bootstrap_sqlite_schema(&mut db, &install).await.unwrap();
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT inline_text,ext_space_tainted FROM chat_pending_inputs ORDER BY ordinal",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        let receipt: (Vec<u8>, Vec<u8>, i64) = sqlx::query_as(
            "SELECT command_hash,sanitized_envelope_msgpack,canonical_seq FROM command_receipts WHERE idempotency_key='legacy'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(receipt, (vec![0; 32], vec![0x81, 0x81], 2));
        assert_eq!(rows, vec![("keep".to_owned(), 1), ("".to_owned(), 0)]);
        let checkpoints: Vec<(String,i64,i64,i64)> = sqlx::query_as(
            "SELECT note_id,snapshot_lease_epoch,snapshot_update_seq,carrier_dirty FROM collab_checkpoints ORDER BY note_id"
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(
            checkpoints,
            vec![
                ("checkpoint".into(), 7, i64::MAX, 1),
                ("delta-only".into(), 0, 0, 1)
            ]
        );
        let deltas: i64 = sqlx::query_scalar("SELECT count(*) FROM collab_update_log")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(deltas, 2);
        let generation: String = sqlx::query_scalar("SELECT owner_generation FROM backup_holds")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert!(generation.is_empty());
        sqlx::raw_sql("INSERT INTO content_jobs (space_id,job_id,job_kind,state,lease_epoch,artifacts_json,result_msgpack,created_seq,updated_seq)
            VALUES ('legacy-collab','job','backup','queued',0,'[]',zeroblob(8192),1,1);
            INSERT INTO account_catalog_receipts VALUES ('owner','actor','key',zeroblob(32),zeroblob(4096))")
            .execute(&mut db).await.unwrap();
        assert!(
            sqlx::query("UPDATE account_catalog_receipts SET result_msgpack=zeroblob(4097)")
                .execute(&mut db)
                .await
                .unwrap_err()
                .as_database_error()
                .unwrap()
                .is_check_violation()
        );

        bootstrap_sqlite_schema(&mut db, &install).await.unwrap();
    }
}
