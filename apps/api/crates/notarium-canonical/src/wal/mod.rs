use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
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
    pub max_reset_reader_gate_ns: u64,
    pub reset_gate_overruns: u64,
    pub timed_out_reads: u64,
    pub cancelled_or_dropped_reads: u64,
    pub leaked_sqlite_busy_errors: u64,
    pub backup_aborts: u64,
    pub last_backup_abort_reason: Option<String>,
}

pub(crate) struct ActiveBackupPin {
    baseline_frames: Arc<OnceLock<u64>>,
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

thread_local! {
    static LAST_WAL_COMMIT_FRAMES: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

pub(crate) fn sqlite_writer_wal_hook(
    _wal: &rusqlite::hooks::Wal,
    pages: std::os::raw::c_int,
) -> rusqlite::Result<()> {
    LAST_WAL_COMMIT_FRAMES.set(Some(u64::try_from(pages.max(0)).unwrap_or(0)));
    Ok(())
}

pub(crate) fn take_last_wal_commit_frames() -> Option<u64> {
    LAST_WAL_COMMIT_FRAMES.take()
}

#[derive(Default)]
struct WalAtomicCounters {
    wal_bytes: AtomicU64,
    logical_wal_bytes: AtomicU64,
    has_wal_hook_frames: AtomicBool,
    last_passive_wal_bytes: AtomicU64,
    commits_since_passive: AtomicU64,
    commits_since_reset: AtomicU64,
    last_commit_elapsed_ns: AtomicU64,
    log_frames: AtomicU64,
    checkpointed_frames: AtomicU64,
    total_admission_wait_ns: AtomicU64,
    passive_checkpoints: AtomicU64,
    reset_attempts: AtomicU64,
    reset_successes: AtomicU64,
    max_reset_reader_gate_ns: AtomicU64,
    reset_gate_overruns: AtomicU64,
    timed_out_reads: AtomicU64,
    cancelled_or_dropped_reads: AtomicU64,
    leaked_sqlite_busy_errors: AtomicU64,
    backup_aborts: AtomicU64,
}

pub struct SqliteWalCoordinator {
    started_at: Instant,
    db_path: PathBuf,
    wal_path: PathBuf,
    wal_frame_bytes: u64,
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
    passive_conn: Mutex<Option<rusqlite::Connection>>,
    #[cfg(test)]
    checkpoint_io_delay_ms: AtomicU64,
    bg_stop: AtomicBool,
    bg_wake: Notify,
    bg_task: Mutex<Option<JoinHandle<()>>>,
    detached_cleanups: StdMutex<Vec<JoinHandle<()>>>,
}

#[allow(dead_code)]
pub(crate) struct BackupWalPinGuard {
    coord: Arc<SqliteWalCoordinator>,
    pin_id: u64,
    baseline_frames: Arc<OnceLock<u64>>,
    pub abort_flag: Arc<AtomicBool>,
    pub abort_notify: Arc<Notify>,
}

#[allow(dead_code)]
impl BackupWalPinGuard {
    pub fn mark_cut(&self, observer: &rusqlite::Connection) -> Result<(), PortError> {
        let (log, backfilled) = read_wal_frames(observer)?;
        // A fully backfilled WAL can restart on the next write even with a
        // database-only reader. In that case its new frames start at one.
        let floor = if log > backfilled { log } else { 0 };
        self.baseline_frames
            .set(floor)
            .map_err(|_| internal_not_committed("wal_backup_mark_cut", "cut already pinned"))
    }

    pub fn current_pinned_wal_bytes(
        &self,
        observer: &rusqlite::Connection,
    ) -> Result<u64, PortError> {
        let (log, backfilled) = read_wal_frames(observer)?;
        let floor = self.baseline_frames.get().expect("backup cut is pinned");
        Ok(log
            .saturating_sub(backfilled.max(*floor))
            .saturating_mul(self.coord.wal_frame_bytes))
    }

    pub fn is_aborted_by_coordinator(&self) -> bool {
        self.abort_flag.load(Ordering::SeqCst)
    }
}

// NOOP reads the live WAL index without copying pages or changing its generation.
fn read_wal_frames(observer: &rusqlite::Connection) -> Result<(u64, u64), PortError> {
    let until = Instant::now() + Duration::from_millis(50);
    loop {
        let (busy, log, backfilled): (i64, i64, i64) = observer
            .query_row("PRAGMA main.wal_checkpoint(NOOP)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|err| internal_not_committed("wal_backup_frames", err.to_string()))?;
        if busy == 0 && log >= 0 && backfilled >= 0 {
            return Ok((log as u64, backfilled as u64));
        }
        if Instant::now() >= until {
            return Err(unavailable_retryable(
                "wal_backup_observer_busy",
                "WAL index unavailable",
                Duration::from_millis(5),
            ));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

impl Drop for BackupWalPinGuard {
    fn drop(&mut self) {
        self.coord.unregister_backup_pin(self.pin_id);
    }
}

struct GateReopenGuard<'a> {
    coord: &'a SqliteWalCoordinator,
    closed_at: Instant,
}

impl Drop for GateReopenGuard<'_> {
    fn drop(&mut self) {
        self.coord.reopen_reader_gate();
        let dwell = self.closed_at.elapsed();
        self.coord.counters.max_reset_reader_gate_ns.fetch_max(
            u64::try_from(dwell.as_nanos()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        if dwell > self.coord.wal_reset_cycle_deadline {
            self.coord
                .counters
                .reset_gate_overruns
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(crate) struct FastReaderGateGuard {
    coord: Arc<SqliteWalCoordinator>,
    reader_id: u64,
    completed_cleanly: bool,
    counted_timeout: bool,
}

impl FastReaderGateGuard {
    pub fn mark_timeout(&mut self) {
        if !self.counted_timeout {
            self.counted_timeout = true;
            self.coord
                .counters
                .timed_out_reads
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn finish_cleanly(mut self) {
        self.completed_cleanly = true;
        self.coord.release_reader_slot(self.reader_id);
    }
}

impl Drop for FastReaderGateGuard {
    fn drop(&mut self) {
        if !self.completed_cleanly {
            if !self.counted_timeout {
                self.coord
                    .counters
                    .cancelled_or_dropped_reads
                    .fetch_add(1, Ordering::Relaxed);
            }
            self.coord.release_reader_slot(self.reader_id);
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

pub(crate) async fn read_cancelled(budget: Option<&CallBudget>) -> PortError {
    match budget {
        Some(budget) => budget.cancellation.cancelled().await,
        None => std::future::pending().await,
    }
    cancelled_not_committed("sqlite_read_cancelled", "ordinary SQLite read cancelled")
}

pub fn sqlite_wal_path_for(db_path: &Path) -> PathBuf {
    let mut s = db_path.as_os_str().to_os_string();
    s.push("-wal");
    PathBuf::from(s)
}

#[cfg(feature = "test-support")]
impl crate::CanonicalStore {
    /// Observes connection-local settings on the handle used for SQLite batch commits.
    pub async fn sqlite_writer_pragmas_for_bench(&self) -> Result<(i64, i64), PortError> {
        let SqlDriverState::Sqlite { writer, .. } = &self.inner.sql else {
            return Err(internal_not_committed(
                "wal_pragmas",
                "SQLite writer required",
            ));
        };
        let guard = writer.lock().await;
        let conn = guard
            .as_ref()
            .and_then(|p| p.rusqlite_conn.as_ref())
            .ok_or_else(|| internal_not_committed("wal_pragmas", "SQLite writer closed"))?;
        conn.query_row(
            "SELECT synchronous, journal_size_limit FROM pragma_synchronous, pragma_journal_size_limit",
            [], |row| Ok((row.get(0)?, row.get(1)?))
        ).map_err(|err| internal_not_committed("wal_pragmas", err.to_string()))
    }
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
        let page_size_bytes = {
            use std::io::Read;
            let mut hdr = [0u8; 18];
            match fs::File::open(db_path).and_then(|mut f| f.read_exact(&mut hdr)) {
                Ok(()) => match u16::from_be_bytes([hdr[16], hdr[17]]) {
                    1 => 65_536u64,
                    ps if ps >= 512 && ps.is_power_of_two() => u64::from(ps),
                    _ => 4_096u64,
                },
                Err(_) => 4_096u64,
            }
        };
        let wal_frame_bytes = page_size_bytes + 24;

        let coord = Arc::new(Self {
            started_at: Instant::now(),
            db_path: db_path.to_path_buf(),
            wal_path,
            wal_frame_bytes,
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
            passive_conn: Mutex::new(None),
            #[cfg(test)]
            checkpoint_io_delay_ms: AtomicU64::new(0),
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

    fn now_elapsed_ns(&self) -> u64 {
        u64::try_from(self.started_at.elapsed().as_nanos()).unwrap_or(u64::MAX)
    }

    pub fn note_writer_commit(&self) {
        self.counters
            .last_commit_elapsed_ns
            .store(self.now_elapsed_ns(), Ordering::Relaxed);
        self.counters
            .has_wal_hook_frames
            .store(false, Ordering::Relaxed);
        self.counters
            .commits_since_passive
            .fetch_add(1, Ordering::Release);
        self.counters
            .commits_since_reset
            .fetch_add(1, Ordering::Release);
    }

    pub fn note_writer_commit_with_frames(&self, frames_opt: Option<u64>) {
        self.counters
            .last_commit_elapsed_ns
            .store(self.now_elapsed_ns(), Ordering::Relaxed);
        if let Some(frames) = frames_opt {
            let new_bytes = frames.saturating_mul(self.wal_frame_bytes);
            let prev_bytes = self
                .counters
                .logical_wal_bytes
                .swap(new_bytes, Ordering::Relaxed);
            if new_bytes < prev_bytes {
                // SQLite natively auto-wrapped the WAL back to frame 1 after `PASSIVE` caught up!
                self.counters
                    .checkpointed_frames
                    .store(0, Ordering::Relaxed);
                self.counters
                    .last_passive_wal_bytes
                    .store(0, Ordering::Relaxed);
            }
            self.counters.log_frames.store(frames, Ordering::Relaxed);
            self.counters
                .has_wal_hook_frames
                .store(true, Ordering::Relaxed);
        }
        self.counters
            .commits_since_passive
            .fetch_add(1, Ordering::Release);
        self.counters
            .commits_since_reset
            .fetch_add(1, Ordering::Release);
    }

    pub(crate) fn read_deadline(&self) -> Duration {
        self.read_deadline
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
            max_reset_reader_gate_ns: self
                .counters
                .max_reset_reader_gate_ns
                .load(Ordering::Relaxed),
            reset_gate_overruns: self.counters.reset_gate_overruns.load(Ordering::Relaxed),
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
        let baseline_frames = Arc::new(OnceLock::new());
        let abort_flag = Arc::new(AtomicBool::new(false));
        let abort_notify = Arc::new(Notify::new());

        let pin_id = {
            let mut st = self.gate.lock().expect("wal gate mutex");
            let id = st.next_backup_id;
            st.next_backup_id += 1;
            st.active_backups.insert(
                id,
                ActiveBackupPin {
                    baseline_frames: Arc::clone(&baseline_frames),
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
            baseline_frames,
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
        let should_notify = {
            let mut st = self.gate.lock().expect("wal gate mutex");
            st.active_readers.remove(&reader_id);
            st.active_readers.is_empty() && (!st.open || st.shutting_down)
        };
        if should_notify {
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

    /// Admits a short-lived synchronous `rusqlite` read transaction through the exact same
    /// WAL reader gate and monotonic deadline contract as `with_ordinary_read_tx`.
    pub(crate) async fn acquire_reader_gate_slot(
        self: &Arc<Self>,
        budget: Option<&CallBudget>,
    ) -> Result<(FastReaderGateGuard, tokio::time::Instant), PortError> {
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

        // Fast path: 99.99% of the time `st.open == true`; avoid allocating/enabling `Notify` waiter!
        let fast_id = {
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
                st.active_readers.insert(id, start_wait);
                Some(id)
            } else {
                None
            }
        };

        let reader_id = match fast_id {
            Some(id) => id,
            None => loop {
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
                    biased;
                    error = read_cancelled(budget) => return Err(error),
                    _ = notified => {}
                    _ = tokio::time::sleep_until(caller_deadline_tokio) => {
                        self.counters.timed_out_reads.fetch_add(1, Ordering::Relaxed);
                        return Err(deadline_not_committed(
                            "sqlite_read_gate_deadline",
                            "read deadline exceeded while waiting for WAL reset gate",
                        ));
                    }
                }
            },
        };

        let waited_ns = u64::try_from(start_wait.elapsed().as_nanos()).unwrap_or(u64::MAX);
        self.counters
            .total_admission_wait_ns
            .fetch_add(waited_ns, Ordering::Relaxed);

        Ok((
            FastReaderGateGuard {
                coord: Arc::clone(self),
                reader_id,
                completed_cleanly: false,
                counted_timeout: false,
            },
            caller_deadline_tokio,
        ))
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
                biased;
                error = read_cancelled(budget) => return Err(error),
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
            biased;
            error = read_cancelled(budget) => return Err(error),
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
                biased;
                error = read_cancelled(budget) => Err(error),
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

        let disk_wal_bytes = self.observe_wal_file_bytes();
        let has_hook_frames = self.counters.has_wal_hook_frames.load(Ordering::Relaxed);
        let pre_wal_bytes = if has_hook_frames {
            self.counters.logical_wal_bytes.load(Ordering::Relaxed)
        } else {
            disk_wal_bytes
        };

        // 1. Check active backup WAL budgets first: if any backup exceeded `max_pinned_wal_bytes`,
        // signal abort and wait for it to close before resetting WAL!
        let has_pins = !self
            .gate
            .lock()
            .expect("wal gate mutex")
            .active_backups
            .is_empty();
        let observed = if has_pins {
            self.checkpoint_status("PRAGMA main.wal_checkpoint(NOOP)")
                .await
        } else {
            None
        };
        let mut aborted_any_backup = false;
        if let Some((0, log, backfilled)) = observed
            && log >= 0
            && backfilled >= 0
        {
            let mut st = self.gate.lock().expect("wal gate mutex");
            for pin in st.active_backups.values() {
                let Some(floor) = pin.baseline_frames.get() else {
                    continue;
                };
                let pinned = (log as u64)
                    .saturating_sub((*floor).max(backfilled as u64))
                    .saturating_mul(self.wal_frame_bytes);
                if pinned > pin.max_pinned_wal_bytes && !pin.abort_flag.swap(true, Ordering::SeqCst)
                {
                    pin.abort_notify.notify_waiters();
                    aborted_any_backup = true;
                }
            }
            if aborted_any_backup {
                st.last_backup_abort_reason = Some(format!(
                    "pinned WAL exceeded backup budget (log_frames={log}, backfilled_frames={backfilled})"
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

        let active_backups_empty = self
            .gate
            .lock()
            .expect("wal gate mutex")
            .active_backups
            .is_empty();

        let commits_since_reset = self.counters.commits_since_reset.load(Ordering::Acquire);
        // A RESTART keeps the physical WAL allocation for reuse. SQLx commits do not
        // report frames through the writer hook. Check the live WAL index before
        // using a large file as grounds for closing admission.
        let active_wal_bytes = if !has_hook_frames
            && disk_wal_bytes >= self.wal_soft_watermark_bytes
            && commits_since_reset > 0
        {
            match self
                .checkpoint_status("PRAGMA main.wal_checkpoint(NOOP)")
                .await
            {
                Some((0, frames, _)) => u64::try_from(frames)
                    .ok()
                    .map(|frames| frames.saturating_mul(self.wal_frame_bytes)),
                _ => None,
            }
        } else {
            Some(pre_wal_bytes)
        };
        let threshold_hit = commits_since_reset > 0
            && active_wal_bytes.is_some_and(|bytes| bytes >= self.wal_high_watermark_bytes);

        if active_backups_empty && (force_reset || threshold_hit) {
            self.run_bounded_wal_reset(inner, force_reset).await;
            return;
        }

        // 2. Otherwise run concurrent `PASSIVE` checkpoint during quiet ticks (or small test watermarks)
        // without issuing mid-burst `fsync(canonical.sqlite)` storms against active batch writes.
        let commits_pending = self.counters.commits_since_passive.load(Ordering::Acquire);
        let quiet_ns = self
            .now_elapsed_ns()
            .saturating_sub(self.counters.last_commit_elapsed_ns.load(Ordering::Relaxed));
        let writer_idle = quiet_ns >= 250_000_000
            && inner
                .writer_coord
                .get()
                .is_none_or(|w| !w.has_active_sqlite_ops());
        let unckpt_frames = self
            .counters
            .log_frames
            .load(Ordering::Relaxed)
            .saturating_sub(self.counters.checkpointed_frames.load(Ordering::Relaxed));
        let should_run_passive = (self.wal_soft_watermark_bytes <= 1024 * 1024
            && pre_wal_bytes >= 4096
            && commits_pending > 0)
            || (writer_idle && (commits_pending > 0 || unckpt_frames > 0) && pre_wal_bytes > 0);
        let passive_res = if should_run_passive {
            self.run_passive_checkpoint(pre_wal_bytes, false).await
        } else {
            None
        };
        if !active_backups_empty {
            return;
        }

        let passive_busy = match passive_res {
            Some((busy, _, _)) => busy != 0,
            None => false,
        };

        let needs_soft_reset = commits_since_reset > 0
            && active_wal_bytes.is_some_and(|bytes| bytes >= self.wal_soft_watermark_bytes)
            && (passive_busy || writer_idle);

        if needs_soft_reset {
            self.run_bounded_wal_reset(inner, false).await;
        }
    }

    async fn run_passive_checkpoint(
        &self,
        pre_wal_bytes: u64,
        force: bool,
    ) -> Option<(i64, i64, i64)> {
        if !force
            && self.counters.commits_since_passive.load(Ordering::Acquire) == 0
            && self.counters.last_passive_wal_bytes.load(Ordering::Relaxed) == pre_wal_bytes
            && self.counters.checkpointed_frames.load(Ordering::Relaxed)
                >= self.counters.log_frames.load(Ordering::Relaxed)
        {
            return None;
        }

        self.counters
            .commits_since_passive
            .store(0, Ordering::Release);
        let (busy, log_frames, ckpt_frames) = self
            .checkpoint_status("PRAGMA main.wal_checkpoint(PASSIVE)")
            .await?;
        self.counters
            .passive_checkpoints
            .fetch_add(1, Ordering::Relaxed);
        self.counters
            .last_passive_wal_bytes
            .store(pre_wal_bytes, Ordering::Relaxed);
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

    async fn checkpoint_status(&self, pragma: &'static str) -> Option<(i64, i64, i64)> {
        let conn = {
            let mut slot = self.passive_conn.lock().await;
            match slot.take() {
                Some(c) => c,
                None => {
                    match crate::dialect::sqlite::open_rusqlite_checkpoint_connection(&self.db_path)
                    {
                        Ok(c) => c,
                        Err(_) => return None,
                    }
                }
            }
        };

        let ckpt_join = tokio::task::spawn_blocking(move || {
            let res = conn.query_row(pragma, [], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            });
            (conn, res)
        })
        .await;

        let Ok((conn, ckpt_res)) = ckpt_join else {
            return None;
        };
        *self.passive_conn.lock().await = Some(conn);

        ckpt_res.ok()
    }

    async fn run_bounded_wal_reset(&self, inner: &Arc<CanonicalInner>, force_truncate: bool) {
        let Some(writer_coord) = inner.writer_coord.get() else {
            return;
        };
        let SqlDriverState::Sqlite { writer, .. } = &inner.sql else {
            return;
        };

        // Pre-backfill uncheckpointed WAL frames concurrently in up to 3 converging `PASSIVE` passes
        // BEFORE closing the reader gate or acquiring the exclusive writer safe point so `WriteBatchActor`
        // keeps committing during the bulk copy and the exclusive `RESTART`/`TRUNCATE` pause only flushes <= ~3 MiB!
        for _ in 0..3 {
            let pre_bytes = self.observe_wal_file_bytes();
            let Some((busy, log_f, ckpt_f)) = self.run_passive_checkpoint(pre_bytes, true).await
            else {
                break;
            };
            let live_frames = if self.counters.has_wal_hook_frames.load(Ordering::Relaxed) {
                self.counters.logical_wal_bytes.load(Ordering::Relaxed)
                    / self.wal_frame_bytes.max(1)
            } else {
                u64::try_from(log_f.max(0)).unwrap_or(0)
            };
            let ckpt_u64 = u64::try_from(ckpt_f.max(0)).unwrap_or(0);
            if busy == 0 && live_frames.saturating_sub(ckpt_u64) <= 768 {
                break;
            }
        }

        self.counters.reset_attempts.fetch_add(1, Ordering::Relaxed);
        let cycle_deadline = tokio::time::Instant::now() + self.wal_reset_cycle_deadline;

        // Close ordinary reader admission and ensure an RAII guard ALWAYS reopens it!
        self.close_reader_gate();
        let reopen_guard = GateReopenGuard {
            coord: self,
            closed_at: Instant::now(),
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

        // 2. Acquire writer safe point bounded by `cycle_deadline` so no new batch commits occur during reset.
        let Ok(safe_point) =
            tokio::time::timeout_at(cycle_deadline, writer_coord.acquire_safe_point()).await
        else {
            return;
        };

        // 3. Run bounded `RESTART` (preserving `journal_size_limit = 64MiB` pre-allocated blocks)
        // or `TRUNCATE` (when explicitly forced or using small test watermarks) on writer connection.
        let Ok(mut writer_guard) = tokio::time::timeout_at(cycle_deadline, writer.lock()).await
        else {
            drop(safe_point);
            return;
        };

        let use_truncate = force_truncate || self.wal_high_watermark_bytes <= 1024 * 1024;
        let ckpt_sql = if use_truncate {
            "PRAGMA wal_checkpoint(TRUNCATE)"
        } else {
            "PRAGMA wal_checkpoint(RESTART)"
        };
        let quiet_ns = self
            .now_elapsed_ns()
            .saturating_sub(self.counters.last_commit_elapsed_ns.load(Ordering::Relaxed));
        let burst_active =
            !use_truncate && (quiet_ns < 250_000_000 || writer_coord.has_active_sqlite_ops());
        let high_limit_i64 = i64::try_from(self.wal_high_watermark_bytes).unwrap_or(134_217_728);

        if let Some(pair) = writer_guard.as_mut() {
            let remaining = cycle_deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return;
            }
            let rem_ms = u64::try_from(remaining.as_millis().clamp(1, 250)).unwrap_or(250);

            let trunc_tuple = if let Some(rconn) = pair.rusqlite_conn.take() {
                #[cfg(test)]
                let io_delay_ms = self.checkpoint_io_delay_ms.load(Ordering::Relaxed);
                let join_res = tokio::task::spawn_blocking(move || {
                    let _ = rconn.busy_timeout(Duration::from_millis(rem_ms));
                    let target_journal_limit = if burst_active {
                        high_limit_i64.saturating_add(high_limit_i64 / 2)
                    } else {
                        crate::dialect::sqlite::SQLITE_JOURNAL_SIZE_LIMIT_BYTES
                    };
                    let _ = rconn.execute_batch(&format!(
                        "PRAGMA journal_size_limit = {target_journal_limit};"
                    ));
                    // SQLite's busy timeout limits lock waits. The OS can take longer
                    // to flush dirty pages, and the connection remains owned until it returns.
                    #[cfg(test)]
                    std::thread::sleep(Duration::from_millis(io_delay_ms));
                    let res = rconn.query_row(ckpt_sql, [], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    });
                    let _ = rconn.busy_timeout(Duration::from_secs(5));
                    (rconn, res.ok())
                })
                .await;
                match join_res {
                    Ok((rc, out)) => {
                        pair.rusqlite_conn = Some(rc);
                        out
                    }
                    Err(_) => None,
                }
            } else {
                let conn = &mut pair.sqlx_conn;
                let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
                    "PRAGMA busy_timeout = {rem_ms}"
                )))
                .execute(&mut *conn)
                .await;
                let trunc_res = sqlx::query(ckpt_sql).fetch_one(&mut *conn).await;
                let _ = sqlx::query("PRAGMA busy_timeout = 5000")
                    .execute(&mut *conn)
                    .await;
                trunc_res.ok().map(|row| {
                    (
                        row.get::<i64, _>(0),
                        row.get::<i64, _>(1),
                        row.get::<i64, _>(2),
                    )
                })
            };

            if let Some((busy, log_frames, ckpt_frames)) = trunc_tuple {
                self.counters.log_frames.store(
                    u64::try_from(log_frames.max(0)).unwrap_or(0),
                    Ordering::Relaxed,
                );
                self.counters.checkpointed_frames.store(
                    u64::try_from(ckpt_frames.max(0)).unwrap_or(0),
                    Ordering::Relaxed,
                );
                if busy == 0 {
                    let post_bytes = self.observe_wal_file_bytes();
                    self.counters.log_frames.store(0, Ordering::Relaxed);
                    self.counters
                        .checkpointed_frames
                        .store(0, Ordering::Relaxed);
                    self.counters.logical_wal_bytes.store(0, Ordering::Relaxed);
                    let next_passive_base =
                        if self.counters.has_wal_hook_frames.load(Ordering::Relaxed) {
                            0
                        } else {
                            post_bytes
                        };
                    self.counters
                        .last_passive_wal_bytes
                        .store(next_passive_base, Ordering::Relaxed);
                    self.counters
                        .commits_since_reset
                        .store(0, Ordering::Release);
                    self.counters
                        .reset_successes
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        drop(writer_guard);
        drop(safe_point);

        // Immediately reopen reader admission before filesystem stat!
        drop(reopen_guard);
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

        let _maint = self.maintenance_lock.lock().await;
        if let Some(conn) = self.passive_conn.lock().await.take() {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = conn.close();
            })
            .await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CanonicalConfig, CanonicalRuntime, SqlBackendConfig};
    use notarium_core::{epoch::DataRoot, ids::InstallationId};

    #[tokio::test]
    async fn cancellation_releases_sqlite_readers_waiting_for_gate_or_pool() {
        use notarium_core::{error::CommitEffect, ids::RequestId, ports::Cancellation};

        let mut id = [0; 16];
        getrandom::fill(&mut id).unwrap();
        let path = std::env::temp_dir().join(format!("notarium-read-cancel-{}", hex::encode(id)));
        fs::create_dir_all(&path).unwrap();
        let mut config =
            CanonicalConfig::local_default(InstallationId::from_bytes(id), DataRoot::new(&path));
        let SqlBackendConfig::Sqlite { read_pool_size, .. } = &mut config.sql else {
            unreachable!()
        };
        *read_pool_size = 1;
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        {
            let wal = store.inner.wal_coord.get().unwrap();
            let SqlDriverState::Sqlite {
                read_pool,
                fast_read_pool,
                ..
            } = &store.inner.sql
            else {
                unreachable!()
            };
            let _maintenance = wal.maintenance_lock.lock().await;
            let sqlx_slot = read_pool.acquire().await.unwrap();
            let native_slots = fast_read_pool.hold_idle_slots();
            for closed in [true, false] {
                if closed {
                    wal.close_reader_gate();
                }
                let budget = CallBudget {
                    request: RequestId::from_bytes(id),
                    cancellation: Cancellation::default(),
                    remaining: Duration::from_secs(30),
                };
                let sqlx = wal.with_ordinary_read_tx(read_pool, Some(&budget), |_| {
                    Box::pin(async { Ok(()) })
                });
                let native = fast_read_pool.with_read_conn(wal, Some(&budget), |_| Ok(()));
                tokio::pin!(sqlx, native);
                assert!(futures_util::poll!(sqlx.as_mut()).is_pending());
                assert!(futures_util::poll!(native.as_mut()).is_pending());
                assert_eq!(wal.telemetry().active_readers, if closed { 0 } else { 2 });
                budget.cancellation.cancel();
                let results = tokio::time::timeout(Duration::from_secs(1), async {
                    tokio::join!(sqlx, native)
                })
                .await
                .expect("cancellation must not wait for a reader slot or reopen");
                for result in [results.0, results.1] {
                    assert!(
                        matches!(result, Err(PortError::Cancelled(err)) if err.effect() == CommitEffect::NotCommitted)
                    );
                }
                assert_eq!(wal.telemetry().active_readers, 0);
                if closed {
                    wal.reopen_reader_gate();
                }
            }
            drop((sqlx_slot, native_slots));
            wal.with_ordinary_read_tx(read_pool, None, |_| Box::pin(async { Ok(()) }))
                .await
                .unwrap();
            fast_read_pool
                .with_read_conn(wal, None, |_| Ok(()))
                .await
                .unwrap();
            assert_eq!(wal.telemetry().active_readers, 0);
        }
        runtime.shutdown().await.unwrap();
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn checkpoint_io_overrun_counts_actual_reader_gate_dwell() {
        let mut id = [0; 16];
        getrandom::fill(&mut id).unwrap();
        let path = std::env::temp_dir().join(format!("notarium-wal-dwell-{}", hex::encode(id)));
        fs::create_dir_all(&path).unwrap();
        let mut config =
            CanonicalConfig::local_default(InstallationId::from_bytes(id), DataRoot::new(&path));
        let SqlBackendConfig::Sqlite {
            wal_reset_cycle_deadline,
            ..
        } = &mut config.sql
        else {
            unreachable!()
        };
        *wal_reset_cycle_deadline = Duration::from_millis(20);
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let wal = store.inner.wal_coord.get().unwrap();
        wal.checkpoint_io_delay_ms.store(75, Ordering::Relaxed);
        wal.run_maintenance_tick(&store.inner, true).await;
        let snapshot = wal.telemetry();
        assert!(snapshot.max_reset_reader_gate_ns >= 75_000_000);
        assert!(snapshot.reset_gate_overruns >= 1);
        assert!(wal.gate.lock().unwrap().open);
        runtime.shutdown().await.unwrap();
        fs::remove_dir_all(path).unwrap();
    }
}
