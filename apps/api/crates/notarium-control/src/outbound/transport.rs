use super::{
    CheckedEndpoint, NetworkPolicy, OutboundScope,
    resolver::{DEFAULT_DNS_PERMITS, DEFAULT_DNS_QUEUE, GuardedResolver, Lookup},
};
use crate::{
    error::{invalid, unavailable},
    store::lease::OperationBudget,
};
use notarium_core::{
    DomainError,
    error::{
        BudgetKind, CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason,
    },
    ids::{ContentDigest, ProviderResourceId},
    ports::{CallBudget, Cancellation},
};
use reqwest::{Client, Method, header::HeaderMap};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OnceCell, OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

pub const DEFAULT_MAX_ACTIVE_REQUESTS: usize = 64;
const MAX_ACTIVE_REQUESTS_CAP: usize = 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CLIENTS: usize = 128;
const CHUNK_BYTES: usize = 64 * 1024;
const IDLE_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);

fn failed() -> PortError {
    unavailable("control outbound request", CommitEffect::Unknown)
}
fn send_failed(error: reqwest::Error) -> PortError {
    // With proxies and request retries disabled, connector failure occurs before
    // HTTP application bytes. Other failures may follow a partial or full POST.
    let effect = if error.is_connect() {
        CommitEffect::NotCommitted
    } else {
        CommitEffect::Unknown
    };
    unavailable("control outbound request", effect)
}
fn saturated() -> PortError {
    DomainError::RateLimited {
        retry_after_ms: 100,
        budget: BudgetKind::Concurrency,
    }
    .into()
}
fn cancelled() -> PortError {
    PortError::Cancelled(
        OperationalFailure::new(
            ContentDigest::from_bytes(*blake3::hash(b"control outbound cancellation").as_bytes()),
            CommitEffect::Unknown,
            RetryAdvice::Never,
            false,
        )
        .expect("non-retryable failure"),
    )
}
fn header_bytes(headers: &HeaderMap) -> Result<usize, PortError> {
    let mut total = 0usize;
    for (name, value) in headers {
        total = total
            .checked_add(name.as_str().len() + value.as_bytes().len() + 4)
            .ok_or_else(failed)?;
        if total > MAX_HEADER_BYTES {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
    }
    Ok(total)
}

/// Deliberately not Debug: URLs, headers and bodies may contain confidential
/// data. Provider callers must hold current authority/consent and durable intent
/// before calling send; this transport enforces destination and I/O policy.
pub struct OutboundRequest {
    pub scope: OutboundScope,
    pub url: String,
    pub method: Method,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub response_limit: usize,
}
impl OutboundRequest {
    fn validate(&mut self) -> Result<Duration, PortError> {
        if self.body.len() > MAX_REQUEST_BYTES
            || self.response_limit == 0
            || self.response_limit > MAX_RESPONSE_BYTES
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        if self.method != Method::GET && self.method != Method::POST {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        let maximum = match self.scope {
            OutboundScope::Provider { .. } => Duration::from_secs(120),
            OutboundScope::Cimd => {
                if self.method != Method::GET
                    || !self.body.is_empty()
                    || self.response_limit > 64 * 1024
                {
                    return Err(invalid(ValidationReason::InvalidLimit));
                }
                Duration::from_secs(10)
            }
            OutboundScope::Oidc { .. } => {
                if self.body.len() > 64 * 1024 || self.response_limit > 256 * 1024 {
                    return Err(invalid(ValidationReason::InvalidLimit));
                }
                Duration::from_secs(10)
            }
        };
        header_bytes(&self.headers)?;
        for (name, value) in &mut self.headers {
            if matches!(
                name.as_str(),
                "host"
                    | "connection"
                    | "content-length"
                    | "transfer-encoding"
                    | "proxy-authorization"
                    | "proxy-connection"
                    | "upgrade"
                    | "te"
                    | "trailer"
                    | "expect"
            ) {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
            value.set_sensitive(true);
        }
        Ok(maximum)
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct PoolKey {
    scope: OutboundScope,
    origin: String,
    policy_epoch: u64,
}
struct Slot {
    endpoint: CheckedEndpoint,
    client: OnceCell<Client>,
    cancelled: Cancellation,
}
struct Entry {
    slot: Arc<Slot>,
    used: u64,
}
struct State {
    policy: NetworkPolicy,
    epoch: u64,
    tick: u64,
    clients: HashMap<PoolKey, Entry>,
}
struct Shared {
    state: Mutex<State>,
    send_admission: Arc<Semaphore>,
    #[cfg(test)]
    max_active_requests: usize,
    dns_admission: Arc<Semaphore>,
    dns_queue: Arc<Semaphore>,
    lookup: Option<Arc<dyn Lookup>>,
    #[cfg(test)]
    fixture: Option<(String, reqwest::Certificate)>,
}

#[derive(Clone)]
pub struct OutboundTransport {
    shared: Arc<Shared>,
}
impl OutboundTransport {
    /// Validate configuration against the current operator policy without DNS or
    /// network I/O. Send always repeats this check with the current policy.
    pub fn check_endpoint(&self, scope: OutboundScope, url: &str) -> Result<String, PortError> {
        let state = self.shared.state.lock().map_err(|_| failed())?;
        Ok(state.policy.endpoint(scope, url)?.url().to_string())
    }
    pub fn new(policy: NetworkPolicy) -> Self {
        Self::with_lookup_and_limit(policy, None, DEFAULT_MAX_ACTIVE_REQUESTS)
    }
    pub fn with_max_active_requests(
        policy: NetworkPolicy,
        max_active_requests: usize,
    ) -> Result<Self, PortError> {
        if max_active_requests == 0 || max_active_requests > MAX_ACTIVE_REQUESTS_CAP {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(Self::with_lookup_and_limit(
            policy,
            None,
            max_active_requests,
        ))
    }
    #[cfg(test)]
    fn with_lookup(policy: NetworkPolicy, lookup: Option<Arc<dyn Lookup>>) -> Self {
        Self::with_lookup_and_limit(policy, lookup, DEFAULT_MAX_ACTIVE_REQUESTS)
    }
    fn with_lookup_and_limit(
        policy: NetworkPolicy,
        lookup: Option<Arc<dyn Lookup>>,
        max_active_requests: usize,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    policy,
                    epoch: 1,
                    tick: 0,
                    clients: HashMap::new(),
                }),
                send_admission: Arc::new(Semaphore::new(max_active_requests)),
                #[cfg(test)]
                max_active_requests,
                dns_admission: Arc::new(Semaphore::new(DEFAULT_DNS_PERMITS)),
                dns_queue: Arc::new(Semaphore::new(DEFAULT_DNS_QUEUE)),
                lookup,
                #[cfg(test)]
                fixture: None,
            }),
        }
    }
    #[cfg(test)]
    pub(super) fn available_permits(&self) -> usize {
        self.shared.send_admission.available_permits()
    }
    #[cfg(test)]
    pub(super) fn max_active_requests(&self) -> usize {
        self.shared.max_active_requests
    }
    #[cfg(test)]
    pub(super) fn fixture_https(
        origin: String,
        lookup: Arc<dyn Lookup>,
        ca: reqwest::Certificate,
    ) -> Self {
        let mut transport = Self::with_lookup(NetworkPolicy::default(), Some(lookup));
        Arc::get_mut(&mut transport.shared)
            .expect("new transport")
            .fixture = Some((origin, ca));
        transport
    }
    /// Operator policy changes cancel active calls and discard every old pool.
    pub fn replace_policy(&self, policy: NetworkPolicy) -> Result<(), PortError> {
        let mut state = self.shared.state.lock().map_err(|_| failed())?;
        let epoch = state.epoch.checked_add(1).ok_or_else(failed)?;
        for entry in state.clients.values() {
            entry.slot.cancelled.cancel();
        }
        state.clients.clear();
        state.policy = policy;
        state.epoch = epoch;
        Ok(())
    }
    /// Call as part of the provider mutation admission fence. A later dispatch
    /// must obtain fresh DB authority, including after an idle cache eviction.
    pub fn invalidate_provider(&self, resource: &ProviderResourceId) -> Result<(), PortError> {
        let mut state = self.shared.state.lock().map_err(|_| failed())?;
        state.clients.retain(|key, entry| {
            if matches!(&key.scope, OutboundScope::Provider { resource: id, .. } if id == resource)
            {
                entry.slot.cancelled.cancel();
                false
            } else {
                true
            }
        });
        Ok(())
    }
    fn slot(
        &self,
        scope: OutboundScope,
        url: &str,
    ) -> Result<(Arc<Slot>, CheckedEndpoint), PortError> {
        let mut state = self.shared.state.lock().map_err(|_| failed())?;
        let endpoint = state.policy.endpoint(scope.clone(), url)?;
        #[cfg(test)]
        let endpoint = match &self.shared.fixture {
            Some((origin, _)) if endpoint.origin() == origin => endpoint.fixture_loopback(origin),
            _ => endpoint,
        };
        if let OutboundScope::Provider {
            resource,
            runtime_epoch,
            credential_epoch,
            wire,
        } = &scope
        {
            for key in state.clients.keys() {
                if let OutboundScope::Provider {
                    resource: old_resource,
                    runtime_epoch: old_epoch,
                    credential_epoch: old_credential,
                    wire: old_wire,
                } = &key.scope
                    && old_resource == resource
                    && (*old_epoch > *runtime_epoch
                        || (*old_epoch == *runtime_epoch
                            && (old_wire != wire
                                || key.origin != endpoint.origin()
                                || old_credential.is_some() != credential_epoch.is_some()
                                || old_credential > credential_epoch)))
                {
                    return Err(DomainError::AccessDenied.into());
                }
            }
            state.clients.retain(|key, entry| {
                if matches!(&key.scope, OutboundScope::Provider { resource: old_resource, runtime_epoch: old_epoch, credential_epoch: old_credential, .. }
                    if old_resource == resource && (old_epoch, old_credential) < (runtime_epoch, credential_epoch)) {
                    entry.slot.cancelled.cancel(); false
                } else { true }
            });
        }
        let key = PoolKey {
            scope,
            origin: endpoint.origin().into(),
            policy_epoch: state.epoch,
        };
        state.tick = state.tick.saturating_add(1);
        let tick = state.tick;
        if let Some(entry) = state.clients.get_mut(&key) {
            entry.used = tick;
            return Ok((entry.slot.clone(), endpoint));
        }
        if state.clients.len() == MAX_CLIENTS {
            let oldest = state
                .clients
                .iter()
                .filter(|(_, entry)| Arc::strong_count(&entry.slot) == 1)
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
                .ok_or_else(saturated)?;
            state.clients.remove(&oldest);
        }
        let slot = Arc::new(Slot {
            endpoint: endpoint.clone(),
            client: OnceCell::new(),
            cancelled: Cancellation::default(),
        });
        state.clients.insert(
            key,
            Entry {
                slot: slot.clone(),
                used: tick,
            },
        );
        Ok((slot, endpoint))
    }
    pub async fn send(
        &self,
        call: CallBudget,
        request: OutboundRequest,
    ) -> Result<OutboundResponse, PortError> {
        let mut response = self.start(call, request)?;
        response.receive_head().await?;
        Ok(response)
    }
    /// Returns ownership before any await. Authority owners use `close` to await
    /// actual network shutdown before releasing their revocation registrations.
    pub(crate) fn start(
        &self,
        call: CallBudget,
        request: OutboundRequest,
    ) -> Result<OutboundResponse, PortError> {
        self.start_checked(call, request, || Ok(()))
    }

    pub(crate) fn start_checked(
        &self,
        mut call: CallBudget,
        mut request: OutboundRequest,
        preflight: impl FnOnce() -> Result<(), PortError> + Send + 'static,
    ) -> Result<OutboundResponse, PortError> {
        call.remaining = call.remaining.min(request.validate()?);
        let request_id = call.request.clone();
        let budget = OperationBudget::new(call);
        budget.check(CommitEffect::NotCommitted)?;
        let permit = self
            .shared
            .send_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| saturated())?;
        let (slot, endpoint) = self.slot(request.scope, &request.url)?;
        let dropped = Cancellation::default();
        let guard = CancelOnDrop(dropped.clone());
        let (head_tx, head_rx) = oneshot::channel();
        let (uploaded_tx, uploaded_rx) = oneshot::channel();
        let (chunks_tx, chunks_rx) = mpsc::channel(1);
        let (end_tx, end_rx) = oneshot::channel();
        let (closed_tx, closed_rx) = oneshot::channel();
        let context = Worker {
            budget: budget.clone(),
            slot,
            dropped,
            _permit: permit,
        };
        let lookup = self.shared.lookup.clone();
        let dns_admission = self.shared.dns_admission.clone();
        let dns_queue = self.shared.dns_queue.clone();
        #[cfg(test)]
        let fixture_ca = self.shared.fixture.as_ref().map(|(_, ca)| ca.clone());
        tokio::spawn(async move {
            let mut head_tx = Some(head_tx);
            let mut uploaded_tx = Some(uploaded_tx);
            let result = async {
                // Certificate loading may touch the filesystem. The owner keeps
                // its active slot through actual blocking construction even if
                // the caller has already timed out or dropped the future.
                let client = context
                    .slot
                    .client
                    .get_or_try_init(|| async {
                        let endpoint = context.slot.endpoint.clone();
                        tokio::task::spawn_blocking(move || {
                            build_client(
                                endpoint,
                                lookup,
                                dns_admission,
                                dns_queue,
                                #[cfg(test)]
                                fixture_ca,
                            )
                        })
                        .await
                        .map_err(|_| failed())?
                    })
                    .await?;
                context.check()?;
                let is_get = request.method == Method::GET;
                let content_len = request.body.len();
                let mut builder = client
                    .request(request.method, endpoint.url().clone())
                    .headers(request.headers)
                    .timeout(context.budget.context(request_id).remaining);
                if !is_get && !request.body.is_empty() {
                    let body_signal = uploaded_tx.take();
                    builder = builder
                        .header(reqwest::header::CONTENT_LENGTH, content_len)
                        .body(reqwest::Body::wrap_stream(TrackedBody {
                            chunk: Some(request.body),
                            polled: false,
                            uploaded: body_signal,
                        }));
                }
                let outgoing = builder.build().map_err(|_| failed())?;
                let mut response = context
                    .run(async {
                        preflight()?;
                        if let Some(tx) = uploaded_tx.take() {
                            let _ = tx.send(());
                        }
                        client.execute(outgoing).await.map_err(send_failed)
                    })
                    .await?;
                header_bytes(response.headers()).map_err(|_| failed())?;
                if response
                    .content_length()
                    .is_some_and(|size| size > request.response_limit as u64)
                {
                    return Err(failed());
                }
                let mut headers = response.headers().clone();
                for value in headers.values_mut() {
                    value.set_sensitive(true);
                }
                head_tx
                    .take()
                    .expect("head once")
                    .send(Ok((response.status().as_u16(), headers)))
                    .map_err(|_| cancelled())?;
                let mut received = 0usize;
                while let Some(chunk) = context
                    .run(async {
                        tokio::time::timeout(IDLE_CHUNK_TIMEOUT, response.chunk())
                            .await
                            .map_err(|_| failed())?
                            .map_err(|_| failed())
                    })
                    .await?
                {
                    received = received.checked_add(chunk.len()).ok_or_else(failed)?;
                    if received > request.response_limit {
                        return Err(failed());
                    }
                    for part in chunk.chunks(CHUNK_BYTES) {
                        context
                            .run(async {
                                tokio::time::timeout(
                                    IDLE_CHUNK_TIMEOUT,
                                    chunks_tx.send(part.to_vec()),
                                )
                                .await
                                .map_err(|_| failed())?
                                .map_err(|_| cancelled())
                            })
                            .await?;
                    }
                }
                Ok(())
            }
            .await;
            if let Some(head_tx) = head_tx {
                let _ = head_tx.send(Err(result.as_ref().err().cloned().unwrap_or_else(failed)));
            }
            let _ = end_tx.send(result);
            // Response, client lease and active admission are owned here. An
            // unpolled consumer cannot keep a socket alive past the budget.
            drop(context);
            let _ = closed_tx.send(());
        });
        Ok(OutboundResponse {
            status: 0,
            headers: HeaderMap::new(),
            head: Some(head_rx),
            uploaded: Some(uploaded_rx),
            budget,
            closed: closed_rx,
            chunks: chunks_rx,
            end: Some(end_rx),
            finished: false,
            _guard: guard,
        })
    }
}

fn build_client(
    endpoint: CheckedEndpoint,
    lookup: Option<Arc<dyn Lookup>>,
    dns_admission: Arc<Semaphore>,
    dns_queue: Arc<Semaphore>,
    #[cfg(test)] fixture_ca: Option<reqwest::Certificate>,
) -> Result<Client, PortError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let resolver = GuardedResolver::with_admission(
        endpoint,
        lookup.unwrap_or_else(GuardedResolver::default_lookup),
        dns_admission,
        dns_queue,
    );
    let builder = Client::builder()
        .tls_backend_rustls()
        .dns_resolver(Arc::new(resolver))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .tls_sslkeylogfile(false)
        .http1_only()
        .http1_max_headers(100)
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(2);
    #[cfg(test)]
    let builder = match fixture_ca {
        Some(ca) => builder.tls_certs_only([ca]),
        None => builder,
    };
    builder.build().map_err(|_| failed())
}
struct CancelOnDrop(Cancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct Worker {
    budget: OperationBudget,
    slot: Arc<Slot>,
    dropped: Cancellation,
    _permit: OwnedSemaphorePermit,
}
impl Worker {
    fn check(&self) -> Result<(), PortError> {
        self.budget.check(CommitEffect::Unknown)?;
        if self.dropped.is_cancelled() || self.slot.cancelled.is_cancelled() {
            return Err(cancelled());
        }
        Ok(())
    }
    async fn run<T>(
        &self,
        operation: impl Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        self.check()?;
        let wait_for = self.budget.remaining_now();
        tokio::select! {
            biased;
            () = self.budget.cancellation().cancelled() => {
                Err(self.budget.check(CommitEffect::Unknown).expect_err("budget cancelled"))
            }
            () = self.dropped.cancelled() => Err(cancelled()),
            () = self.slot.cancelled.cancelled() => Err(cancelled()),
            () = tokio::time::sleep(wait_for) => {
                while self.budget.remaining_now() > Duration::ZERO {
                    tokio::time::sleep(self.budget.remaining_now()).await;
                }
                Err(self.budget.check(CommitEffect::Unknown).expect_err("budget expired"))
            }
            result = operation => {
                // The driver's timer can finish between wakeups. Keep the
                // current caller deadline/cancellation as the terminal cause.
                self.check()?;
                result
            },
        }
    }
}

struct TrackedBody {
    chunk: Option<Vec<u8>>,
    polled: bool,
    uploaded: Option<oneshot::Sender<()>>,
}
impl Drop for TrackedBody {
    fn drop(&mut self) {
        if self.polled
            && self.chunk.is_none()
            && let Some(tx) = self.uploaded.take()
        {
            let _ = tx.send(());
        }
    }
}
impl futures_util::Stream for TrackedBody {
    type Item = Result<Vec<u8>, std::io::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.polled = true;
        if let Some(chunk) = self.chunk.take() {
            return std::task::Poll::Ready(Some(Ok(chunk)));
        }
        if let Some(tx) = self.uploaded.take() {
            let _ = tx.send(());
        }
        std::task::Poll::Ready(None)
    }
}

/// A bounded stream whose producer owns cancellation, sockets and admission.
/// Dropping it stops the worker; retaining it without polling cannot suspend
/// absolute/idle deadlines. Headers are marked sensitive and are not Debugged.
pub struct OutboundResponse {
    status: u16,
    headers: HeaderMap,
    head: Option<oneshot::Receiver<Result<(u16, HeaderMap), PortError>>>,
    uploaded: Option<oneshot::Receiver<()>>,
    budget: OperationBudget,
    closed: oneshot::Receiver<()>,
    chunks: mpsc::Receiver<Vec<u8>>,
    end: Option<oneshot::Receiver<Result<(), PortError>>>,
    finished: bool,
    _guard: CancelOnDrop,
}
impl OutboundResponse {
    /// Wait until preflight, connection establishment, and request-body write
    /// complete (`Ok(true)`), or the request fails before upload (`Ok(false)`).
    pub(crate) async fn wait_uploaded(&mut self) -> Result<bool, PortError> {
        if let Some(uploaded) = self.uploaded.as_mut() {
            let sent = self
                .budget
                .run(async { Ok(uploaded.await.is_ok()) }, CommitEffect::Unknown)
                .await?;
            self.uploaded = None;
            return Ok(sent);
        }
        Ok(true)
    }
    pub(crate) async fn receive_head(&mut self) -> Result<(), PortError> {
        if let Some(head) = self.head.as_mut() {
            let (status, headers) = self
                .budget
                .run(
                    async { head.await.map_err(|_| failed())? },
                    CommitEffect::Unknown,
                )
                .await?;
            self.head = None;
            self.status = status;
            self.headers = headers;
        }
        Ok(())
    }
    /// Cancellation is a request; this acknowledgement proves the producer has
    /// dropped its HTTP response and request future. Do not cancel this wait
    /// while holding authority that must exclude in-flight application bytes.
    pub(crate) async fn close(self) -> Result<(), PortError> {
        self._guard.0.cancel();
        self.closed.await.map_err(|_| failed())
    }
    pub fn status(&self) -> u16 {
        self.status
    }
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }
    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, PortError> {
        if self.finished {
            return Ok(None);
        }
        loop {
            if let Some(end) = &mut self.end {
                tokio::select! {
                    biased;
                    result = end => {
                        self.end = None;
                        if let Err(error) = result.unwrap_or_else(|_| Err(failed())) {
                            self.finished = true; self.chunks.close(); return Err(error);
                        }
                    },
                    chunk = self.chunks.recv() => {
                        if let Some(chunk) = chunk { return Ok(Some(chunk)); }
                        // The terminal witness is sent before the producer drops
                        // its channel. Await it to preserve any final error.
                    }
                }
            } else {
                let chunk = self.chunks.recv().await;
                if chunk.is_none() {
                    self.finished = true;
                }
                return Ok(chunk);
            }
        }
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
