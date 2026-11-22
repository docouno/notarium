use crate::{
    embed::{EmbeddingError, OrtModel},
    layout::VectorModel,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

// A completed load keeps a strong model reference until all current waiters
// have received it. Idle profiles in the registry retain only weak references.
type LoadGate<M> = tokio::sync::Mutex<Option<Arc<M>>>;

struct ModelSlot<M> {
    model: Weak<M>,
    gate: Weak<LoadGate<M>>,
}

struct ModelRegistry<M> {
    closed: bool,
    slots: HashMap<VectorModel, ModelSlot<M>>,
}

pub(crate) struct LocalModels<M = OrtModel> {
    registry: Arc<Mutex<ModelRegistry<M>>>,
}

impl<M> Default for LocalModels<M> {
    fn default() -> Self {
        Self {
            registry: Arc::new(Mutex::new(ModelRegistry {
                closed: false,
                slots: HashMap::new(),
            })),
        }
    }
}

impl<M: Send + Sync + 'static> LocalModels<M> {
    fn loading_gate(&self, key: &VectorModel) -> Result<Arc<LoadGate<M>>, EmbeddingError> {
        let mut registry = self.registry.lock().unwrap_or_else(|err| err.into_inner());
        if registry.closed {
            return Err(EmbeddingError::Cancelled);
        }
        registry
            .slots
            .retain(|_, slot| slot.model.strong_count() != 0 || slot.gate.strong_count() != 0);
        let slot = registry
            .slots
            .entry(key.clone())
            .or_insert_with(|| ModelSlot {
                model: Weak::new(),
                gate: Weak::new(),
            });
        Ok(slot.gate.upgrade().unwrap_or_else(|| {
            let gate = Arc::new(LoadGate::default());
            slot.gate = Arc::downgrade(&gate);
            gate
        }))
    }

    pub(super) async fn get_or_open(
        &self,
        key: VectorModel,
        open: impl FnOnce() -> Result<M, EmbeddingError> + Send + 'static,
    ) -> Result<Arc<M>, EmbeddingError> {
        let mut guard = self.loading_gate(&key)?.lock_owned().await;
        {
            let registry = self.registry.lock().unwrap_or_else(|err| err.into_inner());
            if registry.closed {
                return Err(EmbeddingError::Cancelled);
            }
            if let Some(model) = registry.slots[&key].model.upgrade() {
                return Ok(model);
            }
        }

        // A cancelled waiter can drop its JoinHandle. The native task owns the
        // gate and publishes the model before admitting the next waiter.
        let registry = self.registry.clone();
        tokio::task::spawn_blocking(move || {
            let model = Arc::new(open()?);
            let mut registry = registry.lock().unwrap_or_else(|err| err.into_inner());
            registry
                .slots
                .get_mut(&key)
                .expect("live loading gate")
                .model = Arc::downgrade(&model);
            *guard = Some(model.clone());
            Ok(model)
        })
        .await
        .map_err(|_| EmbeddingError::ModelUnavailable)?
    }

    pub async fn shutdown(&self) {
        let gates: Vec<_> = {
            let mut registry = self.registry.lock().unwrap_or_else(|err| err.into_inner());
            registry.closed = true;
            registry
                .slots
                .values()
                .filter_map(|slot| slot.gate.upgrade())
                .collect()
        };
        for gate in gates {
            drop(gate.lock().await);
        }
    }

    #[cfg(test)]
    pub(crate) async fn hold_loading(&self, key: VectorModel) -> impl Drop {
        self.loading_gate(&key).unwrap().lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::ids::ModelProfileId;
    use std::{sync::mpsc, time::Duration};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn cancelled_waiter_shares_its_native_load_with_the_next_space() {
        let models = LocalModels::default();
        let key = VectorModel::local(ModelProfileId::from_bytes([19; 16]), 64);
        let (started, running) = oneshot::channel();
        let (release, paused) = mpsc::channel();
        let mut first = Box::pin(models.get_or_open(key.clone(), move || {
            started.send(()).unwrap();
            paused.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(42)
        }));
        tokio::select! {
            biased;
            _ = &mut first => panic!("load completed before release"),
            result = running => result.unwrap(),
        }
        drop(first);
        let mut second = Box::pin(models.get_or_open(key, || panic!("duplicate native load")));
        tokio::select! {
            biased;
            _ = &mut second => panic!("second space did not wait for the native loader"),
            () = std::future::ready(()) => (),
        }
        release.send(()).unwrap();
        assert_eq!(*second.await.unwrap(), 42);
    }

    #[tokio::test]
    async fn shutdown_drains_native_load_after_waiter_drops() {
        let models = LocalModels::<()>::default();
        let key = VectorModel::local(ModelProfileId::from_bytes([23; 16]), 64);
        let (started, running) = oneshot::channel();
        let (release, paused) = mpsc::channel();
        let mut waiter = Box::pin(models.get_or_open(key.clone(), move || {
            started.send(()).unwrap();
            paused.recv_timeout(Duration::from_secs(5)).unwrap();
            Err(EmbeddingError::InvalidModel)
        }));
        tokio::select! {
            biased;
            _ = &mut waiter => panic!("load completed before release"),
            result = running => result.unwrap(),
        }
        drop(waiter);
        let mut shutdown = Box::pin(models.shutdown());
        tokio::select! {
            biased;
            () = &mut shutdown => panic!("shutdown returned during a native load"),
            () = std::future::ready(()) => (),
        }
        assert!(matches!(
            models
                .get_or_open(key, || panic!("load after shutdown"))
                .await,
            Err(EmbeddingError::Cancelled)
        ));
        release.send(()).unwrap();
        shutdown.await;
    }
}
