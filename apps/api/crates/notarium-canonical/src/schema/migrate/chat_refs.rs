//! Populate normalized `chat_entry_note_refs` rows during schema v6 -> v7 upgrades.
use super::{POSTGRES_BASELINE_DDL, SQLITE_BASELINE_DDL, baseline_statement};
use crate::{
    codec::internal_not_committed, projection_chat::write_chat_note_refs_tx, sql_exec::BackendConn,
};
use notarium_core::{error::PortError, model::NoteRef};
use sqlx::{PgConnection, SqliteConnection};

fn migration_error(error: sqlx::Error) -> PortError {
    internal_not_committed("migrate_chat_note_refs", error.to_string())
}

const OBJECTS: [&str; 5] = [
    "CREATE TABLE IF NOT EXISTS chat_entry_note_refs (",
    "CREATE INDEX IF NOT EXISTS idx_chat_entry_note_refs_target",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_projection",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_created_change",
    "CREATE INDEX IF NOT EXISTS idx_chat_entries_redacted_change",
];

const LEGACY_ENTRIES: &str = "SELECT space_id,thread_id,entry_seq,referenced_notes_json
    FROM chat_entries
    WHERE (space_id,thread_id,entry_seq)>($1,$2,$3)
      AND kind <> 'redacted' AND checkpoint_stale=0 AND referenced_notes_json <> '[]'
    ORDER BY space_id,thread_id,entry_seq LIMIT 128";

pub(super) async fn sqlite(conn: &mut SqliteConnection) -> Result<(), PortError> {
    for prefix in OBJECTS {
        let statement = baseline_statement(SQLITE_BASELINE_DDL, prefix)?;
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(&mut *conn)
            .await
            .map_err(migration_error)?;
    }
    sqlx::query("DELETE FROM chat_entry_note_refs")
        .execute(&mut *conn)
        .await
        .map_err(migration_error)?;
    let mut after = (String::new(), String::new(), 0_i64);
    loop {
        let entries: Vec<(String, String, i64, String)> = sqlx::query_as(LEGACY_ENTRIES)
            .bind(&after.0)
            .bind(&after.1)
            .bind(after.2)
            .fetch_all(&mut *conn)
            .await
            .map_err(migration_error)?;
        if entries.is_empty() {
            return Ok(());
        }
        for (space, thread, seq, json) in entries {
            let refs: Vec<NoteRef> = serde_json::from_str(&json).map_err(|error| {
                internal_not_committed("migrate_chat_note_refs_json", error.to_string())
            })?;
            write_chat_note_refs_tx(&mut BackendConn::Sqlite(conn), &space, &thread, seq, &refs)
                .await?;
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
    sqlx::query("DELETE FROM chat_entry_note_refs")
        .execute(&mut *conn)
        .await
        .map_err(migration_error)?;
    let mut after = (String::new(), String::new(), 0_i64);
    loop {
        let entries: Vec<(String, String, i64, String)> = sqlx::query_as(LEGACY_ENTRIES)
            .bind(&after.0)
            .bind(&after.1)
            .bind(after.2)
            .fetch_all(&mut *conn)
            .await
            .map_err(migration_error)?;
        if entries.is_empty() {
            return Ok(());
        }
        for (space, thread, seq, json) in entries {
            let refs: Vec<NoteRef> = serde_json::from_str(&json).map_err(|error| {
                internal_not_committed("migrate_chat_note_refs_json", error.to_string())
            })?;
            write_chat_note_refs_tx(
                &mut BackendConn::Postgres(conn),
                &space,
                &thread,
                seq,
                &refs,
            )
            .await?;
            after = (space, thread, seq);
        }
    }
}
