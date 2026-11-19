//! Capture the first pre-image of a changed export row while a cut owns its
//! hold. Normal writes have no version-retention burden between exports.

use notarium_core::error::PortError;
use sqlx::{PgConnection, SqliteConnection};

use crate::codec::internal_not_committed;

pub(crate) struct Versioned {
    pub table: &'static str,
    pub kind: &'static str,
    pub key: &'static str,
    pub values: &'static [&'static str],
}

pub(crate) const VERSIONED: &[Versioned] = &[
    Versioned {
        table: "folder_heads",
        kind: "folder",
        key: "folder_id",
        values: &["parent_folder_id", "is_root", "slug", "lifecycle_state"],
    },
    Versioned {
        table: "note_heads",
        kind: "note",
        key: "note_id",
        values: &[
            "parent_folder_id",
            "slug",
            "doc_class",
            "ability_id",
            "content_blake3",
            "lifecycle_state",
        ],
    },
    Versioned {
        table: "space_field_schemas",
        kind: "schema",
        key: "schema_rev_id",
        values: &["schema_note_id", "is_current", "created_seq"],
    },
    Versioned {
        table: "ability_packages",
        kind: "package",
        key: "ability_id",
        values: &["slug_fold", "manifest_rev_id", "lifecycle_state"],
    },
    Versioned {
        table: "chat_threads",
        kind: "thread",
        key: "thread_id",
        values: &[
            "owner_id",
            "kind",
            "title",
            "project_folder_id",
            "ext_space_tainted_mask",
            "head_leaf_seq",
        ],
    },
];

fn capture(spec: &Versioned, pg: bool) -> String {
    let payload = spec.payload("OLD", pg);
    format!(
        "INSERT INTO archive_export_shadows(backup_id,space_id,entity_kind,entity_id,payload)
         SELECT c.backup_id,OLD.space_id,'{kind}',OLD.{key},{payload}
         FROM archive_export_cuts c WHERE c.space_id=OLD.space_id AND OLD.created_seq<=c.cutoff_seq
         ON CONFLICT(backup_id,space_id,entity_kind,entity_id) DO NOTHING",
        kind = spec.kind,
        key = spec.key,
    )
}

impl Versioned {
    pub(crate) fn payload(&self, row: &str, pg: bool) -> String {
        let value_expr = self.values.iter().map(|&name| {
        if name == "content_blake3" {
            if pg { format!("encode({row}.content_blake3,'hex')") }
            else { format!("CASE WHEN {row}.content_blake3 IS NULL THEN NULL ELSE lower(hex({row}.content_blake3)) END") }
        } else {
            format!("{row}.{name}")
        }
    }).collect::<Vec<_>>().join(",");
        if pg {
            format!("CAST(json_build_array({value_expr}) AS TEXT)")
        } else {
            format!("json_array({value_expr})")
        }
    }
}

pub fn sqlite_statements() -> impl Iterator<Item = String> {
    VERSIONED.iter().flat_map(|spec| {
        [
            format!(
                "CREATE TRIGGER IF NOT EXISTS archive_cut_update_{table}
                BEFORE UPDATE OF {columns} ON {table} BEGIN {capture}; END",
                table = spec.table,
                columns = spec.values.join(","),
                capture = capture(spec, false)
            ),
            format!(
                "CREATE TRIGGER IF NOT EXISTS archive_cut_delete_{table}
                BEFORE DELETE ON {table} BEGIN {capture}; END",
                table = spec.table,
                capture = capture(spec, false)
            ),
        ]
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
    for spec in VERSIONED {
        let table = spec.table;
        let sql = format!(
            "CREATE OR REPLACE FUNCTION notarium_archive_copy_{table}() RETURNS TRIGGER
              LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
              BEGIN {capture}; IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END;
              $$",
            capture = capture(spec, true),
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await
            .map_err(error)?;
        let sql = format!(
            "CREATE OR REPLACE TRIGGER archive_cut_{table}
            BEFORE UPDATE OF {columns} OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION notarium_archive_copy_{table}()",
            columns = spec.values.join(",")
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await
            .map_err(error)?;
    }
    Ok(())
}

fn error(err: sqlx::Error) -> PortError {
    internal_not_committed("archive_version_triggers", err.to_string())
}
