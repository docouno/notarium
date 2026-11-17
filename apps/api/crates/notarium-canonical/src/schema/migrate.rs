//! Additive upgrades run inside the bootstrap transaction. The incoming witness
//! must identify the exact schema this migration understands.
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

pub(crate) fn recognized_predecessor(version: i64, hash: &[u8]) -> bool {
    match version {
        1 => hex::encode(hash) == V1_HASH,
        2 => hex::encode(hash) == V2_HASH,
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

fn create_new_table(ddl: &str, table: &str) -> Result<String, PortError> {
    let prefix = format!("CREATE TABLE IF NOT EXISTS {table} (");
    split_sql_statements(ddl)
        .into_iter()
        .find(|s| s.starts_with(&prefix))
        .map(|s| s.replacen("CREATE TABLE IF NOT EXISTS", "CREATE TABLE", 1))
        .ok_or_else(|| {
            internal_not_committed("migration_add_table", format!("missing table {table}"))
        })
}

macro_rules! upgrade {
    ($name:ident, $connection:ty, $ddl:ident, $pg_v2:expr) => {
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
            } else if let Some(sql) = $pg_v2 {
                sqlx::query(sql).execute(&mut *conn).await.map_err(|e| {
                    internal_not_committed("migration_v2_receipt_constraint", e.to_string())
                })?;
            }
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
    SQLITE_BASELINE_DDL,
    None::<&'static str>
);
upgrade!(
    postgres,
    PgConnection,
    POSTGRES_BASELINE_DDL,
    Some(NORMALIZE_PG_V2)
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::bootstrap_sqlite_schema;
    use sqlx::Connection;

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
