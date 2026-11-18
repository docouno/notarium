use crate::{codec::internal_not_committed, sql_exec::BackendConn};
use notarium_core::{error::PortError, model::HistoryScope};

// A normal restore clears old receipts. Imported data can retain several incarnations.
// Each scalar query seeks past one distinct key prefix in the existing receipt primary index.
const ADDITIONAL_HISTORIES: &str = "WITH RECURSIVE histories(h) AS (
    SELECT (SELECT history_incarnation FROM command_receipts WHERE space_id=$1 ORDER BY history_incarnation LIMIT 1)
    UNION ALL
    SELECT (SELECT r.history_incarnation FROM command_receipts r
            WHERE r.space_id=$1 AND r.history_incarnation>histories.h ORDER BY r.history_incarnation LIMIT 1)
    FROM histories WHERE h IS NOT NULL
)
SELECT h FROM histories WHERE h IS NOT NULL AND h<>$2";

const CLEAR_BY_KEY: &str = "UPDATE command_receipts SET response_payload_id=NULL
    WHERE space_id=$1 AND history_incarnation=$2 AND actor_id=$3 AND idempotency_key=$4 AND response_payload_id=$5";

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
    let current = scope.incarnation.as_bytes().as_slice();
    let keys: Vec<_> = details
        .iter()
        .filter_map(|detail| {
            let (actor, key) = detail.strip_prefix("rcpt_pay:")?.split_once(':')?;
            Some((actor, key, detail.as_str()))
        })
        .collect();
    if !keys.is_empty() {
        let other: Vec<Vec<u8>> = match tx {
            BackendConn::Sqlite(db) => {
                sqlx::query_scalar(ADDITIONAL_HISTORIES)
                    .bind(space)
                    .bind(current)
                    .fetch_all(&mut **db)
                    .await
            }
            BackendConn::Postgres(db) => {
                sqlx::query_scalar(ADDITIONAL_HISTORIES)
                    .bind(space)
                    .bind(current)
                    .fetch_all(&mut **db)
                    .await
            }
        }
        .map_err(|e| internal_not_committed("purge_receipt_incarnations", e.to_string()))?;
        for incarnation in std::iter::once(current).chain(other.iter().map(Vec::as_slice)) {
            for &(actor, key, detail) in &keys {
                match tx {
                    BackendConn::Sqlite(db) => sqlx::query(CLEAR_BY_KEY)
                        .bind(space)
                        .bind(incarnation)
                        .bind(actor)
                        .bind(key)
                        .bind(detail)
                        .execute(&mut **db)
                        .await
                        .map(|_| ()),
                    BackendConn::Postgres(db) => sqlx::query(CLEAR_BY_KEY)
                        .bind(space)
                        .bind(incarnation)
                        .bind(actor)
                        .bind(key)
                        .bind(detail)
                        .execute(&mut **db)
                        .await
                        .map(|_| ()),
                }
                .map_err(|e| internal_not_committed("purge_receipt_pointer", e.to_string()))?;
            }
        }
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
    use super::{ADDITIONAL_HISTORIES, CLEAR_BY_KEY, CLEAR_SQLITE_EXCEPTIONS};
    use rusqlite::{Connection, StatementStatus, params};

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
            let mut histories = db.prepare(ADDITIONAL_HISTORIES).unwrap();
            let other: Vec<Vec<u8>> = histories
                .query_map(params!["s", [0u8; 16].as_slice()], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(other, [vec![2u8; 16]]);
            assert!(histories.get_status(StatementStatus::VmStep) < 200);
            db.execute(
                CLEAR_BY_KEY,
                params!["s", &other[0], "principal", "1", regular],
            )
            .unwrap();
            let exception_count: i64 = db.query_row(
                "SELECT count(*) FROM command_receipts INDEXED BY idx_receipt_exception_pointer
                 WHERE response_payload_id IS NOT NULL AND (response_payload_id <> 'rcpt_pay:' || actor_id || ':' || idempotency_key OR actor_id LIKE '%:%')",
                [], |r| r.get(0),
            ).unwrap();
            assert_eq!(exception_count, 3);
            for (key, detail, expected) in [("expired", expired, 0), ("1", regular, 1)] {
                let mut direct = db.prepare(CLEAR_BY_KEY).unwrap();
                assert_eq!(
                    direct
                        .execute(params!["s", [0u8; 16].as_slice(), "principal", key, detail])
                        .unwrap(),
                    expected
                );
                assert!(direct.get_status(StatementStatus::VmStep) < 200);
            }
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
