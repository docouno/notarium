//! Remove data retained by predecessor schemas when an ancestor was redacted.
use crate::{
    blobs::{RetirementReason, initiate_digest_retirement_tx},
    codec::internal_not_committed,
    sql_exec::BackendConn,
};
use notarium_core::{
    error::PortError,
    ids::{ContentDigest, HistoryIncarnation, LeaseEpoch, SpaceId},
    model::HistoryScope,
};

fn sql_error(error: sqlx::Error) -> PortError {
    internal_not_committed("migrate_stale_compactions", error.to_string())
}

async fn execute(tx: &mut BackendConn<'_>, sql: &'static str) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(db) => sqlx::query(sql).execute(&mut **db).await.map(|_| ()),
        BackendConn::Postgres(db) => sqlx::query(sql).execute(&mut **db).await.map(|_| ()),
    }
    .map_err(sql_error)
}

pub(super) async fn scrub(tx: &mut BackendConn<'_>) -> Result<(), PortError> {
    // A predecessor's stale bit records invalidation, but not its commit sequence.
    // Keep that marker and DAG coordinates without inventing a redaction timestamp.
    for sql in [
        "CREATE TEMP TABLE migrating_stale_chats AS
         SELECT e.space_id,e.thread_id,e.entry_seq,e.created_space_seq,t.history_incarnation,
                e.thread_id || ':' || CAST(e.entry_seq AS TEXT) AS owner_id
         FROM chat_entries e JOIN chat_threads t ON t.space_id=e.space_id AND t.thread_id=e.thread_id
         WHERE e.kind='compaction' AND e.checkpoint_stale<>0",
        "CREATE UNIQUE INDEX migrating_stale_chat_seq ON migrating_stale_chats(space_id,history_incarnation,created_space_seq)",
        "CREATE TEMP TABLE migrating_stale_digests AS
         SELECT DISTINCT b.space_id,b.content_blake3 FROM migrating_stale_chats c JOIN blob_references b
           ON b.space_id=c.space_id AND b.owner_kind='chat_entry' AND b.owner_id=c.owner_id",
        "CREATE UNIQUE INDEX migrating_stale_digest_key ON migrating_stale_digests(space_id,content_blake3)",
        "UPDATE change_payloads SET erased_by_purge=1,effect_msgpack=NULL WHERE (space_id,payload_id) IN (
           SELECT r.space_id,r.response_payload_id FROM command_receipts r JOIN migrating_stale_chats c
             ON r.space_id=c.space_id AND r.history_incarnation=c.history_incarnation AND r.canonical_seq=c.created_space_seq
           WHERE r.response_payload_id IS NOT NULL)",
        "UPDATE command_receipts SET response_payload_id=NULL WHERE (space_id,history_incarnation,canonical_seq) IN (
           SELECT space_id,history_incarnation,created_space_seq FROM migrating_stale_chats)",
        "DELETE FROM blob_references WHERE owner_kind='chat_entry' AND (space_id,owner_id) IN (
           SELECT space_id,owner_id FROM migrating_stale_chats)",
        "UPDATE blob_catalog SET ref_count=(SELECT COUNT(*) FROM blob_references b
           WHERE b.space_id=blob_catalog.space_id AND b.content_blake3=blob_catalog.content_blake3)
         WHERE (space_id,content_blake3) IN (SELECT space_id,content_blake3 FROM migrating_stale_digests)",
        "UPDATE chat_entries SET inline_text='',payload_blake3=NULL,referenced_notes_json='[]'
         WHERE (space_id,thread_id,entry_seq) IN (SELECT space_id,thread_id,entry_seq FROM migrating_stale_chats)",
        "DROP TABLE migrating_stale_chats",
    ] {
        execute(tx, sql).await?;
    }

    // Seal only unreferenced publications. The existing startup/takeover worker
    // performs physical deletion under its own lease and backup-hold checks.
    const PAGE: &str = "SELECT d.space_id,d.content_blake3,s.history_incarnation,s.active_epoch
        FROM migrating_stale_digests d JOIN spaces s ON s.space_id=d.space_id
        JOIN blob_catalog b ON b.space_id=d.space_id AND b.content_blake3=d.content_blake3
        WHERE b.ref_count=0 AND (d.space_id,d.content_blake3)>($1,$2)
        ORDER BY d.space_id,d.content_blake3 LIMIT 128";
    let mut after = (String::new(), Vec::<u8>::new());
    loop {
        let rows: Vec<(String, Vec<u8>, Vec<u8>, i64)> = match tx {
            BackendConn::Sqlite(db) => {
                sqlx::query_as(PAGE)
                    .bind(&after.0)
                    .bind(&after.1)
                    .fetch_all(&mut **db)
                    .await
            }
            BackendConn::Postgres(db) => {
                sqlx::query_as(PAGE)
                    .bind(&after.0)
                    .bind(&after.1)
                    .fetch_all(&mut **db)
                    .await
            }
        }
        .map_err(sql_error)?;
        if rows.is_empty() {
            break;
        }
        for (space, bytes, incarnation, epoch) in rows {
            let scope = HistoryScope {
                space_id: SpaceId::parse(&space)?,
                incarnation: HistoryIncarnation::from_bytes(incarnation.try_into().map_err(
                    |_| {
                        internal_not_committed(
                            "migrate_stale_history",
                            "invalid history incarnation",
                        )
                    },
                )?),
            };
            let digest = ContentDigest::from_bytes(bytes.as_slice().try_into().map_err(|_| {
                internal_not_committed("migrate_stale_digest", "invalid content digest")
            })?);
            let epoch = LeaseEpoch::new(u64::try_from(epoch).map_err(|_| {
                internal_not_committed("migrate_stale_epoch", "negative active epoch")
            })?)?;
            initiate_digest_retirement_tx(
                tx,
                &scope,
                epoch,
                digest,
                RetirementReason::Gc,
                None,
                None,
            )
            .await?
            .ok_or_else(|| {
                internal_not_committed(
                    "migrate_stale_publication",
                    "stale chat reference has no publication",
                )
            })?;
            after = (space, bytes);
        }
    }
    execute(tx, "DROP TABLE migrating_stale_digests").await
}

#[cfg(test)]
mod tests {
    use crate::schema::{bootstrap_sqlite_schema, migrate::V3_HASH};
    use notarium_core::ids::InstallationId;
    use sqlx::Connection;

    #[tokio::test]
    async fn predecessor_scrubs_only_invalidated_chat_owners() {
        let mut db = sqlx::SqliteConnection::connect(":memory:").await.unwrap();
        let installation = InstallationId::from_bytes([3; 16]);
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        sqlx::query("UPDATE schema_meta SET schema_version=3,manifest_checksum=?1")
            .bind(hex::decode(V3_HASH).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("CREATE TEMP TABLE fixture_blob AS SELECT manifest_checksum AS body_digest, 32 AS compressed_size FROM schema_meta")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../tests/fixtures/legacy-stale-compactions.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        bootstrap_sqlite_schema(&mut db, &installation)
            .await
            .unwrap();
        let result: i32 = sqlx::query_scalar(include_str!(
            "../../../tests/fixtures/check-stale-compactions.sql"
        ))
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(result, 1);
    }
}
