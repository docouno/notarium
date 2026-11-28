//! Local SQLite has a single store owner. Space pins order disclosure with
//! changes to its sources without holding the database writer across network I/O.
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex, Weak},
};

use notarium_core::ids::SpaceId;
use tokio::sync::{Mutex as AsyncMutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

#[derive(Default)]
pub(crate) struct DisclosureLocks {
    spaces: Mutex<HashMap<SpaceId, Weak<SpaceLock>>>,
    whole_store: Arc<RwLock<()>>,
}

#[derive(Default)]
struct SpaceLock {
    gate: Arc<RwLock<()>>,
    // An admitted batch shares one writer guard. Serializing admission stops
    // new mutations joining an old batch once a disclosure is waiting.
    batch: AsyncMutex<Weak<OwnedRwLockWriteGuard<()>>>,
}

pub(crate) struct SpaceMutation {
    _batch: Arc<OwnedRwLockWriteGuard<()>>,
    _space: Arc<SpaceLock>,
}

pub(crate) struct DisclosurePin {
    _spaces: Vec<(OwnedRwLockReadGuard<()>, Arc<SpaceLock>)>,
    _store: OwnedRwLockReadGuard<()>,
}

impl DisclosureLocks {
    fn space(&self, id: &SpaceId) -> Arc<SpaceLock> {
        let mut locks = self.spaces.lock().expect("SQLite disclosure locks");
        if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
            return lock;
        }
        if locks.len() == locks.capacity() {
            locks.retain(|_, lock| lock.strong_count() > 0);
        }
        let lock = Arc::new(SpaceLock::default());
        locks.insert(id.clone(), Arc::downgrade(&lock));
        lock
    }

    pub(crate) async fn mutation(&self, id: &SpaceId) -> SpaceMutation {
        let space = self.space(id);
        let mut admission = space.batch.lock().await;
        let batch = match admission.upgrade() {
            Some(batch) => batch,
            None => {
                let batch = Arc::new(space.gate.clone().write_owned().await);
                *admission = Arc::downgrade(&batch);
                batch
            }
        };
        drop(admission);
        SpaceMutation {
            _batch: batch,
            _space: space,
        }
    }

    pub(crate) async fn unscoped_mutation(&self) -> OwnedRwLockWriteGuard<()> {
        self.whole_store.clone().write_owned().await
    }

    pub(crate) async fn pin(&self, ids: &BTreeSet<SpaceId>) -> DisclosurePin {
        let mut spaces = Vec::with_capacity(ids.len());
        for id in ids {
            let space = self.space(id);
            let admission = space.batch.lock().await;
            let guard = space.gate.clone().read_owned().await;
            drop(admission);
            spaces.push((guard, space));
        }
        DisclosurePin {
            _spaces: spaces,
            _store: self.whole_store.clone().read_owned().await,
        }
    }
}
