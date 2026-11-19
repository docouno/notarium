use super::{LexicalError, LexicalIndex};
use notarium_core::ports::Cancellation;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tantivy::{Index, IndexWriter, indexer::LogMergePolicy};

const IDLE: Duration = Duration::from_secs(5);
pub(super) const WRITER_BUDGET: usize = 16 * 1024 * 1024;
const MAX_ACTIVE_WRITERS: usize = 4;
const MAX_READERS: usize = 32;

struct Lease {
    writer: Option<IndexWriter>,
    last_used: Instant,
    staged: bool,
}

type Entry = Arc<Mutex<Lease>>;

#[derive(Clone, Default)]
pub struct WriterPool {
    leases: Arc<Mutex<HashMap<PathBuf, Entry>>>,
}

impl WriterPool {
    fn checkout(&self, path: &Path) -> Result<Entry, LexicalError> {
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| LexicalError::WriterUnavailable)?;
        if let Some(lease) = leases.get(path) {
            return Ok(lease.clone());
        }
        if leases.len() >= MAX_ACTIVE_WRITERS {
            let oldest = leases
                .iter()
                .filter(|(_, entry)| Arc::strong_count(entry) == 1)
                .filter_map(|(path, lease)| {
                    let lease = lease.lock().ok()?;
                    (!lease.staged).then_some((path, lease.last_used))
                })
                .min_by_key(|(_, last_used)| *last_used)
                .map(|(path, _)| path.clone())
                .ok_or(LexicalError::WriterUnavailable)?;
            leases.remove(&oldest);
        }
        let lease = Arc::new(Mutex::new(Lease {
            writer: None,
            last_used: Instant::now(),
            staged: false,
        }));
        leases.insert(path.to_owned(), lease.clone());
        Ok(lease)
    }

    pub(super) fn with_writer<T>(
        &self,
        path: &Path,
        index: &Index,
        staged: bool,
        operation: impl FnOnce(&mut IndexWriter) -> Result<T, LexicalError>,
    ) -> Result<T, LexicalError> {
        let entry = self.checkout(path)?;
        let mut lease = entry.lock().map_err(|_| LexicalError::WriterUnavailable)?;
        if lease.writer.is_none() {
            let writer = index.writer_with_num_threads(1, WRITER_BUDGET)?;
            let mut policy = LogMergePolicy::default();
            policy.set_min_num_segments(4);
            policy.set_max_docs_before_merge(100_000);
            writer.set_merge_policy(Box::new(policy));
            lease.writer = Some(writer);
        }
        let result = operation(lease.writer.as_mut().expect("writer admitted"));
        lease.last_used = Instant::now();
        lease.staged = result.is_ok() && staged;
        if result.is_err() {
            lease.writer.take();
        }
        result
    }

    pub fn open_leases(&self) -> Result<usize, LexicalError> {
        Ok(self
            .leases
            .lock()
            .map_err(|_| LexicalError::WriterUnavailable)?
            .len())
    }

    pub fn release(&self, path: &Path) -> Result<(), LexicalError> {
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| LexicalError::WriterUnavailable)?;
        if leases
            .get(path)
            .is_some_and(|lease| Arc::strong_count(lease) > 1)
        {
            return Err(LexicalError::WriterUnavailable);
        }
        leases.remove(path);
        Ok(())
    }

    fn reap_idle(&self) -> Result<(), LexicalError> {
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| LexicalError::WriterUnavailable)?;
        leases.retain(|_, entry| {
            Arc::strong_count(entry) > 1
                || entry
                    .lock()
                    .is_ok_and(|lease| lease.staged || lease.last_used.elapsed() < IDLE)
        });
        Ok(())
    }

    /// Own this future alongside the indexing worker and cancel it during drain.
    pub async fn evict_idle_until(&self, cancellation: Cancellation) -> Result<(), LexicalError> {
        let mut interval = tokio::time::interval(Duration::from_millis(200));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return Ok(()),
                _ = interval.tick() => {
                    let pool = self.clone();
                    tokio::task::spawn_blocking(move || pool.reap_idle()).await
                        .map_err(|_| LexicalError::WriterUnavailable)??;
                }
            }
        }
    }
}

#[derive(Default)]
pub struct ReaderCache {
    indexes: Mutex<HashMap<PathBuf, (Arc<LexicalIndex>, Instant)>>,
}

impl ReaderCache {
    pub fn open(&self, path: &Path) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.acquire(path, LexicalIndex::open)
    }

    pub fn create(&self, path: &Path) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.acquire(path, LexicalIndex::create)
    }

    fn acquire(
        &self,
        path: &Path,
        admit: impl FnOnce(&Path) -> Result<LexicalIndex, LexicalError>,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        let mut indexes = self
            .indexes
            .lock()
            .map_err(|_| LexicalError::ReaderUnavailable)?;
        if let Some((index, last_use)) = indexes.get_mut(path) {
            *last_use = Instant::now();
            return Ok(index.clone());
        }
        if indexes.len() >= MAX_READERS {
            let oldest = indexes
                .iter()
                .filter(|(_, (index, _))| Arc::strong_count(index) == 1)
                .min_by_key(|(_, (_, last_use))| *last_use)
                .map(|(path, _)| path.clone())
                .ok_or(LexicalError::ReaderUnavailable)?;
            indexes.remove(&oldest);
        }
        let index = Arc::new(admit(path)?);
        indexes.insert(path.to_owned(), (index.clone(), Instant::now()));
        Ok(index)
    }

    /// Return whether the generation can be removed. Existing users keep it pinned.
    pub fn release(&self, path: &Path) -> Result<bool, LexicalError> {
        let mut indexes = self
            .indexes
            .lock()
            .map_err(|_| LexicalError::ReaderUnavailable)?;
        if indexes
            .get(path)
            .is_some_and(|(index, _)| Arc::strong_count(index) > 1)
        {
            return Ok(false);
        }
        indexes.remove(path);
        Ok(true)
    }
}
