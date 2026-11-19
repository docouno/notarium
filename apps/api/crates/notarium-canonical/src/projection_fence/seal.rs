use std::{sync::atomic::AtomicU8, time::Duration};

use notarium_core::{auth::SpaceKind, ids::HistoryIncarnation};
use sqlx::Row;

use crate::{
    codec::{
        cancelled_not_committed, i64_to_space_seq, internal_not_committed,
        unknown_commit_non_idempotent,
    },
    sql_exec::{BackendConn, PgTransactionLease, WriteTransaction},
};

use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionCatalogSealEntry {
    pub scope: HistoryScope,
    pub root_folder_id: FolderId,
    pub head: SpaceSeq,
    pub kind: SpaceKind,
    pub lifecycle: SpaceLifecycle,
    pub epoch: LeaseEpoch,
    pub owner: Option<ProjectionOwnerIdentity>,
}

const PENDING: u8 = 0;
const APPLYING: u8 = 1;
const ABANDONED: u8 = 2;

struct Admission(Arc<AtomicU8>);

impl Admission {
    fn abandon(&self) -> bool {
        self.0
            .compare_exchange(PENDING, ABANDONED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.abandon();
    }
}

impl CanonicalStore {
    /// Holds the canonical catalog and owner vector stable during a
    /// PostgreSQL projection-generation switch.
    ///
    /// The operation must resolve a possibly committed switch before
    /// returning, by reading the durable descriptor under a conflicting lock.
    /// The operation cannot perform canonical writes under this seal.
    /// Once the operation starts the storage executor holds the seal to its
    /// completion, even if the caller can no longer wait for the response.
    pub async fn with_projection_catalog_seal<T, F, Fut>(
        &self,
        ctx: &MaintenanceContext,
        operation: F,
    ) -> Result<T, PortError>
    where
        T: Send + 'static,
        F: FnOnce(Vec<ProjectionCatalogSealEntry>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, PortError>> + Send + 'static,
    {
        ctx.authority.require(ServicePurpose::Projection)?;
        self.ensure_open()?;
        if !self.is_postgres() {
            return Err(not_ready());
        }
        let deadline =
            crate::runtime::deadline_after(tokio::time::Instant::now(), ctx.budget.remaining);
        let admission = Admission(Arc::new(AtomicU8::new(PENDING)));
        let authorized = Arc::clone(&admission.0);
        let store = self.clone();
        let budget = ctx.budget.clone();
        let mut task = self.inner.backup_executor.spawn(async move {
            let SqlDriverState::Postgres { pool, .. } = &store.inner.sql else {
                return Err(not_ready());
            };
            let mut pooled =
                budgeted(&budget, deadline, pool.acquire())
                    .await?
                    .map_err(|error| {
                        internal_not_committed("projection_seal_acquire", error.to_string())
                    })?;
            let mut lease = PgTransactionLease::new(&mut pooled);
            let mut connection = BackendConn::Postgres(lease.conn());
            let mut tx =
                budgeted(&budget, deadline, WriteTransaction::begin(&mut connection)).await??;
            let catalog_deadline =
                deadline.min(tokio::time::Instant::now() + Duration::from_millis(240));
            let entries = budgeted(
                &budget,
                catalog_deadline,
                read_sealed_catalog(&mut tx.conn()),
            )
            .await??;
            if authorized
                .compare_exchange(PENDING, APPLYING, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Err(cancelled_not_committed(
                    "projection_seal_cancelled",
                    "catalog delivery was abandoned before the switch",
                ));
            }
            let result = operation(entries).await;
            // There are no canonical effects and hence no canonical COMMIT.
            if tx.rollback().await {
                lease.complete();
            }
            result
        });
        match budgeted(&ctx.budget, deadline, &mut task).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(unknown_commit_non_idempotent(
                "projection_seal_worker",
                error.to_string(),
            )),
            Err(error) if !admission.abandon() => Err(unknown_commit_non_idempotent(
                "projection_seal_wait",
                error.to_string(),
            )),
            Err(error) => Err(error),
        }
    }
}

async fn read_sealed_catalog(
    tx: &mut BackendConn<'_>,
) -> Result<Vec<ProjectionCatalogSealEntry>, PortError> {
    let BackendConn::Postgres(conn) = tx else {
        return Err(not_ready());
    };
    sqlx::query("LOCK TABLE spaces, projection_space_owners IN SHARE MODE NOWAIT")
        .execute(&mut **conn)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .and_then(|db| db.code())
                .as_deref()
                == Some("55P03")
            {
                not_ready()
            } else {
                internal_not_committed("projection_seal_lock", error.to_string())
            }
        })?;
    let rows = sqlx::query(
        "SELECT s.space_id, s.history_incarnation, s.root_folder_id, s.last_seq,
                s.space_kind, s.lifecycle_state, s.active_epoch, o.process_id
         FROM spaces s
         LEFT JOIN projection_space_owners o
            ON o.space_id=s.space_id AND o.history_incarnation=s.history_incarnation
           AND o.active_epoch=s.active_epoch AND o.phase='active'
         ORDER BY s.space_id",
    )
    .fetch_all(&mut **conn)
    .await
    .map_err(|error| internal_not_committed("projection_seal_catalog", error.to_string()))?;
    rows.into_iter()
        .map(|row| {
            let bytes: Vec<u8> = row.get("history_incarnation");
            let scope = HistoryScope {
                space_id: SpaceId::parse(row.get::<&str, _>("space_id"))?,
                incarnation: HistoryIncarnation::from_bytes(
                    bytes.try_into().map_err(|_| not_ready())?,
                ),
            };
            let epoch: i64 = row.get("active_epoch");
            let epoch = LeaseEpoch::new(u64::try_from(epoch).map_err(|_| not_ready())?)?;
            let owner =
                row.get::<Option<String>, _>("process_id")
                    .map(|process| ProjectionOwnerIdentity {
                        scope: scope.clone(),
                        epoch,
                        process,
                    });
            let kind = match row.get::<&str, _>("space_kind") {
                "personal" => SpaceKind::Personal,
                "shared" => SpaceKind::Shared,
                _ => return Err(not_ready()),
            };
            let lifecycle = match row.get::<&str, _>("lifecycle_state") {
                "active" => SpaceLifecycle::Active,
                "closing" => SpaceLifecycle::Closing,
                "archived" => SpaceLifecycle::Archived,
                _ => return Err(not_ready()),
            };
            Ok(ProjectionCatalogSealEntry {
                scope,
                root_folder_id: FolderId::parse(row.get::<&str, _>("root_folder_id"))?,
                head: i64_to_space_seq(row.get("last_seq"))?,
                kind,
                lifecycle,
                epoch,
                owner,
            })
        })
        .collect()
}
