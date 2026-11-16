use super::*;
use notarium_core::{ids::RequestId, ports::Cancellation};
use std::{
    fs,
    sync::{Condvar, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn call() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([1; 16]),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(30),
    }
}
struct Gate {
    entered: Semaphore,
    released: Mutex<bool>,
    wake: Condvar,
}
impl Default for Gate {
    fn default() -> Self {
        Self {
            entered: Semaphore::new(0),
            released: Mutex::new(false),
            wake: Condvar::new(),
        }
    }
}
impl Gate {
    fn wait(&self) {
        self.entered.add_permits(1);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.wake.wait(released).unwrap();
        }
    }
    async fn entered(&self, count: u32) {
        tokio::time::timeout(Duration::from_secs(5), self.entered.acquire_many(count))
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        *self.0.released.lock().unwrap() = true;
        self.0.wake.notify_all();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_key_jobs_keep_admission_after_timeout_and_drop_and_recheck_database() {
    let _guard = crate::TEST_RESOURCE_LOCK.lock().await;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap())
        .join(format!("control-tests/keyring-owners-{unique}"));
    fs::create_dir_all(path.join("v1")).unwrap();
    let store = ControlStore::sqlite(&DataRoot::new(&path)).await.unwrap();
    let Backend::Sqlite { pool, .. } = &store.backend else {
        unreachable!()
    };
    let pool = pool.clone();
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/keyring/vectors.json")).unwrap();
    sqlx::query("INSERT INTO secret_keyring(key_id,key_hash,generation,state,canary,created_at) VALUES($1,$2,1,'active',$3,0)")
        .bind(v["keyId"].as_str().unwrap()).bind(v["keyHash"].as_str().unwrap()).bind(v["canaryEnvelope"].as_str().unwrap())
        .execute(&pool).await.unwrap();
    let keyring = Keyring::open(
        store.clone(),
        KeyringLocation::External(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native"),
        ),
        call(),
    )
    .await
    .unwrap();
    let gate = Arc::new(Gate::default());
    let release = Release(gate.clone());
    let mut jobs = Vec::new();
    for number in 0..4 {
        let keyring = keyring.clone();
        let gate = gate.clone();
        let mut call = call();
        if number == 0 {
            call.remaining = Duration::from_millis(500);
        }
        jobs.push(tokio::spawn(async move {
            keyring
                .execute(call, None, false, move |_, _| {
                    // This executes after real confined I/O and key validation.
                    gate.wait();
                    Ok(())
                })
                .await
        }));
    }
    gate.entered(4).await;
    let timed_out = jobs.remove(0);
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), timed_out)
            .await
            .unwrap()
            .unwrap(),
        Err(PortError::DeadlineExceeded(_))
    ));
    for job in jobs {
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
    }
    assert_eq!(IO_ADMISSION.available_permits(), 0);
    assert!(matches!(
        keyring.inspect(call()).await,
        Err(PortError::Domain(DomainError::RateLimited { .. }))
    ));
    drop(release);
    tokio::time::timeout(Duration::from_secs(5), async {
        while IO_ADMISSION.available_permits() != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    keyring.inspect(call()).await.unwrap();

    let gate = Arc::new(Gate::default());
    let release = Release(gate.clone());
    let running = {
        let keyring = keyring.clone();
        let gate = gate.clone();
        tokio::spawn(async move {
            keyring
                .execute(call(), None, false, move |_, _| {
                    gate.wait();
                    Ok(())
                })
                .await
        })
    };
    gate.entered(1).await;
    sqlx::query("UPDATE secret_keyring SET generation=2")
        .execute(&pool)
        .await
        .unwrap();
    drop(release);
    assert!(
        running.await.unwrap().is_err(),
        "a changed durable witness invalidates the in-flight result"
    );
    store.close().await;
    fs::remove_dir_all(path).unwrap();
}
