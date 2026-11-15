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
async fn released() {
    tokio::time::timeout(Duration::from_secs(5), async {
        while SEND_ADMISSION.available_permits() != 32 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_connector_uses_checked_addresses_and_isolates_pools_and_epochs() {
    let _serial = crate::outbound::NETWORK_TEST_LOCK.lock().await;
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
    released().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirects_dns_rebinding_mixed_answers_and_metadata_do_not_reach_denied_sockets() {
    let _serial = crate::outbound::NETWORK_TEST_LOCK.lock().await;
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
    released().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn literal_path_stream_limits_deadlines_and_epoch_cancellation_release_real_calls() {
    let _serial = crate::outbound::NETWORK_TEST_LOCK.lock().await;
    let server = Server::new(Reply::StallBody).await;
    let origin = server.origin("127.0.0.1");
    let dns = Dns::new(&[&["169.254.169.254:0"]]);
    let client = transport(&origin, &[1], dns.clone());
    let mut call = budget();
    call.remaining = Duration::from_millis(250);
    let mut response = client
        .send(call, request(1, 1, &origin, "secret"))
        .await
        .unwrap();
    // Keep an unpolled response. Its worker still closes on the absolute budget.
    released().await;
    assert!(matches!(
        response.next_chunk().await,
        Err(PortError::DeadlineExceeded(_))
    ));
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
    released().await;
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
    released().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_call_limit_survives_caller_drop_and_idle_pool_cache_is_bounded() {
    let _serial = crate::outbound::NETWORK_TEST_LOCK.lock().await;
    let server = Server::new(Reply::StallHeaders).await;
    let origin = server.origin("127.0.0.1");
    let client = transport(&origin, &[1], Dns::new(&[&["127.0.0.1:0"]]));
    let mut jobs = Vec::new();
    for _ in 0..32 {
        let client = client.clone();
        let origin = origin.clone();
        jobs.push(tokio::spawn(async move {
            client
                .send(budget(), request(1, 1, &origin, "secret"))
                .await
        }));
    }
    server.count(32).await;
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
    released().await;
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
