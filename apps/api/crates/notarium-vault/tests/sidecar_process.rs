#![deny(unsafe_code)]

#[path = "../examples/sidecar_fixture/support.rs"]
mod support;

use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpStream},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_canonical::CanonicalRuntime;
use notarium_core::{
    epoch::DataRoot,
    ports::GetNote,
    receipt::{CausalBasis, ReceiptSet},
};
use notarium_vault::{
    filesystem::ValidatedRoots,
    sidecar::{COLLAB_PROTOCOL, SidecarOrigin, TICKET_PROTOCOL_PREFIX, WS_TICKET_PATH},
};
use serde::Deserialize;

const DATA_ROOT: &str = "NOTARIUM_SIDECAR_PROCESS_TEST_DATA_ROOT";
const MODE: &str = "NOTARIUM_SIDECAR_PROCESS_TEST_MODE";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DRAIN_BUDGET: Duration = Duration::from_millis(500);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyFrame {
    schema_version: u32,
    status: String,
    port: u16,
    base_url: String,
    pid: u32,
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn fixture_process(test: &str, mode: &str, root: &DataRoot) -> Command {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(["--exact", test, "--nocapture"])
        .env(MODE, mode)
        .env(DATA_ROOT, root.root())
        .env("AUTH_MODE", "none");
    command
}

fn launch_token(child: &mut Child) -> String {
    let mut token = [0; 32];
    getrandom::fill(&mut token).unwrap();
    let token = URL_SAFE_NO_PAD.encode(token);
    writeln!(child.stdin.as_mut().unwrap(), "{{\"token\":\"{token}\"}}").unwrap();
    token
}

fn read_ready(child: &mut Child) -> ReadyFrame {
    let stdout = child.stdout.take().unwrap();
    let (ready, reader) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // The libtest child can prefix a line with its test name.
            if let Some((_, json)) = line.split_once('{')
                && let Ok(frame) = serde_json::from_str::<ReadyFrame>(&format!("{{{json}"))
            {
                let _ = ready.send(frame);
            }
        }
    });
    let frame = reader
        .recv_timeout(STARTUP_TIMEOUT)
        .expect("child emitted readiness");
    assert_eq!(frame.schema_version, 1);
    assert_eq!(frame.status, "ready");
    assert_ne!(frame.port, 0);
    assert_eq!(frame.base_url, format!("http://127.0.0.1:{}", frame.port));
    frame
}

fn wait_until<T>(timeout: Duration, mut check: impl FnMut() -> Option<T>, what: &str) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(result) = check() {
            return result;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(2));
    }
}

fn wait_for_exit(child: &mut Child) -> ExitStatus {
    wait_until(Duration::from_secs(5), || child.try_wait().unwrap(), "exit")
}

fn fixture_root() -> (tempfile::TempDir, DataRoot) {
    let base = tempfile::tempdir().unwrap();
    let root = DataRoot::new(base.path().canonicalize().unwrap().join("private"));
    (base, root)
}

fn run() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .unwrap()
}

#[test]
fn sidecar_child_helper() {
    let Ok(mode) = env::var(MODE) else { return };
    if !matches!(mode.as_str(), "early-eof" | "barrier") {
        return;
    }
    let root = DataRoot::new(env::var_os(DATA_ROOT).unwrap());
    let outcome = run().block_on(support::launch(root, SidecarOrigin::App, mode == "barrier"));
    if mode == "early-eof"
        && matches!(
            &outcome,
            Err(notarium_vault::sidecar::SidecarError::StoppedBeforeReady)
        )
    {
        std::process::exit(1);
    }
    outcome.unwrap();
}

#[test]
fn sidecar_parent_helper() {
    if env::var(MODE).as_deref() != Ok("parent") {
        return;
    }
    let root = DataRoot::new(env::var_os(DATA_ROOT).unwrap());
    let mut child = ChildGuard(
        fixture_process("sidecar_child_helper", "barrier", &root)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    launch_token(&mut child.0);
    // Keep the sole stdin writer and the Windows Job handle in this process.
    // Child::wait closes its own stdin field, so hold the writer independently.
    let _lifecycle = child.0.stdin.take().unwrap();
    assert!(child.0.wait().unwrap().success());
}

fn assert_nonempty_wal(root: &DataRoot) {
    let wal = root.canonical().with_extension("sqlite-wal");
    assert!(
        fs::metadata(wal).unwrap().len() > 0,
        "fixture must exercise a populated WAL"
    );
}

fn assert_released(root: &DataRoot, checkpointed: bool) {
    if checkpointed {
        let wal = root.canonical().with_extension("sqlite-wal");
        match fs::metadata(wal) {
            Ok(size) => assert_eq!(size.len(), 0),
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
        }
    }
    let roots = ValidatedRoots::open(root, None).unwrap();
    let _lock = roots
        .acquire_sidecar_lock()
        .expect("sidecar ownership released");
}

fn verify_saved(root: DataRoot, checkpointed: bool) {
    run().block_on(async {
        let (store, runtime) = CanonicalRuntime::open(support::config(root)).await.unwrap();
        let record = store.get_space(&support::space_id()).await.unwrap();
        let scope = record.scope;
        let context = support::authorized(&scope).unwrap();
        let cases = [
            (false, support::RECEIPT_BODY),
            (true, support::CHECKPOINT_BODY),
        ];
        for (checkpoint, expected) in cases.into_iter().take(if checkpointed { 2 } else { 1 }) {
            let saved = store
                .get_note(
                    context.clone(),
                    GetNote {
                        note: support::note_id(checkpoint),
                        revision: None,
                        causal: CausalBasis::Exact(ReceiptSet::default()),
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                saved.document.explicit_read(context.auth()).unwrap(),
                expected
            );
            support::commit_note(&store, &scope, checkpoint)
                .await
                .unwrap();
        }
        assert_eq!(
            store
                .get_space(&support::space_id())
                .await
                .unwrap()
                .last_seq,
            record.last_seq
        );
        if !checkpointed {
            assert!(
                store
                    .get_note(
                        context,
                        GetNote {
                            note: support::note_id(true),
                            revision: None,
                            causal: CausalBasis::Exact(ReceiptSet::default()),
                        },
                    )
                    .await
                    .is_err(),
                "hard Job kill cannot persist the gated room write"
            );
        }
        runtime.shutdown_with_wal_truncate().await.unwrap();
    });
}

fn hold_then_release_checkpoint(root: &DataRoot, started: Instant, wait: Duration) {
    wait_until(
        Duration::from_secs(3),
        || {
            root.root()
                .join("checkpoint.waiting")
                .exists()
                .then_some(())
        },
        "room checkpoint admission",
    );
    let remaining = wait.saturating_sub(started.elapsed());
    thread::sleep(remaining);
    let blocked = ValidatedRoots::open(root, None)
        .unwrap()
        .acquire_sidecar_lock()
        .unwrap_err();
    assert_eq!(blocked.kind(), std::io::ErrorKind::WouldBlock);
    fs::write(root.root().join("checkpoint.release"), b"release").unwrap();
}

fn connect(port: u16) -> TcpStream {
    let socket =
        TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_secs(2))
            .unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    socket
}

fn http(port: u16, request: &str) -> String {
    let mut socket = connect(port);
    socket.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    response
}

fn request(port: u16, method: &str, path: &str, headers: &str, body: &str) -> String {
    http(
        port,
        &format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{headers}\r\n{body}"
        ),
    )
}

fn assert_perimeter(port: u16, token: &str) {
    let path = "/api/greeting?name=Ada";
    let origin = "Origin: app://local\r\n";
    let authorized = format!("{origin}Authorization: Bearer {token}\r\n");
    let good = request(port, "GET", path, &authorized, "");
    assert!(good.starts_with("HTTP/1.1 200"));
    assert!(good.contains("Hello, Ada!"));
    assert!(request(port, "GET", path, origin, "").starts_with("HTTP/1.1 401"));
    assert!(
        request(
            port,
            "GET",
            path,
            &format!("Authorization: Bearer {token}\r\n"),
            ""
        )
        .starts_with("HTTP/1.1 403")
    );
    assert!(http(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n{authorized}\r\n")
    ).starts_with("HTTP/1.1 403"));
    assert!(
        request(
            port,
            "GET",
            path,
            &format!("{authorized}Origin: app://local\r\n"),
            ""
        )
        .starts_with("HTTP/1.1 403")
    );
    assert!(
        request(
            port,
            "GET",
            path,
            &format!("{authorized}Authorization: Bearer {token}\r\n"),
            ""
        )
        .starts_with("HTTP/1.1 401")
    );

    let preflight = request(
        port,
        "OPTIONS",
        path,
        "Origin: app://local\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: authorization\r\nAccess-Control-Request-Private-Network: true\r\n",
        "",
    );
    assert!(preflight.starts_with("HTTP/1.1 204"));
    assert!(preflight.contains("access-control-allow-private-network: true"));
    assert!(preflight.ends_with("\r\n\r\n"));
    assert!(request(
        port, "OPTIONS", path,
        "Origin: app://local\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: x-forwarded-for\r\n", ""
    ).starts_with("HTTP/1.1 403"));

    let body = format!(
        r#"{{"space_id":"{}","note_id":"{}"}}"#,
        support::space_id(),
        support::note_id(false)
    );
    let response = request(
        port,
        "POST",
        WS_TICKET_PATH,
        &format!(
            "{authorized}Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ),
        &body,
    );
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("cache-control: no-store"));
    let (_, json) = response.split_once("\r\n\r\n").unwrap();
    let issued: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(issued["expires_in"], 30);
    let secret = issued["ticket"].as_str().unwrap();
    let upgrade = format!(
        "GET /api/v1/spaces/{}/notes/{}/collab HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{origin}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: {COLLAB_PROTOCOL}, {TICKET_PROTOCOL_PREFIX}{secret}\r\n\r\n",
        support::space_id(),
        support::note_id(false),
    );
    fn upgrade_response(port: u16, request: &str) -> String {
        let mut socket = connect(port);
        socket.write_all(request.as_bytes()).unwrap();
        let mut output = BufReader::new(socket);
        let mut headers = String::new();
        loop {
            let start = headers.len();
            if output.read_line(&mut headers).unwrap() == 0 || headers[start..] == *"\r\n" {
                break;
            }
        }
        headers
    }
    let accepted = upgrade_response(port, &upgrade);
    assert!(accepted.starts_with("HTTP/1.1 101"), "{accepted}");
    assert!(accepted.contains(&format!("sec-websocket-protocol: {COLLAB_PROTOCOL}\r\n")));
    assert!(!accepted.contains(secret));
    assert!(upgrade_response(port, &upgrade).starts_with("HTTP/1.1 401"));
}

#[test]
fn real_child_checks_loopback_and_drains_on_eof_with_parent_alive() {
    let (_base, root) = fixture_root();
    let mut child = ChildGuard(
        fixture_process("sidecar_child_helper", "barrier", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let token = launch_token(&mut child.0);
    let ready = read_ready(&mut child.0);
    assert_eq!(ready.pid, child.0.id());
    assert_nonempty_wal(&root);
    assert_perimeter(ready.port, &token);

    let started = Instant::now();
    drop(child.0.stdin.take());
    hold_then_release_checkpoint(&root, started, Duration::from_millis(35));
    assert!(wait_for_exit(&mut child.0).success());
    assert_released(&root, true);
    let elapsed = started.elapsed();
    eprintln!("sidecar managed EOF: {elapsed:?}");
    assert!(
        elapsed < DRAIN_BUDGET,
        "managed EOF exceeded {DRAIN_BUDGET:?}: {elapsed:?}"
    );
    verify_saved(root, true);
}

#[test]
fn managed_checkpoint_wait_remains_observable_past_the_budget() {
    let (_base, root) = fixture_root();
    let mut child = ChildGuard(
        fixture_process("sidecar_child_helper", "barrier", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    launch_token(&mut child.0);
    read_ready(&mut child.0);
    let started = Instant::now();
    drop(child.0.stdin.take());
    hold_then_release_checkpoint(&root, started, DRAIN_BUDGET + Duration::from_millis(25));
    assert!(wait_for_exit(&mut child.0).success());
    assert_released(&root, true);
    verify_saved(root, true);
}

#[cfg(unix)]
#[test]
fn managed_signal_drains_with_the_lifecycle_pipe_still_open() {
    use rustix::process::{Pid, Signal, kill_process};

    let (_base, root) = fixture_root();
    let mut child = ChildGuard(
        fixture_process("sidecar_child_helper", "barrier", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    launch_token(&mut child.0);
    let process = read_ready(&mut child.0);
    let pid = Pid::from_raw(i32::try_from(process.pid).unwrap()).unwrap();
    let started = Instant::now();
    kill_process(pid, Signal::TERM).unwrap();
    hold_then_release_checkpoint(&root, started, Duration::from_millis(35));
    assert!(wait_for_exit(&mut child.0).success());
    assert!(child.0.stdin.is_some());
    assert_released(&root, true);
    assert!(started.elapsed() < DRAIN_BUDGET);
    verify_saved(root, true);
}

#[test]
fn closed_startup_pipe_prevents_readiness_and_releases_the_lock() {
    let (_base, root) = fixture_root();
    let mut child = ChildGuard(
        fixture_process("sidecar_child_helper", "early-eof", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    launch_token(&mut child.0);
    drop(child.0.stdin.take());
    assert!(!wait_for_exit(&mut child.0).success());
    let mut stdout = String::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    assert!(!stdout.contains("\"status\":\"ready\""));
    assert_released(&root, false);
}

#[cfg(target_os = "linux")]
#[test]
fn unexpected_linux_parent_death_drains_and_releases_sidecar() {
    use rustix::process::{Pid, WaitOptions, getpid, set_child_subreaper, waitpid};
    // Reap the orphan and verify its real exit code instead of treating the
    // released lock alone as proof of successful shutdown.
    set_child_subreaper(Some(getpid())).unwrap();
    let mut timings = Vec::new();
    for _ in 0..3 {
        let (_base, root) = fixture_root();
        let mut parent = killable_parent(&root);
        let ready = read_ready(&mut parent.0);
        let orphan = Pid::from_raw(i32::try_from(ready.pid).unwrap()).unwrap();
        assert_nonempty_wal(&root);
        let started = Instant::now();
        parent.0.kill().unwrap();
        assert!(!parent.0.wait().unwrap().success());
        hold_then_release_checkpoint(&root, started, Duration::from_millis(35));
        let status = wait_until(
            Duration::from_secs(5),
            || {
                waitpid(Some(orphan), WaitOptions::NOHANG)
                    .unwrap()
                    .map(|(_, status)| status)
            },
            "adopted sidecar exit",
        );
        assert_eq!(status.exit_status(), Some(0));
        assert_released(&root, true);
        timings.push(started.elapsed());
        verify_saved(root, true);
    }
    set_child_subreaper(None).unwrap();
    eprintln!("sidecar Linux launcher SIGKILL: {timings:?}");
    assert!(timings.into_iter().all(|duration| duration < DRAIN_BUDGET));
}

#[cfg(windows)]
#[test]
fn unexpected_windows_parent_death_releases_job_and_recovers_confirmed_blob() {
    let (_base, root) = fixture_root();
    let mut parent = killable_parent(&root);
    let ready = read_ready(&mut parent.0);
    let orphan = windows::observe_process(ready.pid);
    assert_nonempty_wal(&root);
    let started = Instant::now();
    parent.0.kill().unwrap();
    assert!(!parent.0.wait().unwrap().success());
    windows::assert_forced_exit(&orphan);
    assert_released(&root, false);
    eprintln!(
        "sidecar Windows launcher Job death: {:?}",
        started.elapsed()
    );
    verify_saved(root, false);
}

#[cfg(any(windows, target_os = "linux"))]
fn killable_parent(root: &DataRoot) -> ChildGuard {
    ChildGuard(
        fixture_process("sidecar_parent_helper", "parent", root)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod windows {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    pub fn observe_process(pid: u32) -> OwnedHandle {
        // SAFETY: OpenProcess has no pointer arguments and returns a live
        // owning handle or null. Pin this identity before killing its parent.
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!raw.is_null());
        // SAFETY: raw is the newly owned handle, checked above.
        unsafe { OwnedHandle::from_raw_handle(raw) }
    }

    pub fn assert_forced_exit(process: &OwnedHandle) {
        // SAFETY: This observer owns a synchronizable process handle.
        let waited = unsafe { WaitForSingleObject(process.as_raw_handle(), 2000) };
        // The unreleased checkpoint cannot finish within this window. Windows
        // can report a successful exit code for termination on Job close.
        assert_eq!(waited, WAIT_OBJECT_0);
    }
}
