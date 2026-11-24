use super::{
    CheckedEndpoint, NetworkPolicy, OutboundScope,
    resolver::{DEFAULT_DNS_PERMITS, DEFAULT_DNS_QUEUE, GuardedResolver, Lookup},
};
use crate::{
    error::{invalid, unavailable},
    store::lease::OperationBudget,
};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, Request, Uri, Version, header};
use hyper::{
    body::{Body, Frame, SizeHint},
    client::conn::http1::{self, SendRequest},
};
use hyper_util::rt::TokioIo;
use notarium_core::{
    DomainError,
    error::{
        BudgetKind, CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason,
    },
    ids::{ContentDigest, ProviderResourceId},
    ports::{CallBudget, Cancellation},
};
use std::{
    collections::HashMap,
    future::Future,
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
    sync::{OnceCell, OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    time::Instant,
};
use tokio_rustls::{TlsConnector, client::TlsStream};
use url::Host;

pub const DEFAULT_MAX_ACTIVE_REQUESTS: usize = 64;
const MAX_ACTIVE_REQUESTS_CAP: usize = 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CLIENTS: usize = 128;
const MAX_IDLE_PER_SLOT: usize = 2;
const CHUNK_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const IDLE_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);

fn failed() -> PortError {
    unavailable("control outbound request", CommitEffect::Unknown)
}
fn connect_failed() -> PortError {
    unavailable("control outbound request", CommitEffect::NotCommitted)
}
fn saturated() -> PortError {
    DomainError::RateLimited {
        retry_after_ms: 100,
        budget: BudgetKind::Concurrency,
    }
    .into()
}
fn cancelled(effect: CommitEffect) -> PortError {
    PortError::Cancelled(
        OperationalFailure::new(
            ContentDigest::from_bytes(*blake3::hash(b"control outbound cancellation").as_bytes()),
            effect,
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

fn transfer_encoding_ends_with_chunked(headers: &HeaderMap) -> bool {
    let mut last_token: Option<String> = None;
    for value in headers.get_all(header::TRANSFER_ENCODING) {
        let Ok(text) = value.to_str() else {
            return false;
        };
        for token in text.split(',') {
            let token = token.trim();
            if !token.is_empty() {
                last_token = Some(token.to_ascii_lowercase());
            }
        }
    }
    last_token.as_deref() == Some("chunked")
}

fn response_allows_keep_alive<B>(response: &http::Response<B>) -> bool {
    let status = response.status().as_u16();
    if status == 101 || (100..200).contains(&status) {
        return false;
    }
    let mut saw_close = false;
    let mut saw_keep_alive = false;
    for value in response.headers().get_all(header::CONNECTION) {
        let Ok(text) = value.to_str() else {
            return false;
        };
        for token in text.split(',') {
            let token = token.trim();
            if token.eq_ignore_ascii_case("close") {
                saw_close = true;
            } else if token.eq_ignore_ascii_case("keep-alive") {
                saw_keep_alive = true;
            }
        }
    }
    if saw_close {
        return false;
    }
    let version_allows = match response.version() {
        Version::HTTP_11 => true,
        Version::HTTP_10 => saw_keep_alive,
        _ => false,
    };
    if !version_allows {
        return false;
    }
    // RFC 9112 §6.3: close-delimited responses terminate the connection at EOF
    // and must never be returned to the keep-alive pool. When Transfer-Encoding
    // is present, it takes precedence over Content-Length.
    if matches!(status, 204 | 304) {
        return true;
    }
    if response.headers().contains_key(header::TRANSFER_ENCODING) {
        return transfer_encoding_ends_with_chunked(response.headers());
    }
    response.headers().contains_key(header::CONTENT_LENGTH)
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

struct UploadTracker {
    body_done: bool,
    wrote_bytes: bool,
    flushed: bool,
    uploaded: Option<oneshot::Sender<()>>,
}

struct TrackedRequestBody {
    remaining: Bytes,
    tracker: Arc<Mutex<Option<UploadTracker>>>,
}
impl Body for TrackedRequestBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if self.remaining.is_empty() {
            if let Ok(mut guard) = self.tracker.lock()
                && let Some(tracker) = guard.as_mut()
            {
                tracker.body_done = true;
            }
            return Poll::Ready(None);
        }
        let take = self.remaining.len().min(CHUNK_BYTES);
        let chunk = self.remaining.split_to(take);
        if self.remaining.is_empty()
            && let Ok(mut guard) = self.tracker.lock()
            && let Some(tracker) = guard.as_mut()
        {
            tracker.body_done = true;
        }
        Poll::Ready(Some(Ok(Frame::data(chunk))))
    }

    fn is_end_stream(&self) -> bool {
        self.remaining.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining.len() as u64)
    }
}

enum TransportStream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}
impl AsyncRead for TransportStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(&mut **stream).poll_read(cx, buf),
        }
    }
}
impl AsyncWrite for TransportStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(&mut **stream).poll_write(cx, buf),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write_vectored(cx, bufs),
            Self::Tls(stream) => Pin::new(&mut **stream).poll_write_vectored(cx, bufs),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Plain(stream) => stream.is_write_vectored(),
            Self::Tls(stream) => stream.is_write_vectored(),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(&mut **stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(&mut **stream).poll_shutdown(cx),
        }
    }
}

struct TrackedIo<S> {
    inner: S,
    tracker: Arc<Mutex<Option<UploadTracker>>>,
}
impl<S> TrackedIo<S> {
    fn new(inner: S, tracker: Arc<Mutex<Option<UploadTracker>>>) -> Self {
        Self { inner, tracker }
    }
    fn note_wrote(&self, n: usize) {
        if n > 0
            && let Ok(mut guard) = self.tracker.lock()
            && let Some(tracker) = guard.as_mut()
        {
            tracker.wrote_bytes = true;
        }
    }
    fn note_flushed(&self) {
        if let Ok(mut guard) = self.tracker.lock()
            && let Some(tracker) = guard.as_mut()
            && tracker.body_done
            && tracker.wrote_bytes
        {
            tracker.flushed = true;
            if let Some(tx) = tracker.uploaded.take() {
                let _ = tx.send(());
            }
        }
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for TrackedIo<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for TrackedIo<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let poll = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = poll {
            self.note_wrote(n);
        }
        poll
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let poll = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if let Poll::Ready(Ok(n)) = poll {
            self.note_wrote(n);
        }
        poll
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let poll = Pin::new(&mut self.inner).poll_flush(cx);
        if matches!(poll, Poll::Ready(Ok(()))) {
            self.note_flushed();
        }
        poll
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

struct PooledConn {
    sender: SendRequest<TrackedRequestBody>,
    tracker: Arc<Mutex<Option<UploadTracker>>>,
    conn_cancel: Cancellation,
    conn_done: Option<oneshot::Receiver<()>>,
    last_used: Instant,
}
impl PooledConn {
    fn finish_upload_wait(&self) {
        if let Ok(mut guard) = self.tracker.lock()
            && let Some(tracker) = guard.as_mut()
        {
            tracker.uploaded = None;
        }
    }
    fn finish_tracker(&self) -> bool {
        if let Ok(mut guard) = self.tracker.lock() {
            guard.take().is_some_and(|tracker| tracker.flushed)
        } else {
            false
        }
    }
    async fn close(mut self) {
        let _ = self.finish_tracker();
        self.conn_cancel.cancel();
        if let Some(done) = self.conn_done.take() {
            let _ = done.await;
        }
    }
}
impl Drop for PooledConn {
    fn drop(&mut self) {
        let _ = self.finish_tracker();
        self.conn_cancel.cancel();
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
    tls: OnceCell<Option<Arc<rustls::ClientConfig>>>,
    idle: Mutex<Vec<PooledConn>>,
    cancelled: Cancellation,
}
impl Slot {
    fn cancel(&self) {
        self.cancelled.cancel();
        if let Ok(mut idle) = self.idle.lock() {
            idle.clear();
        }
    }
    fn pop_idle(&self) -> Option<PooledConn> {
        let mut idle = self.idle.lock().ok()?;
        while let Some(conn) = idle.pop() {
            if conn.last_used.elapsed() < POOL_IDLE_TIMEOUT && !conn.sender.is_closed() {
                return Some(conn);
            }
        }
        None
    }
    fn push_idle(&self, conn: PooledConn) -> Option<PooledConn> {
        let Ok(mut idle) = self.idle.lock() else {
            return Some(conn);
        };
        if self.cancelled.is_cancelled() || conn.sender.is_closed() {
            return Some(conn);
        }
        idle.retain(|c| c.last_used.elapsed() < POOL_IDLE_TIMEOUT && !c.sender.is_closed());
        if idle.len() < MAX_IDLE_PER_SLOT {
            idle.push(conn);
            None
        } else {
            Some(conn)
        }
    }
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
    verifier: OnceCell<Arc<dyn rustls::client::danger::ServerCertVerifier>>,
    #[cfg(test)]
    connect_timeout: Duration,
    #[cfg(test)]
    fixture: Option<(String, Vec<u8>)>,
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
                verifier: OnceCell::new(),
                #[cfg(test)]
                connect_timeout: CONNECT_TIMEOUT,
                #[cfg(test)]
                fixture: None,
            }),
        }
    }
    #[cfg(test)]
    fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        Arc::get_mut(&mut self.shared)
            .expect("new transport")
            .connect_timeout = timeout;
        self
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
    pub(super) fn fixture_https(origin: String, lookup: Arc<dyn Lookup>, ca_der: Vec<u8>) -> Self {
        let mut transport = Self::with_lookup(NetworkPolicy::default(), Some(lookup));
        Arc::get_mut(&mut transport.shared)
            .expect("new transport")
            .fixture = Some((origin, ca_der));
        transport
    }
    /// Operator policy changes cancel active calls and discard every old pool.
    pub fn replace_policy(&self, policy: NetworkPolicy) -> Result<(), PortError> {
        let mut state = self.shared.state.lock().map_err(|_| failed())?;
        let epoch = state.epoch.checked_add(1).ok_or_else(failed)?;
        for entry in state.clients.values() {
            entry.slot.cancel();
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
                entry.slot.cancel();
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
                    entry.slot.cancel(); false
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
            if let Some(evicted) = state.clients.remove(&oldest) {
                evicted.slot.cancel();
            }
        }
        let slot = Arc::new(Slot {
            endpoint: endpoint.clone(),
            tls: OnceCell::new(),
            idle: Mutex::new(Vec::new()),
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
        let shared = self.shared.clone();
        let lookup = self.shared.lookup.clone();
        let dns_admission = self.shared.dns_admission.clone();
        let dns_queue = self.shared.dns_queue.clone();
        #[cfg(test)]
        let connect_timeout = self.shared.connect_timeout;
        #[cfg(not(test))]
        let connect_timeout = CONNECT_TIMEOUT;
        #[cfg(test)]
        let fixture_ca = self.shared.fixture.as_ref().map(|(_, ca)| ca.clone());
        tokio::spawn(async move {
            let mut head_tx = Some(head_tx);
            let mut uploaded_tx = Some(uploaded_tx);
            let mut active_conn: Option<PooledConn> = None;
            let mut keep_alive = false;
            let result = async {
                // Platform certificate verifier initialization may touch the
                // OS trust store once per transport. Keep the active slot
                // through blocking load even if the caller times out, while
                // keeping a separate ClientConfig per Slot for TLS session isolation.
                let tls_config = context
                    .slot
                    .tls
                    .get_or_try_init(|| async {
                        if context.slot.endpoint.url().scheme() != "https" {
                            return Ok::<Option<Arc<rustls::ClientConfig>>, PortError>(None);
                        }
                        let verifier = shared
                            .verifier
                            .get_or_try_init(|| async {
                                tokio::task::spawn_blocking(move || {
                                    load_cert_verifier(
                                        #[cfg(test)]
                                        fixture_ca,
                                    )
                                })
                                .await
                                .map_err(|_| connect_failed())?
                            })
                            .await?
                            .clone();
                        Ok(Some(build_tls_config(verifier)?))
                    })
                    .await?
                    .clone();
                context.check(CommitEffect::NotCommitted)?;
                let mut pooled = context
                    .run(
                        async {
                            while let Some(mut candidate) = context.slot.pop_idle() {
                                if candidate.sender.ready().await.is_ok()
                                    && !candidate.sender.is_closed()
                                {
                                    return Ok(Some(candidate));
                                }
                                candidate.close().await;
                            }
                            Ok(None)
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                if pooled.is_none() {
                    let fresh = context
                        .run(
                            connect_fresh(
                                endpoint.clone(),
                                tls_config,
                                lookup,
                                dns_admission,
                                dns_queue,
                                connect_timeout,
                            ),
                            CommitEffect::NotCommitted,
                        )
                        .await?;
                    pooled = Some(fresh);
                }
                active_conn = pooled;
                context.check(CommitEffect::NotCommitted)?;
                preflight()?;
                let conn = active_conn.as_mut().expect("acquired connection");
                let body_bytes = Bytes::from(request.body);
                let body_empty = body_bytes.is_empty();
                let mut req_builder = Request::builder()
                    .method(request.method.clone())
                    .uri(origin_form_uri(&endpoint)?);
                let req_headers = req_builder.headers_mut().ok_or_else(connect_failed)?;
                req_headers.insert(header::HOST, host_header(&endpoint)?);
                for (name, value) in &request.headers {
                    req_headers.append(name.clone(), value.clone());
                }
                if request.method == Method::POST || !body_empty {
                    req_headers.insert(
                        header::CONTENT_LENGTH,
                        HeaderValue::from_str(&body_bytes.len().to_string())
                            .map_err(|_| connect_failed())?,
                    );
                }
                {
                    let mut guard = conn.tracker.lock().map_err(|_| connect_failed())?;
                    *guard = Some(UploadTracker {
                        body_done: body_empty,
                        wrote_bytes: false,
                        flushed: false,
                        uploaded: uploaded_tx.take(),
                    });
                }
                let tracked_body = TrackedRequestBody {
                    remaining: body_bytes,
                    tracker: conn.tracker.clone(),
                };
                let outgoing = req_builder
                    .body(tracked_body)
                    .map_err(|_| connect_failed())?;
                let response = context
                    .run(
                        async {
                            conn.sender
                                .send_request(outgoing)
                                .await
                                .map_err(|_| failed())
                        },
                        CommitEffect::Unknown,
                    )
                    .await?;
                // If response headers arrived before the request body finished
                // flushing, release wait_uploaded() immediately so the caller
                // cannot deadlock against the bounded response chunk channel,
                // while keeping `tracker.flushed` intact for socket teardown.
                conn.finish_upload_wait();
                keep_alive = response_allows_keep_alive(&response);
                header_bytes(response.headers()).map_err(|_| failed())?;
                if let Some(len) = response
                    .headers()
                    .get(header::CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    && len > request.response_limit as u64
                {
                    return Err(failed());
                }
                if response.body().size_hint().lower() > request.response_limit as u64 {
                    return Err(failed());
                }
                let status = response.status().as_u16();
                let mut headers = response.headers().clone();
                for value in headers.values_mut() {
                    value.set_sensitive(true);
                }
                head_tx
                    .take()
                    .expect("head once")
                    .send(Ok((status, headers)))
                    .map_err(|_| cancelled(CommitEffect::Unknown))?;
                let mut resp_body = response.into_body();
                let mut received = 0usize;
                while let Some(frame) = context
                    .run(
                        async {
                            tokio::time::timeout(
                                IDLE_CHUNK_TIMEOUT,
                                std::future::poll_fn(|cx| Pin::new(&mut resp_body).poll_frame(cx)),
                            )
                            .await
                            .map_err(|_| failed())?
                            .transpose()
                            .map_err(|_| failed())
                        },
                        CommitEffect::Unknown,
                    )
                    .await?
                {
                    let Ok(chunk) = frame.into_data() else {
                        continue;
                    };
                    if chunk.is_empty() {
                        continue;
                    }
                    received = received.checked_add(chunk.len()).ok_or_else(failed)?;
                    if received > request.response_limit {
                        return Err(failed());
                    }
                    for part in chunk.chunks(CHUNK_BYTES) {
                        context
                            .run(
                                async {
                                    tokio::time::timeout(
                                        IDLE_CHUNK_TIMEOUT,
                                        chunks_tx.send(part.to_vec()),
                                    )
                                    .await
                                    .map_err(|_| failed())?
                                    .map_err(|_| cancelled(CommitEffect::Unknown))
                                },
                                CommitEffect::Unknown,
                            )
                            .await?;
                    }
                }
                Ok(())
            }
            .await;
            drop(uploaded_tx);
            if let Some(mut conn) = active_conn.take() {
                let upload_flushed = conn.finish_tracker();
                if result.is_ok()
                    && upload_flushed
                    && keep_alive
                    && !context.slot.cancelled.is_cancelled()
                    && !conn.sender.is_closed()
                {
                    conn.last_used = Instant::now();
                    if let Some(rejected) = context.slot.push_idle(conn) {
                        rejected.close().await;
                    }
                } else {
                    conn.close().await;
                }
            }
            if let Some(head_tx) = head_tx {
                let _ = head_tx.send(Err(result.as_ref().err().cloned().unwrap_or_else(failed)));
            }
            let _ = end_tx.send(result);
            // Connection shutdown, pool return and active admission are owned
            // here. An unpolled consumer cannot keep a socket alive past the
            // budget, and `close()` does not return until aborted sockets drop.
            drop(context);
            let _ = closed_tx.send(());
        });
        Ok(OutboundResponse {
            status: 0,
            headers: HeaderMap::new(),
            head: Some(head_rx),
            uploaded: UploadWait::Pending(uploaded_rx),
            budget,
            closed: closed_rx,
            chunks: chunks_rx,
            end: Some(end_rx),
            finished: false,
            _guard: guard,
        })
    }
}

fn origin_form_uri(endpoint: &CheckedEndpoint) -> Result<Uri, PortError> {
    let mut path_and_query = endpoint.url().path().to_owned();
    if path_and_query.is_empty() {
        path_and_query.push('/');
    }
    if let Some(query) = endpoint.url().query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    path_and_query.parse().map_err(|_| connect_failed())
}

fn host_header(endpoint: &CheckedEndpoint) -> Result<HeaderValue, PortError> {
    let host = endpoint.url().host_str().ok_or_else(connect_failed)?;
    let value = match endpoint.url().port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    HeaderValue::from_str(&value).map_err(|_| connect_failed())
}

fn load_cert_verifier(
    #[cfg(test)] fixture_ca: Option<Vec<u8>>,
) -> Result<Arc<dyn rustls::client::danger::ServerCertVerifier>, PortError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    #[cfg(test)]
    if let Some(der) = fixture_ca {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(der))
            .map_err(|_| connect_failed())?;
        let verifier =
            rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .map_err(|_| connect_failed())?;
        return Ok(verifier);
    }
    let verifier =
        rustls_platform_verifier::Verifier::new(provider).map_err(|_| connect_failed())?;
    Ok(Arc::new(verifier))
}

fn build_tls_config(
    verifier: Arc<dyn rustls::client::danger::ServerCertVerifier>,
) -> Result<Arc<rustls::ClientConfig>, PortError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| connect_failed())?
    .dangerous()
    .with_custom_certificate_verifier(verifier)
    .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config.key_log = Arc::new(rustls::NoKeyLog {});
    Ok(Arc::new(config))
}

async fn connect_fresh(
    endpoint: CheckedEndpoint,
    tls_config: Option<Arc<rustls::ClientConfig>>,
    lookup: Option<Arc<dyn Lookup>>,
    dns_admission: Arc<Semaphore>,
    dns_queue: Arc<Semaphore>,
    connect_timeout: Duration,
) -> Result<PooledConn, PortError> {
    let port = endpoint
        .url()
        .port_or_known_default()
        .ok_or_else(connect_failed)?;
    let connect_deadline = Instant::now() + connect_timeout;
    let stream = tokio::time::timeout_at(connect_deadline, async {
        let addrs: Vec<SocketAddr> = match endpoint.url().host().ok_or_else(connect_failed)? {
            Host::Ipv4(ip) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
            Host::Ipv6(ip) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
            Host::Domain(host) => {
                let resolver = GuardedResolver::with_admission(
                    endpoint.clone(),
                    lookup.unwrap_or_else(GuardedResolver::default_lookup),
                    dns_admission,
                    dns_queue,
                );
                resolver
                    .resolve_addrs(host)
                    .await
                    .map_err(|_| connect_failed())?
                    .into_iter()
                    .map(|addr| SocketAddr::new(addr.ip(), port))
                    .collect()
            }
        };
        let mut connected = None;
        let total = addrs.len();
        for (index, addr) in addrs.into_iter().enumerate() {
            let remaining = connect_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let left = (total - index) as u32;
            let per_addr = if left > 1 {
                (remaining / left)
                    .max(Duration::from_millis(250))
                    .min(remaining)
            } else {
                remaining
            };
            if let Ok(Ok(tcp)) = tokio::time::timeout(per_addr, TcpStream::connect(addr)).await {
                let _ = tcp.set_nodelay(true);
                connected = Some(tcp);
                break;
            }
        }
        let tcp = connected.ok_or_else(connect_failed)?;
        if let Some(tls_cfg) = tls_config {
            let server_name = match endpoint.url().host().ok_or_else(connect_failed)? {
                Host::Domain(host) => rustls::pki_types::ServerName::try_from(
                    host.strip_suffix('.').unwrap_or(host).to_owned(),
                )
                .map_err(|_| connect_failed())?,
                Host::Ipv4(ip) => rustls::pki_types::ServerName::IpAddress(ip.into()),
                Host::Ipv6(ip) => rustls::pki_types::ServerName::IpAddress(ip.into()),
            };
            let tls = TlsConnector::from(tls_cfg)
                .connect(server_name, tcp)
                .await
                .map_err(|_| connect_failed())?;
            Ok::<TransportStream, PortError>(TransportStream::Tls(Box::new(tls)))
        } else {
            Ok(TransportStream::Plain(tcp))
        }
    })
    .await
    .map_err(|_| connect_failed())??;
    let tracker = Arc::new(Mutex::new(None));
    let tracked = TrackedIo::new(stream, tracker.clone());
    let (sender, conn) = http1::Builder::new()
        .max_headers(100)
        .handshake(TokioIo::new(tracked))
        .await
        .map_err(|_| connect_failed())?;
    let conn_cancel = Cancellation::default();
    let (conn_done_tx, conn_done_rx) = oneshot::channel();
    let driver_cancel = conn_cancel.clone();
    tokio::spawn(async move {
        tokio::select! {
            biased;
            () = driver_cancel.cancelled() => {}
            _ = conn => {}
        }
        let _ = conn_done_tx.send(());
    });
    Ok(PooledConn {
        sender,
        tracker,
        conn_cancel,
        conn_done: Some(conn_done_rx),
        last_used: Instant::now(),
    })
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
    fn check(&self, effect: CommitEffect) -> Result<(), PortError> {
        self.budget.check(effect)?;
        if self.dropped.is_cancelled() || self.slot.cancelled.is_cancelled() {
            return Err(cancelled(effect));
        }
        Ok(())
    }
    async fn run<T>(
        &self,
        operation: impl Future<Output = Result<T, PortError>>,
        effect: CommitEffect,
    ) -> Result<T, PortError> {
        self.check(effect)?;
        let wait_for = self.budget.remaining_now();
        tokio::select! {
            biased;
            () = self.budget.cancellation().cancelled() => {
                Err(self.budget.check(effect).expect_err("budget cancelled"))
            }
            () = self.dropped.cancelled() => Err(cancelled(effect)),
            () = self.slot.cancelled.cancelled() => Err(cancelled(effect)),
            () = tokio::time::sleep(wait_for) => {
                while self.budget.remaining_now() > Duration::ZERO {
                    tokio::time::sleep(self.budget.remaining_now()).await;
                }
                Err(self.budget.check(effect).expect_err("budget expired"))
            }
            result = operation => {
                // The driver's timer can finish between wakeups. Keep the
                // current caller deadline/cancellation as the terminal cause.
                self.check(effect)?;
                result
            },
        }
    }
}

enum UploadWait {
    Pending(oneshot::Receiver<()>),
    Done(bool),
}

/// A bounded stream whose producer owns cancellation, sockets and admission.
/// Dropping it stops the worker; retaining it without polling cannot suspend
/// absolute/idle deadlines. Headers are marked sensitive and are not Debugged.
pub struct OutboundResponse {
    status: u16,
    headers: HeaderMap,
    head: Option<oneshot::Receiver<Result<(u16, HeaderMap), PortError>>>,
    uploaded: UploadWait,
    budget: OperationBudget,
    closed: oneshot::Receiver<()>,
    chunks: mpsc::Receiver<Vec<u8>>,
    end: Option<oneshot::Receiver<Result<(), PortError>>>,
    finished: bool,
    _guard: CancelOnDrop,
}
impl OutboundResponse {
    /// Wait until preflight, connection establishment, and request-body flush
    /// to the underlying socket complete (`Ok(true)`), or the request fails
    /// before upload finishes (`Ok(false)`).
    pub(crate) async fn wait_uploaded(&mut self) -> Result<bool, PortError> {
        match &mut self.uploaded {
            UploadWait::Done(sent) => Ok(*sent),
            UploadWait::Pending(uploaded) => {
                let sent = self
                    .budget
                    .run(async { Ok(uploaded.await.is_ok()) }, CommitEffect::Unknown)
                    .await?;
                self.uploaded = UploadWait::Done(sent);
                Ok(sent)
            }
        }
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
    /// dropped its HTTP response, request future, and aborted socket. Do not
    /// cancel this wait while holding authority that must exclude in-flight
    /// application bytes.
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
