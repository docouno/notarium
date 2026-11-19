//! The local process contract for desktop hosts.

mod perimeter;
mod process;

use std::{future::Future, io, net::Ipv4Addr, sync::Arc};

use axum::Router;
use notarium_core::{error::PortError, ports::Cancellation};
use serde::Serialize;
use tokio::net::TcpListener;

use crate::filesystem::ValidatedRoots;
use process::ProcessInput;

pub use perimeter::{
    COLLAB_PROTOCOL, LaunchToken, PreflightRule, SidecarPerimeter, SidecarService,
    TICKET_PROTOCOL_PREFIX, WS_TICKET_PATH, WsTicketRequest, WsTicketVerifier,
};

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("unsupported sidecar origin")]
    Origin,
    #[error("invalid sidecar launch frame")]
    LaunchFrame,
    #[error("unexpected data on the sidecar lifecycle pipe")]
    LifecyclePipe,
    #[error("the sidecar host stopped before readiness")]
    StoppedBeforeReady,
    #[error("the sidecar process input is already in use")]
    ProcessAlreadyStarted,
    #[error("sidecar process transport failed")]
    Io(#[from] io::Error),
    #[error("sidecar root validation or lock failed")]
    Filesystem(#[source] io::Error),
    #[error("sidecar storage failed")]
    Storage(#[from] PortError),
    #[error("sidecar task failed")]
    Task(#[from] tokio::task::JoinError),
    #[error("sidecar host initialization or shutdown failed")]
    Host(#[source] Box<dyn std::error::Error + Send + Sync>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidecarOrigin {
    App,
    NativeDevelopment,
}

impl SidecarOrigin {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::App => "app://local",
            Self::NativeDevelopment => "http://localhost:5173",
        }
    }
}

impl TryFrom<&str> for SidecarOrigin {
    type Error = SidecarError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "app://local" => Ok(Self::App),
            "http://localhost:5173" => Ok(Self::NativeDevelopment),
            _ => Err(SidecarError::Origin),
        }
    }
}

/// The validated filesystem capabilities and idempotent quit request for the host.
pub struct SidecarStart {
    pub roots: Arc<ValidatedRoots>,
    pub shutdown_requested: Cancellation,
}

pub struct SidecarApplication<L> {
    pub router: Router,
    pub preflight: Vec<PreflightRule>,
    pub tickets: Option<Arc<dyn WsTicketVerifier>>,
    pub lifecycle: L,
}

/// One host shutdown sequence. The runtime stops new HTTP admission alongside
/// `stop_event_intake`, then drains the accepted requests before checkpointing.
/// Implementations own upgraded connections and must stop their mutation intake too.
pub trait SidecarLifecycle {
    fn stop_event_intake(&mut self) -> impl Future<Output = Result<(), SidecarError>> + Send;
    fn checkpoint_rooms(&mut self) -> impl Future<Output = Result<(), SidecarError>> + Send;

    /// Finish storage shutdown, including the confirmed final WAL truncate.
    fn close(self) -> impl Future<Output = Result<(), SidecarError>> + Send;
}

/// Run once from the sidecar entry point after selecting the stdin-token mode.
/// Startup owns its own partial-initialization cleanup if it returns an error.
/// An EOF or signal during startup prevents readiness and requests cleanup.
/// The host requests programmatic shutdown through the quit token and awaits
/// this process entry until cleanup finishes.
pub async fn run_sidecar<L, F>(
    roots: ValidatedRoots,
    origin: SidecarOrigin,
    start: impl FnOnce(SidecarStart) -> F,
) -> Result<(), SidecarError>
where
    L: SidecarLifecycle,
    F: Future<Output = Result<SidecarApplication<L>, SidecarError>>,
{
    let roots = Arc::new(roots);
    let _lock = roots
        .acquire_sidecar_lock()
        .map_err(SidecarError::Filesystem)?;
    let mut process = ProcessInput::open()?;
    let token = process.take_token().await?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();

    roots.verify_current().map_err(SidecarError::Filesystem)?;
    let application = start(SidecarStart {
        roots: roots.clone(),
        shutdown_requested: process.stop.clone(),
    })
    .await?;
    let SidecarApplication {
        router,
        preflight,
        tickets,
        mut lifecycle,
    } = application;
    let perimeter = SidecarPerimeter::new(port, origin, token, preflight, tickets);
    let router = router.layer(perimeter);
    let readiness = roots
        .verify_current()
        .map_err(SidecarError::Filesystem)
        .and_then(|()| process.check_readiness())
        .and_then(|()| publish_ready(port));

    let outcome = if readiness.is_ok() {
        let stopped = process.stop.clone();
        let mut server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { stopped.cancelled().await })
                .await
        });
        let first = tokio::select! {
            exit = process.wait() => (exit, None),
            serve = &mut server => (Ok(()), Some(serve)),
        };
        process.stop.cancel();
        let stopped_intake = lifecycle.stop_event_intake().await;
        let drained = match first.1 {
            Some(serve) => serve,
            None => server.await,
        };
        let drained = drained
            .map_err(SidecarError::from)
            .and_then(|result| result.map_err(Into::into));
        first.0.and(stopped_intake).and(drained)
    } else {
        drop(listener);
        drop(router);
        process.stop.cancel();
        let stopped_intake = lifecycle.stop_event_intake().await;
        readiness.and(stopped_intake)
    };

    let checkpoint = lifecycle.checkpoint_rooms().await;
    let closed = lifecycle.close().await;
    outcome.and(checkpoint).and(closed)
}

fn publish_ready(port: u16) -> Result<(), SidecarError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ReadyFrame {
        schema_version: u8,
        status: &'static str,
        port: u16,
        base_url: String,
        pid: u32,
    }

    use io::Write as _;
    let mut output = io::stdout().lock();
    serde_json::to_writer(
        &mut output,
        &ReadyFrame {
            schema_version: 1,
            status: "ready",
            port,
            base_url: format!("http://127.0.0.1:{port}"),
            pid: std::process::id(),
        },
    )
    .map_err(io::Error::other)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
