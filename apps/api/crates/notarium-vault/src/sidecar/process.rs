use std::{
    io::{self, BufRead, Read as _},
    sync::atomic::{AtomicBool, Ordering},
};

use notarium_core::ports::Cancellation;
use serde::Deserialize;
use tokio::{sync::oneshot, task::JoinHandle};
use zeroize::Zeroizing;

use super::{LaunchToken, SidecarError};

#[cfg(windows)]
mod windows;

const MAX_LAUNCH_FRAME: usize = 1024;
static STARTED: AtomicBool = AtomicBool::new(false);

pub(super) struct ProcessInput {
    token: Option<oneshot::Receiver<Result<LaunchToken, SidecarError>>>,
    pub stop: Cancellation,
    watch: JoinHandle<Result<(), SidecarError>>,
}

impl ProcessInput {
    pub fn open() -> Result<Self, SidecarError> {
        if STARTED.swap(true, Ordering::AcqRel) {
            return Err(SidecarError::ProcessAlreadyStarted);
        }

        let mut signal = TerminationSignal::open()?;
        let stop = Cancellation::default();
        let watch_stop = stop.clone();
        let (token_tx, token) = oneshot::channel();
        let (closed_tx, closed) = oneshot::channel();
        // tokio::io::stdin owns a blocking task which the runtime waits for on
        // shutdown. A managed signal can arrive while the parent pipe is open.
        // The process owns this one detached reader until EOF or process exit.
        std::thread::Builder::new()
            .name("sidecar-stdin".into())
            .spawn(move || {
                let mut input = io::stdin().lock();
                let launch = read_token(&mut input).and_then(|token| {
                    if stdin_peer_open()? {
                        Ok(token)
                    } else {
                        Err(SidecarError::StoppedBeforeReady)
                    }
                });
                let accepted = launch.is_ok();
                if token_tx.send(launch).is_err() || !accepted {
                    return;
                }
                let result = match input.fill_buf() {
                    Ok([]) => Ok(()),
                    Ok(_) => Err(SidecarError::LifecyclePipe),
                    Err(error) => Err(error.into()),
                };
                let _ = closed_tx.send(result);
            })?;
        let watch = tokio::spawn(async move {
            let result = tokio::select! {
                biased;
                closed = closed => closed.unwrap_or(Ok(())),
                () = signal.wait() => Ok(()),
                () = watch_stop.cancelled() => Ok(()),
            };
            watch_stop.cancel();
            result
        });
        Ok(Self {
            token: Some(token),
            stop,
            watch,
        })
    }

    pub async fn take_token(&mut self) -> Result<LaunchToken, SidecarError> {
        let token = self.token.take().expect("launch token awaited once");
        tokio::select! {
            biased;
            value = token => value.map_err(|_| SidecarError::LaunchFrame)?,
            () = self.stop.cancelled() => Err(SidecarError::StoppedBeforeReady),
        }
    }

    pub async fn wait(&mut self) -> Result<(), SidecarError> {
        (&mut self.watch).await?
    }

    pub fn check_readiness(&self) -> Result<(), SidecarError> {
        if self.stop.is_cancelled() {
            return Err(SidecarError::StoppedBeforeReady);
        }
        // POSIX poll observes a hangup even when the reader thread has not
        // yet been scheduled. On Windows the Job handles host death, while
        // the reader checks the pipe before handing the token off.
        #[cfg(unix)]
        if !stdin_peer_open()? {
            return Err(SidecarError::StoppedBeforeReady);
        }
        Ok(())
    }
}

impl Drop for ProcessInput {
    fn drop(&mut self) {
        self.stop.cancel();
        self.watch.abort();
    }
}

fn read_token(input: &mut impl BufRead) -> Result<LaunchToken, SidecarError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LaunchFrame<'a> {
        token: &'a str,
    }

    let mut line = Zeroizing::new(Vec::new());
    input
        .take(MAX_LAUNCH_FRAME as u64)
        .read_until(b'\n', &mut line)?;
    if line.last() != Some(&b'\n') {
        return Err(SidecarError::LaunchFrame);
    }
    let frame: LaunchFrame<'_> =
        serde_json::from_slice(&line).map_err(|_| SidecarError::LaunchFrame)?;
    LaunchToken::parse(frame.token)
}

#[cfg(unix)]
fn stdin_peer_open() -> io::Result<bool> {
    use rustix::{
        event::{PollFd, PollFlags, Timespec, poll},
        fs::{FileType, fstat},
    };

    let stdin = io::stdin();
    // libuv implements its Unix stdio pipes with a socket pair.
    if !matches!(
        FileType::from_raw_mode(fstat(&stdin)?.st_mode),
        FileType::Fifo | FileType::Socket
    ) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a sidecar lifecycle pipe",
        ));
    }
    let requested = PollFlags::IN;
    let closed = PollFlags::HUP | PollFlags::ERR | PollFlags::NVAL;
    #[cfg(target_os = "linux")]
    let (requested, closed) = (requested | PollFlags::RDHUP, closed | PollFlags::RDHUP);
    let mut fd = [PollFd::new(&stdin, requested)];
    poll(&mut fd, Some(&Timespec::default()))?;
    Ok(!fd[0].revents().intersects(closed))
}

#[cfg(windows)]
use windows::stdin_peer_open;

#[cfg(unix)]
struct TerminationSignal {
    term: tokio::signal::unix::Signal,
    int: tokio::signal::unix::Signal,
    parent_changed: bool,
}

#[cfg(unix)]
impl TerminationSignal {
    fn open() -> io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        // Install the handlers before arming the Linux parent-death signal.
        let term = signal(SignalKind::terminate())?;
        let int = signal(SignalKind::interrupt())?;
        #[cfg(target_os = "linux")]
        let parent_changed = {
            use rustix::process::{Signal, getppid, set_parent_process_death_signal};
            let parent = getppid();
            set_parent_process_death_signal(Some(Signal::TERM))?;
            getppid() != parent
        };
        #[cfg(not(target_os = "linux"))]
        let parent_changed = false;
        Ok(Self {
            term,
            int,
            parent_changed,
        })
    }

    async fn wait(&mut self) {
        if !self.parent_changed {
            tokio::select! {
                _ = self.term.recv() => {},
                _ = self.int.recv() => {},
            }
        }
    }
}

#[cfg(windows)]
struct TerminationSignal;

#[cfg(windows)]
impl TerminationSignal {
    fn open() -> io::Result<Self> {
        windows::attach_parent_job()?;
        Ok(Self)
    }

    async fn wait(&mut self) {
        // A graceful Windows quit arrives over stdin. The Job's kill is final.
        std::future::pending::<()>().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn validates_one_bounded_launch_frame_and_leaves_the_rest_of_the_pipe() {
        let mut input =
            Cursor::new(&b"{\"token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}\nnext"[..]);
        assert!(read_token(&mut input).is_ok());
        assert_eq!(input.fill_buf().unwrap(), b"next");
        for invalid in [
            &b""[..],
            &b"{\"token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}"[..],
            &b"{\"token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\"}\n"[..],
            &b"{\"token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB\"}\n"[..],
            &b"{\"token\":\"AA\"}\n"[..],
            &b"{\"token\":\"\xff\"}\n"[..],
            &b"{\"token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"extra\":1}\n"[..],
        ] {
            assert!(matches!(
                read_token(&mut Cursor::new(invalid)),
                Err(SidecarError::LaunchFrame)
            ));
        }

        let mut oversized = vec![b' '; MAX_LAUNCH_FRAME];
        oversized.extend_from_slice(b"\n");
        let mut input = Cursor::new(oversized);
        assert!(matches!(
            read_token(&mut input),
            Err(SidecarError::LaunchFrame)
        ));
        assert_eq!(input.position(), MAX_LAUNCH_FRAME as u64);
    }
}
