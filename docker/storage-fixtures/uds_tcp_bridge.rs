#![forbid(unsafe_code)]
//! Minimal test-only Unix domain socket to loopback TCP bridge and readiness probe.
//! Shares only the closed network namespace of the S3 test fixture container.

use std::{
    env, fs,
    io::{self, Read, Write},
    net::{Shutdown, TcpStream},
    os::unix::{fs::PermissionsExt, net::{UnixListener, UnixStream}},
    path::Path,
    process::ExitCode,
    thread,
    time::Duration,
};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") if args.len() == 4 => match serve(&args[2], &args[3]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("uds-tcp-bridge serve error: {err}");
                ExitCode::from(1)
            }
        },
        Some("probe-http") if args.len() == 4 => match probe_http(&args[2], &args[3]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("uds-tcp-bridge probe error: {err}");
                ExitCode::from(1)
            }
        },
        _ => {
            eprintln!(
                "usage: uds-tcp-bridge serve <socket-path> <host:port> | probe-http <socket-path> <http-path>"
            );
            ExitCode::from(2)
        }
    }
}

fn serve(socket_path: &str, target_addr: &str) -> io::Result<()> {
    let path = Path::new(socket_path);
    if path.exists() {
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o666))?;

    let target = target_addr.to_owned();
    for accepted in listener.incoming() {
        let client = match accepted {
            Ok(stream) => stream,
            Err(err) => {
                eprintln!("uds-tcp-bridge accept error: {err}");
                continue;
            }
        };
        let upstream_addr = target.clone();
        thread::spawn(move || {
            let _ = forward_connection(client, &upstream_addr);
        });
    }
    Ok(())
}

fn forward_connection(client: UnixStream, upstream_addr: &str) -> io::Result<()> {
    let upstream = TcpStream::connect_timeout(
        &upstream_addr
            .parse()
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?,
        Duration::from_secs(5),
    )?;
    let _ = upstream.set_nodelay(true);

    let mut client_read = client.try_clone()?;
    let mut client_write = client;
    let mut upstream_read = upstream.try_clone()?;
    let mut upstream_write = upstream;

    let c2u = thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut upstream_write);
        let _ = upstream_write.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut upstream_read, &mut client_write);
    let _ = client_write.shutdown(Shutdown::Write);
    let _ = c2u.join();
    Ok(())
}

fn probe_http(socket_path: &str, http_path: &str) -> io::Result<()> {
    let mut stream = UnixStream::connect(socket_path)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET {http_path} HTTP/1.1\r\nHost: 127.0.0.1:9000\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let status_line = response.lines().next().unwrap_or_default();
    if status_line.starts_with("HTTP/1.1 200") || status_line.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(io::Error::other(format!("unexpected HTTP status: {status_line}")))
    }
}
