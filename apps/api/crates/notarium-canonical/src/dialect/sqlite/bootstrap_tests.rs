use std::{env, process::Command};

use super::*;
use crate::schema::{SQLITE_BASELINE_DDL, migrate::V6_HASH};

#[tokio::test]
async fn legacy_index_bootstrap_spills_with_a_bounded_sqlite_heap() {
    const CHILD_DB: &str = "NOTARIUM_TEST_BOOTSTRAP_HEAP_DB";
    let installation = InstallationId::from_bytes([0x61; 16]);

    // hard_heap_limit is process-wide and can only be lowered.
    if let Some(path) = env::var_os(CHILD_DB) {
        let mut writer = open_sqlite_writer_connection(Path::new(&path))
            .await
            .unwrap();
        sqlx::raw_sql("PRAGMA mmap_size=0; PRAGMA cache_size=-1024")
            .execute(&mut writer)
            .await
            .unwrap();
        let limit: i64 = sqlx::query_scalar("PRAGMA hard_heap_limit=8388608")
            .fetch_one(&mut writer)
            .await
            .unwrap();
        assert_eq!(limit, 8 * 1024 * 1024);
        let (mut writer, witness) = bootstrap_new_writer(writer, &installation).await.unwrap();
        assert_eq!(witness.state, DatabaseState::Ready);
        let serving_mode: i64 = sqlx::query_scalar("PRAGMA temp_store")
            .fetch_one(&mut writer)
            .await
            .unwrap();
        assert_eq!(serving_mode, 2);
        return;
    }

    let root = env::temp_dir()
        .join(crate::codec::new_prefixed_hex_id("notarium-bootstrap-sort-").unwrap());
    fs::create_dir(&root).unwrap();
    let path = root.join("canonical.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(SQLITE_BASELINE_DDL).unwrap();
    db.execute_batch(concat!(
        include_str!("../../../tests/fixtures/schema-v6-remove-projection.sql"),
        include_str!("../../../tests/fixtures/schema-v8-remove-agents.sql")
    ))
    .unwrap();
    db.execute(
        "INSERT INTO schema_meta VALUES(1,6,1,?1,'ready',?2,0,0,0,0)",
        rusqlite::params![installation.as_str(), hex::decode(V6_HASH).unwrap()],
    )
    .unwrap();
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
         INSERT INTO spaces VALUES('sp_'||printf('%032x',1),zeroblob(16),'root','home','home',
              'personal','owner','active',1,65538,'{}',0,0);
         INSERT INTO chat_threads VALUES('sp_'||printf('%032x',1),zeroblob(16),'thr_'||printf('%032x',1),
              'personal','owner',NULL,'',0,'r',1,NULL,0,1,1,0,0,0,0);
         WITH RECURSIVE ids(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM ids WHERE i<65536)
         INSERT INTO chat_entries(space_id,thread_id,entry_seq,revision_id,kind,author_id,inline_text,
              referenced_notes_json,ext_space_tainted,is_chain_node,branch_depth,created_space_seq)
         SELECT 'sp_'||printf('%032x',1),'thr_'||printf('%032x',1),i,'rev_'||printf('%032x',i),
              'human','owner','body','[]',0,1,0,i+2 FROM ids"
    ).unwrap();
    drop(db);

    let child = Command::new(env::current_exe().unwrap()).args([
        "--exact", "dialect::sqlite::bootstrap_tests::legacy_index_bootstrap_spills_with_a_bounded_sqlite_heap",
    ]).env(CHILD_DB, &path).output().unwrap();
    // Check the file independently, including that the child ran the migration.
    let db = rusqlite::Connection::open(&path).unwrap();
    let state = db.query_row(
        "SELECT schema_version,
            (SELECT COUNT(*) FROM chat_entries INDEXED BY idx_chat_entries_projection)
         FROM schema_meta",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    );
    drop(db);
    fs::remove_dir_all(root).unwrap();
    assert!(
        child.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
    assert_eq!(
        state.unwrap(),
        (i64::from(CANONICAL_SCHEMA_VERSION), 65_536)
    );
}
