use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use notarium_core::{error::PortError, ports::CallBudget};
use sqlx::{Connection, Row, Sqlite, SqliteConnection, pool::PoolConnection};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};

use crate::{
    BoxFuture,
    codec::{
        cancelled_not_committed, deadline_not_committed, internal_not_committed,
        unavailable_retryable,
    },
    runtime::{CanonicalInner, SqlDriverState},
    sql_exec::BackendConn,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WalTelemetrySnapshot {
    pub wal_bytes: u64,
    pub log_frames: u64,
    pub checkpointed_frames: u64,
    pub active_readers: usize,
    pub active_backups: usize,
    pub oldest_reader_age_ns: u64,
    pub total_admission_wait_ns: u64,
    pub passive_checkpoints: u64,
    pub reset_attempts: u64,
    pub reset_successes: u64,
    pub timed_out_reads: u64,
    pub cancelled_or_dropped_reads: u64,
    pub leaked_sqlite_busy_errors: u64,
    pub backup_aborts: u64,
    pub last_backup_abort_reason: Option<String>,
}

pub(crate) struct ActiveBackupPin {
    pub baseline_wal_bytes: u64,
    pub max_pinned_wal_bytes: u64,
    pub abort_flag: Arc<AtomicBool>,
    pub abort_notify: Arc<Notify>,
}

#[allow(dead_code)]
struct ReaderGateState {
    open: bool,
    shutting_down: bool,
    next_reader_id: u64,
    next_backup_id: u64,
    active_readers: BTreeMap<u64, Instant>,
    active_backups: BTreeMap<u64, ActiveBackupPin>,
    last_backup_abort_reason: Option<String>,
}

#[derive(Default)]
struct WalAtomicCounters {
    wal_bytes: AtomicU64,
    log_frames: AtomicU64,
    checkpointed_frames: AtomicU64,
    total_admission_wait_ns: AtomicU64,
    passive_checkpoints: AtomicU64,
    reset_attempts: AtomicU64,
    reset_successes: AtomicU64,
    timed_out_reads: AtomicU64,
    cancelled_or_dropped_reads: AtomicU64,
    leaked_sqlite_busy_errors: AtomicU64,
    backup_aborts: AtomicU64,
}

pub struct SqliteWalCoordinator {
    wal_path: PathBuf,
    read_deadline: Duration,
    passive_checkpoint_interval: Duration,
    wal_soft_watermark_bytes: u64,
    wal_high_watermark_bytes: u64,
    wal_reset_cycle_deadline: Duration,
    gate: StdMutex<ReaderGateState>,
    gate_open_notify: Notify,
    drained_notify: Notify,
    counters: WalAtomicCounters,
    maintenance_lock: Mutex<()>,
    bg_stop: AtomicBool,
    bg_wake: Notify,
    bg_task: Mutex<Option<JoinHandle<()>>>,
    detached_cleanups: StdMutex<Vec<JoinHandle<()>>>,
}

#[allow(dead_code)]
pub(crate) struct BackupWalPinGuard {
    coord: Arc<SqliteWalCoordinator>,
    pin_id: u64,
    baseline_wal_bytes: u64,
    pub abort_flag: Arc<AtomicBool>,
    pub abort_notify: Arc<Notify>,
}

#[allow(dead_code)]
impl BackupWalPinGuard {
    pub fn current_pinned_wal_bytes(&self) -> u64 {
        self.coord
            .observe_wal_file_bytes()
            .saturating_sub(self.baseline_wal_bytes)
    }

    pub fn is_aborted_by_coordinator(&self) -> bool {
        self.abort_flag.load(Ordering::SeqCst)
    }
}

impl Drop for BackupWalPinGuard {
    fn drop(&mut self) {
        self.coord.unregister_backup_pin(self.pin_id);
    }
}

struct GateReopenGuard<'a> {
    coord: &'a SqliteWalCoordinator,
    reopened: bool,
}

impl Drop for GateReopenGuard<'_> {
    fn drop(&mut self) {
        if !self.reopened {
            self.coord.reopen_reader_gate();
        }
    }
}

struct ActiveSqliteSnapshotGuard {
    coord: Arc<SqliteWalCoordinator>,
    reader_id: u64,
    interrupt_flag: Arc<AtomicBool>,
    pooled: Option<PoolConnection<Sqlite>>,
    completed_cleanly: bool,
    counted_timeout: bool,
}

impl ActiveSqliteSnapshotGuard {
    fn conn_mut(&mut self) -> &mut SqliteConnection {
        self.pooled
            .as_mut()
            .expect("pooled connection present while active")
    }

    async fn finish_cleanly(mut self) {
        if let Some(pooled) = self.pooled.as_mut()
            && let Ok(mut locked) = pooled.lock_handle().await
        {
            locked.remove_progress_handler();
        }
        self.completed_cleanly = true;
        drop(self.pooled.take());
        self.coord.release_reader_slot(self.reader_id);
    }
}

impl Drop for ActiveSqliteSnapshotGuard {
    fn drop(&mut self) {
        if self.completed_cleanly {
            return;
        }
        // Immediately interrupt any running SQLite VM step on the worker thread!
        self.interrupt_flag.store(true, Ordering::SeqCst);
        if !self.counted_timeout {
            self.coord
                .counters
                .cancelled_or_dropped_reads
                .fetch_add(1, Ordering::Relaxed);
        }

        if let Some(pooled) = self.pooled.take() {
            // Detach from pool so an interrupted or uncommitted connection is NEVER reused!
            let mut raw_conn = pooled.detach();
            let coord = Arc::clone(&self.coord);
            let reader_id = self.reader_id;

            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                let coord_bg = Arc::clone(&coord);
                let handle = rt.spawn(async move {
                    let _ = sqlx::query("ROLLBACK").execute(&mut raw_conn).await;
                    let _ = raw_conn.close().await;
                    coord_bg.release_reader_slot(reader_id);
                });
                coord.register_detached_cleanup(handle);
            } else {
                drop(raw_conn);
                coord.release_reader_slot(reader_id);
            }
        } else {
            self.coord.release_reader_slot(self.reader_id);
        }
    }
}

pub fn sqlite_wal_path_for(db_path: &Path) -> PathBuf {
    let mut s = db_path.as_os_str().to_os_string();
    s.push("-wal");
    PathBuf::from(s)
}

impl SqliteWalCoordinator {
    pub(crate) fn start(
        inner: &Arc<CanonicalInner>,
        db_path: &Path,
        read_deadline: Duration,
        passive_checkpoint_interval: Duration,
        wal_soft_watermark_bytes: u64,
        wal_high_watermark_bytes: u64,
        wal_reset_cycle_deadline: Duration,
    ) -> Arc<Self> {
        let wal_path = sqlite_wal_path_for(db_path);
        let initial_wal_bytes = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

        let coord = Arc::new(Self {
            wal_path,
            read_deadline: read_deadline.max(Duration::from_millis(1)),
            passive_checkpoint_interval: passive_checkpoint_interval.max(Duration::from_millis(2)),
            wal_soft_watermark_bytes: wal_soft_watermark_bytes.max(4096),
            wal_high_watermark_bytes: wal_high_watermark_bytes
                .max(wal_soft_watermark_bytes.max(4096)),
            wal_reset_cycle_deadline: wal_reset_cycle_deadline.max(Duration::from_millis(10)),
            gate: StdMutex::new(ReaderGateState {
                open: true,
                shutting_down: false,
                next_reader_id: 1,
                next_backup_id: 1,
                active_readers: BTreeMap::new(),
                active_backups: BTreeMap::new(),
                last_backup_abort_reason: None,
            }),
            gate_open_notify: Notify::new(),
            drained_notify: Notify::new(),
            counters: WalAtomicCounters {
                wal_bytes: AtomicU64::new(initial_wal_bytes),
                ..WalAtomicCounters::default()
            },
            maintenance_lock: Mutex::new(()),
            bg_stop: AtomicBool::new(false),
            bg_wake: Notify::new(),
            bg_task: Mutex::new(None),
            detached_cleanups: StdMutex::new(Vec::new()),
        });

        let inner_weak = Arc::downgrade(inner);
        let coord_cl = Arc::clone(&coord);
        let handle = tokio::spawn(async move {
            run_background_wal_loop(inner_weak, coord_cl).await;
        });
        if let Ok(mut slot) = coord.bg_task.try_lock() {
            *slot = Some(handle);
        }

        coord
    }

    pub fn observe_wal_file_bytes(&self) -> u64 {
        let bytes = fs::metadata(&self.wal_path).map(|m| m.len()).unwrap_or(0);
        self.counters.wal_bytes.store(bytes, Ordering::Relaxed);
        bytes
    }

    pub fn record_busy_if_any(&self, err_msg: &str) {
        let lower = err_msg.to_ascii_lowercase();
        if lower.contains("database is locked") || lower.contains("sqlite_busy") {
            self.counters
                .leaked_sqlite_busy_errors
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn telemetry(&self) -> WalTelemetrySnapshot {
        let wal_bytes = self.observe_wal_file_bytes();
        let now = Instant::now();
        let (active_readers, active_backups, oldest_reader_age_ns, last_backup_abort_reason) = {
            let st = self.gate.lock().expect("wal gate mutex");
            let oldest = st
                .active_readers
                .values()
                .map(|started| {
                    u64::try_from(now.duration_since(*started).as_nanos()).unwrap_or(u64::MAX)
                })
                .max()
                .unwrap_or(0);
            (
                st.active_readers.len(),
                st.active_backups.len(),
                oldest,
                st.last_backup_abort_reason.clone(),
            )
        };

        WalTelemetrySnapshot {
            wal_bytes,
            log_frames: self.counters.log_frames.load(Ordering::Relaxed),
            checkpointed_frames: self.counters.checkpointed_frames.load(Ordering::Relaxed),
            active_readers,
            active_backups,
            oldest_reader_age_ns,
            total_admission_wait_ns: self
                .counters
                .total_admission_wait_ns
                .load(Ordering::Relaxed),
            passive_checkpoints: self.counters.passive_checkpoints.load(Ordering::Relaxed),
            reset_attempts: self.counters.reset_attempts.load(Ordering::Relaxed),
            reset_successes: self.counters.reset_successes.load(Ordering::Relaxed),
            timed_out_reads: self.counters.timed_out_reads.load(Ordering::Relaxed),
            cancelled_or_dropped_reads: self
                .counters
                .cancelled_or_dropped_reads
                .load(Ordering::Relaxed),
            leaked_sqlite_busy_errors: self
                .counters
                .leaked_sqlite_busy_errors
                .load(Ordering::Relaxed),
            backup_aborts: self.counters.backup_aborts.load(Ordering::Relaxed),
            last_backup_abort_reason,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn register_backup_pin(
        self: &Arc<Self>,
        max_pinned_wal_bytes: u64,
    ) -> BackupWalPinGuard {
        let baseline = self.observe_wal_file_bytes();
        let abort_flag = Arc::new(AtomicBool::new(false));
        let abort_notify = Arc::new(Notify::new());

        let pin_id = {
            let mut st = self.gate.lock().expect("wal gate mutex");
            let id = st.next_backup_id;
            st.next_backup_id += 1;
            st.active_backups.insert(
                id,
                ActiveBackupPin {
                    baseline_wal_bytes: baseline,
                    max_pinned_wal_bytes,
                    abort_flag: Arc::clone(&abort_flag),
                    abort_notify: Arc::clone(&abort_notify),
                },
            );
            id
        };

        BackupWalPinGuard {
            coord: Arc::clone(self),
            pin_id,
            baseline_wal_bytes: baseline,
            abort_flag,
            abort_notify,
        }
    }

    #[allow(dead_code)]
    fn unregister_backup_pin(&self, pin_id: u64) {
        let empty = {
            let mut st = self.gate.lock().expect("wal gate mutex");
            st.active_backups.remove(&pin_id);
            st.active_backups.is_empty()
        };
        if empty {
            self.drained_notify.notify_waiters();
            self.bg_wake.notify_one();
        }
    }

    fn release_reader_slot(&self, reader_id: u64) {
        let drained = {
            let mut st = self.gate.lock().expect("wal gate mutex");
            st.active_readers.remove(&reader_id);
            st.active_readers.is_empty()
        };
        if drained {
            self.drained_notify.notify_waiters();
        }
    }

    fn register_detached_cleanup(&self, handle: JoinHandle<()>) {
        let mut list = self.detached_cleanups.lock().expect("cleanups mutex");
        list.retain(|h| !h.is_finished());
        list.push(handle);
    }

    fn close_reader_gate(&self) {
        let mut st = self.gate.lock().expect("wal gate mutex");
        st.open = false;
    }

    fn reopen_reader_gate(&self) {
        {
            let mut st = self.gate.lock().expect("wal gate mutex");
            st.open = true;
        }
        self.gate_open_notify.notify_waiters();
    }

    /// Executes an ordinary short-lived read transaction with reader-gate admission,
    /// `<250 ms` monotonic SQLite progress-handler deadline, and guaranteed connection detach/close on cancel or drop.
    pub(crate) async fn with_ordinary_read_tx<F, T>(
        self: &Arc<Self>,
        read_pool: &sqlx::SqlitePool,
        budget: Option<&CallBudget>,
        op: F,
    ) -> Result<T, PortError>
    where
        F: for<'c> FnOnce(&'c mut BackendConn<'_>) -> BoxFuture<'c, Result<T, PortError>>,
    {
        if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
            return Err(cancelled_not_committed(
                "sqlite_read_cancelled_pre_admission",
                "read cancelled before admission",
            ));
        }
        let caller_remaining = budget.map(|b| b.remaining).unwrap_or(self.read_deadline);
        if caller_remaining.is_zero() {
            return Err(deadline_not_committed(
                "sqlite_read_zero_budget",
                "read call budget expired before admission",
            ));
        }

        let start_wait = Instant::now();
        let caller_deadline_tokio = tokio::time::Instant::now() + caller_remaining;

        // 1. Wait for ordinary reader admission gate without losing Caller's deadline!
        let reader_id = loop {
            let notified = self.gate_open_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            {
                let mut st = self.gate.lock().expect("wal gate mutex");
                if st.shutting_down {
                    return Err(unavailable_retryable(
                        "sqlite_wal_shutting_down",
                        "SQLite WAL coordinator is shutting down",
                        Duration::from_millis(50),
                    ));
                }
                if st.open {
                    let id = st.next_reader_id;
                    st.next_reader_id += 1;
                    st.active_readers.insert(id, Instant::now());
                    break id;
                }
            }

            if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
                return Err(cancelled_not_committed(
                    "sqlite_read_cancelled_waiting_gate",
                    "read cancelled while waiting for WAL reset gate",
                ));
            }
            if tokio::time::Instant::now() >= caller_deadline_tokio {
                self.counters
                    .timed_out_reads
                    .fetch_add(1, Ordering::Relaxed);
                return Err(deadline_not_committed(
                    "sqlite_read_gate_deadline",
                    "read deadline exceeded while waiting for WAL reset gate",
                ));
            }

            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep_until(caller_deadline_tokio) => {
                    self.counters.timed_out_reads.fetch_add(1, Ordering::Relaxed);
                    return Err(deadline_not_committed(
                        "sqlite_read_gate_deadline",
                        "read deadline exceeded while waiting for WAL reset gate",
                    ));
                }
            }
        };

        let waited_ns = u64::try_from(start_wait.elapsed().as_nanos()).unwrap_or(u64::MAX);
        self.counters
            .total_admission_wait_ns
            .fetch_add(waited_ns, Ordering::Relaxed);

        let interrupt_flag = Arc::new(AtomicBool::new(false));
        let mut snap_guard = ActiveSqliteSnapshotGuard {
            coord: Arc::clone(self),
            reader_id,
            interrupt_flag: Arc::clone(&interrupt_flag),
            pooled: None,
            completed_cleanly: false,
            counted_timeout: false,
        };

        // 2. Acquire read-only connection bounded by remaining caller budget.
        let pooled = tokio::select! {
            res = read_pool.acquire() => match res {
                Ok(conn) => conn,
                Err(err) => {
                    self.record_busy_if_any(&err.to_string());
                    return Err(unavailable_retryable(
                        "sqlite_acquire_read",
                        err.to_string(),
                        Duration::from_millis(25),
                    ));
                }
            },
            _ = tokio::time::sleep_until(caller_deadline_tokio) => {
                snap_guard.counted_timeout = true;
                self.counters.timed_out_reads.fetch_add(1, Ordering::Relaxed);
                return Err(deadline_not_committed(
                    "sqlite_acquire_read_deadline",
                    "deadline exceeded acquiring SQLite read connection",
                ));
            }
        };

        // 3. Enforce monotonic `<250 ms` snapshot deadline (`min(remaining_caller, read_deadline)`).
        let now_tokio = tokio::time::Instant::now();
        let remaining_after_acquire = caller_deadline_tokio.saturating_duration_since(now_tokio);
        if remaining_after_acquire.is_zero() {
            snap_guard.pooled = Some(pooled);
            snap_guard.counted_timeout = true;
            self.counters
                .timed_out_reads
                .fetch_add(1, Ordering::Relaxed);
            return Err(deadline_not_committed(
                "sqlite_read_budget_exhausted",
                "read budget exhausted after pool acquire",
            ));
        }

        let effective_tx_budget = remaining_after_acquire.min(self.read_deadline);
        let tx_deadline_std = Instant::now() + effective_tx_budget;
        let tx_deadline_tokio = now_tokio + effective_tx_budget;

        snap_guard.pooled = Some(pooled);
        {
            let mut locked = snap_guard
                .conn_mut()
                .lock_handle()
                .await
                .map_err(|err| internal_not_committed("sqlite_lock_handle", err.to_string()))?;
            let flag_cl = Arc::clone(&interrupt_flag);
            let cancel_opt = budget.map(|b| b.cancellation.clone());
            // Returning `true` continues execution; returning `false` interrupts SQLite VM immediately!
            locked.set_progress_handler(128, move || {
                if flag_cl.load(Ordering::Relaxed) {
                    return false;
                }
                if let Some(c) = &cancel_opt
                    && c.is_cancelled()
                {
                    return false;
                }
                Instant::now() < tx_deadline_std
            });
        }

        // 4. Execute `BEGIN DEFERRED` + read body + `COMMIT`, racing against `tx_deadline_tokio`.
        let body_res: Result<T, PortError> = {
            let conn = snap_guard.conn_mut();
            let mut backend = BackendConn::Sqlite(conn);
            let fut = async {
                backend.begin_read(None).await?;
                let out = op(&mut backend).await?;
                backend.commit_read().await?;
                Ok(out)
            };
            tokio::select! {
                res = fut => res,
                _ = tokio::time::sleep_until(tx_deadline_tokio) => {
                    interrupt_flag.store(true, Ordering::SeqCst);
                    snap_guard.counted_timeout = true;
                    self.counters.timed_out_reads.fetch_add(1, Ordering::Relaxed);
                    Err(deadline_not_committed(
                        "sqlite_read_tx_deadline",
                        "ordinary SQLite read transaction exceeded monotonic deadline",
                    ))
                }
            }
        };

        match body_res {
            Ok(value) => {
                snap_guard.finish_cleanly().await;
                Ok(value)
            }
            Err(err) => {
                if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
                    return Err(cancelled_not_committed(
                        "sqlite_read_cancelled",
                        "ordinary SQLite read cancelled",
                    ));
                }
                if Instant::now() >= tx_deadline_std {
                    if !snap_guard.counted_timeout {
                        snap_guard.counted_timeout = true;
                        self.counters
                            .timed_out_reads
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    return Err(deadline_not_committed(
                        "sqlite_read_interrupted_deadline",
                        "ordinary SQLite read interrupted at deadline",
                    ));
                }
                self.record_busy_if_any(&format!("{err:?}"));
                // `snap_guard` Drop detaches and closes the connection in background!
                Err(err)
            }
        }
    }

    /// Runs one maintenance tick (`PASSIVE` checkpoint + conditional bounded `TRUNCATE` reset).
    pub(crate) async fn run_maintenance_tick(
        &self,
        inner: &Arc<CanonicalInner>,
        force_reset: bool,
    ) {
        let _maint_guard = self.maintenance_lock.lock().await;
        if self.bg_stop.load(Ordering::SeqCst) || inner.shutting_down.load(Ordering::SeqCst) {
            return;
        }

        // 1. Run `PRAGMA wal_checkpoint(PASSIVE)` on the writer connection between micro-batches.
        let passive_res = self.run_passive_checkpoint(inner).await;
        let wal_bytes = self.observe_wal_file_bytes();

        // 2. Check active backup WAL budgets first: if any backup exceeded `max_pinned_wal_bytes`,
        // signal abort and wait for it to close before resetting WAL!
        let mut aborted_any_backup = false;
        {
            let mut st = self.gate.lock().expect("wal gate mutex");
            for pin in st.active_backups.values() {
                let pinned = wal_bytes.saturating_sub(pin.baseline_wal_bytes);
                if pinned > pin.max_pinned_wal_bytes && !pin.abort_flag.swap(true, Ordering::SeqCst)
                {
                    pin.abort_notify.notify_waiters();
                    aborted_any_backup = true;
                }
            }
            if aborted_any_backup {
                st.last_backup_abort_reason = Some(format!(
                    "pinned WAL exceeded backup budget (current wal_bytes={wal_bytes})"
                ));
            }
        }
        if aborted_any_backup {
            self.counters.backup_aborts.fetch_add(1, Ordering::Relaxed);
            // Wait boundedly for aborted backup snapshot(s) to close.
            let wait_backup_deadline = tokio::time::Instant::now() + self.wal_reset_cycle_deadline;
            loop {
                let notified = self.drained_notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self
                    .gate
                    .lock()
                    .expect("wal gate mutex")
                    .active_backups
                    .is_empty()
                {
                    break;
                }
                if tokio::time::Instant::now() >= wait_backup_deadline {
                    break;
                }
                tokio::select! {
                    _ = notified => {}
                    _ = tokio::time::sleep_until(wait_backup_deadline) => break,
                }
            }
        }

        // Do not run `TRUNCATE` while a valid within-budget backup holds a read snapshot.
        if !self
            .gate
            .lock()
            .expect("wal gate mutex")
            .active_backups
            .is_empty()
        {
            return;
        }

        let passive_blocked_or_lagging = match passive_res {
            Some((busy, log_f, ckpt_f)) => busy != 0 || log_f > ckpt_f,
            None => false,
        };

        let needs_reset = force_reset
            || wal_bytes >= self.wal_high_watermark_bytes
            || (wal_bytes >= self.wal_soft_watermark_bytes
                && (passive_blocked_or_lagging || wal_bytes > 0));

        if needs_reset {
            self.run_bounded_wal_reset(inner).await;
        }
    }

    async fn run_passive_checkpoint(&self, inner: &Arc<CanonicalInner>) -> Option<(i64, i64, i64)> {
        let SqlDriverState::Sqlite { writer, .. } = &inner.sql else {
            return None;
        };
        let mut guard = writer.lock().await;
        let conn = guard.as_mut()?;
        match sqlx::query("PRAGMA wal_checkpoint(PASSIVE)")
            .fetch_one(&mut *conn)
            .await
        {
            Ok(row) => {
                let busy: i64 = row.get(0);
                let log_frames: i64 = row.get(1);
                let ckpt_frames: i64 = row.get(2);
                self.counters
                    .passive_checkpoints
                    .fetch_add(1, Ordering::Relaxed);
                self.counters.log_frames.store(
                    u64::try_from(log_frames.max(0)).unwrap_or(0),
                    Ordering::Relaxed,
                );
                self.counters.checkpointed_frames.store(
                    u64::try_from(ckpt_frames.max(0)).unwrap_or(0),
                    Ordering::Relaxed,
                );
                Some((busy, log_frames, ckpt_frames))
            }
            Err(err) => {
                self.record_busy_if_any(&err.to_string());
                None
            }
        }
    }

    async fn run_bounded_wal_reset(&self, inner: &Arc<CanonicalInner>) {
        let Some(writer_coord) = inner.writer_coord.get() else {
            return;
        };
        let SqlDriverState::Sqlite { writer, .. } = &inner.sql else {
            return;
        };

        self.counters.reset_attempts.fetch_add(1, Ordering::Relaxed);
        let cycle_deadline = tokio::time::Instant::now() + self.wal_reset_cycle_deadline;

        // Close ordinary reader admission and ensure an RAII guard ALWAYS reopens it!
        self.close_reader_gate();
        let mut reopen_guard = GateReopenGuard {
            coord: self,
            reopened: false,
        };

        // 1. Wait for active ordinary readers to drain by their monotonic deadlines.
        loop {
            let notified = self.drained_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let drained = {
                let st = self.gate.lock().expect("wal gate mutex");
                st.active_readers.is_empty() && st.active_backups.is_empty()
            };
            if drained {
                break;
            }
            if tokio::time::Instant::now() >= cycle_deadline {
                return;
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep_until(cycle_deadline) => return,
            }
        }

        // 2. Acquire writer safe point bounded by `cycle_deadline` so no new batch commits occur during TRUNCATE.
        let Ok(safe_point) =
            tokio::time::timeout_at(cycle_deadline, writer_coord.acquire_safe_point()).await
        else {
            return;
        };

        // 3. Run bounded `PRAGMA wal_checkpoint(TRUNCATE)` on writer connection.
        let Ok(mut writer_guard) = tokio::time::timeout_at(cycle_deadline, writer.lock()).await
        else {
            drop(safe_point);
            return;
        };

        if let Some(conn) = writer_guard.as_mut() {
            let rem_ms = cycle_deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis()
                .clamp(5, 250);
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
                "PRAGMA busy_timeout = {rem_ms}"
            )))
            .execute(&mut *conn)
            .await;

            let trunc_res = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .fetch_one(&mut *conn)
                .await;

            let _ = sqlx::query("PRAGMA busy_timeout = 5000")
                .execute(&mut *conn)
                .await;

            if let Ok(row) = trunc_res {
                let busy: i64 = row.get(0);
                let log_frames: i64 = row.get(1);
                let ckpt_frames: i64 = row.get(2);
                self.counters.log_frames.store(
                    u64::try_from(log_frames.max(0)).unwrap_or(0),
                    Ordering::Relaxed,
                );
                self.counters.checkpointed_frames.store(
                    u64::try_from(ckpt_frames.max(0)).unwrap_or(0),
                    Ordering::Relaxed,
                );
                if busy == 0 {
                    self.counters
                        .reset_successes
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        drop(writer_guard);
        drop(safe_point);

        // Immediately reopen reader admission before filesystem stat!
        self.reopen_reader_gate();
        reopen_guard.reopened = true;
        let _ = self.observe_wal_file_bytes();
    }

    pub async fn shutdown(&self) {
        self.bg_stop.store(true, Ordering::SeqCst);
        {
            let mut st = self.gate.lock().expect("wal gate mutex");
            st.shutting_down = true;
            st.open = true;
        }
        self.gate_open_notify.notify_waiters();
        self.bg_wake.notify_waiters();

        if let Some(handle) = self.bg_task.lock().await.take() {
            let _ = handle.await;
        }

        let cleanups: Vec<JoinHandle<()>> = {
            let mut list = self.detached_cleanups.lock().expect("cleanups mutex");
            std::mem::take(&mut *list)
        };
        for handle in cleanups {
            let _ = handle.await;
        }
    }
}

async fn run_background_wal_loop(
    inner_weak: std::sync::Weak<CanonicalInner>,
    coord: Arc<SqliteWalCoordinator>,
) {
    let interval = coord.passive_checkpoint_interval;
    while !coord.bg_stop.load(Ordering::SeqCst) {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = coord.bg_wake.notified() => {}
        }
        if coord.bg_stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(inner) = inner_weak.upgrade() else {
            break;
        };
        coord.run_maintenance_tick(&inner, false).await;
    }
}
