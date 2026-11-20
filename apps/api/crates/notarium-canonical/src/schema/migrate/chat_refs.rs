//! Upgrade normalized chat references inside the schema bootstrap transaction.
use super::{POSTGRES_BASELINE_DDL, SQLITE_BASELINE_DDL, baseline_statement};
use crate::{
    codec::internal_not_committed, projection_chat::write_chat_note_refs_json_tx,
    sql_exec::BackendConn,
};
use notarium_core::error::PortError;
use sqlx::{PgConnection, SqliteConnection};

fn migration_error(error: sqlx::Error) -> PortError {
    internal_not_committed("migrate_chat_note_refs", error.to_string())
}

const OBJECTS: [&str; 6] = [
    "CREATE TABLE IF NOT EXISTS chat_entry_note_refs (",
    "CREATE INDEX IF NOT EXISTS idx_chat_entry_note_refs_target",
    "CREATE INDEX IF NOT EXISTS idx_chat_entry_note_refs_created",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_projection",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_created_change",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_redacted_change",
];

// Page only fixed-size identities. Holding several complete legacy JSON values
// at once would make bootstrap memory depend on the sum of their sizes.
const LEGACY_KEYS: &str = "SELECT space_id,thread_id,entry_seq
    FROM chat_entries
    WHERE (space_id,thread_id,entry_seq)>($1,$2,$3)
    ORDER BY space_id,thread_id,entry_seq LIMIT 128";
const LEGACY_REFS: &str = "SELECT created_space_seq,referenced_notes_json FROM chat_entries
    WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3
      AND kind <> 'redacted' AND checkpoint_stale=0";

// Both paths run under the bootstrap transaction. SQLite needs a replacement
// table for the NOT NULL column. Keep its source on disk and index the empty
// destination before copying, so the sort never holds the full catalog in RAM.
const SQLITE_PREPARE_V7: &str =
    "ALTER TABLE chat_entry_note_refs RENAME TO chat_entry_note_refs_v7;
     DROP INDEX idx_chat_entry_note_refs_target";
const SQLITE_COPY_V7: &str = "INSERT INTO chat_entry_note_refs
         (space_id,thread_id,entry_seq,ref_ordinal,target_space_id,target_note_id,created_space_seq)
     SELECT r.space_id,r.thread_id,r.entry_seq,r.ref_ordinal,r.target_space_id,r.target_note_id,
         (SELECT e.created_space_seq FROM chat_entries e WHERE e.space_id=r.space_id
             AND e.thread_id=r.thread_id AND e.entry_seq=r.entry_seq)
     FROM chat_entry_note_refs_v7 r;
     DROP TABLE chat_entry_note_refs_v7";

// PostgreSQL can add the column in place. Updating only this column preserves
// the validated foreign keys and avoids queueing a trigger event per occurrence.
const POSTGRES_PREPARE_V7: &str =
    "ALTER TABLE chat_entry_note_refs ADD COLUMN created_space_seq BIGINT CHECK (created_space_seq >= 1);
     DROP INDEX idx_chat_entry_note_refs_target;
     UPDATE chat_entry_note_refs r SET created_space_seq=e.created_space_seq
       FROM chat_entries e
       WHERE e.space_id=r.space_id AND e.thread_id=r.thread_id AND e.entry_seq=r.entry_seq;
     ALTER TABLE chat_entry_note_refs ALTER COLUMN created_space_seq SET NOT NULL";

macro_rules! migrate {
    ($name:ident, $connection:ty, $variant:ident, $ddl:ident, $prepare:ident $(, $copy:ident)?) => {
        pub(super) async fn $name(conn: &mut $connection, version: i64) -> Result<(), PortError> {
            if version == 7 {
                sqlx::raw_sql($prepare)
                    .execute(&mut *conn)
                    .await
                    .map_err(migration_error)?;
            }
            for prefix in OBJECTS {
                let statement = baseline_statement($ddl, prefix)?;
                sqlx::query(sqlx::AssertSqlSafe(statement))
                    .execute(&mut *conn)
                    .await
                    .map_err(migration_error)?;
            }
            if version == 7 {
                $(sqlx::raw_sql($copy)
                    .execute(&mut *conn)
                    .await
                    .map_err(migration_error)?;)?
                return Ok(());
            }
            sqlx::query("DELETE FROM chat_entry_note_refs")
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
                    let entry: Option<(i64, String)> = sqlx::query_as(LEGACY_REFS)
                        .bind(&space)
                        .bind(&thread)
                        .bind(seq)
                        .fetch_optional(&mut *conn)
                        .await
                        .map_err(migration_error)?;
                    if let Some((created, json)) = entry {
                        write_chat_note_refs_json_tx(
                            &mut BackendConn::$variant(conn),
                            &space,
                            &thread,
                            seq,
                            created,
                            &json,
                        )
                        .await?;
                    }
                    after = (space, thread, seq);
                }
            }
        }
    };
}

migrate!(
    sqlite,
    SqliteConnection,
    Sqlite,
    SQLITE_BASELINE_DDL,
    SQLITE_PREPARE_V7,
    SQLITE_COPY_V7
);
migrate!(
    postgres,
    PgConnection,
    Postgres,
    POSTGRES_BASELINE_DDL,
    POSTGRES_PREPARE_V7
);

#[cfg(test)]
#[test]
fn migration_key_page_reads_only_fixed_size_identities() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch(SQLITE_BASELINE_DDL).unwrap();
    let keys = db.prepare(LEGACY_KEYS).unwrap();
    assert_eq!(keys.column_names(), ["space_id", "thread_id", "entry_seq"]);
    let plan: String = db
        .query_row(
            &format!("EXPLAIN QUERY PLAN {LEGACY_KEYS}"),
            rusqlite::params!["", "", 0],
            |row| row.get(3),
        )
        .unwrap();
    assert!(plan.contains("COVERING INDEX"), "{plan}");
}
