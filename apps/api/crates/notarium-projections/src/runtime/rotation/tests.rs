use std::{fs::OpenOptions, path::PathBuf};

use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CanonicalStore};
use notarium_core::{
    epoch::DataRoot,
    ids::{InstallationId, RequestId},
    ports::{MaintenanceContext, ServiceAuthority, ServicePurpose},
};

use super::*;
use crate::runtime::ProjectionConfig;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let path =
            std::env::temp_dir().join(format!("notarium-local-rotation-{}", hex::encode(nonce)));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn root(&self) -> DataRoot {
        DataRoot::new(&self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([3; 16]),
        remaining: Duration::from_secs(5),
        cancellation: Cancellation::default(),
    }
}

async fn start(store: CanonicalStore, root: &DataRoot) -> ProjectorRuntime {
    ProjectorRuntime::start_sqlite(
        store,
        MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Projection),
            budget: budget(),
        },
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap()
}

async fn reservation(control: &GenerationControl) -> GenerationDescriptor {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(candidate) = control.candidate().await.unwrap() {
                return candidate;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("rotation durably reserved a candidate")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_rotation_finishes_a_file_swap_waiting_on_its_lock() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([8; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let mut runtime = start(store, &root).await;
    let control = runtime.control.clone();
    let initial = control.active().await.unwrap().unwrap();
    let candidate = DerivedStore::open_sqlite(&root, initial.generation.checked_next().unwrap())
        .await
        .unwrap();
    let engine = runtime.engine();
    let read_gate = Arc::clone(&engine.publication).read_owned().await;
    let request_budget = budget();
    let mut request = Box::pin(runtime.rotate(candidate.clone(), &request_budget));
    let pending = tokio::select! {
        outcome = &mut request => panic!("rotation ended before the publication gate opened: {outcome:?}"),
        pending = reservation(&control) => pending,
    };
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.active_projection_generation().with_extension("lock"))
        .unwrap();
    file.lock().unwrap();
    drop(read_gate);
    tokio::time::timeout(Duration::from_secs(2), async {
        while engine.publication.try_read().is_ok() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("local publication waited on the descriptor");
    drop(request);
    assert_eq!(control.active().await.unwrap(), Some(initial));
    drop(file);
    tokio::time::timeout(Duration::from_secs(3), async {
        while engine.generation.load().store.generation() != pending.generation {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("detached rotation published its local generation");
    assert_eq!(
        control.active().await.unwrap().unwrap().generation,
        pending.generation
    );
    assert!(control.candidate().await.unwrap().is_none());
    runtime.rotate(candidate, &budget()).await.unwrap();
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn rotation_reconciles_an_installed_descriptor_and_restart_clears_orphan() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes([9; 16]),
        root.clone(),
    ))
    .await
    .unwrap();
    let mut runtime = start(store.clone(), &root).await;
    let control = runtime.control.clone();
    let initial = control.active().await.unwrap().unwrap();
    let candidate = DerivedStore::open_sqlite(&root, initial.generation.checked_next().unwrap())
        .await
        .unwrap();
    let engine = runtime.engine();
    let read_gate = Arc::clone(&engine.publication).read_owned().await;
    let request_budget = budget();
    let mut request = Box::pin(runtime.rotate(candidate, &request_budget));
    let pending = tokio::select! {
        outcome = &mut request => panic!("rotation ended before the publication gate opened: {outcome:?}"),
        pending = reservation(&control) => pending,
    };
    // The file is already installed when the waiting local publication
    // resumes. It must converge rather than treat a failed CAS as Old.
    assert!(
        control
            .compare_and_swap(Some(&initial), &pending)
            .await
            .unwrap()
    );
    drop(read_gate);
    request.await.unwrap();
    assert_eq!(
        engine.generation.load().store.generation(),
        pending.generation
    );

    let orphan = GenerationDescriptor {
        generation: pending.generation.checked_next().unwrap(),
        publication_epoch: pending.publication_epoch + 1,
        cut_fingerprint: pending.cut_fingerprint,
    };
    assert!(
        control
            .reserve_candidate(Some(&pending), &orphan)
            .await
            .unwrap()
    );
    runtime.shutdown().await.unwrap();
    let reopened = start(store, &root).await;
    assert_eq!(
        reopened.engine.generation.load().store.generation(),
        pending.generation
    );
    assert!(control.candidate().await.unwrap().is_none());
    reopened.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}
