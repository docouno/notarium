use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    io,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Extension, Json, Router,
    extract::{Query, State, WebSocketUpgrade, ws::Message},
    http::{
        Extensions, Method, StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::DataRoot,
    error::PortError,
    ids::{
        CommandKey, ContentDigest, FolderId, GrantId, HistoryIncarnation, InstallationId,
        LeaseEpoch, NoteId, PrincipalId, RequestId, SpaceId, SpaceSeq,
    },
    model::HistoryScope,
    ports::{CallBudget, CreateNote, Mutation, NoteWritePort, Preconditions, SpaceContext},
    receipt::CommandIdentity,
};
use notarium_vault::{
    filesystem::ValidatedRoots,
    sidecar::{
        COLLAB_PROTOCOL, PreflightRule, SidecarApplication, SidecarError, SidecarLifecycle,
        SidecarOrigin, WS_TICKET_PATH, WsTicketRequest, WsTicketVerifier, run_sidecar,
    },
};
use serde::{Deserialize, Serialize};

pub const RECEIPT_BODY: &str =
    "# Confirmed sidecar write\n\nCanonical CAS survives process exit.\n";
pub const CHECKPOINT_BODY: &str = "# Final checkpoint marker\n\nWritten during shutdown.\n";
const GREETING_PATH: &str = "/api/greeting";

pub fn space_id() -> SpaceId {
    SpaceId::from_bytes([1; 16])
}

fn owner() -> PrincipalId {
    PrincipalId::from_bytes([3; 16])
}

pub fn note_id(checkpoint: bool) -> NoteId {
    NoteId::from_bytes([if checkpoint { 4 } else { 2 }; 16])
}

pub fn authorized(scope: &HistoryScope) -> Result<SpaceContext, SidecarError> {
    let auth = VerifiedHuman::attest(
        owner(),
        GrantId::from_bytes([3; 16]),
        BTreeMap::from([(
            scope.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        false,
    );
    SpaceContext::new(
        EngineAuthContext::for_human(auth),
        scope.clone(),
        CallBudget {
            request: RequestId::from_bytes([3; 16]),
            remaining: Duration::from_secs(4),
            cancellation: Default::default(),
        },
    )
    .map_err(|error| SidecarError::Storage(error.into()))
}

pub fn config(root: DataRoot) -> CanonicalConfig {
    CanonicalConfig::local_default(InstallationId::from_bytes([5; 16]), root)
}

pub async fn commit_note(
    store: &CanonicalStore,
    scope: &HistoryScope,
    checkpoint: bool,
) -> Result<(), SidecarError> {
    let (slug, carrier) = if checkpoint {
        ("sidecar-checkpoint", CHECKPOINT_BODY)
    } else {
        ("sidecar-confirmed", RECEIPT_BODY)
    };
    store
        .create_note(
            authorized(scope)?,
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner(),
                    key: CommandKey::from_bytes([if checkpoint { 4 } else { 2 }; 16]),
                    hash: ContentDigest::from_bytes(*blake3::hash(carrier.as_bytes()).as_bytes()),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note_id(checkpoint),
                    parent: None,
                    slug: slug.into(),
                    class: DocClass::UserDoc,
                    carrier: carrier.into(),
                },
            },
        )
        .await?;
    Ok(())
}

pub async fn launch(
    root: DataRoot,
    origin: SidecarOrigin,
    hold_checkpoint: bool,
) -> Result<(), SidecarError> {
    let roots = ValidatedRoots::open(&root, None).map_err(SidecarError::Filesystem)?;
    run_sidecar(roots, origin, |start| async move {
        let root = start.roots.data_root().clone();
        let (store, runtime) = CanonicalRuntime::open(config(root.clone())).await?;
        let initialized = async {
            let record = match store.get_space(&space_id()).await {
                Ok(record) => record,
                Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                    store
                        .create_space(CreateSpaceSpec {
                            space_id: space_id(),
                            incarnation: HistoryIncarnation::from_bytes([6; 16]),
                            root_folder_id: FolderId::from_bytes([7; 16]),
                            kind: SpaceKind::Personal,
                            slug: "sidecar-fixture".into(),
                            owner: owner(),
                            active_epoch: LeaseEpoch::new(1).expect("valid epoch"),
                            initial_last_seq: SpaceSeq::ZERO,
                            created_at: None,
                        })
                        .await?
                }
                Err(error) => return Err(error.into()),
            };
            commit_note(&store, &record.scope, false).await?;
            Ok::<_, SidecarError>(record.scope)
        }
        .await;
        let scope = match initialized {
            Ok(scope) => scope,
            Err(error) => {
                runtime.shutdown().await?;
                return Err(error);
            }
        };
        let tickets = Arc::new(FixtureTickets::default());
        let router = Router::new()
            .route(GREETING_PATH, get(greeting))
            .route(WS_TICKET_PATH, post(issue_ticket))
            .route(
                "/api/v1/spaces/{space_id}/notes/{note_id}/collab",
                get(collab),
            )
            .with_state(tickets.clone());
        Ok(SidecarApplication {
            router,
            preflight: vec![
                PreflightRule::new(GREETING_PATH, Method::GET, &[AUTHORIZATION]),
                PreflightRule::new(WS_TICKET_PATH, Method::POST, &[AUTHORIZATION, CONTENT_TYPE]),
            ],
            tickets: Some(tickets),
            lifecycle: FixtureLifecycle {
                checkpoint_barrier: hold_checkpoint.then(|| root.root().to_owned()),
                runtime,
                scope,
                store,
            },
        })
    })
    .await
}

struct FixtureLifecycle {
    checkpoint_barrier: Option<PathBuf>,
    runtime: CanonicalRuntime,
    scope: HistoryScope,
    store: CanonicalStore,
}

impl SidecarLifecycle for FixtureLifecycle {
    async fn stop_event_intake(&mut self) -> Result<(), SidecarError> {
        Ok(())
    }

    async fn checkpoint_rooms(&mut self) -> Result<(), SidecarError> {
        let Some(dir) = &self.checkpoint_barrier else {
            return Ok(());
        };
        // A room checkpoint is accepted by the test room before the control
        // probe releases the simulated room worker to submit its write.
        let (release, ready) = tokio::sync::oneshot::channel();
        let store = self.store.clone();
        let scope = self.scope.clone();
        let pending = tokio::spawn(async move {
            ready.await.map_err(io::Error::other)?;
            commit_note(&store, &scope, true).await
        });
        tokio::fs::write(dir.join("checkpoint.waiting"), b"checkpoint accepted").await?;
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if tokio::fs::try_exists(dir.join("checkpoint.release")).await? {
                    return Ok::<_, io::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
        })
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "fixture checkpoint was not released",
            )
        })??;
        release
            .send(())
            .map_err(|()| io::Error::other("fixture checkpoint worker closed"))?;
        pending.await?
    }

    async fn close(self) -> Result<(), SidecarError> {
        self.runtime.shutdown_with_wal_truncate().await?;
        Ok(())
    }
}

#[derive(Deserialize)]
struct GreetingQuery {
    name: Option<String>,
}

async fn greeting(Query(query): Query<GreetingQuery>) -> Json<serde_json::Value> {
    let name = query
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    Json(serde_json::json!({ "message": format!("Hello, {}!", name.unwrap_or("world")) }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketScope {
    space_id: SpaceId,
    note_id: NoteId,
}

struct TicketGrant {
    scope: TicketScope,
    expiry: Instant,
}

#[derive(Default)]
struct FixtureTickets(Mutex<HashMap<[u8; 16], TicketGrant>>);

#[derive(Clone)]
struct VerifiedFixtureTicket;

impl WsTicketVerifier for FixtureTickets {
    fn consume(
        &self,
        request: WsTicketRequest,
    ) -> Pin<Box<dyn Future<Output = Option<Extensions>> + Send + '_>> {
        Box::pin(async move {
            let mut grants = self.0.lock().unwrap();
            let valid = grants.get(&*request.ticket).is_some_and(|grant| {
                grant.expiry > Instant::now()
                    && grant.scope.space_id == request.space_id
                    && grant.scope.note_id == request.note_id
            });
            if valid {
                grants.remove(&*request.ticket);
                let mut authority = Extensions::new();
                authority.insert(VerifiedFixtureTicket);
                Some(authority)
            } else {
                None
            }
        })
    }
}

#[derive(Serialize)]
struct TicketResponse {
    ticket: String,
    expires_in: u32,
}

async fn issue_ticket(
    State(tickets): State<Arc<FixtureTickets>>,
    Json(scope): Json<TicketScope>,
) -> Response {
    let mut grants = tickets.0.lock().unwrap();
    let now = Instant::now();
    grants.retain(|_, grant| grant.expiry > now);
    if scope.space_id != space_id() || scope.note_id != note_id(false) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if grants.len() >= 64 {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let mut secret = [0; 16];
    if getrandom::fill(&mut secret).is_err() || grants.contains_key(&secret) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    grants.insert(
        secret,
        TicketGrant {
            scope,
            expiry: now + Duration::from_secs(30),
        },
    );
    (
        [(CACHE_CONTROL, "no-store")],
        Json(TicketResponse {
            ticket: URL_SAFE_NO_PAD.encode(secret),
            expires_in: 30,
        }),
    )
        .into_response()
}

async fn collab(_: Extension<VerifiedFixtureTicket>, socket: WebSocketUpgrade) -> Response {
    socket
        .protocols([COLLAB_PROTOCOL])
        .on_upgrade(|mut socket| async move {
            let _ = socket.send(Message::Text("fixture-ready".into())).await;
            let _ = socket.send(Message::Close(None)).await;
        })
}
