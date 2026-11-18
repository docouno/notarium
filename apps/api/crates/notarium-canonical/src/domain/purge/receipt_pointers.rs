use crate::{codec::internal_not_committed, sql_exec::BackendConn};
use notarium_core::{error::PortError, model::HistoryScope};

// Seek each distinct primary-key prefix, including imported histories. Apply the
// requested (actor, key) set in one statement and keep the enclosing receipt shells.
// A short history costs at most its own rows. A large history costs a bounded
// prefix count followed by one primary-key probe per requested key.
macro_rules! clear_regular {
    ($keys:literal, $row:literal) => {
        concat!(
            "WITH RECURSIVE histories(h) AS (
                SELECT (SELECT history_incarnation FROM command_receipts WHERE space_id=$1 ORDER BY history_incarnation LIMIT 1)
                UNION ALL SELECT (SELECT r.history_incarnation FROM command_receipts r WHERE r.space_id=$1
                    AND r.history_incarnation>histories.h ORDER BY r.history_incarnation LIMIT 1)
                    FROM histories WHERE h IS NOT NULL
            ), keys(actor, command) AS MATERIALIZED (", $keys, "),
            sizes AS MATERIALIZED (
                SELECT h, EXISTS (SELECT 1 FROM command_receipts r
                    WHERE r.space_id=$1 AND r.history_incarnation=h
                    LIMIT 1 OFFSET (SELECT count(*) FROM keys)) AS dense
                FROM histories WHERE h IS NOT NULL
            )
            UPDATE command_receipts SET response_payload_id=NULL WHERE ", $row, " IN (
                SELECT r.", $row, " FROM sizes CROSS JOIN command_receipts r
                WHERE NOT dense AND r.space_id=$1 AND r.history_incarnation=h
                  AND r.response_payload_id IN (SELECT 'rcpt_pay:' || actor || ':' || command FROM keys)
                UNION ALL
                SELECT r.", $row, " FROM sizes CROSS JOIN keys CROSS JOIN command_receipts r
                WHERE dense AND r.space_id=$1 AND r.history_incarnation=h AND r.actor_id=actor AND r.idempotency_key=command
                  AND r.response_payload_id = 'rcpt_pay:' || r.actor_id || ':' || r.idempotency_key)"
        )
    };
}

const CLEAR_SQLITE_KEYS: &str =
    clear_regular!("SELECT value->>0, value->>1 FROM json_each($2)", "rowid");
const CLEAR_PG_KEYS: &str = clear_regular!(
    "SELECT value->>0, value->>1 FROM jsonb_array_elements($2::jsonb)",
    "ctid"
);

const CLEAR_SQLITE_EXCEPTIONS: &str = "UPDATE command_receipts INDEXED BY idx_receipt_exception_pointer
    SET response_payload_id=NULL WHERE space_id=$1 AND response_payload_id IN (SELECT value FROM json_each($2))
      AND response_payload_id IS NOT NULL AND (response_payload_id <> 'rcpt_pay:' || actor_id || ':' || idempotency_key
                                              OR actor_id LIKE '%:%')";

const CLEAR_PG_EXCEPTIONS: &str = "UPDATE command_receipts SET response_payload_id=NULL
    WHERE space_id=$1 AND response_payload_id=ANY($2::TEXT[])
      AND response_payload_id IS NOT NULL AND (response_payload_id <> 'rcpt_pay:' || actor_id || ':' || idempotency_key
                                              OR actor_id LIKE '%:%')";

pub(super) async fn clear(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    details: &[String],
) -> Result<(), PortError> {
    if details.is_empty() {
        return Ok(());
    }
    let space = scope.space_id.as_str();
    let keys: Vec<_> = details
        .iter()
        .filter_map(|detail| detail.strip_prefix("rcpt_pay:")?.split_once(':'))
        .collect();
    if !keys.is_empty() {
        let keys = serde_json::to_string(&keys)
            .map_err(|e| internal_not_committed("encode_erased_receipt_keys", e.to_string()))?;
        match tx {
            BackendConn::Sqlite(db) => sqlx::query(CLEAR_SQLITE_KEYS)
                .bind(space)
                .bind(&keys)
                .execute(&mut **db)
                .await
                .map(|_| ()),
            BackendConn::Postgres(db) => sqlx::query(CLEAR_PG_KEYS)
                .bind(space)
                .bind(&keys)
                .execute(&mut **db)
                .await
                .map(|_| ()),
        }
        .map_err(|e| internal_not_committed("purge_receipt_pointers", e.to_string()))?;
    }
    // Exceptional source pointers might also name a detail with a valid primary receipt.
    match tx {
        BackendConn::Sqlite(db) => {
            let ids = serde_json::to_string(details)
                .map_err(|e| internal_not_committed("encode_erased_receipt_ids", e.to_string()))?;
            sqlx::query(CLEAR_SQLITE_EXCEPTIONS)
                .bind(space)
                .bind(ids)
                .execute(&mut **db)
                .await
                .map(|_| ())
        }
        BackendConn::Postgres(db) => sqlx::query(CLEAR_PG_EXCEPTIONS)
            .bind(space)
            .bind(details)
            .execute(&mut **db)
            .await
            .map(|_| ()),
    }
    .map_err(|e| internal_not_committed("purge_exceptional_receipt_pointers", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{CLEAR_SQLITE_EXCEPTIONS, CLEAR_SQLITE_KEYS};
    use rusqlite::{Connection, StatementStatus, params};

    #[test]
    fn batched_receipt_erasure_visits_short_imported_histories_once() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        let mut insert = db.prepare("INSERT INTO command_receipts VALUES ('s',?1,'owner',?2,zeroblob(32),'completed',1,'rcpt_pay:owner:' || ?2,X'01',1,9000)").unwrap();
        for n in 0..100u128 {
            insert
                .execute(params![n.to_be_bytes().as_slice(), "other"])
                .unwrap();
        }
        let keys: Vec<_> = (0..40).map(|i| ("owner", format!("k{i}"))).collect();
        for (_, key) in &keys {
            insert.execute(params![[0u8; 16].as_slice(), key]).unwrap();
        }
        let mut regular = db.prepare(CLEAR_SQLITE_KEYS).unwrap();
        regular
            .execute(params!["s", serde_json::to_string(&keys).unwrap()])
            .unwrap();
        assert_eq!(db.changes(), 40);
        assert!(regular.get_status(StatementStatus::VmStep) < 20_000);
    }

    #[test]
    fn expired_and_irregular_receipt_pointers_use_bounded_lookups() {
        for count in [100, 10_000] {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
                .unwrap();
            db.execute(
                "WITH RECURSIVE series(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM series WHERE n<?1)
                 INSERT INTO command_receipts SELECT 's',zeroblob(16),'principal',CAST(n AS TEXT),
                    zeroblob(32),'completed',1,'rcpt_pay:principal:' || n,X'01',n,9000 FROM series",
                [count],
            ).unwrap();
            let insert = "INSERT INTO command_receipts VALUES (?1,zeroblob(16),'principal',?2,zeroblob(32),'completed',1,?3,X'01',1,9000)";
            let regular = "rcpt_pay:principal:1";
            let expired = "rcpt_pay:principal:expired";
            let opaque = "foreign-imported-detail";
            db.execute(insert, params!["s", "duplicate", regular])
                .unwrap();
            db.execute(insert, params!["s", "opaque", opaque]).unwrap();
            db.execute(insert, params!["other", "neighbor", regular])
                .unwrap();
            db.execute("INSERT INTO command_receipts SELECT space_id,?1,actor_id,idempotency_key,command_hash,status,
                envelope_version,response_payload_id,sanitized_envelope_msgpack,canonical_seq,expires_at_ms
                FROM command_receipts WHERE space_id='s' AND idempotency_key='1'",[[2u8;16].as_slice()]).unwrap();
            let exception_count: i64 = db.query_row(
                "SELECT count(*) FROM command_receipts INDEXED BY idx_receipt_exception_pointer
                 WHERE response_payload_id IS NOT NULL AND (response_payload_id <> 'rcpt_pay:' || actor_id || ':' || idempotency_key OR actor_id LIKE '%:%')",
                [], |r| r.get(0),
            ).unwrap();
            assert_eq!(exception_count, 3);
            let mut direct = db.prepare(CLEAR_SQLITE_KEYS).unwrap();
            direct
                .execute(params![
                    "s",
                    r#"[["principal","expired"],["principal","1"]]"#
                ])
                .unwrap();
            assert_eq!(db.changes(), 2);
            assert!(direct.get_status(StatementStatus::VmStep) < 700);
            for (ids, expected) in [
                (vec![expired], 0),
                (vec![regular, opaque], 2),
                (vec![regular, opaque], 0),
            ] {
                let mut sparse = db.prepare(CLEAR_SQLITE_EXCEPTIONS).unwrap();
                assert_eq!(
                    sparse
                        .execute(params!["s", serde_json::to_string(&ids).unwrap()])
                        .unwrap(),
                    expected
                );
                assert!(sparse.get_status(StatementStatus::VmStep) < 350);
            }
            let kept: i64 = db
                .query_row(
                    "SELECT count(*) FROM command_receipts WHERE response_payload_id=?1",
                    [regular],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(kept, 1);
            let shells: i64=db.query_row("SELECT count(*) FROM command_receipts WHERE space_id='s' AND sanitized_envelope_msgpack=X'01'",[],|r|r.get(0)).unwrap();
            assert_eq!(shells, count + 3);
        }
    }
}
