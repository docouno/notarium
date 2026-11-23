use super::{LexicalError, LexicalIndex};
use notarium_core::ports::Cancellation;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, Weak},
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
struct ReaderSlots {
    entries: HashMap<PathBuf, ReaderEntry>,
    opening: HashSet<PathBuf>,
    reserved: usize,
}

#[derive(Default)]
pub struct ReaderCache {
    slots: Mutex<ReaderSlots>,
    changed: Condvar,
}

struct ReaderAdmission<'a> {
    cache: &'a ReaderCache,
    path: &'a Path,
    reserved: bool,
}

impl Drop for ReaderAdmission<'_> {
    fn drop(&mut self) {
        let mut slots = self.cache.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.opening.remove(self.path);
        if self.reserved {
            slots.reserved -= 1;
        }
        self.cache.changed.notify_all();
    }
}

impl ReaderAdmission<'_> {
    fn reserve(&mut self) -> Result<(), LexicalError> {
        let mut tried = HashSet::new();
        loop {
            let mut slots = self
                .cache
                .slots
                .lock()
                .map_err(|_| LexicalError::ReaderUnavailable)?;
            if slots.entries.len() + slots.reserved < MAX_READERS {
                slots.reserved += 1;
                self.reserved = true;
                return Ok(());
            }
            let oldest = slots
                .entries
                .iter()
                .filter(|(_, entry)| Arc::strong_count(&entry.index) == 1)
                .min_by_key(|(_, entry)| entry.last_use)
                .map(|(path, _)| path.clone());
            if let Some(oldest) = oldest {
                let evicted = slots.entries.remove(&oldest);
                slots.reserved += 1;
                self.reserved = true;
                drop(slots);
                drop(evicted);
                return Ok(());
            }
            let candidates: Vec<_> = slots
                .entries
                .iter()
                .filter(|(path, _)| !tried.contains(*path))
                .filter_map(|(path, entry)| {
                    Some((
                        path.clone(),
                        entry.last_use,
                        entry.owner.as_ref()?.upgrade()?,
                    ))
                })
                .collect();
            drop(slots);
            let (_, path, owner) = candidates
                .into_iter()
                .filter_map(|(path, last_use, owner)| {
                    let activity = owner.idle_last_activity(&path)?;
                    Some((last_use.max(activity), path, owner))
                })
                .min_by_key(|(last_use, _, _)| *last_use)
                .ok_or(LexicalError::ReaderUnavailable)?;
            owner.evict_if_idle(&path);
            tried.insert(path);
        }
    }
}

impl ReaderCache {
    pub fn open(&self, path: &Path) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.open_or_create(path, None, false)
    }

    pub fn create(&self, path: &Path) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.open_or_create(path, None, true)
    }

    pub(crate) fn open_owned(
        &self,
        path: &Path,
        owner: Weak<dyn IdleReaderOwner>,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.open_or_create(path, Some(owner), false)
    }

    pub(crate) fn create_owned(
        &self,
        path: &Path,
        owner: Weak<dyn IdleReaderOwner>,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.open_or_create(path, Some(owner), true)
    }

    pub(crate) fn get_owned(
        &self,
        path: &Path,
        owner: Weak<dyn IdleReaderOwner>,
    ) -> Result<Option<Arc<LexicalIndex>>, LexicalError> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| LexicalError::ReaderUnavailable)?;
        Ok(Self::cached(&mut slots, path, Some(owner)))
    }

    fn cached(
        slots: &mut ReaderSlots,
        path: &Path,
        owner: Option<Weak<dyn IdleReaderOwner>>,
    ) -> Option<Arc<LexicalIndex>> {
        let entry = slots.entries.get_mut(path)?;
        entry.last_use = Instant::now();
        if owner.is_some() {
            entry.owner = owner;
        }
        Some(entry.index.clone())
    }

    fn open_or_create(
        &self,
        path: &Path,
        owner: Option<Weak<dyn IdleReaderOwner>>,
        create: bool,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        self.acquire(path, owner, |admission| {
            if create {
                admission.reserve()?;
                LexicalIndex::create(path)
            } else {
                // Validate the index and schema before sacrificing a cached reader.
                let (index, fields) = LexicalIndex::open_index(path)?;
                admission.reserve()?;
                LexicalIndex::from_index(path.to_owned(), index, fields)
            }
        })
    }

    fn acquire(
        &self,
        path: &Path,
        owner: Option<Weak<dyn IdleReaderOwner>>,
        open: impl FnOnce(&mut ReaderAdmission<'_>) -> Result<LexicalIndex, LexicalError>,
    ) -> Result<Arc<LexicalIndex>, LexicalError> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| LexicalError::ReaderUnavailable)?;
        while slots.opening.contains(path) {
            slots = self
                .changed
                .wait(slots)
                .map_err(|_| LexicalError::ReaderUnavailable)?;
        }
        if let Some(index) = Self::cached(&mut slots, path, owner.clone()) {
            return Ok(index);
        }
        slots.opening.insert(path.to_owned());
        drop(slots);
        let mut admission = ReaderAdmission {
            cache: self,
            path,
            reserved: false,
        };
        let index = Arc::new(open(&mut admission)?);
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| LexicalError::ReaderUnavailable)?;
        debug_assert!(admission.reserved);
        slots.reserved -= 1;
        admission.reserved = false;
        slots.entries.insert(
            path.to_owned(),
            ReaderEntry {
                index: index.clone(),
                last_use: Instant::now(),
                owner,
            },
        );
        drop(slots);
        Ok(index)
    }

    /// Return whether the generation can be removed. Existing users keep it pinned.
    pub fn release(&self, path: &Path) -> Result<bool, LexicalError> {
        let (removed, _release_slot) = {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| LexicalError::ReaderUnavailable)?;
            if slots.opening.contains(path)
                || slots
                    .entries
                    .get(path)
                    .is_some_and(|entry| Arc::strong_count(&entry.index) > 1)
            {
                return Ok(false);
            }
            let Some(entry) = slots.entries.remove(path) else {
                return Ok(true);
            };
            // The physical reader still occupies its slot while its handles close.
            slots.opening.insert(path.to_owned());
            slots.reserved += 1;
            (
                entry,
                ReaderAdmission {
                    cache: self,
                    path,
                    reserved: true,
                },
            )
        };
        drop(removed);
        Ok(true)
    }

    pub(crate) fn release_all(&self) {
        let removed = {
            let Ok(mut slots) = self.slots.lock() else {
                return;
            };
            std::mem::take(&mut slots.entries)
        };
        drop(removed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_flight_reader_occupies_the_last_slot_and_failure_returns_it() {
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy).unwrap();
        let root = std::env::temp_dir().join(format!("reader-admission-{}", hex::encode(entropy)));
        std::fs::create_dir(&root).unwrap();
        let cache = ReaderCache::default();
        let mut pinned = Vec::new();
        for index in 1..MAX_READERS {
            let path = root.join(index.to_string());
            std::fs::create_dir(&path).unwrap();
            pinned.push(cache.create(&path).unwrap());
        }
        let last = root.join("last");
        let competing = root.join("competing");
        std::fs::create_dir(&last).unwrap();
        std::fs::create_dir(&competing).unwrap();
        std::thread::scope(|scope| {
            let (ready, opened) = std::sync::mpsc::channel();
            let (finish, wait) = std::sync::mpsc::channel();
            let cache = &cache;
            let attempt = scope.spawn(move || {
                cache.acquire(&last, None, |admission| {
                    admission.reserve()?;
                    let _index = LexicalIndex::create(&last)?;
                    ready.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(5)).unwrap();
                    Err(LexicalError::CorruptIndex)
                })
            });
            opened.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(matches!(
                cache.create(&competing),
                Err(LexicalError::ReaderUnavailable)
            ));
            assert!(!competing.join("meta.json").exists());
            finish.send(()).unwrap();
            assert!(matches!(
                attempt.join().unwrap(),
                Err(LexicalError::CorruptIndex)
            ));
        });
        assert!(cache.create(&competing).is_ok());
        drop(pinned);
        drop(cache);
        std::fs::remove_dir_all(root).unwrap();
    }
}
