//! Offline protocol fixture. TLS, HTTP and service behavior are real; a test-only
//! route maps the single fixture origin to loopback. Production SSRF policy is
//! qualified separately without that route. All key material here is public.
use super::{OutboundTransport, resolver::Lookup};
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub headers: String,
    pub body: Vec<u8>,
}
pub(crate) struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl Reply {
    pub fn json(value: serde_json::Value) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: serde_json::to_vec(&value).unwrap(),
        }
    }
}
struct Loopback;
impl Lookup for Loopback {
    fn addresses(&self, host: &str) -> io::Result<Vec<SocketAddr>> {
        if host != "identity.example.invalid" {
            return Err(io::Error::other("fixture host"));
        }
        Ok(vec![SocketAddr::from(([127, 0, 0, 1], 0))])
    }
}
pub(crate) struct HttpsFixture {
    pub origin: String,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl HttpsFixture {
    pub fn start(handler: impl Fn(Request) -> Reply + Send + Sync + 'static) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![
                    include_bytes!("../../tests/fixtures/identity/server.der")
                        .to_vec()
                        .into(),
                ],
                rustls::pki_types::PrivatePkcs8KeyDer::from(
                    include_bytes!("../../tests/fixtures/identity/server-key.der").to_vec(),
                )
                .into(),
            )
            .unwrap();
        let config = Arc::new(config);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!(
            "https://identity.example.invalid:{}",
            listener.local_addr().unwrap().port()
        );
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let handler = Arc::new(handler);
        let thread = thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let config = config.clone();
                        let handler = handler.clone();
                        workers.push(thread::spawn(move || {
                            let connection = rustls::ServerConnection::new(config).unwrap();
                            let mut stream = rustls::StreamOwned::new(connection, stream);
                            let _ = serve(&mut stream, &*handler);
                        }));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            origin,
            stop,
            thread: Some(thread),
        }
    }
    pub fn transport(&self) -> OutboundTransport {
        OutboundTransport::fixture_https(
            self.origin.clone(),
            Arc::new(Loopback),
            reqwest::Certificate::from_der(include_bytes!("../../tests/fixtures/identity/ca.der"))
                .unwrap(),
        )
    }
}
impl Drop for HttpsFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn serve(stream: &mut (impl Read + Write), handler: &dyn Fn(Request) -> Reply) -> io::Result<()> {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        bytes.push(byte[0]);
        if bytes.len() > 16 * 1024 {
            return Err(io::Error::other("fixture headers"));
        }
    }
    let headers = String::from_utf8(bytes).map_err(|_| io::Error::other("fixture utf8"))?;
    let mut first = headers.lines().next().unwrap().split(' ');
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap().to_owned();
    let length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        .unwrap_or(0);
    if length > 64 * 1024 {
        return Err(io::Error::other("fixture body"));
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body)?;
    let reply = handler(Request {
        method,
        path,
        headers,
        body,
    });
    if reply.status == 0 {
        return Ok(());
    }
    write!(
        stream,
        "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
        reply.status,
        reply.body.len()
    )?;
    for (name, value) in reply.headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(&reply.body)?;
    stream.flush()
}
