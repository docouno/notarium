//! Materialize bounded projection reads for complete predecessor chat entries.
use super::{POSTGRES_BASELINE_DDL, SQLITE_BASELINE_DDL, baseline_statement};
use crate::{
    codec::internal_not_committed,
    projection_chat::{REF_BLOCK_BYTES, write_chat_ref_blocks_tx},
    sql_exec::BackendConn,
};
use notarium_core::error::PortError;
use sqlx::{PgConnection, SqliteConnection};

fn migration_error(error: sqlx::Error) -> PortError {
    internal_not_committed("migrate_chat_ref_blocks", error.to_string())
}

const OBJECTS: [&str; 4] = [
    "CREATE TABLE IF NOT EXISTS chat_entry_ref_blocks (",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_projection",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_created_change",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_redacted_change",
];

// The predecessor is exclusively locked. Only keys and the length of one old
// datum are examined here. The application receives at most one full entry
// during SQLite migration and never receives a full entry on PostgreSQL.
const LEGACY_KEYS: &str = "SELECT space_id,thread_id,entry_seq
    FROM chat_entries
    WHERE (space_id,thread_id,entry_seq)>($1,$2,$3)
      AND kind <> 'redacted' AND checkpoint_stale=0 AND octet_length(referenced_notes_json)>4096
    ORDER BY space_id,thread_id,entry_seq LIMIT 128";

pub(super) async fn sqlite(conn: &mut SqliteConnection) -> Result<(), PortError> {
    for prefix in OBJECTS {
        let statement = baseline_statement(SQLITE_BASELINE_DDL, prefix)?;
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(&mut *conn)
            .await
            .map_err(migration_error)?;
    }
    sqlx::query("DELETE FROM chat_entry_ref_blocks")
        .execute(&mut *conn)
        .await
        .map_err(migration_error)?;
    let mut after = (String::new(), String::new(), 0_i64);
    loop {
        let keys: Vec<(String, String, i64)> = sqlx::query_as(LEGACY_KEYS)
            .bind(&after.0)
            .bind(&after.1)
            .bind(after.2)
            .fetch_all(&mut *conn)
            .await
            .map_err(migration_error)?;
        if keys.is_empty() {
            return Ok(());
        }
        for (space, thread, seq) in keys {
            let json: String = sqlx::query_scalar(
                "SELECT referenced_notes_json FROM chat_entries
                 WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3",
            )
            .bind(&space)
            .bind(&thread)
            .bind(seq)
            .fetch_one(&mut *conn)
            .await
            .map_err(migration_error)?;
            write_chat_ref_blocks_tx(
                &mut BackendConn::Sqlite(conn),
                &space,
                &thread,
                seq,
                json.as_bytes(),
            )
            .await?;

            let mut blocks = sqlx::query_as::<_, (i64, Vec<u8>)>(
                "SELECT block_no,payload FROM chat_entry_ref_blocks
                 WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3 ORDER BY block_no",
            )
            .bind(&space)
            .bind(&thread)
            .bind(seq)
            .fetch(&mut *conn);
            use futures_util::TryStreamExt;
            for (index, expected) in json.as_bytes().chunks(REF_BLOCK_BYTES).enumerate() {
                let Some((actual_index, payload)) =
                    blocks.try_next().await.map_err(migration_error)?
                else {
                    return Err(corrupt_backfill());
                };
                if usize::try_from(actual_index).ok() != Some(index) || payload != expected {
                    return Err(corrupt_backfill());
                }
            }
            if blocks.try_next().await.map_err(migration_error)?.is_some() {
                return Err(corrupt_backfill());
            }
            drop(blocks);
            after = (space, thread, seq);
        }
    }
}

pub(super) async fn postgres(conn: &mut PgConnection) -> Result<(), PortError> {
    for prefix in OBJECTS {
        let statement = baseline_statement(POSTGRES_BASELINE_DDL, prefix)?;
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(&mut *conn)
            .await
            .map_err(migration_error)?;
    }
    for statement in [
        "DELETE FROM chat_entry_ref_blocks",
        "CREATE TEMP TABLE migration_chat_refs(payload BYTEA NOT NULL) ON COMMIT DROP",
        "ALTER TABLE pg_temp.migration_chat_refs ALTER COLUMN payload SET STORAGE EXTERNAL",
    ] {
        sqlx::query(statement)
            .execute(&mut *conn)
            .await
            .map_err(migration_error)?;
    }
    let mut after = (String::new(), String::new(), 0_i64);
    loop {
        let keys: Vec<(String, String, i64)> = sqlx::query_as(LEGACY_KEYS)
            .bind(&after.0)
            .bind(&after.1)
            .bind(after.2)
            .fetch_all(&mut *conn)
            .await
            .map_err(migration_error)?;
        if keys.is_empty() {
            return Ok(());
        }
        for (space, thread, seq) in keys {
            // Convert the predecessor TEXT once. EXTERNAL storage lets later
            // SUBSTRING operations access the corresponding bytea TOAST slices.
            sqlx::query(
                "INSERT INTO pg_temp.migration_chat_refs
                 SELECT convert_to(referenced_notes_json,'UTF8') FROM chat_entries
                 WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3",
            )
            .bind(&space)
            .bind(&thread)
            .bind(seq)
            .execute(&mut *conn)
            .await
            .map_err(migration_error)?;
            let written = sqlx::query(
                "INSERT INTO chat_entry_ref_blocks(space_id,thread_id,entry_seq,block_no,payload)
                 SELECT $1,$2,$3,part,substring(p.payload FROM part*4096+1 FOR 4096)
                 FROM pg_temp.migration_chat_refs p
                 CROSS JOIN LATERAL generate_series(0,(octet_length(p.payload)-1)/4096) AS part",
            )
            .bind(&space)
            .bind(&thread)
            .bind(seq)
            .execute(&mut *conn)
            .await
            .map_err(migration_error)?
            .rows_affected();
            let verified: bool = sqlx::query_scalar(
                "SELECT EXISTS (
                   SELECT 1 FROM pg_temp.migration_chat_refs p
                   JOIN chat_entry_ref_blocks b ON b.space_id=$1 AND b.thread_id=$2 AND b.entry_seq=$3
                   GROUP BY octet_length(p.payload)
                   HAVING count(*)=$4
                      AND count(*)=(octet_length(p.payload)+4095)/4096
                      AND sum(octet_length(b.payload))=octet_length(p.payload)
                      AND min(b.block_no)=0 AND max(b.block_no)=count(*)-1
                      AND bool_and(b.payload=substring(p.payload FROM (b.block_no*4096+1)::integer FOR 4096))
                 )",
            )
            .bind(&space)
            .bind(&thread)
            .bind(seq)
            .bind(written as i64)
            .fetch_one(&mut *conn)
            .await
            .map_err(migration_error)?;
            if !verified {
                return Err(corrupt_backfill());
            }
            sqlx::query("TRUNCATE pg_temp.migration_chat_refs")
                .execute(&mut *conn)
                .await
                .map_err(migration_error)?;
            after = (space, thread, seq);
        }
    }
}

fn corrupt_backfill() -> PortError {
    internal_not_committed(
        "migrate_chat_ref_blocks_mismatch",
        "chat reference blocks do not match predecessor bytes",
    )
}
