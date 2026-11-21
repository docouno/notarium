//! Privacy invalidation shares the commit of its mutation, including fast
//! writer, rollback and maintenance paths in both storage profiles.

use std::collections::BTreeMap;

use notarium_core::error::PortError;
use sqlx::{PgConnection, SqliteConnection};

use crate::codec::internal_not_committed;

const GATES: &[(&str, &str, &str)] = &[
    (
        "note_heads",
        "lifecycle_state, doc_class, visibility_mask",
        "(OLD.lifecycle_state <> 'purged' AND NEW.lifecycle_state = 'purged') OR
         (OLD.lifecycle_state = 'active' AND
            (NEW.lifecycle_state <> 'active' OR OLD.doc_class <> NEW.doc_class
                OR OLD.visibility_mask <> NEW.visibility_mask))",
    ),
    (
        "folder_heads",
        "lifecycle_state",
        "OLD.lifecycle_state='active' AND NEW.lifecycle_state<>'active'",
    ),
    (
        "chat_entries",
        "kind, checkpoint_stale, ext_space_tainted",
        "(OLD.kind<>'redacted' AND NEW.kind='redacted')
          OR (OLD.checkpoint_stale=0 AND NEW.checkpoint_stale<>0)
          OR (OLD.ext_space_tainted=0 AND NEW.ext_space_tainted<>0)",
    ),
    (
        "chat_threads",
        "ext_space_tainted_mask, project_folder_id",
        "(OLD.ext_space_tainted_mask=0 AND NEW.ext_space_tainted_mask<>0)
          OR COALESCE(OLD.project_folder_id, '') <> COALESCE(NEW.project_folder_id, '')",
    ),
    (
        "ability_packages",
        "lifecycle_state",
        "OLD.lifecycle_state='active' AND NEW.lifecycle_state<>'active'",
    ),
    (
        "spaces",
        "lifecycle_state, history_incarnation",
        "(OLD.lifecycle_state='active' AND NEW.lifecycle_state<>'active')
          OR OLD.history_incarnation<>NEW.history_incarnation",
    ),
];

const BUMP: &str = "INSERT INTO archive_privacy(space_id, generation) VALUES (NEW.space_id, 1)
    ON CONFLICT(space_id) DO UPDATE SET generation = archive_privacy.generation + 1";

// An invalidated cut can never read again. Its cascade removes pre-images
// atomically with the privacy mutation, including any just captured by it.
const CLEAR_CUTS: &str = "DELETE FROM archive_export_cuts WHERE space_id=NEW.space_id";

// SQLite stores the CREATE statement without IF NOT EXISTS in sqlite_schema.
fn sqlite_definitions(clear_cuts: bool) -> impl Iterator<Item = (String, String)> {
    let body = if clear_cuts {
        format!("{BUMP}; {CLEAR_CUTS};")
    } else {
        format!("{BUMP};")
    };
    GATES.iter().map(move |(table, columns, condition)| {
        let name = format!("archive_privacy_{table}");
        let sql = format!(
            "CREATE TRIGGER {name}
             AFTER UPDATE OF {columns} ON {table} WHEN ({condition})
             BEGIN {body} END"
        );
        (name, sql)
    })
}

pub fn sqlite_statements() -> impl Iterator<Item = String> {
    sqlite_definitions(true)
        .map(|(_, sql)| sql.replacen("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS", 1))
}

/// Stored definitions from the recognized v7 manifest before eager cut deletion.
/// Subsequent schema upgrades could retain this complete set via IF NOT EXISTS.
pub fn sqlite_v7_privacy_definitions() -> impl Iterator<Item = (String, String)> {
    sqlite_definitions(false)
}

pub(super) async fn sqlite(conn: &mut SqliteConnection) -> Result<(), PortError> {
    let stored: Vec<(String, String)> = sqlx::query_as(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'archive_privacy_*'
         LIMIT ?",
    )
    .bind(GATES.len() as i64 + 1)
    .fetch_all(&mut *conn)
    .await
    .map_err(error)?;
    let stored: BTreeMap<_, _> = stored.into_iter().collect();
    let current: BTreeMap<_, _> = sqlite_definitions(true).collect();
    if stored == current {
        return Ok(());
    }
    if !stored.is_empty() {
        if stored != sqlite_v7_privacy_definitions().collect() {
            return Err(internal_not_committed(
                "archive_privacy_triggers",
                "unrecognized SQLite privacy trigger definitions",
            ));
        }
        for name in current.keys() {
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
                .execute(&mut *conn)
                .await
                .map_err(error)?;
        }
    }
    for sql in current.into_values() {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await
            .map_err(error)?;
    }
    Ok(())
}

pub(super) async fn postgres(conn: &mut PgConnection) -> Result<(), PortError> {
    let procedure = format!(
        "CREATE OR REPLACE FUNCTION notarium_bump_archive_privacy()
         RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
         BEGIN
           PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || NEW.space_id, 7311231));
           {BUMP}; {CLEAR_CUTS}; RETURN NEW;
         END;
         $$"
    );
    sqlx::query(sqlx::AssertSqlSafe(procedure))
        .execute(&mut *conn)
        .await
        .map_err(error)?;
    for (table, columns, condition) in GATES {
        let sql = format!(
            "CREATE OR REPLACE TRIGGER archive_privacy_{table}
             AFTER UPDATE OF {columns} ON {table} FOR EACH ROW WHEN ({condition})
             EXECUTE FUNCTION notarium_bump_archive_privacy()"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await
            .map_err(error)?;
    }
    Ok(())
}

fn error(err: sqlx::Error) -> PortError {
    internal_not_committed("archive_privacy_triggers", err.to_string())
}
