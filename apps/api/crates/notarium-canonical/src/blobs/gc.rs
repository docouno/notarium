use std::time::Duration;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, LeaseEpoch, SpaceId},
    model::HistoryScope,
    ports::CallBudget,
};

use crate::{
    CanonicalStore, codec::internal_not_committed, domain::common::CommandDeadline,
    peers::job_clock_ms, sql_exec::BackendConn,
};

use super::{
    BlobBackendDriver, RetirementReason, count_reachable_refs_tx, ensure_no_backup_holds_tx,
    initiate_digest_retirement_tx, lock_and_check_space_tx,
};

pub const GC_QUARANTINE: Duration = Duration::from_secs(24 * 3600 + 5 * 60);
const PAGE: i64 = 128;

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
                    candidates(tx, &scope.space_id, after.as_ref()).await
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
            let worker_scope = scope.clone();
            // The transaction owns the stripe even if COMMIT outlives the caller.
            let decision = self
                .with_auxiliary_command(
                    Some((budget, deadline)),
                    move |(result, stripe)| {
                        drop(stripe);
                        if let Decision::Retire(id) = &result {
                            worker.schedule_retirements(&worker_scope, epoch, vec![id.clone()]);
                        }
                        Ok(result)
                    },
                    move |tx| {
                        Box::pin(async move {
                            lock_and_check_space_tx(tx, &owner, epoch).await?;
                            let now = job_clock_ms(tx).await?;
                            Ok((
                                plan_candidate_tx(tx, &owner, epoch, candidate, now).await?,
                                local_guard,
                            ))
                        })
                    },
                )
                .await;
            match decision {
                Ok(Decision::Skip) => {}
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

/// Run under startup/takeover/offline-restore ownership. An already sealed
/// retirement is recovered via the existing durable retirement queue.
pub(crate) async fn reconcile_unowned_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
) -> Result<bool, PortError> {
    let mut planned = false;
    let now = job_clock_ms(tx).await?;
    // Leave subsequent pages to the regular sweep. A recovered Space may
    // contain arbitrarily many zero-reference rows.
    for candidate in candidates(tx, &scope.space_id, None).await? {
        planned |= matches!(
            plan_candidate_tx(tx, scope, epoch, candidate, now).await?,
            Decision::Retire(_)
        );
    }
    Ok(planned)
}

async fn candidates(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    after: Option<&GcCursor>,
) -> Result<Vec<Candidate>, PortError> {
    macro_rules! sql {
        ($index:literal) => {
            concat!(
                "SELECT touched_at_ms, content_blake3, current_publication_id FROM blob_catalog ",
                $index,
                " WHERE space_id=$1 AND (touched_at_ms,content_blake3)>($2,$3)
                  AND ref_count=0 AND admission_state='open' AND blob_state='active'
                  ORDER BY touched_at_ms,content_blake3 LIMIT $4",
            )
        };
    }
    let touched = after.map_or(i64::MIN, |cursor| cursor.touched);
    let digest = after.map_or(&[][..], |cursor| cursor.digest.as_bytes().as_slice());
    let rows: Vec<(i64, Vec<u8>, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(sql!("INDEXED BY idx_blob_catalog_gc"))
                .bind(space.as_str())
                .bind(touched)
                .bind(digest)
                .bind(PAGE)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(sql!(""))
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

async fn plan_candidate_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    candidate: Candidate,
    now: i64,
) -> Result<Decision, PortError> {
    let space = &scope.space_id;
    let digest = candidate.cursor.digest;
    const CHECK: &str =
        "SELECT current_publication_id, quarantined_at_ms, CAST(legacy_cleanup AS BIGINT)
        FROM blob_catalog c WHERE space_id=$1 AND content_blake3=$2
          AND ref_count=0 AND admission_state='open' AND blob_state='active'
          AND NOT EXISTS(SELECT 1 FROM blob_publications p
              WHERE p.space_id=c.space_id AND p.content_blake3=c.content_blake3
                AND p.state IN ('staging','retiring'))
          AND NOT EXISTS(SELECT 1 FROM pending_purges x
              WHERE x.space_id=c.space_id AND x.phase<>'completed')";
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
        return Ok(Decision::Skip);
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
    match ensure_no_backup_holds_tx(tx, space, RetirementReason::Gc).await {
        Ok(()) => {}
        Err(err) if err == super::held_retirement() => return Ok(Decision::Skip),
        Err(err) => return Err(err),
    }
    Ok(
        initiate_digest_retirement_tx(tx, scope, epoch, digest, RetirementReason::Gc, None, None)
            .await?
            .map_or(Decision::Skip, Decision::Retire),
    )
}

fn gc_sql(err: sqlx::Error) -> PortError {
    internal_not_committed("cas_gc_catalog", err.to_string())
}
