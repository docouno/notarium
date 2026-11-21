use rusqlite::{Connection, OptionalExtension, StatementStatus, named_params, params};

use super::{ArchiveJobClass, ClaimRead, RUNNABLE_ARCHIVE_SCOPES, candidate_sql};

#[test]
fn archive_workers_seek_their_class_in_queued_and_running_jobs() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
        .unwrap();
    db.execute_batch(
        "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<250)
         INSERT INTO spaces SELECT printf('s%03d',i),zeroblob(16),'root',printf('s%03d',i),
             printf('s%03d',i),'personal','owner','active',1,0,'{}',0,0 FROM n;
         WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<120)
         INSERT INTO content_jobs(space_id,job_id,job_kind,state,lease_epoch,lease_until_ms,
                                  claim_space_epoch,artifacts_json,created_seq,updated_seq)
         SELECT space_id,printf('job%03d',i),'import',CASE WHEN i%2=1 THEN 'queued' ELSE 'running' END,
                1,50,1,'[]',i,i FROM spaces CROSS JOIN n;",
    ).unwrap();
    for analyze in [false, true] {
        if analyze {
            db.execute_batch("ANALYZE").unwrap();
        }
        let args = named_params! {"$1": "", "$2": 64, "$3": "export", "$4": 100};
        for expected in [vec![], vec!["s123", "s234"]] {
            if !expected.is_empty() {
                db.execute_batch(
                    "UPDATE content_jobs SET job_kind='export' WHERE space_id='s123' AND job_id='job001';
                     UPDATE content_jobs SET job_kind='export' WHERE space_id='s234' AND job_id='job002';",
                ).unwrap();
            }
            let mut poll = db.prepare(RUNNABLE_ARCHIVE_SCOPES).unwrap();
            let found = poll
                .query_map(args, |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert_eq!(found, expected);
            assert!(poll.get_status(StatementStatus::VmStep) < 1000);
        }
        let mut explain = db
            .prepare(&format!("EXPLAIN QUERY PLAN {RUNNABLE_ARCHIVE_SCOPES}"))
            .unwrap();
        let plan = explain
            .query_map(args, |row| row.get(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();
        let indexed_seeks = plan
            .iter()
            .filter(|line| {
                line.contains("idx_content_jobs_claim (state=? AND job_kind=? AND space_id>?)")
            })
            .count();
        assert_eq!(indexed_seeks, 2, "{plan:?}");
        db.execute(
            "UPDATE content_jobs SET job_kind='import' WHERE job_kind='export'",
            [],
        )
        .unwrap();
    }
}

#[test]
fn ordinary_claim_finds_each_kind_without_scanning_other_spaces_or_terminal_history() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
        .unwrap();
    db.execute_batch(
        "INSERT INTO spaces VALUES('ours',zeroblob(16),'root','ours','ours','personal','owner','active',1,0,'{}',0,0);
         INSERT INTO spaces VALUES('other',zeroblob(16),'root','other','other','personal','owner','active',1,0,'{}',0,0);
         WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5000)
         INSERT INTO content_jobs(space_id,job_id,job_kind,state,lease_epoch,artifacts_json,created_seq,updated_seq)
         SELECT space_id,printf('job%d',i),'import',CASE WHEN space_id='ours' THEN 'succeeded' ELSE 'queued' END,
                1,'[]',i,i FROM spaces CROSS JOIN n;",
    ).unwrap();
    for analyze in [false, true] {
        if analyze {
            db.execute_batch("ANALYZE").unwrap();
        }
        for kind in [
            "import", "export", "backup", "restore", "reindex", "reembed",
        ] {
            db.execute(
                "INSERT INTO content_jobs(space_id,job_id,job_kind,state,lease_epoch,artifacts_json,created_seq,updated_seq)
                 VALUES('ours','wanted',?,'queued',0,'[]',5001,5001)", [kind],
            ).unwrap();
            for class in [None, Some(ArchiveJobClass::Export)] {
                let mut claim = db.prepare(candidate_sql(class, ClaimRead::Sqlite)).unwrap();
                let job = claim
                    .query_row(params!["ours", 100], |row| row.get::<_, String>(0))
                    .optional()
                    .unwrap();
                assert_eq!(
                    job.as_deref(),
                    (class.is_none() || kind == "export").then_some("wanted")
                );
                assert!(claim.get_status(StatementStatus::VmStep) < 1000);
            }
            db.execute(
                "DELETE FROM content_jobs WHERE space_id='ours' AND job_id='wanted'",
                [],
            )
            .unwrap();
        }
    }
}
