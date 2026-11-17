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

fn create_ledger(ddl: &str) -> Result<String, PortError> {
    split_sql_statements(ddl)
        .into_iter()
        .find(|s| s.starts_with("CREATE TABLE IF NOT EXISTS account_catalog_receipts ("))
        // An unrecognized ledger already present in a v1 database must fail closed.
        .map(|s| s.replacen("CREATE TABLE IF NOT EXISTS", "CREATE TABLE", 1))
        .ok_or_else(|| {
            internal_not_committed("migration_add_table", "missing catalog ledger definition")
        })
}

macro_rules! upgrade {
    ($name:ident, $connection:ty, $ddl:ident) => {
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
            if !previous.is_some_and(|(version, hash)| version == 1 && hex::encode(hash) == V1_HASH)
            {
                return Ok(());
            }
            sqlx::query(sqlx::AssertSqlSafe(create_ledger($ddl)?))
                .execute(&mut *conn)
                .await
                .map_err(|e| internal_not_committed("migration_add_table", e.to_string()))?;
            for sql in MIGRATE_PENDING_INPUTS {
                sqlx::query(sql).execute(&mut *conn).await.map_err(|e| {
                    internal_not_committed("migration_pending_input_provenance", e.to_string())
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
upgrade!(sqlite, SqliteConnection, SQLITE_BASELINE_DDL);
upgrade!(postgres, PgConnection, POSTGRES_BASELINE_DDL);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::bootstrap_sqlite_schema;
    use sqlx::Connection;

    #[tokio::test]
    async fn previous_schema_upgrades_atomically_and_preserves_queue_provenance() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        for sql in split_sql_statements(SQLITE_BASELINE_DDL) {
            if sql.starts_with("CREATE TABLE IF NOT EXISTS account_catalog_receipts") {
                continue;
            }
            let old = if sql.starts_with("CREATE TABLE IF NOT EXISTS chat_pending_inputs") {
                sql.lines()
                    .filter(|l| !l.contains("ext_space_tainted"))
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
        bootstrap_sqlite_schema(&mut db, &install).await.unwrap();
    }
}
