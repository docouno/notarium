use super::CheckedEndpoint;
use std::{
    io,
    net::{SocketAddr, ToSocketAddrs},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;

pub(super) const DEFAULT_DNS_PERMITS: usize = 4;
pub(super) const DEFAULT_DNS_QUEUE: usize = 64;
const DNS_ADMISSION_WAIT: Duration = Duration::from_millis(50);

fn rejected() -> io::Error {
    io::Error::other("outbound destination unavailable")
}

pub(super) trait Lookup: Send + Sync {
    fn addresses(&self, host: &str) -> io::Result<Vec<SocketAddr>>;
}
struct SystemLookup;
impl Lookup for SystemLookup {
    fn addresses(&self, host: &str) -> io::Result<Vec<SocketAddr>> {
        // The OS resolver may block. Retain only the limit plus one candidate
        // so the policy rejects oversized answers rather than truncating them.
        Ok((host, 0)
            .to_socket_addrs()
            .map_err(|_| rejected())?
            .take(33)
            .collect())
    }
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// A resolver bound to one checked origin. The outbound connector resolves the
/// host once per fresh TCP connection and dials only these verified addresses.
/// System jobs own one of four transport-scoped slots until they actually finish.
pub(super) struct GuardedResolver {
    endpoint: CheckedEndpoint,
    lookup: Arc<dyn Lookup>,
    dns_admission: Arc<Semaphore>,
    dns_queue: Arc<Semaphore>,
}
impl GuardedResolver {
    #[cfg(test)]
    pub(super) fn with_lookup(endpoint: CheckedEndpoint, lookup: Arc<dyn Lookup>) -> Self {
        Self::with_admission(
            endpoint,
            lookup,
            Arc::new(Semaphore::new(DEFAULT_DNS_PERMITS)),
            Arc::new(Semaphore::new(DEFAULT_DNS_QUEUE)),
        )
    }
    pub(super) fn with_admission(
        endpoint: CheckedEndpoint,
        lookup: Arc<dyn Lookup>,
        dns_admission: Arc<Semaphore>,
        dns_queue: Arc<Semaphore>,
    ) -> Self {
        Self {
            endpoint,
            lookup,
            dns_admission,
            dns_queue,
        }
    }
    pub(super) fn default_lookup() -> Arc<dyn Lookup> {
        Arc::new(SystemLookup)
    }
    #[cfg(test)]
    pub(super) fn available_permits(&self) -> usize {
        self.dns_admission.available_permits()
    }
    pub(super) async fn resolve_addrs(&self, host: &str) -> io::Result<Vec<SocketAddr>> {
        if self.endpoint.url().host_str() != Some(host) {
            return Err(rejected());
        }
        let permit = match self.dns_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _queue_slot = self
                    .dns_queue
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| rejected())?;
                tokio::time::timeout(
                    DNS_ADMISSION_WAIT,
                    self.dns_admission.clone().acquire_owned(),
                )
                .await
                .map_err(|_| rejected())?
                .map_err(|_| rejected())?
            }
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel = CancelOnDrop(cancelled.clone());
        let endpoint = self.endpoint.clone();
        let lookup = self.lookup.clone();
        let host = host.to_owned();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if cancelled.load(Ordering::Acquire) {
                return Err(rejected());
            }
            let values = lookup.addresses(&host).map_err(|_| rejected())?;
            if cancelled.load(Ordering::Acquire) {
                return Err(rejected());
            }
            endpoint.addresses(values).map_err(|_| rejected())
        });
        worker.await.map_err(|_| rejected())?
    }
}

#[cfg(test)]
#[path = "resolver_tests.rs"]
mod tests;
