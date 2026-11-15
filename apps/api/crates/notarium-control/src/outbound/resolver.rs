use super::CheckedEndpoint;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::{
    io,
    net::{SocketAddr, ToSocketAddrs},
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Semaphore;

static DNS_ADMISSION: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));

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
/// System jobs own one of four process-wide slots until they actually finish.
pub struct GuardedResolver {
    endpoint: CheckedEndpoint,
    lookup: Arc<dyn Lookup>,
}
impl GuardedResolver {
    pub fn new(endpoint: CheckedEndpoint) -> Self {
        Self::with_lookup(endpoint, Arc::new(SystemLookup))
    }
    pub(super) fn with_lookup(endpoint: CheckedEndpoint, lookup: Arc<dyn Lookup>) -> Self {
        Self { endpoint, lookup }
    }
}
impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let endpoint = self.endpoint.clone();
        let lookup = self.lookup.clone();
        Box::pin(async move {
            if endpoint.url().host_str() != Some(name.as_str()) {
                return Err(rejected().into());
            }
            let permit = DNS_ADMISSION
                .clone()
                .try_acquire_owned()
                .map_err(|_| rejected())?;
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
