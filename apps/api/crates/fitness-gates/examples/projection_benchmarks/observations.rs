//! SQL witnesses read only from the disposable derived database. All timed
//! board and graph requests use the runtime ports.

use std::path::Path;

use notarium_core::ids::{NoteId, SpaceId};
use sqlx::{AssertSqlSafe, PgPool, SqlitePool};

use super::fixture::{card_id, matches_board};

const PG_SCHEMA: &str = "test_projection_derived_g1";

pub(crate) enum Observer {
    Sqlite(SqlitePool),
    Postgres(PgPool),
}

impl Observer {
    pub async fn sqlite(path: &Path) -> Self {
        Self::Sqlite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(path))
                .await
                .expect("open disposable derived database for observation"),
        )
    }

    fn qualifier(&self) -> &str {
        match self {
            Self::Sqlite(_) => "",
            Self::Postgres(_) => "test_projection_derived_g1.",
        }
    }

    pub async fn drop_for_rebuild(self, path: &Path) {
        match self {
            Self::Sqlite(pool) => {
                pool.close().await;
                std::fs::remove_dir_all(path).expect("remove disposable SQLite derived generation");
            }
            Self::Postgres(pool) => {
                sqlx::raw_sql("DROP SCHEMA test_projection_derived_g1 CASCADE")
                    .execute(&pool)
                    .await
                    .expect("remove disposable PostgreSQL derived schema");
                std::fs::remove_dir_all(path).expect("remove disposable PostgreSQL mmap cache");
            }
        }
    }

    pub async fn counts(&self) -> (usize, usize, usize) {
        let qualifier = self.qualifier();
        let notes =
            format!("SELECT count(*) FROM {qualifier}projected_notes WHERE slug LIKE 'task-%'");
        let links = format!(
            "SELECT count(*), count(resolved_dense_id) FROM {qualifier}projected_note_links"
        );
        let (notes, (links, resolved)): (i64, (i64, i64)) = match self {
            Self::Sqlite(connection) => (
                sqlx::query_scalar(AssertSqlSafe(notes.as_str()))
                    .fetch_one(connection)
                    .await
                    .unwrap(),
                sqlx::query_as(AssertSqlSafe(links.as_str()))
                    .fetch_one(connection)
                    .await
                    .unwrap(),
            ),
            Self::Postgres(connection) => (
                sqlx::query_scalar(AssertSqlSafe(notes.as_str()))
                    .fetch_one(connection)
                    .await
                    .unwrap(),
                sqlx::query_as(AssertSqlSafe(links.as_str()))
                    .fetch_one(connection)
                    .await
                    .unwrap(),
            ),
        };
        (
            usize::try_from(notes).unwrap(),
            usize::try_from(links).unwrap(),
            usize::try_from(resolved).unwrap(),
        )
    }

    pub async fn board_top(&self) -> Vec<NoteId> {
        // Read the actual header timestamps separately from the planner.
        // Deterministic fixture IDs supply an independent membership oracle.
        let sql = format!(
            "SELECT note_id, slug FROM {}projected_notes WHERE slug LIKE 'task-%'
             ORDER BY CAST(SUBSTR(slug, 6) AS BIGINT) % 2, updated_at_sec, updated_at_nsec, note_id",
            self.qualifier()
        );
        let rows: Vec<(String, String)> = match self {
            Self::Sqlite(pool) => sqlx::query_as(AssertSqlSafe(sql.as_str()))
                .fetch_all(pool)
                .await
                .unwrap(),
            Self::Postgres(pool) => sqlx::query_as(AssertSqlSafe(sql.as_str()))
                .fetch_all(pool)
                .await
                .unwrap(),
        };
        rows.into_iter()
            .filter(|(_, slug)| matches_board(slug[5..].parse::<usize>().unwrap()))
            .take(50)
            .map(|(note, _)| NoteId::parse(&note).unwrap())
            .collect()
    }

    pub async fn watch_folder_move(&self) {
        match self {
            Self::Sqlite(pool) => {
                sqlx::raw_sql(
                    "CREATE TABLE benchmark_move_touches (links INTEGER NOT NULL, candidates INTEGER NOT NULL);
                     INSERT INTO benchmark_move_touches VALUES (0, 0);",
                ).execute(pool).await.unwrap();
                for (operation, row) in [("INSERT", "NEW"), ("UPDATE", "OLD"), ("DELETE", "OLD")] {
                    let sql = format!(
                        "CREATE TRIGGER measure_link_{operation} AFTER {operation} ON projected_note_links
                         WHEN {row}.raw_target LIKE 'Task %' AND {row}.dir_norm_prefix = ''
                         BEGIN UPDATE benchmark_move_touches SET links = links + 1; END;
                         CREATE TRIGGER measure_candidates_{operation} AFTER {operation} ON candidate_lookup_keys
                         BEGIN UPDATE benchmark_move_touches SET candidates = candidates + 1; END;",
                    );
                    sqlx::raw_sql(AssertSqlSafe(sql))
                        .execute(pool)
                        .await
                        .unwrap();
                }
            }
            Self::Postgres(pool) => {
                let sql = format!(
                    "CREATE TABLE {PG_SCHEMA}.benchmark_move_touches (links BIGINT NOT NULL, candidates BIGINT NOT NULL);
                     INSERT INTO {PG_SCHEMA}.benchmark_move_touches VALUES (0, 0);
                     CREATE FUNCTION {PG_SCHEMA}.measure_projection_move() RETURNS trigger
                     LANGUAGE plpgsql AS $benchmark$
                     BEGIN
                       IF TG_TABLE_NAME = 'candidate_lookup_keys' THEN
                         UPDATE {PG_SCHEMA}.benchmark_move_touches SET candidates = candidates + 1;
                       ELSIF TG_OP = 'INSERT' THEN
                         IF NEW.raw_target LIKE 'Task %' AND NEW.dir_norm_prefix = '' THEN
                           UPDATE {PG_SCHEMA}.benchmark_move_touches SET links = links + 1;
                         END IF;
                       ELSIF OLD.raw_target LIKE 'Task %' AND OLD.dir_norm_prefix = '' THEN
                         UPDATE {PG_SCHEMA}.benchmark_move_touches SET links = links + 1;
                       END IF;
                       RETURN NULL;
                     END
                     $benchmark$;
                     CREATE TRIGGER measure_link_move AFTER INSERT OR UPDATE OR DELETE
                     ON {PG_SCHEMA}.projected_note_links FOR EACH ROW
                     EXECUTE FUNCTION {PG_SCHEMA}.measure_projection_move();
                     CREATE TRIGGER measure_candidate_move AFTER INSERT OR UPDATE OR DELETE
                     ON {PG_SCHEMA}.candidate_lookup_keys FOR EACH ROW
                     EXECUTE FUNCTION {PG_SCHEMA}.measure_projection_move();",
                );
                sqlx::raw_sql(AssertSqlSafe(sql))
                    .execute(pool)
                    .await
                    .unwrap();
            }
        }
    }

    pub async fn folder_move_touches(&self) -> (usize, usize) {
        let sql = format!(
            "SELECT links, candidates FROM {}benchmark_move_touches",
            self.qualifier()
        );
        let (links, candidates): (i64, i64) = match self {
            Self::Sqlite(pool) => sqlx::query_as(AssertSqlSafe(sql.as_str()))
                .fetch_one(pool)
                .await
                .unwrap(),
            Self::Postgres(pool) => sqlx::query_as(AssertSqlSafe(sql.as_str()))
                .fetch_one(pool)
                .await
                .unwrap(),
        };
        (
            usize::try_from(links).unwrap(),
            usize::try_from(candidates).unwrap(),
        )
    }

    pub async fn semantic_digest(&self, space: &SpaceId, corpus_notes: usize) -> blake3::Hash {
        let mut digest = blake3::Hasher::new();
        let qualifier = self.qualifier();
        let notes_sql = format!(
            "SELECT note.note_id, note.rev_id, note.parent_folder_id, note.slug, note.title,
                    note.preview, note.tags_msgpack, note.raw_fields_msgpack,
                    note.evaluated_fields_msgpack, folder.project_folder_id
             FROM {qualifier}projected_notes note
             LEFT JOIN {qualifier}projected_folders folder
               ON folder.space_id = note.space_id AND folder.folder_id = note.parent_folder_id
             WHERE note.space_id = $3 AND note.note_id >= $1 AND note.note_id < $2 ORDER BY note.note_id"
        );
        let links_sql = format!(
            "SELECT src.note_id, link.link_ord, link.raw_target, dest.note_id, link.resolved_tier
             FROM {qualifier}projected_notes src
             JOIN {qualifier}projected_note_links link
               ON link.space_id = src.space_id AND link.src_dense_id = src.dense_id
             LEFT JOIN {qualifier}projected_notes dest
               ON dest.space_id = link.space_id AND dest.dense_id = link.resolved_dense_id
             WHERE src.space_id = $3 AND src.note_id >= $1 AND src.note_id < $2 ORDER BY src.note_id, link.link_ord"
        );
        let ranks_sql = format!(
            "SELECT view_note_id, view_key, target_note_id, group_key_hex, sort_rank_lexo, rank_rev_id,
                    placement_revision FROM {qualifier}projected_view_ranks
             WHERE space_id = $3 AND target_note_id >= $1 AND target_note_id < $2 ORDER BY view_note_id, view_key, target_note_id"
        );
        type NoteWitness = (
            String,
            String,
            String,
            String,
            String,
            String,
            Vec<u8>,
            Vec<u8>,
            Vec<u8>,
            Option<String>,
        );
        type LinkWitness = (String, i64, String, Option<String>, Option<i64>);
        type RankWitness = (String, String, String, String, String, String, String);
        for start in (0..corpus_notes).step_by(512) {
            let lower = card_id(start);
            let upper = card_id((start + 512).min(corpus_notes));
            // These fixture keys are deterministic. Limits apply to each range
            // so verification does not materialize the complete corpus.
            let (notes, links, ranks): (Vec<NoteWitness>, Vec<LinkWitness>, Vec<RankWitness>) =
                match self {
                    Self::Sqlite(pool) => (
                        sqlx::query_as(AssertSqlSafe(notes_sql.as_str()))
                            .bind(lower.as_str())
                            .bind(upper.as_str())
                            .bind(space.as_str())
                            .fetch_all(pool)
                            .await
                            .unwrap(),
                        sqlx::query_as(AssertSqlSafe(links_sql.as_str()))
                            .bind(lower.as_str())
                            .bind(upper.as_str())
                            .bind(space.as_str())
                            .fetch_all(pool)
                            .await
                            .unwrap(),
                        sqlx::query_as(AssertSqlSafe(ranks_sql.as_str()))
                            .bind(lower.as_str())
                            .bind(upper.as_str())
                            .bind(space.as_str())
                            .fetch_all(pool)
                            .await
                            .unwrap(),
                    ),
                    Self::Postgres(pool) => (
                        sqlx::query_as(AssertSqlSafe(notes_sql.as_str()))
                            .bind(lower.as_str())
                            .bind(upper.as_str())
                            .bind(space.as_str())
                            .fetch_all(pool)
                            .await
                            .unwrap(),
                        sqlx::query_as(AssertSqlSafe(links_sql.as_str()))
                            .bind(lower.as_str())
                            .bind(upper.as_str())
                            .bind(space.as_str())
                            .fetch_all(pool)
                            .await
                            .unwrap(),
                        sqlx::query_as(AssertSqlSafe(ranks_sql.as_str()))
                            .bind(lower.as_str())
                            .bind(upper.as_str())
                            .bind(space.as_str())
                            .fetch_all(pool)
                            .await
                            .unwrap(),
                    ),
                };
            let encoded =
                serde_json::to_vec(&(notes, links, ranks)).expect("serialize semantic witnesses");
            digest.update(&(encoded.len() as u64).to_le_bytes());
            digest.update(&encoded);
        }
        digest.finalize()
    }
}
