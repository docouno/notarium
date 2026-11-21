use std::time::Duration;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, LeaseEpoch, SpaceId},
    model::HistoryScope,
    ports::CallBudget,
};

use crate::{
    CanonicalStore,
    codec::internal_not_committed,
    domain::{common::CommandDeadline, purge::RetirementRecovery},
    peers::job_clock_ms,
    sql_exec::BackendConn,
};

use super::{
    BlobBackendDriver, RetirementReason, count_reachable_refs_tx, ensure_no_backup_holds_tx,
    initiate_digest_retirement_tx, lock_and_check_space_tx,
};

pub const GC_QUARANTINE: Duration = Duration::from_secs(24 * 3600 + 5 * 60);
const PAGE: i64 = 128;
/// Maximum number of sweep retirements admitted across all Spaces of a store.
pub const MAX_GC_RETIREMENTS: usize = 4;

#[derive(Clone, Debug)]
pub struct GcCursor {
    touched: i64,
    digest: ContentDigest,
}

#[derive(Debug)]
pub struct GcPage {
    pub next: Option<GcCursor>,
    pub inspected: usize,
    pub quarantined: usize,
    pub retirements: usize,
    pub failure: Option<PortError>,
}

struct Candidate {
    cursor: GcCursor,
    publication: Option<String>,
}

enum Decision {
    Skip,
    Busy,
    Held,
    Quarantine,
    Retire(String),
}

impl CanonicalStore {
    /// Plan at most one indexed page. Existing retirement workers own physical
    /// deletion and recovery; the sweep retains no read transaction or hold.
    pub async fn sweep_blob_gc(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        after: Option<GcCursor>,
    ) -> Result<GcPage, PortError> {
        self.inner.check_writer_epoch(&scope.space_id, epoch)?;
        let deadline = CommandDeadline::start(budget, "sweep_blob_gc");
        let candidates = self
            .with_read_tx_budget(Some(budget), |tx| {
                let scope = scope.clone();
                Box::pin(async move {
                    let space = crate::runtime::load_space_record(tx, &scope.space_id).await?;
                    space.scope.check(&scope)?;
                    if space.active_epoch != epoch {
                        return Err(
                            DomainError::validation(ValidationReason::InvalidAuthority).into()
                        );
                    }
                    candidates(tx, &scope.space_id, after.as_ref(), false).await
                })
            })
            .await?;
        let inspected = candidates.len();
        let next = (inspected == PAGE as usize).then(|| candidates[inspected - 1].cursor.clone());
        let mut page = GcPage {
            next,
            inspected: 0,
            quarantined: 0,
            retirements: 0,
            failure: None,
        };
        let local = match &self.inner.blobs {
            BlobBackendDriver::Local(local) => Some(local),
            BlobBackendDriver::S3(remote) => {
                if inspected > 0 {
                    deadline
                        .prepare(budget, || remote.verify_runtime_bucket_mode())
                        .await?;
                }
                None
            }
        };
        let mut last = None;
        for candidate in candidates {
            if let Err(error) = deadline.remaining(budget) {
                let Some(last) = last else { return Err(error) };
                page.next = Some(last);
                page.failure.get_or_insert(error);
                break;
            }
            page.inspected += 1;
            last = Some(candidate.cursor.clone());
            let local_guard = if let Some(local) = local {
                let Some(guard) =
                    local.try_acquire_exclusive_guard(&scope.space_id, candidate.cursor.digest)
                else {
                    continue;
                };
                Some(guard)
            } else {
                None
            };
            let owner = scope.clone();
            let worker = self.clone();
            let slot = self.inner.gc_retirements.clone().try_acquire_owned().ok();
            let decision = self
                .with_auxiliary_command(
                    Some((budget, deadline)),
                    |(result, _guard, _handoff)| Ok(result),
                    move |tx| {
                        Box::pin(async move {
                            lock_and_check_space_tx(tx, &owner, epoch).await?;
                            let now = job_clock_ms(tx).await?;
                            let result = plan_candidate_tx(
                                tx,
                                &owner,
                                epoch,
                                candidate,
                                now,
                                slot.is_some(),
                                worker.local_store_arc().as_deref(),
                            )
                            .await?;
                            // The SQL result owns both the local stripe and the durable ID
                            // through COMMIT. A lost acknowledgement drops the same handoff.
                            let handoff = match (&result, slot) {
                                (Decision::Retire(id), Some(slot)) => {
                                    super::gc_retry::enqueue_tx(tx, &owner.space_id, id, now)
                                        .await?;
                                    let mut handoff = worker.retirement_handoff(
                                        &owner,
                                        epoch,
                                        vec![id.clone()],
                                        None,
                                    );
                                    handoff.sweep_slot = Some(slot);
                                    Some(handoff)
                                }
                                _ => None,
                            };
                            Ok((result, local_guard, handoff))
                        })
                    },
                )
                .await;
            match decision {
                Ok(Decision::Skip | Decision::Busy | Decision::Held) => {}
                Ok(Decision::Quarantine) => page.quarantined += 1,
                Ok(Decision::Retire(_)) => page.retirements += 1,
                Err(error) => {
                    page.failure.get_or_insert(error);
                }
            }
            tokio::task::yield_now().await;
        }
        Ok(page)
    }
}

// A submitted page can commit after its caller disappears. SQL owns the exact IDs;
// the same indexed scans pick up sealed retirements and any unplanned legacy suffix.
struct LegacyHandoff(Option<CanonicalStore>);

macro_rules! legacy_space_sql {
    ($index:literal, $filter:literal) => {
        concat!(
            "SELECT space_id FROM blob_catalog ",
            $index,
            " WHERE ",
            $filter,
            " AND legacy_cleanup=1 AND ref_count=0 AND admission_state='open'
              AND blob_state='active' ORDER BY space_id LIMIT 1"
        )
    };
}

impl Drop for LegacyHandoff {
    fn drop(&mut self) {
        if let Some(store) = self.0.take() {
            store.wake_gc_retries();
            store.wake_legacy_cleanup();
        }
    }
}

impl CanonicalStore {
    /// Commit one page of legacy retirements at a time. Keep each staging fence
    /// through the page's COMMIT, then release it before attempting physical I/O.
    pub(crate) async fn reconcile_legacy_cleanup(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        recovery: RetirementRecovery,
    ) -> Result<(), PortError> {
        let mut deferred = false;
        let result = self
            .reconcile_legacy_pages(scope, epoch, Some(recovery), &mut deferred)
            .await;
        if deferred {
            self.wake_legacy_cleanup();
        }
        result
    }

    // An open hold or staging ticket has no sealed retirement to enqueue yet.
    // Only a deferred legacy page starts this catalog scanner. It performs no physical I/O.
    fn wake_legacy_cleanup(&self) {
        if !self.inner.retirement_workers.legacy.request() {
            return;
        }
        let store = self.clone();
        let shutdown = self.inner.backup_shutdown.clone();
        let handle = self.inner.backup_executor.spawn(async move {
            let legacy = &store.inner.retirement_workers.legacy;
            tokio::select! { biased; () = shutdown.cancelled() => {}, () = legacy.run(|| store.retry_deferred_legacy()) => {} }
        });
        crate::backup::register_cleanup_task(&self.inner, handle);
    }

    async fn retry_deferred_legacy(&self) -> Result<Option<Duration>, PortError> {
        let mut after = String::new();
        let mut waiting = false;
        loop {
            // Seek to the next Space, skipping its entire run of legacy index entries.
            let space: Option<String> = self
                .with_read_tx(move |tx| {
                    Box::pin(async move {
                        match tx {
                            BackendConn::Sqlite(c) => {
                                sqlx::query_scalar(legacy_space_sql!(
                                    "INDEXED BY idx_blob_catalog_legacy",
                                    "space_id>$1"
                                ))
                                .bind(after)
                                .fetch_optional(&mut **c)
                                .await
                            }
                            BackendConn::Postgres(c) => {
                                sqlx::query_scalar(legacy_space_sql!("", "space_id>$1"))
                                    .bind(after)
                                    .fetch_optional(&mut **c)
                                    .await
                            }
                        }
                        .map_err(gc_sql)
                    })
                })
                .await?;
            let Some(space) = space else { break };
            let current = self.read_space(&SpaceId::parse(&space)?).await?;
            after = space;
            if self
                .inner
                .check_writer_epoch(&current.scope.space_id, current.active_epoch)
                .is_err()
            {
                continue;
            }
            if let Err(error) = self
                .reconcile_legacy_pages(&current.scope, current.active_epoch, None, &mut waiting)
                .await
            {
                waiting |= super::retirement_worker::retry_after(&error).is_some();
                tracing::warn!(?error, "legacy cleanup page failed");
            }
        }
        Ok(waiting.then_some(Duration::from_secs(1)))
    }

    async fn reconcile_legacy_pages(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        recovery: Option<RetirementRecovery>,
        deferred: &mut bool,
    ) -> Result<(), PortError> {
        let mut after = None;
        let mut permanent = None;
        loop {
            self.inner.check_writer_epoch(&scope.space_id, epoch)?;
            let scope_in = scope.clone();
            let worker = self.clone();
            let mut page = self
                .with_auxiliary_command(
                    None,
                    |(_guards, page)| Ok(page),
                    move |tx| Box::pin(plan_legacy_page_tx(tx, worker, scope_in, epoch, after)),
                )
                .await
                .map_err(|error| crate::codec::retry_unknown_commit("legacy_gc_page", error))?;
            *deferred |= page.deferred;
            if let Some(recovery) = recovery {
                for id in page.retirements {
                    if let Err(error) = self.attempt_legacy_gc(scope, epoch, id, recovery).await {
                        if recovery != RetirementRecovery::RestoredGc {
                            return Err(error);
                        }
                        permanent.get_or_insert(error);
                    }
                }
            } else if !page.retirements.is_empty() {
                self.wake_gc_retries();
            }
            page.handoff.0 = None;
            let Some(next) = page.next else {
                return permanent.map_or(Ok(()), Err);
            };
            after = Some(next);
        }
    }

    pub(crate) async fn attempt_legacy_gc(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        id: String,
        recovery: RetirementRecovery,
    ) -> Result<(), PortError> {
        let slot = self
            .inner
            .gc_retirements
            .clone()
            .acquire_owned()
            .await
            .expect("GC semaphore is open");
        let (mut attempt, work) = self.reserve_retirement(scope, epoch, id);
        if let Some(work) = work {
            let retry = if recovery == RetirementRecovery::RestoredGc {
                work.retry_if_due().await?.is_some()
            } else {
                // Startup and lease grants report the first physical outcome.
                work.sweep_attempt().await
            };
            if retry {
                self.wake_gc_retries();
            }
        }
        drop(slot);
        recovery.outcome(&mut attempt).await
    }
}

struct LegacyPage {
    next: Option<GcCursor>,
    deferred: bool,
    retirements: Vec<String>,
    handoff: LegacyHandoff,
}

async fn plan_legacy_page_tx(
    tx: &mut BackendConn<'_>,
    store: CanonicalStore,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    after: Option<GcCursor>,
) -> Result<(Vec<super::local::LocalExclusiveGuard>, LegacyPage), PortError> {
    lock_and_check_space_tx(tx, &scope, epoch).await?;
    let rows = candidates(tx, &scope.space_id, after.as_ref(), true).await?;
    let mut next =
        (rows.len() == PAGE as usize).then(|| rows.last().expect("full page").cursor.clone());
    let now = job_clock_ms(tx).await?;
    let local = store.local_store_arc();
    let mut guards = Vec::new();
    let mut retirements = Vec::new();
    let mut deferred = false;
    for candidate in rows {
        if let Some(local) = &local {
            let Some(guard) =
                local.try_fence_staging_epoch(&scope.space_id, candidate.cursor.digest, epoch)
            else {
                deferred = true;
                continue;
            };
            guards.push(guard);
        }
        match plan_candidate_tx(tx, &scope, epoch, candidate, now, true, local.as_deref()).await? {
            Decision::Retire(id) => {
                super::gc_retry::enqueue_tx(tx, &scope.space_id, &id, now).await?;
                retirements.push(id);
            }
            Decision::Busy => deferred = true,
            Decision::Held => {
                // A backup hold covers this entire Space, including later pages.
                next = None;
                deferred = true;
                break;
            }
            Decision::Skip | Decision::Quarantine => {}
        }
    }
    let armed = deferred || !retirements.is_empty() || next.is_some();
    let handoff = LegacyHandoff(armed.then_some(store));
    Ok((
        guards,
        LegacyPage {
            next,
            deferred,
            retirements,
            handoff,
        },
    ))
}

pub(crate) async fn has_legacy_cleanup_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
) -> Result<bool, PortError> {
    let found: Option<String> = match tx {
        BackendConn::Sqlite(c) => {
            sqlx::query_scalar(legacy_space_sql!(
                "INDEXED BY idx_blob_catalog_legacy",
                "space_id=$1"
            ))
            .bind(space.as_str())
            .fetch_optional(&mut **c)
            .await
        }
        BackendConn::Postgres(c) => {
            sqlx::query_scalar(legacy_space_sql!("", "space_id=$1"))
                .bind(space.as_str())
                .fetch_optional(&mut **c)
                .await
        }
    }
    .map_err(gc_sql)?;
    Ok(found.is_some())
}

async fn candidates(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    after: Option<&GcCursor>,
    legacy: bool,
) -> Result<Vec<Candidate>, PortError> {
    macro_rules! sql {
        ($index:literal, $legacy:literal) => {
            concat!(
                "SELECT touched_at_ms, content_blake3, current_publication_id FROM blob_catalog ",
                $index,
                " WHERE space_id=$1 AND (touched_at_ms,content_blake3)>($2,$3)
                  AND ref_count=0 AND admission_state='open' AND blob_state='active'
                 ",
                $legacy,
                " ORDER BY touched_at_ms,content_blake3 LIMIT $4",
            )
        };
    }
    let touched = after.map_or(i64::MIN, |cursor| cursor.touched);
    let digest = after.map_or(&[][..], |cursor| cursor.digest.as_bytes().as_slice());
    let rows: Vec<(i64, Vec<u8>, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(if legacy {
                sql!(
                    "INDEXED BY idx_blob_catalog_legacy",
                    " AND legacy_cleanup=1"
                )
            } else {
                sql!("INDEXED BY idx_blob_catalog_gc", "")
            })
            .bind(space.as_str())
            .bind(touched)
            .bind(digest)
            .bind(PAGE)
            .fetch_all(&mut **conn)
            .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(if legacy {
                sql!("", " AND legacy_cleanup=1")
            } else {
                sql!("", "")
            })
            .bind(space.as_str())
            .bind(touched)
            .bind(digest)
            .bind(PAGE)
            .fetch_all(&mut **conn)
            .await
        }
    }
    .map_err(gc_sql)?;
    rows.into_iter()
        .map(|(touched, digest, publication)| {
            let digest = ContentDigest::from_bytes(digest.try_into().map_err(|_| {
                internal_not_committed("gc_catalog_digest", "invalid content digest")
            })?);
            Ok(Candidate {
                cursor: GcCursor { touched, digest },
                publication,
            })
        })
        .collect()
}

const CHECK: &str =
    "SELECT current_publication_id, quarantined_at_ms, CAST(legacy_cleanup AS BIGINT)
        FROM blob_catalog c WHERE space_id=$1 AND content_blake3=$2
          AND ref_count=0 AND admission_state='open' AND blob_state='active'
          AND NOT EXISTS(SELECT 1 FROM blob_publications p
              WHERE p.space_id=c.space_id AND p.content_blake3=c.content_blake3
                AND p.state <> 'active' AND p.state IN ('staging','retiring'))
          AND NOT EXISTS(SELECT 1 FROM pending_purges x
              WHERE x.space_id=c.space_id AND x.phase IN ('sql_erased','cas_retired'))";

async fn plan_candidate_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    candidate: Candidate,
    now: i64,
    can_retire: bool,
    local: Option<&super::local::LocalBlobStore>,
) -> Result<Decision, PortError> {
    let space = &scope.space_id;
    let digest = candidate.cursor.digest;
    let row: Option<(Option<String>, Option<i64>, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(CHECK)
                .bind(space.as_str())
                .bind(digest.as_bytes().as_slice())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(CHECK)
                .bind(space.as_str())
                .bind(digest.as_bytes().as_slice())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(gc_sql)?;
    let Some((publication, stamp, legacy)) = row else {
        // Legacy recovery selected this row under the same Space lock. A live
        // publication or purge can still prevent admission until its owner finishes.
        return Ok(Decision::Busy);
    };
    if candidate.publication != publication
        || (publication.is_none() && legacy == 0)
        || count_reachable_refs_tx(tx, space, digest).await? != 0
    {
        return Ok(Decision::Skip);
    }
    if legacy == 0 {
        let Some(stamp) = stamp else {
            const MARK: &str = "UPDATE blob_catalog SET quarantined_at_ms=$1 WHERE space_id=$2
                AND content_blake3=$3 AND quarantined_at_ms IS NULL";
            match tx {
                BackendConn::Sqlite(conn) => sqlx::query(MARK)
                    .bind(now)
                    .bind(space.as_str())
                    .bind(digest.as_bytes().as_slice())
                    .execute(&mut **conn)
                    .await
                    .map(|_| ()),
                BackendConn::Postgres(conn) => sqlx::query(MARK)
                    .bind(now)
                    .bind(space.as_str())
                    .bind(digest.as_bytes().as_slice())
                    .execute(&mut **conn)
                    .await
                    .map(|_| ()),
            }
            .map_err(gc_sql)?;
            return Ok(Decision::Quarantine);
        };
        if now < stamp.saturating_add(GC_QUARANTINE.as_millis() as i64) {
            return Ok(Decision::Skip);
        }
    }
    // A full physical queue leaves this mature publication durably eligible.
    // No task or closed digest waits for an unbounded number of earlier deletes.
    if !can_retire {
        return Ok(Decision::Skip);
    }
    match ensure_no_backup_holds_tx(tx, space, RetirementReason::Gc).await {
        Ok(()) => {}
        Err(err) if err == super::held_retirement() => return Ok(Decision::Held),
        Err(err) => return Err(err),
    }
    Ok(
        initiate_digest_retirement_tx(tx, scope, epoch, digest, RetirementReason::Gc, None, local)
            .await?
            .map_or(Decision::Skip, Decision::Retire),
    )
}

fn gc_sql(err: sqlx::Error) -> PortError {
    internal_not_committed("cas_gc_catalog", err.to_string())
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, StatementStatus, params};

    #[test]
    fn candidate_recheck_seeks_past_active_publications_and_completed_purges() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        db.execute_batch(
            "PRAGMA foreign_keys=OFF;
             INSERT INTO blob_catalog(space_id,content_blake3,raw_size,compressed_size,ref_count,
                 current_publication_id,admission_state,blob_state,touched_at_ms)
                 VALUES ('s',zeroblob(32),1,1,0,'p','open','active',0);
             WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<10000)
             INSERT INTO blob_publications SELECT 's',printf('p%d',n),randomblob(32),1,'local_zstd_v1',
                 'active',1,1,1,1,0,0 FROM seq;
             WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<10000)
             INSERT INTO pending_purges SELECT 's',printf('purge%d',n),zeroblob(16),'owner','key',
                 zeroblob(32),'old',NULL,NULL,1,'completed','[]',X'',NULL,0,0 FROM seq;",
        ).unwrap();
        for analyze in [false, true] {
            if analyze {
                db.execute_batch("ANALYZE").unwrap();
            }
            let mut stmt = db.prepare(super::CHECK).unwrap();
            assert_eq!(
                stmt.query_row(params!["s", [0u8; 32].as_slice()], |r| r
                    .get::<_, String>(0))
                    .unwrap(),
                "p"
            );
            assert!(stmt.get_status(StatementStatus::VmStep) < 200);
        }
    }
}
