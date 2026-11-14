use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

fn binary(name: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target"));
    target
        .join("debug")
        .join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn standalone_binaries_report_their_scaffold_contract() {
    for name in ["notariumd", "notarium-sidecar", "notarium-migrate"] {
        let output = Command::new(binary(name))
            .arg("--help")
            .output()
            .expect("run compiled binary; use make test (build-api is required)");
        assert!(output.status.success(), "{name}");
        assert!(String::from_utf8_lossy(&output.stdout).contains(name));
    }
    for name in ["notarium-sidecar", "notarium-migrate"] {
        let output = Command::new(binary(name)).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(2),
            "{name} must not pretend to implement its future lifecycle"
        );
    }
}

#[test]
fn daemon_serves_starter_routes_on_an_ephemeral_port() {
    let mut child = Process(
        Command::new(binary("notariumd"))
            .env("PORT", "0")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let line = BufReader::new(stdout).lines().next();
        let _ = send.send(line);
    });
    let line = receive
        .recv_timeout(Duration::from_secs(10))
        .expect("daemon startup deadline")
        .expect("daemon output")
        .unwrap();
    reader.join().unwrap();
    let address = line
        .strip_prefix("notariumd listening on 0.0.0.0:")
        .expect("listener announcement");
    for (path, expected) in [
        ("/health", serde_json::json!({"status": "ok"})),
        (
            "/api/greeting?name=Ada",
            serde_json::json!({"message": "Hello, Ada!"}),
        ),
    ] {
        let mut stream = TcpStream::connect(format!("127.0.0.1:{address}")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let body = response.split_once("\r\n\r\n").unwrap().1;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            expected
        );
    }
}
