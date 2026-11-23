use super::*;
use crate::outbound::{NetworkPolicy, OutboundScope};
use std::{
    sync::{Condvar, Mutex, atomic::AtomicUsize},
    time::Duration,
};

struct Source {
    calls: AtomicUsize,
    entered: Semaphore,
    released: Mutex<bool>,
    wake: Condvar,
}
impl Default for Source {
    fn default() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            released: Mutex::new(false),
            wake: Condvar::new(),
        }
    }
}
impl Lookup for Source {
    fn addresses(&self, host: &str) -> io::Result<Vec<SocketAddr>> {
        assert_eq!(host, "public.example");
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.add_permits(1);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.wake.wait(released).unwrap();
        }
        let ip = if n == 5 {
            "127.0.0.1:80"
        } else {
            "8.8.8.8:1234"
        };
        Ok(vec!["1.1.1.1:4567".parse().unwrap(), ip.parse().unwrap()])
    }
}
struct Release(Arc<Source>);
impl Drop for Release {
    fn drop(&mut self) {
        *self.0.released.lock().unwrap() = true;
        self.0.wake.notify_all();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_dns_jobs_remain_bounded_and_each_connection_checks_the_entire_answer() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let endpoint = NetworkPolicy::default()
        .endpoint(OutboundScope::Cimd, "https://public.example/metadata")
        .unwrap();
    let source = Arc::new(Source::default());
    let release = Release(source.clone());
    let resolver = Arc::new(GuardedResolver::with_lookup(endpoint, source.clone()));
    assert!(resolver.resolve_addrs("other.example").await.is_err());
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    let mut jobs = Vec::new();
    for _ in 0..4 {
        let resolver = resolver.clone();
        jobs.push(tokio::spawn(async move {
            resolver.resolve_addrs("public.example").await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), source.entered.acquire_many(4))
        .await
        .unwrap()
        .unwrap()
        .forget();
    for job in jobs {
        job.abort();
        assert!(job.await.is_err());
    }
    assert_eq!(resolver.available_permits(), 0);
    let tiny_queue_resolver = Arc::new(GuardedResolver::with_admission(
        NetworkPolicy::default()
            .endpoint(OutboundScope::Cimd, "https://public.example/metadata")
            .unwrap(),
        source.clone(),
        Arc::new(Semaphore::new(0)),
        Arc::new(Semaphore::new(0)),
    ));
    assert!(
        tiny_queue_resolver
            .resolve_addrs("public.example")
            .await
            .is_err()
    );
    assert!(resolver.resolve_addrs("public.example").await.is_err());
    assert_eq!(source.calls.load(Ordering::SeqCst), 4);
    drop(release);
    tokio::time::timeout(Duration::from_secs(5), async {
        while resolver.available_permits() != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let addresses = resolver.resolve_addrs("public.example").await.unwrap();
    assert_eq!(
        addresses,
        vec![
            "1.1.1.1:0".parse::<SocketAddr>().unwrap(),
            "8.8.8.8:0".parse::<SocketAddr>().unwrap()
        ]
    );
    // The next connection sees a changed DNS answer. A single private address
    // rejects the complete set, including its otherwise valid public candidate.
    assert!(resolver.resolve_addrs("public.example").await.is_err());
    assert_eq!(source.calls.load(Ordering::SeqCst), 6);
}
