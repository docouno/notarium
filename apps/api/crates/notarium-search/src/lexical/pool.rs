use super::{LexicalError, LexicalIndex};
use notarium_core::ports::Cancellation;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tantivy::{
    Index, IndexWriter,
    indexer::{LogMergePolicy, MergePolicy},
};

const IDLE: Duration = Duration::from_secs(5);
const REAP_INTERVAL: Duration = Duration::from_secs(1);
pub(super) const WRITER_BUDGET: usize = 16 * 1024 * 1024;
const MAX_ACTIVE_WRITERS: usize = 4;
const MAX_READERS: usize = 32;

pub(super) fn default_merge_policy() -> Box<dyn MergePolicy> {
    let mut policy = LogMergePolicy::default();
    policy.set_min_num_segments(4);
    policy.set_max_docs_before_merge(100_000);
    Box::new(policy)
}

struct Lease {
    writer: Option<IndexWriter>,
    last_used: Instant,
    staged_guards: usize,
    commit_gen: u64,
}

impl Lease {
    fn is_staged(&self) -> bool {
        self.staged_guards > 0
    }
}

type Entry = Arc<Mutex<Lease>>;

/// Keeps a staged seed writer pinned until `commit_seed` completes. Dropping
/// all active guards before commit unpins the slot and discards the uncommitted
/// writer outside the pool mutex.
#[must_use = "hold SeedLease until commit_seed completes"]
pub struct SeedLease {
    entry: Weak<Mutex<Lease>>,
    commit_gen: u64,
}

impl SeedLease {
    pub(super) fn inert() -> Self {
        Self {
            entry: Weak::new(),
            commit_gen: 0,
        }
    }
}

impl Drop for SeedLease {
    fn drop(&mut self) {
        let Some(entry) = self.entry.upgrade() else {
            return;
        };
        let uncommitted = {
            let Ok(mut lease) = entry.lock() else {
                return;
            };
            if lease.commit_gen != self.commit_gen {
                return;
            }
            lease.staged_guards = lease.staged_guards.saturating_sub(1);
            if lease.staged_guards == 0 {
                lease.last_used = Instant::now();
                lease.writer.take()
            } else {
                None
            }
        };
        drop(uncommitted);
    }
}

#[derive(Clone, Default)]
pub struct WriterPool {
    slots: Arc<Mutex<WriterSlots>>,
}

#[derive(Default)]
struct WriterSlots {
    leases: HashMap<PathBuf, Entry>,
}

impl WriterSlots {
    fn admit(&mut self) -> Result<Option<Entry>, LexicalError> {
        if self.leases.len() >= MAX_ACTIVE_WRITERS {
            let oldest = self
                .leases
                .iter()
                .filter(|(_, entry)| Arc::strong_count(entry) == 1)
                .filter_map(|(path, lease)| {
                    let lease = lease.try_lock().ok()?;
                    (!lease.is_staged()).then_some((path, lease.last_used))
                })
                .min_by_key(|(_, last_used)| *last_used)
                .map(|(path, _)| path.clone())
                .ok_or(LexicalError::WriterUnavailable)?;
            return Ok(self.leases.remove(&oldest));
        }
        Ok(None)
    }
}

impl WriterPool {
    fn checkout(&self, path: &Path) -> Result<Entry, LexicalError> {
        let (lease, evicted) = {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| LexicalError::WriterUnavailable)?;
            if let Some(lease) = slots.leases.get(path) {
                return Ok(lease.clone());
            }
            let evicted = slots.admit()?;
            let lease = Arc::new(Mutex::new(Lease {
                writer: None,
                last_used: Instant::now(),
                staged_guards: 0,
                commit_gen: 0,
            }));
            slots.leases.insert(path.to_owned(), lease.clone());
            (lease, evicted)
        };
        drop(evicted);
        Ok(lease)
    }

    /// Extend an already-active staged seed across an empty page without
    /// allocating a writer for an otherwise empty generation.
    pub(super) fn pin_existing_stage(&self, path: &Path) -> Result<SeedLease, LexicalError> {
        let entry = {
            let slots = self
                .slots
                .lock()
                .map_err(|_| LexicalError::WriterUnavailable)?;
            slots.leases.get(path).cloned()
        };
        let Some(entry) = entry else {
            return Ok(SeedLease::inert());
        };
        let mut lease = entry.lock().map_err(|_| LexicalError::WriterUnavailable)?;
        if !lease.is_staged() {
            return Ok(SeedLease::inert());
        }
        lease.staged_guards += 1;
        lease.last_used = Instant::now();
        Ok(SeedLease {
            entry: Arc::downgrade(&entry),
            commit_gen: lease.commit_gen,
        })
    }

    pub(super) fn with_stage_writer(
        &self,
        path: &Path,
        index: &Index,
        operation: impl FnOnce(&mut IndexWriter) -> Result<(), LexicalError>,
    ) -> Result<SeedLease, LexicalError> {
        let entry = self.checkout(path)?;
        let (result, failed) = {
            let mut lease = entry.lock().map_err(|_| LexicalError::WriterUnavailable)?;
            if lease.writer.is_none() {
                let writer = index.writer_with_num_threads(1, WRITER_BUDGET)?;
                writer.set_merge_policy(default_merge_policy());
                lease.writer = Some(writer);
            }
            let outcome = operation(lease.writer.as_mut().expect("writer admitted"));
            lease.last_used = Instant::now();
            match outcome {
                Ok(()) => {
                    lease.staged_guards += 1;
                    (
                        Ok(SeedLease {
                            entry: Arc::downgrade(&entry),
                            commit_gen: lease.commit_gen,
                        }),
                        None,
                    )
                }
                Err(error) => (Err(error), lease.writer.take()),
            }
        };
        drop(failed);
        result
    }

    pub(super) fn with_writer<T>(
        &self,
        path: &Path,
        index: &Index,
        clear_staged: bool,
        operation: impl FnOnce(&mut IndexWriter) -> Result<T, LexicalError>,
    ) -> Result<T, LexicalError> {
        let entry = self.checkout(path)?;
        let (result, failed) = {
            let mut lease = entry.lock().map_err(|_| LexicalError::WriterUnavailable)?;
            if lease.writer.is_none() {
                let writer = index.writer_with_num_threads(1, WRITER_BUDGET)?;
                writer.set_merge_policy(default_merge_policy());
                lease.writer = Some(writer);
            }
            let outcome = operation(lease.writer.as_mut().expect("writer admitted"));
            lease.last_used = Instant::now();
            match outcome {
                Ok(value) => {
                    if clear_staged {
                        lease.staged_guards = 0;
                        lease.commit_gen = lease.commit_gen.wrapping_add(1);
                    }
                    (Ok(value), None)
                }
                Err(error) => (Err(error), lease.writer.take()),
            }
        };
        drop(failed);
        result
    }

    pub fn open_leases(&self) -> Result<usize, LexicalError> {
        let slots = self
            .slots
            .lock()
            .map_err(|_| LexicalError::WriterUnavailable)?;
        Ok(slots.leases.len())
    }

    pub fn release(&self, path: &Path) -> Result<(), LexicalError> {
        let removed = {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| LexicalError::WriterUnavailable)?;
            if slots
                .leases
                .get(path)
                .is_some_and(|lease| Arc::strong_count(lease) > 1)
            {
                return Err(LexicalError::WriterUnavailable);
            }
            slots.leases.remove(path)
        };
        drop(removed);
        Ok(())
    }

    pub(crate) fn release_all(&self) {
        let removed = {
            let Ok(mut slots) = self.slots.lock() else {
                return;
            };
            std::mem::take(&mut slots.leases)
        };
        drop(removed);
    }

    fn take_idle(&self) -> Result<Vec<Entry>, LexicalError> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| LexicalError::WriterUnavailable)?;
        let expired_keys: Vec<_> = slots
            .leases
            .iter()
            .filter(|(_, entry)| {
                Arc::strong_count(entry) == 1
                    && entry
                        .try_lock()
                        .is_ok_and(|lease| !lease.is_staged() && lease.last_used.elapsed() >= IDLE)
            })
            .map(|(path, _)| path.clone())
            .collect();
        let mut expired = Vec::with_capacity(expired_keys.len());
        for path in expired_keys {
            if let Some(entry) = slots.leases.remove(&path) {
                expired.push(entry);
            }
        }
        Ok(expired)
    }

    /// Own this future alongside the indexing worker and cancel it during drain.
    pub async fn evict_idle_until(&self, cancellation: Cancellation) -> Result<(), LexicalError> {
        let start = tokio::time::Instant::now() + REAP_INTERVAL;
        let mut interval = tokio::time::interval_at(start, REAP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return Ok(()),
                _ = interval.tick() => {
                    let expired = self.take_idle()?;
                    if !expired.is_empty() {
                        tokio::task::spawn_blocking(move || drop(expired))
                            .await
                            .map_err(|_| LexicalError::WriterUnavailable)?;
                    }
                }
            }
        }
    }
}

/// Callback allowing `ReaderCache` to inspect and release idle published
/// snapshots on demand without breaking the hard `MAX_READERS` cap or holding
/// the cache mutex across owner locks.
pub(crate) trait IdleReaderOwner: Send + Sync {
    /// Return the owner's last activity instant when `path` is currently idle
    /// and evictable, or `None` when busy/pinned/detached.
    fn idle_last_activity(&self, path: &Path) -> Option<Instant>;
    fn evict_if_idle(&self, path: &Path);
}

struct ReaderEntry {
    index: Arc<LexicalIndex>,
    last_use: Instant,
    owner: Option<Weak<dyn IdleReaderOwner>>,
}

#[derive(Default)]
pub struct ReaderCache {
    indexes: Mutex<HashMap<PathBuf, ReaderEntry>>,
}

impl ReaderCache {
    pub fn open(&self, path: &Path) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.acquire(path, None, LexicalIndex::open)
    }

    pub fn create(&self, path: &Path) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.acquire(path, None, LexicalIndex::create)
    }

    pub(crate) fn open_owned(
        &self,
        path: &Path,
        owner: Weak<dyn IdleReaderOwner>,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.acquire(path, Some(owner), LexicalIndex::open)
    }

    pub(crate) fn create_owned(
        &self,
        path: &Path,
        owner: Weak<dyn IdleReaderOwner>,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.acquire(path, Some(owner), LexicalIndex::create)
    }

    /// Return a currently cached reader without opening from disk, refreshing
    /// its recency and owner registration under the cache mutex.
    pub(crate) fn get_owned(
        &self,
        path: &Path,
        owner: Weak<dyn IdleReaderOwner>,
    ) -> Result<Option<Arc<LexicalIndex>>, LexicalError> {
        let mut indexes = self
            .indexes
            .lock()
            .map_err(|_| LexicalError::ReaderUnavailable)?;
        let Some(entry) = indexes.get_mut(path) else {
            return Ok(None);
        };
        entry.last_use = Instant::now();
        entry.owner = Some(owner);
        Ok(Some(entry.index.clone()))
    }

    fn acquire(
        &self,
        path: &Path,
        mut owner: Option<Weak<dyn IdleReaderOwner>>,
        admit: impl FnOnce(&Path) -> Result<LexicalIndex, LexicalError>,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        let precheck_candidates = {
            let mut indexes = self
                .indexes
                .lock()
                .map_err(|_| LexicalError::ReaderUnavailable)?;
            if let Some(entry) = indexes.get_mut(path) {
                entry.last_use = Instant::now();
                if owner.is_some() {
                    entry.owner = owner;
                }
                return Ok(entry.index.clone());
            }
            // Reject full pinned caches before opening or creating index files
            // and never evict a valid reader until `admit` succeeds.
            if indexes.len() >= MAX_READERS
                && !indexes
                    .values()
                    .any(|entry| Arc::strong_count(&entry.index) == 1)
            {
                Some(
                    indexes
                        .iter()
                        .filter_map(|(entry_path, entry)| {
                            let candidate = entry.owner.as_ref()?.upgrade()?;
                            Some((entry_path.clone(), candidate))
                        })
                        .collect::<Vec<_>>(),
                )
            } else {
                None
            }
        };
        if let Some(candidates) = precheck_candidates
            && !candidates
                .iter()
                .any(|(entry_path, candidate)| candidate.idle_last_activity(entry_path).is_some())
        {
            return Err(LexicalError::ReaderUnavailable);
        }
        let mut opened = Some(Arc::new(admit(path)?));
        let mut tried = HashSet::new();
        loop {
            enum Action {
                Done(
                    Result<Arc<LexicalIndex>, LexicalError>,
                    Option<Arc<LexicalIndex>>,
                ),
                Evict(Vec<(PathBuf, Instant, Arc<dyn IdleReaderOwner>)>),
            }
            let action = {
                let mut indexes = self
                    .indexes
                    .lock()
                    .map_err(|_| LexicalError::ReaderUnavailable)?;
                if let Some(entry) = indexes.get_mut(path) {
                    entry.last_use = Instant::now();
                    if owner.is_some() {
                        entry.owner = owner.take();
                    }
                    Action::Done(Ok(entry.index.clone()), opened.take())
                } else if indexes.len() >= MAX_READERS {
                    let oldest = indexes
                        .iter()
                        .filter(|(_, entry)| Arc::strong_count(&entry.index) == 1)
                        .min_by_key(|(_, entry)| entry.last_use)
                        .map(|(entry_path, _)| entry_path.clone());
                    match oldest {
                        Some(oldest) => {
                            let evicted = indexes.remove(&oldest).map(|entry| entry.index);
                            let admitted = opened.take().expect("opened lexical index");
                            indexes.insert(
                                path.to_owned(),
                                ReaderEntry {
                                    index: admitted.clone(),
                                    last_use: Instant::now(),
                                    owner: owner.take(),
                                },
                            );
                            Action::Done(Ok(admitted), evicted)
                        }
                        None if tried.len() >= MAX_READERS => {
                            Action::Done(Err(LexicalError::ReaderUnavailable), opened.take())
                        }
                        None => {
                            let candidates: Vec<_> = indexes
                                .iter()
                                .filter(|(entry_path, _)| !tried.contains(*entry_path))
                                .filter_map(|(entry_path, entry)| {
                                    let candidate = entry.owner.as_ref()?.upgrade()?;
                                    Some((entry_path.clone(), entry.last_use, candidate))
                                })
                                .collect();
                            if candidates.is_empty() {
                                Action::Done(Err(LexicalError::ReaderUnavailable), opened.take())
                            } else {
                                Action::Evict(candidates)
                            }
                        }
                    }
                } else {
                    let admitted = opened.take().expect("opened lexical index");
                    indexes.insert(
                        path.to_owned(),
                        ReaderEntry {
                            index: admitted.clone(),
                            last_use: Instant::now(),
                            owner: owner.take(),
                        },
                    );
                    Action::Done(Ok(admitted), None)
                }
            };
            match action {
                Action::Done(result, dropped) => {
                    drop(dropped);
                    return result;
                }
                Action::Evict(candidates) => {
                    let victim = candidates
                        .into_iter()
                        .filter_map(|(entry_path, entry_last_use, candidate)| {
                            let owner_last_use = candidate.idle_last_activity(&entry_path)?;
                            Some((entry_last_use.max(owner_last_use), entry_path, candidate))
                        })
                        .min_by_key(|(effective_last_use, _, _)| *effective_last_use);
                    let Some((_, entry_path, candidate)) = victim else {
                        drop(opened.take());
                        return Err(LexicalError::ReaderUnavailable);
                    };
                    tried.insert(entry_path.clone());
                    candidate.evict_if_idle(&entry_path);
                }
            }
        }
    }

    /// Return whether the generation can be removed. Existing users keep it pinned.
    pub fn release(&self, path: &Path) -> Result<bool, LexicalError> {
        let removed = {
            let mut indexes = self
                .indexes
                .lock()
                .map_err(|_| LexicalError::ReaderUnavailable)?;
            if indexes
                .get(path)
                .is_some_and(|entry| Arc::strong_count(&entry.index) > 1)
            {
                return Ok(false);
            }
            indexes.remove(path).map(|entry| entry.index)
        };
        drop(removed);
        Ok(true)
    }

    pub(crate) fn release_all(&self) {
        let removed = {
            let Ok(mut indexes) = self.indexes.lock() else {
                return;
            };
            std::mem::take(&mut *indexes)
        };
        drop(removed);
    }
}
