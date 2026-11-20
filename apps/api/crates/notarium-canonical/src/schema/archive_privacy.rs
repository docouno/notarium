//! Privacy invalidation shares the commit of its mutation, including fast
//! writer, rollback and maintenance paths in both storage profiles.

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

pub fn sqlite_statements() -> impl Iterator<Item = String> {
    GATES.iter().map(|(table, columns, condition)| {
        format!(
            "CREATE TRIGGER IF NOT EXISTS archive_privacy_{table}
             AFTER UPDATE OF {columns} ON {table} WHEN ({condition})
             BEGIN {BUMP}; {CLEAR_CUTS}; END"
        )
    })
}

pub(super) async fn sqlite(conn: &mut SqliteConnection) -> Result<(), PortError> {
    for sql in sqlite_statements() {
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
