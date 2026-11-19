#![allow(dead_code)]

#[path = "../../../notarium-canonical/tests/support/mod.rs"]
mod storage;

#[allow(unused_imports)]
pub use self::storage::{StorageTestFixtures, TempDataRoot, maintenance_ctx};

use std::{collections::BTreeMap, time::Duration};

use notarium_canonical::{CanonicalStore, CreateSpaceSpec, writer::RoomWalAdmissionPause};
use notarium_collab::{
    CollabHub, CollabPeerSession, CollabSessionAuth, SessionEvent,
    wire::{self, LineageHello, PeerRole},
};
use notarium_core::{
    auth::{ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::PortError,
    ids::*,
    model::HistoryScope,
    patch::CarrierEditOrigin,
    ports::{
        CallBudget, Cancellation, CreateNote, EditNote, GetNote, Mutation, NoteRevision,
        NoteWritePort, Preconditions, RevocationLease, SpaceContext,
    },
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
    span::ByteSpan,
};
use notarium_syntax::{carrier::Carrier, patch};
use tokio::{
    sync::oneshot,
    time::{Instant, timeout},
};
use yrs::{
    ClientID, Doc, GetString, MapRef, OffsetKind, Options, ReadTxn, StateVector, Text, TextRef,
    Transact, TransactionMut, Update,
    encoding::read::{Cursor, Read},
    sync::{Message, SyncMessage, protocol::MessageReader},
    updates::decoder::{Decode, DecoderV1},
};

pub const WAIT: Duration = Duration::from_secs(10);

pub fn pause_wal_admission(store: &CanonicalStore) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
    let (entered, waiting) = oneshot::channel();
    let (release, blocked) = oneshot::channel();
    let replaced = store
        .writer_faults()
        .unwrap()
        .room_wal_admission_pause_once
        .lock()
        .expect("WAL fault registry")
        .replace(RoomWalAdmissionPause {
            entered,
            release: blocked,
        });
    assert!(
        replaced.is_none(),
        "the previous WAL admission pause was consumed"
    );
    (waiting, release)
}

pub fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(storage::random_bytes_16()),
        cancellation: Cancellation::default(),
        remaining: WAIT,
    }
}

pub fn test_scope() -> HistoryScope {
    HistoryScope {
        space_id: SpaceId::from_bytes([19; 16]),
        incarnation: HistoryIncarnation::from_bytes([20; 16]),
    }
}

pub fn test_owner() -> PrincipalId {
    PrincipalId::from_bytes([21; 16])
}

pub async fn create_space(store: &CanonicalStore, scope: &HistoryScope) {
    store
        .create_space(CreateSpaceSpec {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            root_folder_id: FolderId::from_bytes([22; 16]),
            slug: "collab-tests".to_owned(),
            kind: SpaceKind::Shared,
            owner: test_owner(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
}

pub fn context(
    scope: &HistoryScope,
    principal: PrincipalId,
    role: SpaceRole,
    project_root: Option<FolderId>,
) -> SpaceContext {
    let grant = SpaceGrant {
        role,
        read_classes: DocClass::all(),
        write_classes: if role == SpaceRole::Viewer {
            Default::default()
        } else {
            DocClass::all()
        },
        project_root,
    };
    let verified = VerifiedHuman::attest(
        principal,
        GrantId::from_bytes(storage::random_bytes_16()),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        role == SpaceRole::Owner,
    )
    .with_human_management(role == SpaceRole::Owner);
    SpaceContext::new(
        EngineAuthContext::for_human(verified),
        scope.clone(),
        budget(),
    )
    .unwrap()
}

pub fn owner_context(scope: &HistoryScope) -> SpaceContext {
    context(scope, test_owner(), SpaceRole::Owner, None)
}

pub fn agent_context(owner: &SpaceContext, run: &AgentRunId) -> SpaceContext {
    let auth = owner
        .auth()
        .for_agent_run(
            run.clone(),
            owner.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    SpaceContext::new(auth, owner.scope().clone(), budget()).unwrap()
}

pub fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    let key = storage::random_bytes_16();
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes(key),
            hash: ContentDigest::from_bytes(*blake3::hash(&key).as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

pub async fn create_note(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    seed: u8,
    carrier: &str,
    parent: Option<FolderId>,
) -> NoteRevision {
    store
        .create_note(
            ctx.clone(),
            mutation(
                ctx,
                CreateNote {
                    note: NoteId::from_bytes([seed; 16]),
                    parent,
                    slug: format!("collab-note-{seed}"),
                    class: DocClass::UserDoc,
                    carrier: carrier.to_owned(),
                },
            ),
        )
        .await
        .unwrap()
        .value
}

pub async fn note_head(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
) -> (RevisionId, String) {
    let snapshot = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    (
        snapshot.document.revision().clone(),
        snapshot
            .document
            .explicit_read(ctx.auth())
            .unwrap()
            .to_owned(),
    )
}

pub fn edit(
    ctx: &SpaceContext,
    note: &NoteId,
    carrier: &str,
    origin: CarrierEditOrigin,
    start: usize,
    end: usize,
    replacement: &str,
) -> Mutation<EditNote> {
    mutation(
        ctx,
        EditNote {
            note: note.clone(),
            plan: patch::plan(
                carrier,
                Carrier::scan(carrier).unwrap().body,
                vec![(
                    origin,
                    ByteSpan::new(start, end).unwrap(),
                    replacement.to_owned(),
                )],
            )
            .unwrap(),
        },
    )
}

struct TestLease(Cancellation);

impl RevocationLease for TestLease {
    fn check(&self) -> Result<(), PortError> {
        if self.0.is_cancelled() {
            return Err(notarium_core::DomainError::AccessDenied.into());
        }
        Ok(())
    }
}

pub fn test_auth(cancellation: &Cancellation, expires_at: Option<Instant>) -> CollabSessionAuth {
    CollabSessionAuth::new(
        Box::new(TestLease(cancellation.clone())),
        cancellation.clone(),
        expires_at,
    )
}

pub async fn open(hub: &CollabHub, ctx: &SpaceContext, note: &NoteId) -> CollabPeerSession {
    hub.connect(
        ctx.clone(),
        note.clone(),
        test_auth(&Cancellation::default(), None),
    )
    .await
    .unwrap()
}

pub async fn recv(peer: &mut CollabPeerSession) -> SessionEvent {
    timeout(WAIT, peer.recv())
        .await
        .expect("transport event deadline")
        .expect("peer event")
}

pub async fn close_code(peer: &mut CollabPeerSession) -> u16 {
    match recv(peer).await {
        SessionEvent::Close(close) => close.code,
        SessionEvent::Binary(payload) => {
            panic!(
                "expected close, received y-sync data: {:?}",
                messages(&payload)
            )
        }
    }
}

pub fn messages(frame: &[u8]) -> Vec<Message> {
    let mut decoder = DecoderV1::new(Cursor::new(frame));
    MessageReader::new(&mut decoder)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

pub async fn custom(peer: &mut CollabPeerSession, expected_tag: u8) -> Vec<u8> {
    let SessionEvent::Binary(frame) = recv(peer).await else {
        panic!("expected custom y-sync message {expected_tag}, received close");
    };
    let mut messages = messages(&frame).into_iter();
    match (messages.next(), messages.next()) {
        (Some(Message::Custom(tag, data)), None) if tag == expected_tag => data,
        other => panic!("expected one custom message {expected_tag}, got {other:?}"),
    }
}

pub struct Client {
    pub peer: CollabPeerSession,
    pub doc: Doc,
    pub body: TextRef,
    pub fields: MapRef,
}

impl Client {
    pub fn new(peer: CollabPeerSession, client_id: u64) -> Self {
        let mut options = Options::with_client_id(ClientID::new(client_id));
        options.offset_kind = OffsetKind::Utf16;
        let doc = Doc::with_options(options);
        let body = doc.get_or_insert_text("body");
        let fields = doc.get_or_insert_map("fm_overrides");
        Self {
            peer,
            doc,
            body,
            fields,
        }
    }

    pub async fn ready(&mut self, hello: LineageHello) -> wire::LineageReady {
        self.peer.send(hello.encode()).await.unwrap();
        let payload = custom(&mut self.peer, wire::LINEAGE_READY).await;
        let mut decoder = DecoderV1::new(Cursor::new(&payload));
        assert_eq!(decoder.read_u8().unwrap(), wire::WIRE_PROTOCOL_VERSION);
        let history_incarnation =
            HistoryIncarnation::from_bytes(decoder.read_exact(16).unwrap().try_into().unwrap());
        let lineage_epoch = LineageEpoch::new(decoder.read_var().unwrap()).unwrap();
        let current_rev_id = RevisionId::parse(decoder.read_string().unwrap()).unwrap();
        let lease_epoch = LeaseEpoch::new(decoder.read_var().unwrap()).unwrap();
        let role = match decoder.read_u8().unwrap() {
            0 => PeerRole::Viewer,
            1 => PeerRole::Editor,
            value => panic!("invalid LineageReady role {value}"),
        };
        let fm_writable = match decoder.read_u8().unwrap() {
            0 => false,
            1 => true,
            value => panic!("invalid LineageReady fm_writable {value}"),
        };
        wire::LineageReady {
            history_incarnation,
            lineage_epoch,
            current_rev_id,
            lease_epoch,
            role,
            fm_writable,
        }
    }

    pub async fn sync(&mut self) {
        self.peer
            .send(encode_sync_step1(self.doc.transact().state_vector()))
            .await
            .unwrap();
        self.until(|message| matches!(message, Message::Sync(SyncMessage::SyncStep2(_))))
            .await;
    }

    pub fn text(&self) -> String {
        self.body.get_string(&self.doc.transact())
    }

    pub fn update(&self, apply: impl FnOnce(&mut TransactionMut<'_>)) -> Vec<u8> {
        let mut txn = self.doc.transact_mut();
        apply(&mut txn);
        txn.encode_update_v1()
    }

    pub fn append(&self, text: &str) -> Vec<u8> {
        self.update(|txn| self.body.insert(txn, self.body.len(txn), text))
    }

    pub async fn send_update(&self, update: &[u8]) {
        self.peer.send(wire::encode_update(update)).await.unwrap();
    }

    pub async fn ack(&mut self) -> wire::ServerAckWatermark {
        let Message::Custom(_, payload) = self
            .until(|message| matches!(message, Message::Custom(wire::SERVER_ACK_WATERMARK, _)))
            .await
        else {
            unreachable!()
        };
        decode_ack(&payload)
    }

    pub async fn until(&mut self, expected: impl Fn(&Message) -> bool) -> Message {
        timeout(WAIT, async {
            loop {
                let SessionEvent::Binary(frame) = self.peer.recv().await.expect("session event")
                else {
                    panic!("peer closed before expected y-sync message");
                };
                let mut result = None;
                for message in messages(&frame) {
                    if let Message::Sync(
                        SyncMessage::SyncStep2(update) | SyncMessage::Update(update),
                    ) = &message
                    {
                        self.doc
                            .transact_mut()
                            .apply_update(Update::decode_v1(update).unwrap())
                            .unwrap();
                    }
                    if expected(&message) {
                        result = Some(message);
                    }
                }
                if let Some(result) = result {
                    return result;
                }
            }
        })
        .await
        .expect("expected y-sync message before deadline")
    }
}

pub fn decode_ack(payload: &[u8]) -> wire::ServerAckWatermark {
    let mut decoder = DecoderV1::new(Cursor::new(payload));
    assert_eq!(decoder.read_u8().unwrap(), wire::WIRE_PROTOCOL_VERSION);
    wire::ServerAckWatermark {
        lease_epoch: LeaseEpoch::new(decoder.read_var().unwrap()).unwrap(),
        peer_write_seq: decoder.read_var().unwrap(),
        room_update_seq: decoder.read_var().unwrap(),
    }
}

pub async fn synced_client(
    hub: &CollabHub,
    ctx: &SpaceContext,
    note: &NoteId,
    id: u64,
) -> (Client, wire::LineageReady) {
    let mut client = Client::new(open(hub, ctx, note).await, id);
    let ready = client.ready(wire::LineageHello::Fresh).await;
    client.sync().await;
    (client, ready)
}

pub async fn wait_until(mut condition: impl AsyncFnMut() -> bool) {
    timeout(WAIT, async {
        while !condition().await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition before test deadline");
}

pub fn encode_sync_step1(state: StateVector) -> Vec<u8> {
    use yrs::updates::encoder::Encode;
    Message::Sync(SyncMessage::SyncStep1(state)).encode_v1()
}

pub fn empty_sync() -> Vec<u8> {
    encode_sync_step1(StateVector::default())
}
