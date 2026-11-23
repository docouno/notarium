use super::*;
use crate::outbound::{PrivateNetworkRule, ProviderWire};
use notarium_core::ids::RequestId;
use std::{
    io,
    net::SocketAddr,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
    task::{JoinHandle, JoinSet},
};

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([1; 16]),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(10),
    }
}
fn scope(resource: u8, epoch: u64) -> OutboundScope {
    OutboundScope::Provider {
        resource: ProviderResourceId::from_bytes([resource; 16]),
        runtime_epoch: epoch,
        credential_epoch: None,
        wire: ProviderWire::Ollama,
    }
}
fn request(resource: u8, epoch: u64, url: &str, secret: &str) -> OutboundRequest {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", secret.parse().unwrap());
    OutboundRequest {
        scope: scope(resource, epoch),
        url: url.into(),
        method: Method::POST,
        headers,
        body: b"fixture request".to_vec(),
        response_limit: 1024 * 1024,
    }
}
async fn body(mut response: OutboundResponse) -> Vec<u8> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.next_chunk().await.unwrap() {
        bytes.extend(chunk);
    }
    bytes
}
struct Dns {
    calls: AtomicUsize,
    answers: Vec<Vec<SocketAddr>>,
}
impl Dns {
    fn new(answers: &[&[&str]]) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            answers: answers
                .iter()
                .map(|answer| answer.iter().map(|value| value.parse().unwrap()).collect())
                .collect(),
        })
    }
}
impl Lookup for Dns {
    fn addresses(&self, _: &str) -> io::Result<Vec<SocketAddr>> {
        let index = self
            .calls
            .fetch_add(1, Ordering::SeqCst)
            .min(self.answers.len() - 1);
        Ok(self.answers[index].clone())
    }
}
#[derive(Clone)]
enum Reply {
    Static {
        status: u16,
        headers: String,
        body: Vec<u8>,
        close: bool,
    },
    StallHeaders,
    StallBody,
    UnboundedBody,
    DisconnectAfterRequest,
}
#[derive(Clone)]
struct Seen {
    connection: usize,
    headers: String,
    body: Vec<u8>,
}
struct Server {
    address: SocketAddr,
    connections: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<Seen>>>,
    notify: Arc<Notify>,
    reply: Arc<Mutex<Reply>>,
    task: JoinHandle<()>,
}
impl Server {
    async fn new(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let notify = Arc::new(Notify::new());
        let reply = Arc::new(Mutex::new(reply));
        let task = {
            let connections = connections.clone();
            let requests = requests.clone();
            let notify = notify.clone();
            let reply = reply.clone();
            tokio::spawn(async move {
                let mut children = JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let (stream, _) = accepted.unwrap();
                            let connection = connections.fetch_add(1, Ordering::SeqCst);
                            let requests=requests.clone(); let notify=notify.clone(); let reply=reply.clone();
                            children.spawn(async move { serve(stream, connection, requests, notify, reply).await });
                        },
                        _ = children.join_next(), if !children.is_empty() => {},
                    }
                }
            })
        };
        Self {
            address,
            connections,
            requests,
            notify,
            reply,
            task,
        }
    }
    fn origin(&self, host: &str) -> String {
        format!("http://{host}:{}", self.address.port())
    }
    async fn count(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.notify.notified();
                if self.requests.lock().unwrap().len() >= count {
                    break;
                }
                notified.await;
            }
        })
        .await
        .unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn serve(
    mut stream: TcpStream,
    connection: usize,
    requests: Arc<Mutex<Vec<Seen>>>,
    notify: Arc<Notify>,
    reply: Arc<Mutex<Reply>>,
) {
    loop {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let Ok(byte) = stream.read_u8().await else {
                return;
            };
            head.push(byte);
            if head.len() > 20 * 1024 {
                return;
            }
        }
        let head = String::from_utf8(head).unwrap();
        let length: usize = head
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|n| n.trim().parse().unwrap())
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        if stream.read_exact(&mut body).await.is_err() {
            return;
        }
        requests.lock().unwrap().push(Seen {
            connection,
            headers: head,
            body,
        });
        notify.notify_one();
        let current = reply.lock().unwrap().clone();
        let response = match current {
            Reply::DisconnectAfterRequest => return,
            Reply::Static {
                status,
                headers,
                body,
                close,
            } => {
                let mut response = format!(
                    "HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\n{headers}{}\r\n",
                    body.len(),
                    if close { "Connection: close\r\n" } else { "" }
                )
                .into_bytes();
                response.extend(body);
                if stream.write_all(&response).await.is_err() || close {
                    return;
                }
                continue;
            }
            Reply::StallHeaders => {
                std::future::pending::<()>().await;
                return;
            }
            Reply::StallBody => b"HTTP/1.1 200 fixture\r\nContent-Length: 1000000\r\n\r\n".to_vec(),
            Reply::UnboundedBody => {
                let mut response = b"HTTP/1.1 200 fixture\r\nConnection: close\r\n\r\n".to_vec();
                response.extend(vec![b'x'; 128 * 1024]);
                let _ = stream.write_all(&response).await;
                return;
            }
        };
        if stream.write_all(&response).await.is_err() {
            return;
        }
        std::future::pending::<()>().await;
    }
}
fn normal() -> Reply {
    Reply::Static {
        status: 200,
        headers: String::new(),
        body: b"done".to_vec(),
        close: false,
    }
}
fn policy(origin: &str, resources: &[u8]) -> NetworkPolicy {
    NetworkPolicy::new(
        resources
            .iter()
            .map(|resource| {
                PrivateNetworkRule::new(
                    ProviderResourceId::from_bytes([*resource; 16]),
                    origin,
                    vec!["127.0.0.1/32".parse().unwrap()],
                )
                .unwrap()
            })
            .collect(),
    )
    .unwrap()
}
fn transport(origin: &str, resources: &[u8], dns: Arc<Dns>) -> OutboundTransport {
    OutboundTransport::with_lookup(policy(origin, resources), Some(dns))
}
async fn released(client: &OutboundTransport) {
    let expected = client.max_active_requests();
    tokio::time::timeout(Duration::from_secs(5), async {
        while client.available_permits() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn worker_for_completion_test(remaining: Duration) -> (OutboundTransport, Worker) {
    let origin = "http://127.0.0.1:38117";
    let client = transport(origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));
    let (slot, _) = client.slot(scope(1, 1), origin).unwrap();
    let permit = client
        .shared
        .send_admission
        .clone()
        .try_acquire_owned()
        .unwrap();
    let mut call = budget();
    call.remaining = remaining;
    (
        client,
        Worker {
            budget: OperationBudget::new(call),
            slot,
            dropped: Cancellation::default(),
            _permit: permit,
        },
    )
}

#[tokio::test]
async fn operation_completion_preserves_current_deadline_and_cancellation() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let (client, worker) = worker_for_completion_test(Duration::from_secs(1));
    worker
        .run(async { Ok(()) }, CommitEffect::Unknown)
        .await
        .unwrap();
    assert!(matches!(
        worker
            .run(async { Err::<(), _>(failed()) }, CommitEffect::Unknown)
            .await,
        Err(PortError::Unavailable(_))
    ));
    drop(worker);
    released(&client).await;

    for success in [false, true] {
        let (client, worker) = worker_for_completion_test(Duration::from_millis(20));
        let mut entered = false;
        let result = worker
            .run(
                async {
                    entered = true;
                    // Complete in one poll after expiry, before the watchdog can
                    // poll its timer again. Exercise both successful and failed I/O.
                    std::thread::sleep(Duration::from_millis(40));
                    if success { Ok(()) } else { Err(failed()) }
                },
                CommitEffect::Unknown,
            )
            .await;
        assert!(entered, "the operation must reach its completion boundary");
        assert!(
            matches!(result, Err(PortError::DeadlineExceeded(_))),
            "{result:?}"
        );
        drop(worker);
        released(&client).await;
    }

    for invalidate_epoch in [false, true] {
        let (client, worker) = worker_for_completion_test(Duration::from_secs(1));
        let cancelled = if invalidate_epoch {
            worker.slot.cancelled.clone()
        } else {
            worker.dropped.clone()
        };
        let result = worker
            .run(
                async {
                    cancelled.cancel();
                    Ok(())
                },
                CommitEffect::Unknown,
            )
            .await;
        assert!(matches!(result, Err(PortError::Cancelled(_))), "{result:?}");
        drop(worker);
        released(&client).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_connector_uses_checked_addresses_and_isolates_pools_and_epochs() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let server = Server::new(normal()).await;
    let origin = server.origin("pinned.invalid");
    let dns = Dns::new(&[&["127.0.0.1:1"]]);
    let transport = transport(&origin, &[1, 2], dns.clone());
    let url = format!("{origin}/api/chat");
    for (resource, secret) in [(1, "Bearer A"), (1, "Bearer A"), (2, "Bearer B")] {
        assert_eq!(
            body(
                transport
                    .send(budget(), request(resource, 1, &url, secret))
                    .await
                    .unwrap()
            )
            .await,
            b"done"
        );
    }
    let seen = server.requests.lock().unwrap().clone();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[0].connection, seen[1].connection);
    assert_ne!(seen[0].connection, seen[2].connection);
    assert!(seen[0].headers.contains("Bearer A"));
    assert!(seen[2].headers.contains("Bearer B"));
    assert!(
        seen.iter()
            .all(|request| request.body == b"fixture request")
    );
    assert_eq!(
        dns.calls.load(Ordering::SeqCst),
        2,
        "pooled connections must not perform an unrelated second lookup"
    );
    assert_eq!(
        body(
            transport
                .send(budget(), request(1, 2, &url, "Bearer C"))
                .await
                .unwrap()
        )
        .await,
        b"done"
    );
    assert_ne!(
        server.requests.lock().unwrap()[3].connection,
        seen[0].connection
    );
    assert!(
        transport
            .send(budget(), request(1, 1, &url, "Bearer A"))
            .await
            .is_err()
    );
    assert_eq!(server.requests.lock().unwrap().len(), 4);
    transport.replace_policy(NetworkPolicy::default()).unwrap();
    assert!(
        transport
            .send(budget(), request(1, 2, &url, "Bearer C"))
            .await
            .is_err()
    );
    released(&transport).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_epoch_rotation_replaces_pool_without_reviving_the_old_epoch() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let server = Server::new(normal()).await;
    let origin = server.origin("127.0.0.1");
    let client = transport(&origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));
    let make = |epoch| {
        let mut request = request(1, 1, &origin, "fixture secret");
        if let OutboundScope::Provider {
            credential_epoch, ..
        } = &mut request.scope
        {
            *credential_epoch = Some(epoch);
        }
        request
    };
    for epoch in [1, 2] {
        assert_eq!(
            body(client.send(budget(), make(epoch)).await.unwrap()).await,
            b"done"
        );
    }
    assert!(client.send(budget(), make(1)).await.is_err());
    {
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_ne!(requests[0].connection, requests[1].connection);
    }
    released(&client).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirects_dns_rebinding_mixed_answers_and_metadata_do_not_reach_denied_sockets() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let target = Server::new(normal()).await;
    let source = Server::new(Reply::Static {
        status: 302,
        headers: format!("Location: {}/redirected\r\n", target.origin("127.0.0.1")),
        body: vec![],
        close: true,
    })
    .await;
    let origin = source.origin("rebind.invalid");
    let dns = Dns::new(&[&["127.0.0.1:123"], &["169.254.169.254:123"]]);
    let client = transport(&origin, &[1], dns.clone());
    let response = client
        .send(budget(), request(1, 1, &origin, "secret"))
        .await
        .unwrap();
    assert_eq!(response.status(), 302);
    assert!(body(response).await.is_empty());
    assert!(
        client
            .send(budget(), request(1, 1, &origin, "secret"))
            .await
            .is_err()
    );
    assert_eq!(dns.calls.load(Ordering::SeqCst), 2);
    assert_eq!(source.connections.load(Ordering::SeqCst), 1);
    assert_eq!(target.connections.load(Ordering::SeqCst), 0);
    let mixed = transport(
        &origin,
        &[1],
        Dns::new(&[&["127.0.0.1:0", "169.254.169.254:0"]]),
    );
    assert!(
        matches!(mixed.send(budget(), request(1, 1, &origin, "secret")).await,
        Err(PortError::Unavailable(failure)) if failure.effect() == CommitEffect::NotCommitted)
    );
    assert_eq!(source.connections.load(Ordering::SeqCst), 1);
    let mut metadata = request(
        1,
        1,
        &format!("https://127.0.0.1:{}", target.address.port()),
        "secret",
    );
    metadata.scope = OutboundScope::Cimd;
    metadata.method = Method::GET;
    metadata.body.clear();
    metadata.response_limit = 65536;
    assert!(client.send(budget(), metadata).await.is_err());
    assert_eq!(target.connections.load(Ordering::SeqCst), 0);
    released(&client).await;
    released(&mixed).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn literal_path_stream_limits_deadlines_and_epoch_cancellation_release_real_calls() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let server = Server::new(Reply::StallBody).await;
    let origin = server.origin("127.0.0.1");
    let dns = Dns::new(&[&["169.254.169.254:0"]]);
    let client = transport(&origin, &[1], dns.clone());
    for attempt in 0..16 {
        let mut call = budget();
        call.remaining = Duration::from_millis(250);
        let mut response = client
            .send(call, request(1, 1, &origin, "secret"))
            .await
            .unwrap();
        // Keep an unpolled response. Its worker still closes on the absolute
        // budget, regardless of which timer first observes that deadline.
        released(&client).await;
        let result = response.next_chunk().await;
        assert!(
            matches!(result, Err(PortError::DeadlineExceeded(_))),
            "deadline attempt {attempt}: {result:?}"
        );
    }
    assert_eq!(
        dns.calls.load(Ordering::SeqCst),
        0,
        "literal addresses must use the literal policy path"
    );
    let mut response = client
        .send(budget(), request(1, 1, &origin, "secret"))
        .await
        .unwrap();
    *server.reply.lock().unwrap() = normal();
    assert_eq!(
        body(
            client
                .send(budget(), request(1, 2, &origin, "new secret"))
                .await
                .unwrap()
        )
        .await,
        b"done"
    );
    assert!(matches!(
        response.next_chunk().await,
        Err(PortError::Cancelled(_))
    ));
    *server.reply.lock().unwrap() = Reply::StallBody;
    let mut response = client
        .send(budget(), request(1, 2, &origin, "secret"))
        .await
        .unwrap();
    client
        .invalidate_provider(&ProviderResourceId::from_bytes([1; 16]))
        .unwrap();
    released(&client).await;
    assert!(matches!(
        response.next_chunk().await,
        Err(PortError::Cancelled(_))
    ));
    *server.reply.lock().unwrap() = Reply::UnboundedBody;
    let mut small = request(1, 3, &origin, "secret");
    small.response_limit = 1024;
    let mut response = client.send(budget(), small).await.unwrap();
    let mut received = 0;
    loop {
        match response.next_chunk().await {
            Ok(Some(bytes)) => received += bytes.len(),
            Err(_) => break,
            Ok(None) => panic!("oversized response accepted"),
        }
    }
    assert!(received <= 1024);
    *server.reply.lock().unwrap() = Reply::Static {
        status: 200,
        headers: format!("X-Secret: {}\r\n", "s".repeat(17000)),
        body: vec![],
        close: false,
    };
    assert!(
        client
            .send(budget(), request(1, 3, &origin, "secret"))
            .await
            .is_err()
    );
    *server.reply.lock().unwrap() = Reply::DisconnectAfterRequest;
    let before = server.requests.lock().unwrap().len();
    let result = client
        .send(
            budget(),
            request(
                1,
                3,
                &format!("{origin}/?fixture=URL_SECRET"),
                "HEADER_SECRET",
            ),
        )
        .await;
    let Err(error) = result else {
        panic!("disconnected request must fail");
    };
    assert!(
        matches!(&error,PortError::Unavailable(failure) if failure.effect() == CommitEffect::Unknown)
    );
    let diagnostic = format!("{error:?}");
    assert!(!diagnostic.contains("URL_SECRET") && !diagnostic.contains("HEADER_SECRET"));
    assert_eq!(
        server.requests.lock().unwrap().len(),
        before + 1,
        "a POST received before disconnect must not be replayed"
    );
    released(&client).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_call_limit_survives_caller_drop_and_idle_pool_cache_is_bounded() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let server = Server::new(Reply::StallHeaders).await;
    let origin = server.origin("127.0.0.1");
    let client = OutboundTransport::with_lookup_and_limit(
        policy(&origin, &[1]),
        Some(Dns::new(&[&["127.0.0.1:0"]])),
        64,
    );
    let mut jobs = Vec::new();
    for _ in 0..64 {
        let client = client.clone();
        let origin = origin.clone();
        jobs.push(tokio::spawn(async move {
            client
                .send(budget(), request(1, 1, &origin, "secret"))
                .await
        }));
    }
    server.count(64).await;
    assert!(matches!(
        client
            .send(budget(), request(1, 1, &origin, "secret"))
            .await,
        Err(PortError::Domain(DomainError::RateLimited { .. }))
    ));
    for job in jobs {
        job.abort();
        assert!(job.await.is_err());
    }
    released(&client).await;
    let client = OutboundTransport::new(NetworkPolicy::default());
    for n in 0..140 {
        client
            .slot(OutboundScope::Cimd, &format!("https://host{n}.example/"))
            .unwrap();
    }
    assert_eq!(client.shared.state.lock().unwrap().clients.len(), 128);
    let mut active = Vec::new();
    for n in 140..268 {
        active.push(
            client
                .slot(OutboundScope::Cimd, &format!("https://host{n}.example/"))
                .unwrap(),
        );
    }
    assert!(matches!(
        client.slot(OutboundScope::Cimd, "https://overflow.example/"),
        Err(PortError::Domain(DomainError::RateLimited { .. }))
    ));
    drop(active);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_uploaded_waits_for_socket_flush_under_backpressure_and_releases_before_ttfb() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(8 * 1024).unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(4).unwrap();
    let addr = listener.local_addr().unwrap();
    let origin = format!("http://127.0.0.1:{}", addr.port());
    let client = transport(&origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));

    let drain_body = Arc::new(Notify::new());
    let send_reply = Arc::new(Notify::new());
    let body_received = Arc::new(Notify::new());
    let drain_body_srv = drain_body.clone();
    let send_reply_srv = send_reply.clone();
    let body_received_srv = body_received.clone();

    let server_task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        // Hold accepted TCP connection without reading so upload stalls on TCP backpressure.
        drain_body_srv.notified().await;
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.unwrap());
        }
        let head = String::from_utf8(head).unwrap();
        let len: usize = head
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|n| n.trim().parse().unwrap())
            })
            .unwrap();
        let mut buf = vec![0u8; 64 * 1024];
        let mut remaining = len;
        while remaining > 0 {
            let take = remaining.min(buf.len());
            let n = stream.read(&mut buf[..take]).await.unwrap();
            assert!(n > 0, "unexpected EOF while draining request body");
            remaining -= n;
        }
        body_received_srv.notify_one();
        // Deliberately stall before writing response headers (TTFB).
        send_reply_srv.notified().await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });

    let mut req = request(1, 1, &format!("{origin}/upload"), "secret");
    // 6 MiB comfortably exceeds hyper's ~408 KiB WriteBuf plus Linux loopback socket buffers.
    req.body = vec![b'a'; 6 * 1024 * 1024];
    let mut response = client.start(budget(), req).unwrap();

    // While server refuses to read, upload MUST remain pending.
    assert!(
        tokio::time::timeout(Duration::from_millis(150), response.wait_uploaded())
            .await
            .is_err(),
        "wait_uploaded must not resolve before the request body flushes to the socket"
    );

    // Let server drain request body, but keep response headers stalled (TTFB).
    drain_body.notify_one();
    tokio::time::timeout(Duration::from_secs(5), body_received.notified())
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), response.wait_uploaded())
            .await
            .unwrap()
            .unwrap(),
        "wait_uploaded must resolve Ok(true) once body flushes and before TTFB"
    );

    // Release response headers and verify complete roundtrip.
    send_reply.notify_one();
    response.receive_head().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(body(response).await, b"ok");
    server_task.await.unwrap();
    released(&client).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_uploaded_returns_false_on_connect_preflight_and_mid_upload_failures() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    // 1. Connect/DNS failure on both GET and POST -> wait_uploaded() returns Ok(false).
    let blocked_origin = "http://blocked.invalid:49999";
    let blocked_client = transport(blocked_origin, &[1], Dns::new(&[&["169.254.169.254:0"]]));
    for method in [Method::GET, Method::POST] {
        let mut req = request(1, 1, blocked_origin, "secret");
        req.method = method.clone();
        if method == Method::GET {
            req.body.clear();
        }
        let mut response = blocked_client.start(budget(), req).unwrap();
        assert!(!response.wait_uploaded().await.unwrap());
        assert!(matches!(
            response.receive_head().await,
            Err(PortError::Unavailable(failure)) if failure.effect() == CommitEffect::NotCommitted
        ));
        response.close().await.unwrap();
    }
    released(&blocked_client).await;

    // 2. Failing preflight on both GET and POST -> wait_uploaded() returns Ok(false), 0 requests hit server.
    let server = Server::new(Reply::StallHeaders).await;
    let origin = server.origin("127.0.0.1");
    let client = transport(&origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));
    for method in [Method::GET, Method::POST] {
        let mut req = request(1, 1, &origin, "secret");
        req.method = method.clone();
        if method == Method::GET {
            req.body.clear();
        }
        let mut response = client
            .start_checked(budget(), req, || Err(DomainError::CrossSpaceTainted.into()))
            .unwrap();
        assert!(!response.wait_uploaded().await.unwrap());
        assert!(matches!(
            response.receive_head().await,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
        response.close().await.unwrap();
    }
    assert_eq!(server.requests.lock().unwrap().len(), 0);

    // 3. Empty GET against a server that stalls headers -> wait_uploaded() returns Ok(true) after headers flush.
    let mut get_req = request(1, 1, &origin, "secret");
    get_req.method = Method::GET;
    get_req.body.clear();
    let mut response = client.start(budget(), get_req).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), response.wait_uploaded())
            .await
            .unwrap()
            .unwrap()
    );
    server.count(1).await;
    response.close().await.unwrap();
    released(&client).await;

    // 4. Mid-upload cancellation via invalidate_provider -> wait_uploaded() returns Ok(false), never Ok(true).
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(8 * 1024).unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(4).unwrap();
    let stall_origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let stall_client = transport(&stall_origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));
    let hold_conn = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    let mut big_req = request(1, 1, &format!("{stall_origin}/abort"), "secret");
    big_req.body = vec![b'z'; 6 * 1024 * 1024];
    let mut response = stall_client.start(budget(), big_req).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(120), response.wait_uploaded())
            .await
            .is_err()
    );
    stall_client
        .invalidate_provider(&ProviderResourceId::from_bytes([1; 16]))
        .unwrap();
    assert!(
        !tokio::time::timeout(Duration::from_secs(5), response.wait_uploaded())
            .await
            .unwrap()
            .unwrap(),
        "aborted mid-upload request must return Ok(false)"
    );
    assert!(matches!(
        response.receive_head().await,
        Err(PortError::Cancelled(_))
    ));
    response.close().await.unwrap();
    hold_conn.abort();
    released(&stall_client).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn early_http_response_during_upload_closes_socket_before_close_returns() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(8 * 1024).unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(4).unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let client = transport(&origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));

    let close_done = Arc::new(Notify::new());
    let close_done_srv = close_done.clone();
    let server_task = tokio::spawn(async move {
        // Connection 1: read request headers ONLY, immediately return 401 with
        // Content-Length: 0 and NO Connection: close while 6 MiB upload stalls.
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.unwrap());
        }
        stream
            .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        // Wait until client finishes response.close(), then verify the peer
        // closed the socket instead of parking a still-writing upload in slot.idle.
        close_done_srv.notified().await;
        let mut drained = 0usize;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(n)) => drained += n,
                Err(_) => panic!("client left upload socket open after response.close()"),
            }
        }
        assert!(
            drained < 6 * 1024 * 1024,
            "aborted early-response upload must not stream the full 6 MiB payload (got {drained})"
        );
        // Connection 2: follow-up request must arrive on a fresh TCP connection cleanly.
        let (mut second, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut head2 = Vec::new();
        while !head2.ends_with(b"\r\n\r\n") {
            head2.push(second.read_u8().await.unwrap());
        }
        let mut body2 = vec![0u8; b"fixture request".len()];
        second.read_exact(&mut body2).await.unwrap();
        second
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });

    let mut big_req = request(1, 1, &format!("{origin}/early-401"), "secret");
    big_req.body = vec![b'x'; 6 * 1024 * 1024];
    let mut response = client.start(budget(), big_req).unwrap();
    // Because the server replies immediately without reading the 6 MiB body,
    // wait_uploaded() must resolve Ok(false) (NOT Ok(true)).
    assert!(
        !tokio::time::timeout(Duration::from_secs(5), response.wait_uploaded())
            .await
            .unwrap()
            .unwrap(),
        "early response before body flush must return wait_uploaded() == Ok(false)"
    );
    response.receive_head().await.unwrap();
    assert_eq!(response.status(), 401);
    response.close().await.unwrap();
    close_done.notify_one();

    // A follow-up request on the same Slot must succeed immediately on a fresh socket.
    let followup = client
        .send(budget(), request(1, 1, &format!("{origin}/next"), "secret"))
        .await
        .unwrap();
    assert_eq!(followup.status(), 200);
    assert_eq!(body(followup).await, b"ok");
    server_task.await.unwrap();
    released(&client).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn early_multi_chunk_http_response_during_upload_does_not_deadlock_wait_uploaded() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(8 * 1024).unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(4).unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let client = transport(&origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));

    let close_done = Arc::new(Notify::new());
    let close_done_srv = close_done.clone();
    let server_task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(stream.read_u8().await.unwrap());
        }
        // Send an early 401 with >128 KiB across multiple chunks (exceeding the
        // bounded mpsc::channel(1) capacity) while the 6 MiB upload is stalled.
        let chunk_payload = vec![b'e'; 48 * 1024];
        let mut early = b"HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for _ in 0..4 {
            early.extend_from_slice(format!("{:x}\r\n", chunk_payload.len()).as_bytes());
            early.extend_from_slice(&chunk_payload);
            early.extend_from_slice(b"\r\n");
        }
        early.extend_from_slice(b"0\r\n\r\n");
        stream.write_all(&early).await.unwrap();
        close_done_srv.notified().await;
        let mut drained = 0usize;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(n)) => drained += n,
                Err(_) => panic!("client left upload socket open after response.close()"),
            }
        }
        assert!(
            drained < 6 * 1024 * 1024,
            "aborted early-response upload must not stream the full 6 MiB payload (got {drained})"
        );
    });

    let mut big_req = request(1, 1, &format!("{origin}/early-401-chunked"), "secret");
    big_req.body = vec![b'x'; 6 * 1024 * 1024];
    let mut response = client.start(budget(), big_req).unwrap();
    // wait_uploaded() must resolve immediately as Ok(false) rather than
    // deadlocking against chunks_tx backpressure until IDLE_CHUNK_TIMEOUT.
    assert!(
        !tokio::time::timeout(Duration::from_secs(3), response.wait_uploaded())
            .await
            .unwrap()
            .unwrap(),
        "early multi-chunk response before body flush must return Ok(false)"
    );
    assert!(
        !response.wait_uploaded().await.unwrap(),
        "repeated wait_uploaded() calls must preserve Ok(false)"
    );
    response.receive_head().await.unwrap();
    assert_eq!(response.status(), 401);
    response.close().await.unwrap();
    close_done.notify_one();
    server_task.await.unwrap();
    released(&client).await;
}

#[test]
fn response_keep_alive_framing_checks_rfc_9112_and_header_encoding() {
    let non_utf8_conn = http::Response::builder()
        .status(200)
        .header(header::CONTENT_LENGTH, "0")
        .header(
            header::CONNECTION,
            HeaderValue::from_bytes(b"\xff").unwrap(),
        )
        .body(())
        .unwrap();
    assert!(!response_allows_keep_alive(&non_utf8_conn));

    let te_without_chunked_and_cl = http::Response::builder()
        .status(200)
        .header(header::TRANSFER_ENCODING, "gzip")
        .header(header::CONTENT_LENGTH, "4")
        .body(())
        .unwrap();
    assert!(!response_allows_keep_alive(&te_without_chunked_and_cl));

    let te_chunked = http::Response::builder()
        .status(200)
        .header(header::TRANSFER_ENCODING, "gzip, chunked")
        .body(())
        .unwrap();
    assert!(response_allows_keep_alive(&te_chunked));

    let no_content = http::Response::builder().status(204).body(()).unwrap();
    assert!(response_allows_keep_alive(&no_content));
}
