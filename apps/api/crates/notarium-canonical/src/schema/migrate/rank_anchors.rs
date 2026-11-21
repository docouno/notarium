//! Capture the surviving v6 board placements inside the bootstrap transaction.
use crate::sql_exec::BackendConn;
use sqlx::{AssertSqlSafe, PgConnection};

const COPY_MARKERS: &str = "INSERT INTO projection_rank_anchors
    (space_id, history_incarnation, anchor_seq)
    SELECT space_id, history_incarnation, last_seq";
const COPY_ROWS: &str = "INSERT INTO projection_rank_anchor_rows
    (space_id, view_note_id, view_key, target_note_id, group_key_msgpack, group_key_hex,
     sort_rank_lexo, rank_rev_id, placement_revision, placement_actor_id, placement_run_id, updated_seq)
    SELECT space_id, view_note_id, view_key, target_note_id, group_key_msgpack, group_key_hex,
           sort_rank_lexo, rank_rev_id, placement_revision, placement_actor_id, placement_run_id, updated_seq";

pub(super) async fn copy(conn: &mut BackendConn<'_>) -> Result<(), sqlx::Error> {
    match conn {
        BackendConn::Sqlite(conn) => {
            for sql in [
                format!("{COPY_MARKERS} FROM spaces"),
                format!("{COPY_ROWS} FROM view_rank_overlays"),
            ] {
                sqlx::query(AssertSqlSafe(sql)).execute(&mut **conn).await?;
            }
            Ok(())
        }
        BackendConn::Postgres(conn) => copy_postgres(conn).await,
    }
}

// PostgreSQL queues immediate foreign-key events until each statement finishes.
// Each page uses the source primary key and returns only its final identity.
// Derive that identity from the source: the anchor's text collations can differ.
async fn copy_postgres(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    let markers = format!(
        "WITH page AS (
            SELECT space_id, history_incarnation, last_seq FROM spaces
            WHERE space_id > $1 ORDER BY space_id LIMIT 1024
         ), copied AS ({COPY_MARKERS} FROM page)
         SELECT space_id FROM page ORDER BY space_id DESC LIMIT 1"
    );
    let mut space = String::new();
    while let Some(next) = sqlx::query_scalar(AssertSqlSafe(markers.as_str()))
        .bind(&space)
        .fetch_optional(&mut *conn)
        .await?
    {
        space = next;
    }
    let ranks = format!(
        "WITH page AS (
            SELECT * FROM view_rank_overlays
            WHERE (space_id, view_note_id, view_key, target_note_id) > ($1, $2, $3, $4)
            ORDER BY space_id, view_note_id, view_key, target_note_id LIMIT 1024
         ), copied AS ({COPY_ROWS} FROM page)
         SELECT space_id, view_note_id, view_key, target_note_id FROM page
         ORDER BY space_id DESC, view_note_id DESC, view_key DESC, target_note_id DESC LIMIT 1"
    );
    let mut after = (String::new(), String::new(), String::new(), String::new());
    while let Some(next) = sqlx::query_as(AssertSqlSafe(ranks.as_str()))
        .bind(&after.0)
        .bind(&after.1)
        .bind(&after.2)
        .bind(&after.3)
        .fetch_optional(&mut *conn)
        .await?
    {
        after = next;
    }
    Ok(())
}
