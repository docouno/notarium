//! A verifier process receives read-only archive windows over bounded pipes.
//! Its SQLite heap limit applies only to that process.

use std::{
    ffi::OsString,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use notarium_canonical::codec;
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ports::Cancellation,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    backup_format::{Manifest, invalid, io_error},
    fsck::{ArchiveRange, CasIndex, SeekRead, SqliteFacts, inspect_sqlite},
    import::check_cancelled,
    range_source::RangeSource,
    sqlite_range::{cap_verifier_heap, sqlite_heap_peak},
};

pub const SQLITE_VERIFIER_ARGUMENT: &str = "--internal-verify-sqlite-archive";
const HELLO: &[u8] = b"NOTARIUM_SQLITE_VERIFY_1\n";
const MAX_FRAME: usize = 12 * 1024 * 1024;
const MAX_READ: usize = 128 * 1024;
const DEFAULT_HEAP_BYTES: u64 = 80 * 1024 * 1024;

/// Configure the isolated native verifier launcher for an embedding
/// executable. The default starts the current Notarium executable.
#[derive(Clone, Debug)]
pub struct SqliteVerifier {
    program: Option<(PathBuf, Vec<OsString>)>,
    pub heap_bytes: u64,
}

impl Default for SqliteVerifier {
    fn default() -> Self {
        Self {
            program: None,
            heap_bytes: DEFAULT_HEAP_BYTES,
        }
    }
}

impl SqliteVerifier {
    pub fn with_command(mut self, program: PathBuf, arguments: Vec<OsString>) -> Self {
        self.program = Some((program, arguments));
        self
    }
}

#[derive(Serialize, Deserialize)]
struct Request {
    manifest: Manifest,
    with_index: bool,
    heap_bytes: u64,
}

#[derive(Serialize, Deserialize)]
enum Report {
    Verified { facts: SqliteFacts, peak: u64 },
    Rejected(ValidationReason),
}

pub(crate) fn verify_sqlite(
    verifier: &SqliteVerifier,
    manifest: &Manifest,
    control: ArchiveRange,
    canonical: ArchiveRange,
    index: Option<&CasIndex>,
    cancellation: &Cancellation,
) -> Result<(SqliteFacts, u64), PortError> {
    check_cancelled(cancellation)?;
    validate_heap(verifier.heap_bytes)?;
    let mut command = if let Some((program, arguments)) = &verifier.program {
        let mut command = Command::new(program);
        command.args(arguments);
        command
    } else {
        let mut command = Command::new(std::env::current_exe().map_err(io_error)?);
        command.arg(SQLITE_VERIFIER_ARGUMENT);
        command
    };
    let mut child = command
        .env("NOTARIUM_SQLITE_VERIFIER_CHILD", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(io_error)?;
    let mut input = child.stdin.take().expect("piped verifier input");
    let mut output = BufReader::new(child.stdout.take().expect("piped verifier output"));
    let process = Mutex::new(child);
    let done = AtomicBool::new(false);
    std::thread::scope(|threads| {
        let watchdog = threads.spawn(|| {
            while !done.load(Ordering::Acquire) {
                if cancellation.is_cancelled() {
                    kill(&process);
                    break;
                }
                std::thread::park_timeout(Duration::from_millis(10));
            }
        });
        let index = index.map(CasIndex::source);
        let exchange = pump(
            &mut input,
            &mut output,
            [Some(control), Some(canonical), index.clone()],
            &Request {
                manifest: manifest.clone(),
                with_index: index.is_some(),
                heap_bytes: verifier.heap_bytes,
            },
        );
        if exchange.is_err() {
            kill(&process);
        }
        drop(input);
        let status = loop {
            let status = process.lock().expect("verifier process lock").try_wait();
            match status {
                Ok(None) => std::thread::sleep(Duration::from_millis(2)),
                Ok(Some(status)) => break Ok(status),
                Err(err) => break Err(err),
            }
        };
        done.store(true, Ordering::Release);
        watchdog.thread().unpark();
        check_cancelled(cancellation)?;
        let report = exchange?;
        if !status.map_err(io_error)?.success() {
            return Err(codec::internal_not_committed(
                "sqlite_verifier_exit",
                "verifier did not exit successfully",
            ));
        }
        match report {
            Report::Verified { facts, peak } if peak <= verifier.heap_bytes => Ok((facts, peak)),
            Report::Verified { .. } => Err(invalid(ValidationReason::BudgetExceeded)),
            Report::Rejected(reason) => Err(invalid(reason)),
        }
    })
}

fn kill(process: &Mutex<Child>) {
    let _ = process.lock().expect("verifier process lock").kill();
}

fn pump(
    input: &mut impl Write,
    output: &mut impl BufRead,
    mut sources: [Option<ArchiveRange>; 3],
    request: &Request,
) -> Result<Report, PortError> {
    // An embedded test harness may print its own program identification.
    let mut hello = Vec::new();
    let mut remaining = 4096;
    while !hello.ends_with(HELLO) {
        hello.clear();
        let read = output
            .take(remaining)
            .read_until(b'\n', &mut hello)
            .map_err(io_error)?;
        remaining -= read as u64;
        if read == 0 || remaining == 0 {
            return Err(invalid(ValidationReason::UnsupportedContainer));
        }
    }
    write_message(input, request)?;
    let mut buffer = vec![0; MAX_READ];
    loop {
        let mut code = [0];
        output.read_exact(&mut code).map_err(io_error)?;
        match code[0] {
            0 => return read_message(output),
            index @ 1..=3 => {
                let mut header = [0; 12];
                output.read_exact(&mut header).map_err(io_error)?;
                let offset = u64::from_be_bytes(header[..8].try_into().unwrap());
                let amount = u32::from_be_bytes(header[8..].try_into().unwrap()) as usize;
                let data = buffer
                    .get_mut(..amount)
                    .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
                let source = sources[usize::from(index) - 1]
                    .as_mut()
                    .ok_or_else(|| invalid(ValidationReason::InvalidArchive))?;
                source
                    .seek(SeekFrom::Start(offset))
                    .and_then(|_| source.read_exact(data))
                    .map_err(io_error)?;
                input
                    .write_all(data)
                    .and_then(|()| input.flush())
                    .map_err(io_error)?;
            }
            _ => return Err(invalid(ValidationReason::InvalidArchive)),
        }
    }
}

/// Entry point for a freshly started verifier process. The embedding program
/// dispatches this argument before it opens any live SQLite connections.
pub fn run_sqlite_verifier() -> Result<(), PortError> {
    let mut stdout = io::stdout();
    stdout
        .write_all(HELLO)
        .and_then(|()| stdout.flush())
        .map_err(io_error)?;
    let stdin = io::stdin();
    let request: Request = read_message(&mut stdin.lock())?;
    validate_heap(request.heap_bytes)?;
    cap_verifier_heap(request.heap_bytes)?;
    let channel = Arc::new(Mutex::new((stdin, stdout)));
    let range = |id, len| {
        let channel: Box<dyn SeekRead> = Box::new(ChildWindow {
            id,
            len,
            position: 0,
            channel: channel.clone(),
        });
        RangeSource::new(channel).map_err(io_error)
    };
    let manifest = request.manifest;
    let result = (|| {
        let control = range(1, manifest.control.bytes)?;
        let canonical = range(2, manifest.canonical.bytes)?;
        let mut index = request
            .with_index
            .then(|| CasIndex::open(range(3, manifest.index.bytes)?, manifest.index.bytes))
            .transpose()?;
        inspect_sqlite(
            control,
            canonical,
            &manifest,
            &Cancellation::default(),
            index.as_mut(),
        )
    })();
    let reply = match result {
        Ok(facts) => Report::Verified {
            facts,
            peak: sqlite_heap_peak()?,
        },
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) => {
            Report::Rejected(diagnostic.reason)
        }
        Err(err) => return Err(err),
    };
    let mut channel = channel.lock().expect("verifier pipe");
    channel.1.write_all(&[0]).map_err(io_error)?;
    write_message(&mut channel.1, &reply)
}

struct ChildWindow {
    id: u8,
    len: u64,
    position: u64,
    channel: Arc<Mutex<(io::Stdin, io::Stdout)>>,
}

impl Read for ChildWindow {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let amount = bytes
            .len()
            .min(MAX_READ)
            .min((self.len - self.position) as usize);
        if amount == 0 {
            return Ok(0);
        }
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| io::Error::other("verifier pipe closed"))?;
        let mut header = [0; 13];
        header[0] = self.id;
        header[1..9].copy_from_slice(&self.position.to_be_bytes());
        header[9..].copy_from_slice(&(amount as u32).to_be_bytes());
        channel.1.write_all(&header)?;
        channel.1.flush()?;
        channel.0.read_exact(&mut bytes[..amount])?;
        self.position += amount as u64;
        Ok(amount)
    }
}

impl Seek for ChildWindow {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.position = match position {
            SeekFrom::Start(pos) => Some(pos),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
            SeekFrom::End(delta) => self.len.checked_add_signed(delta),
        }
        .filter(|pos| *pos <= self.len)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "archive verifier range exceeded",
            )
        })?;
        Ok(self.position)
    }
}

fn read_message<R: DeserializeOwned>(source: &mut impl Read) -> Result<R, PortError> {
    let mut header = [0; 4];
    source.read_exact(&mut header).map_err(io_error)?;
    let len = u32::from_be_bytes(header) as usize;
    if !(1..=MAX_FRAME).contains(&len) {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut body = vec![0; len];
    source.read_exact(&mut body).map_err(io_error)?;
    serde_json::from_slice(&body).map_err(|_| invalid(ValidationReason::InvalidArchive))
}

fn write_message(output: &mut impl Write, value: &impl Serialize) -> Result<(), PortError> {
    let body = serde_json::to_vec(value).map_err(|_| invalid(ValidationReason::InvalidState))?;
    if body.len() > MAX_FRAME {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    output
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|()| output.write_all(&body))
        .and_then(|()| output.flush())
        .map_err(io_error)
}

fn validate_heap(bytes: u64) -> Result<(), PortError> {
    if (64 * 1024..=512 * 1024 * 1024).contains(&bytes) {
        Ok(())
    } else {
        Err(invalid(ValidationReason::InvalidLimit))
    }
}
