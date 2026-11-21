//! A sealed sweep obligation survives caller cancellation and physical I/O failures.
//! Its first attempt owns a sweep slot. Later attempts share one paged dispatcher.
use super::*;
use notarium_core::ids::HistoryIncarnation;

#[derive(Default)]
pub(super) struct Dispatcher {
    // None is idle. While running, a wakeup requires another pass before exit.
    state: std::sync::Mutex<Option<bool>>,
    wake: tokio::sync::Notify,
}

impl Dispatcher {
    /// Wake the existing scanner, or acquire ownership of a new one.
    pub(super) fn request(&self) -> bool {
        let mut state = self.state.lock().expect("GC dispatcher");
        if state.replace(true).is_some() {
            self.wake.notify_one();
            return false;
        }
        true
    }

    pub(super) async fn run<F, Fut>(&self, mut pass: F)
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<Option<Duration>, PortError>>,
    {
        loop {
            *self.state.lock().expect("GC dispatcher") = Some(false);
            let wait = match pass().await {
                Ok(wait) => wait,
                Err(error) => {
                    tracing::warn!(?error, "could not scan pending GC");
                    Some(Duration::from_secs(1))
                }
            };
            let delay = {
                let mut state = self.state.lock().expect("GC dispatcher");
                if *state == Some(true) {
                    continue;
                }
                let Some(delay) = wait else {
                    *state = None;
                    return;
                };
                delay
            };
            tokio::select! {
                () = tokio::time::sleep(delay) => {},
                () = self.wake.notified() => {},
            }
        }
    }
}

pub(super) async fn enqueue_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    id: &str,
    now: i64,
) -> Result<(), PortError> {
    const INSERT: &str = "INSERT INTO blob_gc_retries(space_id, retirement_id, retry_at_ms)
        VALUES($1,$2,$3) ON CONFLICT(space_id, retirement_id) DO NOTHING";
    match tx {
        BackendConn::Sqlite(c) => sqlx::query(INSERT)
            .bind(space.as_str())
            .bind(id)
            .bind(now)
            .execute(&mut **c)
            .await
            .map(|_| ()),
        BackendConn::Postgres(c) => sqlx::query(INSERT)
            .bind(space.as_str())
            .bind(id)
            .bind(now)
            .execute(&mut **c)
            .await
            .map(|_| ()),
    }
    .map_err(sql_error)
}

pub(super) async fn remove_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    id: &str,
) -> Result<(), PortError> {
    const REMOVE: &str = "DELETE FROM blob_gc_retries WHERE space_id=$1 AND retirement_id=$2";
    match tx {
        BackendConn::Sqlite(c) => sqlx::query(REMOVE)
            .bind(space.as_str())
            .bind(id)
            .execute(&mut **c)
            .await
            .map(|_| ()),
        BackendConn::Postgres(c) => sqlx::query(REMOVE)
            .bind(space.as_str())
            .bind(id)
            .execute(&mut **c)
            .await
            .map(|_| ()),
    }
    .map_err(sql_error)
}

fn sql_error(err: sqlx::Error) -> PortError {
    internal_not_committed("gc_retry_schedule", err.to_string())
}

impl crate::CanonicalStore {
    pub(super) async fn gc_retry_wait(
        &self,
        space: &SpaceId,
        id: &str,
    ) -> Result<Option<Duration>, PortError> {
        let space = space.clone();
        let id = id.to_owned();
        self.with_read_tx(move |tx| {
            Box::pin(async move {
                let now = crate::peers::job_clock_ms(tx).await?;
                const READ: &str = "SELECT retry_at_ms FROM blob_gc_retries
                    WHERE space_id=$1 AND retirement_id=$2";
                let due: Option<i64> = match tx {
                    BackendConn::Sqlite(c) => {
                        sqlx::query_scalar(READ)
                            .bind(space.as_str())
                            .bind(id)
                            .fetch_optional(&mut **c)
                            .await
                    }
                    BackendConn::Postgres(c) => {
                        sqlx::query_scalar(READ)
                            .bind(space.as_str())
                            .bind(id)
                            .fetch_optional(&mut **c)
                            .await
                    }
                }
                .map_err(sql_error)?;
                Ok(due.map(|due| Duration::from_millis(due.saturating_sub(now).max(0) as u64)))
            })
        })
        .await
    }

    pub(super) async fn defer_gc_retry(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        id: &str,
        delay: Option<Duration>,
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        let id = id.to_owned();
        self.with_write_tx(move |tx| {
            Box::pin(async move {
                lock_and_check_space_tx(tx, &scope, epoch).await?;
                let Some(delay) = delay else {
                    return remove_tx(tx, &scope.space_id, &id).await;
                };
                let now = crate::peers::job_clock_ms(tx).await?;
                let earliest =
                    now.saturating_add(i64::try_from(delay.as_millis()).unwrap_or(i64::MAX));
                const UPDATE: &str = "UPDATE blob_gc_retries SET
                retry_at_ms=CASE WHEN $1+backoff_ms>$2 THEN $1+backoff_ms ELSE $2 END,
                backoff_ms=CASE WHEN backoff_ms>=2500 THEN 5000 ELSE 2*backoff_ms END
                WHERE space_id=$3 AND retirement_id=$4";
                match tx {
                    BackendConn::Sqlite(c) => sqlx::query(UPDATE)
                        .bind(now)
                        .bind(earliest)
                        .bind(scope.space_id.as_str())
                        .bind(id)
                        .execute(&mut **c)
                        .await
                        .map(|_| ()),
                    BackendConn::Postgres(c) => sqlx::query(UPDATE)
                        .bind(now)
                        .bind(earliest)
                        .bind(scope.space_id.as_str())
                        .bind(id)
                        .execute(&mut **c)
                        .await
                        .map(|_| ()),
                }
                .map_err(sql_error)
            })
        })
        .await
    }

    pub(crate) fn wake_gc_retries(&self) {
        if !self.inner.retirement_workers.retries.request() {
            return;
        }
        let store = self.clone();
        let shutdown = self.inner.backup_shutdown.clone();
        let handle = self.inner.backup_executor.spawn(async move {
            let retries = &store.inner.retirement_workers.retries;
            tokio::select! { biased; () = shutdown.cancelled() => {}, () = retries.run(|| store.gc_retry_pass()) => {} }
        });
        crate::backup::register_cleanup_task(&self.inner, handle);
    }

    async fn gc_retry_pass(&self) -> Result<Option<Duration>, PortError> {
        // Snapshot the end key so new arrivals cannot prevent a wrap to earlier Spaces.
        const END: &str = "SELECT retry_at_ms,space_id,retirement_id FROM blob_gc_retries
            ORDER BY retry_at_ms DESC,space_id DESC,retirement_id DESC LIMIT 1";
        let (cutoff, end) = self
            .with_read_tx(|tx| {
                Box::pin(async move {
                    let now = crate::peers::job_clock_ms(tx).await?;
                    let end: Option<(i64, String, String)> = match tx {
                        BackendConn::Sqlite(c) => {
                            sqlx::query_as(END).fetch_optional(&mut **c).await
                        }
                        BackendConn::Postgres(c) => {
                            sqlx::query_as(END).fetch_optional(&mut **c).await
                        }
                    }
                    .map_err(sql_error)?;
                    Ok((now, end))
                })
            })
            .await?;
        let Some(end) = end else { return Ok(None) };
        let mut after = (i64::MIN, String::new(), String::new());
        let mut wait: Option<Duration> = None;
        loop {
            let lower = after.clone();
            let upper = end.clone();
            let (now, rows) = self.with_read_tx(move |tx| {
                Box::pin(async move {
                    const PAGE: &str = "SELECT q.space_id,q.retirement_id,q.retry_at_ms,s.history_incarnation,s.active_epoch
                        FROM blob_gc_retries q JOIN spaces s ON s.space_id=q.space_id
                        WHERE (q.retry_at_ms,q.space_id,q.retirement_id)>($1,$2,$3)
                          AND (q.retry_at_ms,q.space_id,q.retirement_id)<=($4,$5,$6)
                        ORDER BY q.retry_at_ms,q.space_id,q.retirement_id LIMIT 32";
                    let now = crate::peers::job_clock_ms(tx).await?;
                    let rows: Vec<(String, String, i64, Vec<u8>, i64)> = match tx {
                        BackendConn::Sqlite(c) => sqlx::query_as(PAGE)
                            .bind(lower.0)
                            .bind(lower.1)
                            .bind(lower.2)
                            .bind(upper.0)
                            .bind(upper.1)
                            .bind(upper.2)
                            .fetch_all(&mut **c)
                            .await,
                        BackendConn::Postgres(c) => sqlx::query_as(PAGE)
                            .bind(lower.0)
                            .bind(lower.1)
                            .bind(lower.2)
                            .bind(upper.0)
                            .bind(upper.1)
                            .bind(upper.2)
                            .fetch_all(&mut **c)
                            .await,
                    }
                    .map_err(sql_error)?;
                    Ok((now, rows))
                })
            }).await?;
            if rows.is_empty() {
                break;
            }
            for (space, id, due, inc, epoch) in rows {
                after = (due, space.clone(), id.clone());
                let scope = HistoryScope {
                    space_id: SpaceId::parse(&space)?,
                    incarnation: HistoryIncarnation::from_bytes(inc.try_into().map_err(|_| {
                        internal_not_committed("gc_retry_scope", "invalid history incarnation")
                    })?),
                };
                let epoch = LeaseEpoch::new(
                    u64::try_from(epoch)
                        .map_err(|_| internal_not_committed("gc_retry_epoch", "invalid epoch"))?,
                )?;
                if self
                    .inner
                    .check_writer_epoch(&scope.space_id, epoch)
                    .is_err()
                {
                    continue;
                }
                if due > cutoff {
                    // All remaining local entries are due at this time or later.
                    let delay = Duration::from_millis(due.saturating_sub(now).max(0) as u64);
                    return Ok(Some(wait.map_or(delay, |previous| previous.min(delay))));
                }
                let remaining = {
                    let _slot = self
                        .inner
                        .gc_retirements
                        .clone()
                        .acquire_owned()
                        .await
                        .expect("GC semaphore is open");
                    let (_, work) = self.reserve_retirement(&scope, epoch, id);
                    if let Some(work) = work {
                        let Some(delay) = work.retry_if_due().await? else {
                            continue;
                        };
                        delay
                    } else {
                        Duration::from_millis(250)
                    }
                };
                wait = Some(wait.map_or(remaining, |previous| previous.min(remaining)));
            }
        }
        Ok(wait)
    }
}
