use super::support::StorageTestFixtures;

const QUERY: &str = include_str!("../../src/domain/rollback/note_states.sql");
const IDS: [&str; 7] = [
    "purged", "missing", "clean", "active", "fenced", "dirty", "pending",
];

// Include unrelated rows in each of the four composite indexes used by the writer.
const ROWS: &str = "
CREATE TEMP TABLE revision_purge_fences(space_id TEXT, note_id TEXT, PRIMARY KEY(space_id,note_id));
CREATE TEMP TABLE collab_sessions(space_id TEXT, note_id TEXT, room_state TEXT, PRIMARY KEY(space_id,note_id));
CREATE TEMP TABLE collab_checkpoints(space_id TEXT, note_id TEXT, carrier_dirty INTEGER, PRIMARY KEY(space_id,note_id));
CREATE TEMP TABLE collab_update_log(space_id TEXT, note_id TEXT, lease_epoch BIGINT, update_seq BIGINT, PRIMARY KEY(space_id,note_id,lease_epoch,update_seq));
WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM numbers WHERE n < 2048)
INSERT INTO revision_purge_fences SELECT 'space', CAST(n AS TEXT) FROM numbers;
INSERT INTO collab_sessions SELECT space_id,note_id,'closed' FROM revision_purge_fences;
INSERT INTO collab_checkpoints SELECT space_id,note_id,0 FROM revision_purge_fences;
INSERT INTO collab_update_log SELECT space_id,note_id,1,1 FROM revision_purge_fences;
INSERT INTO revision_purge_fences VALUES ('space','purged'), ('other','clean');
INSERT INTO collab_sessions VALUES ('space','clean','closed'), ('space','active','active'),
    ('space','fenced','fenced'), ('space','dirty','closed'), ('space','pending','closed'), ('other','missing','active');
INSERT INTO collab_checkpoints VALUES ('space','dirty',1);
INSERT INTO collab_update_log VALUES ('space','pending',1,1);";

type State = (String, bool, Option<i32>);

fn assert_states(mut rows: Vec<State>) {
    rows.sort();
    let expected = [
        ("active", false, Some(1)),
        ("clean", false, Some(0)),
        ("dirty", false, Some(1)),
        ("fenced", false, Some(2)),
        ("missing", false, None),
        ("pending", false, Some(1)),
        ("purged", true, None),
    ]
    .map(|(id, purged, status)| (id.to_owned(), purged, status));
    assert_eq!(rows, expected);
}

#[tokio::test]
async fn rollback_note_states_probe_only_requested_rows_in_both_dialects() {
    use rusqlite::{StatementStatus, named_params};
    let sqlite = rusqlite::Connection::open_in_memory().unwrap();
    sqlite.execute_batch(ROWS).unwrap();
    let query = format!("WITH requested(note_id) AS (SELECT value FROM json_each($2)) {QUERY}");
    let mut stmt = sqlite.prepare(&query).unwrap();
    let json = serde_json::to_string(&IDS).unwrap();
    let args = named_params! { "$1": "space", "$2": json };
    let rows = stmt
        .query_map(args, |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_states(rows);
    assert_eq!(stmt.get_status(StatementStatus::FullscanStep), 0);

    let fixtures = StorageTestFixtures::load_required();
    let mut conn = fixtures.open_raw_pg().await;
    sqlx::raw_sql(ROWS).execute(&mut conn).await.unwrap();
    sqlx::raw_sql("ANALYZE revision_purge_fences; ANALYZE collab_sessions; ANALYZE collab_checkpoints; ANALYZE collab_update_log; SET plan_cache_mode=force_generic_plan").execute(&mut conn).await.unwrap();
    let sql = format!("WITH requested(note_id) AS (SELECT unnest($2::text[])) {QUERY}");
    let rows = sqlx::query_as::<_, State>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind("space")
        .bind(IDS.as_slice())
        .fetch_all(&mut conn)
        .await
        .unwrap();
    assert_states(rows);
    let plan = format!("EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) {sql}");
    let details = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(plan))
        .bind("space")
        .bind(IDS.as_slice())
        .fetch_all(&mut conn)
        .await
        .unwrap()
        .join("\n");
    for table in [
        "revision_purge_fences",
        "collab_sessions",
        "collab_checkpoints",
        "collab_update_log",
    ] {
        assert!(
            !details.contains(&format!("Seq Scan on {table}")),
            "{details}"
        );
    }
    assert!(
        details
            .lines()
            .filter(|line| line.contains("Index Cond:")
                && line.contains("space_id")
                && line.contains("note_id"))
            .count()
            >= 4,
        "{details}"
    );
}
