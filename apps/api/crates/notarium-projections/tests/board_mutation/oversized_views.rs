use std::{fmt::Write, time::Duration};

use notarium_core::{
    error::ValidationReason,
    patch::CarrierEditOrigin,
    ports::{EditNote, PageLimit, ViewGraphPort, ViewQuery},
    query::{FieldFilterAstV1, Predicate, ReadRequest},
    receipt::AwaitWatermarks,
};
use notarium_projections::nota::NotaDescriptor;

use super::*;

const PENDING_SIZE: usize = 17 * 1024 * 1024;
const PRESENTATION_SIZE: usize = 960 * 1024;
const VIEW_COUNT: u8 = 19;

pub(super) struct OversizedViews {
    owner: SpaceContext,
    ready: NoteRevision,
    ready_key: ViewKey,
    large: NoteRevision,
}

pub(super) async fn fixture(store: &CanonicalStore) -> OversizedViews {
    let (_, owner) = open_space(store).await;
    let ready_key = ViewKey::from_bytes([0x90; 16]);
    let ready = note(
        store,
        &owner,
        "pending",
        DocClass::UserDoc,
        small(&ready_key),
    )
    .await;
    let large = note(store, &owner, "large", DocClass::UserDoc, large_ready()).await;
    OversizedViews {
        owner,
        ready,
        ready_key,
        large,
    }
}

impl OversizedViews {
    pub(super) async fn exercise(
        self,
        store: &CanonicalStore,
        runtime: &ProjectorRuntime,
        derived: &DerivedStore,
    ) {
        // Both notes predate the runtime. Starting on an empty generation must
        // seed valid aggregate inputs whose single projected row exceeds 16 MiB.
        let scope = self.owner.scope();
        let seeded = wait(store, runtime, scope).await;
        assert_eq!(
            derived
                .watermarks(&scope.space_id)
                .await
                .unwrap()
                .unwrap()
                .snapshot_seq,
            seeded,
        );
        let last_view = ViewRef {
            note: self.large.note.clone(),
            key: large_key(VIEW_COUNT),
        };
        let fingerprint = check_large(derived, scope, seeded, &last_view).await;
        let view = ViewRef {
            note: self.ready.note.clone(),
            key: self.ready_key.clone(),
        };
        query(runtime, &self.owner, &view).await.unwrap();

        let mut pending = format!("```nota\nid: {}\ntype: table\noptions: [", self.ready_key);
        pending.extend(std::iter::repeat_n('x', PENDING_SIZE));
        let edited = edit(
            store,
            &self.owner,
            self.ready,
            &small(&self.ready_key),
            pending.clone(),
        )
        .await;
        let pending_cut = wait(store, runtime, scope).await;
        check_pending(runtime, &self.owner, &view).await;
        let row = derived
            .note_by_id(scope, pending_cut, &view.note)
            .await
            .unwrap()
            .unwrap();
        assert!(row.view_blocks_msgpack.len() < 512);

        store
            .update_space_schema(
                self.owner.clone(),
                mutation(
                    &self.owner,
                    UpdateSpaceSchema {
                        schema_note: NoteId::from_bytes(random_bytes()),
                        parent: None,
                        slug: "new-schema".into(),
                        carrier: "# Schema\n".into(),
                        schema: BTreeMap::from([(
                            "status".into(),
                            FieldSchema {
                                kind: FieldType::Scalar(ScalarType::String),
                                nullable: false,
                            },
                        )]),
                        expected_schema_revision: None,
                    },
                ),
            )
            .await
            .unwrap();
        let recompiled = wait(store, runtime, scope).await;
        assert_eq!(
            check_large(derived, scope, recompiled, &last_view).await,
            fingerprint
        );
        check_pending(runtime, &self.owner, &view).await;

        edit(store, &self.owner, edited, &pending, small(&self.ready_key)).await;
        // Subsequent rotation fixtures need only the small authored views.
        edit(
            store,
            &self.owner,
            self.large,
            &large_ready(),
            small(&last_view.key),
        )
        .await;
        wait(store, runtime, scope).await;
        query(runtime, &self.owner, &view).await.unwrap();
    }
}

fn small(key: &ViewKey) -> String {
    format!("```nota\nid: {key}\ntype: table\n```\n")
}

fn large_key(index: u8) -> ViewKey {
    ViewKey::from_bytes([index; 16])
}

fn large_ready() -> String {
    let mut carrier = String::with_capacity(usize::from(VIEW_COUNT) * (PRESENTATION_SIZE + 100));
    for ord in 1..=VIEW_COUNT {
        write!(
            carrier,
            "```nota\nid: {}\ntype: table\ncustom: ",
            large_key(ord)
        )
        .unwrap();
        carrier.extend(std::iter::repeat_n(
            char::from(b'a' + ord),
            PRESENTATION_SIZE,
        ));
        carrier.push_str("\n```\n");
    }
    carrier
}

async fn check_large(
    derived: &DerivedStore,
    scope: &HistoryScope,
    cut: SpaceSeq,
    view: &ViewRef,
) -> ContentDigest {
    let note = derived
        .note_by_id(scope, cut, &view.note)
        .await
        .unwrap()
        .unwrap();
    assert!(note.view_blocks_msgpack.len() > 16 * 1024 * 1024);
    let row = derived
        .view_descriptor(scope, cut, view)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "ready");
    let descriptor: NotaDescriptor = rmp_serde::from_slice(&row.compiled_msgpack.unwrap()).unwrap();
    let YamlValue::String(presentation) = &descriptor.presentation["custom"] else {
        panic!("the authored field is a string")
    };
    assert_eq!(presentation.len(), PRESENTATION_SIZE);
    assert!(presentation.bytes().all(|byte| byte == b'a' + VIEW_COUNT));
    row.view_fingerprint.unwrap()
}

async fn wait(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
    scope: &HistoryScope,
) -> SpaceSeq {
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let budget = CallBudget {
        remaining: Duration::from_secs(60),
        ..budget()
    };
    runtime
        .engine()
        .wait_for_projected(scope, head, &budget)
        .await
        .unwrap();
    head
}

async fn edit(
    store: &CanonicalStore,
    owner: &SpaceContext,
    note: NoteRevision,
    from: &str,
    to: String,
) -> NoteRevision {
    let body = notarium_syntax::frontmatter::analyze(from, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(from, body, vec![(CarrierEditOrigin::Body, body, to)])
        .unwrap();
    let mut edit = mutation(
        owner,
        EditNote {
            note: note.note,
            plan,
        },
    );
    edit.preconditions.revision = Some(note.revision);
    store.edit_note(owner.clone(), edit).await.unwrap().value
}

async fn query(
    runtime: &ProjectorRuntime,
    owner: &SpaceContext,
    view: &ViewRef,
) -> Result<(), PortError> {
    runtime
        .engine()
        .query_view(
            owner.clone(),
            ReadRequest::Open {
                query: ViewQuery {
                    view: view.clone(),
                    filter: FieldFilterAstV1 {
                        version: 1,
                        predicate: Predicate::All(Vec::new()),
                    },
                    sort: None,
                    group_by: None,
                    limit: PageLimit::new(1).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .map(|_| ())
}

async fn check_pending(runtime: &ProjectorRuntime, owner: &SpaceContext, view: &ViewRef) {
    assert!(matches!(
        query(runtime, owner, view).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::PendingView
    ));
}
