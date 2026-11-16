use super::CheckedEndpoint;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
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

/// A resolver bound to one checked origin. Pass it to ClientBuilder::dns_resolver
/// so the connector uses these exact verified addresses without another lookup.
/// System jobs own one of four transport-scoped slots until they actually finish.
pub struct GuardedResolver {
    endpoint: CheckedEndpoint,
    lookup: Arc<dyn Lookup>,
    dns_admission: Arc<Semaphore>,
}
impl GuardedResolver {
    pub fn new(endpoint: CheckedEndpoint) -> Self {
        Self::with_admission(
            endpoint,
            Arc::new(SystemLookup),
            Arc::new(Semaphore::new(DEFAULT_DNS_PERMITS)),
        )
    }
    #[cfg(test)]
    pub(super) fn with_lookup(endpoint: CheckedEndpoint, lookup: Arc<dyn Lookup>) -> Self {
        Self::with_admission(
            endpoint,
            lookup,
            Arc::new(Semaphore::new(DEFAULT_DNS_PERMITS)),
        )
    }
    pub(super) fn with_admission(
        endpoint: CheckedEndpoint,
        lookup: Arc<dyn Lookup>,
        dns_admission: Arc<Semaphore>,
    ) -> Self {
        Self {
            endpoint,
            lookup,
            dns_admission,
        }
    }
    pub(super) fn default_lookup() -> Arc<dyn Lookup> {
        Arc::new(SystemLookup)
    }
    #[cfg(test)]
    pub(super) fn available_permits(&self) -> usize {
        self.dns_admission.available_permits()
    }
}
impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let endpoint = self.endpoint.clone();
        let lookup = self.lookup.clone();
        let dns_admission = self.dns_admission.clone();
        Box::pin(async move {
            if endpoint.url().host_str() != Some(name.as_str()) {
                return Err(rejected().into());
            }
            let permit = match dns_admission.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => tokio::time::timeout(DNS_ADMISSION_WAIT, dns_admission.acquire_owned())
                    .await
                    .map_err(|_| rejected())?
                    .map_err(|_| rejected())?,
            };
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancel = CancelOnDrop(cancelled.clone());
            let worker = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                if cancelled.load(Ordering::Acquire) {
                    return Err(rejected());
                }
                let values = lookup.addresses(name.as_str()).map_err(|_| rejected())?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(rejected());
                }
                endpoint.addresses(values).map_err(|_| rejected())
            });
            let checked = worker.await.map_err(|_| rejected())??;
            Ok(Box::new(checked.into_iter()) as Addrs)
        })
    }
}

#[cfg(test)]
#[path = "resolver_tests.rs"]
mod tests;
