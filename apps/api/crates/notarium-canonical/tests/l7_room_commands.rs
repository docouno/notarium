#![forbid(unsafe_code)]

mod support;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CloseCollabSession, CollabSessionRecord,
    CreateSpaceSpec, OpenCollabSession, RoomCommandSettlement, S3BucketModePolicy,
    UpdateSpaceSchema,
    blobs::s3::admin_ensure_bucket,
    changes::{EffectBodyV1, EffectEnvelopeV1},
    codec::RevisionMetadataPayload,
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{CommandKey, ContentDigest, GrantId, LeaseEpoch, NoteId, RequestId, SpaceSeq},
    model::HistoryScope,
    patch::CarrierEditOrigin,
    ports::{
        CallBudget, Cancellation, Committed, CreateNote, EditNote, ExternalObservation,
        ExternalObservationResult, FilenamePin, GetNote, InterceptedMutation, InterceptionResult,
        LiveCollabInterceptor, Mutation, NoteRevision, NoteWritePort, ObservedContent, PortFuture,
        Preconditions, RenameNote, RollbackReservation, SpaceContext,
    },
    query::{FieldObservation, FieldSchema, FieldType, FieldValue, ScalarType},
    receipt::{CausalBasis, CommandIdentity, MutationReceiptToken, ReceiptSet},
    span::ByteSpan,
    value::{ScalarValue, YamlValue},
};
use notarium_syntax::{content_digest, frontmatter, patch};
use tokio::sync::oneshot;

use support::{
    StorageTestFixtures, TempDataRoot, random_bytes_16, sample_folder_id, sample_incarnation,
    sample_installation_id, sample_note_id, sample_principal_id, sample_space_id,
};

fn command<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes(random_bytes_16()),
            hash: content_digest("room command integration test"),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

fn set_status(note: NoteId, base: &str, status: &str) -> EditNote {
    let plan = frontmatter::patch_frontmatter(
        base,
        DocClass::UserDoc,
        &[frontmatter::FieldEdit::Set {
            key: "status".into(),
            value: YamlValue::String(status.into()),
        }],
    )
    .unwrap();
    EditNote { note, plan }
}

async fn assert_carrier_metadata(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    committed: &Committed<NoteRevision>,
    carrier: &str,
    expected_status: Option<&str>,
) {
    let snapshot = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: committed.value.note.clone(),
                revision: Some(committed.value.revision.clone()),
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        snapshot.document.explicit_read(ctx.auth()).unwrap(),
        carrier
    );
    assert_eq!(snapshot.document.digest(), content_digest(carrier));
    let record = store
        .read_entity_revision_at_cutoff(
            ctx.scope(),
            "note",
            committed.value.note.as_str(),
            Some(committed.receipt.seq()),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.revision_id, committed.value.revision);
    let RevisionMetadataPayload::Note(metadata) = record.metadata.payload else {
        panic!("expected note metadata");
    };
    let parsed = frontmatter::analyze(carrier, DocClass::UserDoc).unwrap();
    assert_eq!(metadata.raw_fields, parsed.fields);
    assert_eq!(metadata.evaluated_fields, snapshot.fields);
    if let Some(status) = expected_status {
        assert_eq!(
            snapshot.fields.get("status"),
            Some(&FieldObservation::Ok(FieldValue::Scalar(
                ScalarValue::String(status.into())
            ))),
        );
    }
}

struct ObservationEvidence {
    committed: Committed<NoteRevision>,
    observed_digest: ContentDigest,
    observed_size: usize,
    grant: GrantId,
}

const OBSERVATION_EVIDENCE_QUERY: &str = "SELECT effect.effect_msgpack, receipt.effect_msgpack, o.blake3_hash, o.byte_size
      FROM change_commands c
      JOIN change_payloads effect ON effect.space_id = c.space_id AND effect.payload_id = c.payload_id
      JOIN command_receipts r ON r.space_id = c.space_id
           AND r.history_incarnation = c.history_incarnation AND r.canonical_seq = c.last_seq
      JOIN change_payloads receipt ON receipt.space_id = r.space_id
           AND receipt.payload_id = r.response_payload_id
      JOIN materialized_observations o ON o.space_id = c.space_id AND o.applied_seq = c.last_seq
     WHERE c.space_id = $1 AND c.last_seq = $2";

type StoredObservationEvidence = (Vec<u8>, Vec<u8>, Vec<u8>, i64);

impl ObservationEvidence {
    fn receipt(&self) -> &MutationReceiptToken {
        &self.committed.receipt
    }

    fn assert(&self, (effect, receipt, digest, size): StoredObservationEvidence) {
        let effect = EffectEnvelopeV1::decode(&effect).unwrap();
        let EffectBodyV1::Notes { notes } = effect.body else {
            panic!("expected note field effects");
        };
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].note_id, self.committed.value.note);
        assert_eq!(notes[0].revision, self.committed.value.revision);
        assert_eq!(
            notes[0].changed_fields.get("status"),
            Some(&FieldObservation::Ok(FieldValue::Scalar(
                ScalarValue::String("active".into())
            ))),
        );
        #[derive(serde::Deserialize)]
        struct ReceiptGrant {
            originating_grant: GrantId,
        }
        assert_eq!(
            rmp_serde::from_slice::<ReceiptGrant>(&receipt)
                .unwrap()
                .originating_grant,
            self.grant,
        );
        assert_eq!(
            digest.as_slice(),
            self.observed_digest.as_bytes().as_slice()
        );
        assert_eq!(size, self.observed_size as i64);
    }
}

async fn canonical_room_command_settlement(store: &CanonicalStore) -> ObservationEvidence {
    let scope = HistoryScope {
        space_id: sample_space_id(77),
        incarnation: sample_incarnation(77),
    };
    let owner = sample_principal_id(77);
    store
        .create_space(CreateSpaceSpec {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            root_folder_id: sample_folder_id(77),
            slug: "room-commands".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            owner,
            GrantId::from_bytes([77; 16]),
            BTreeMap::from([(scope.space_id.clone(), grant)]),
            true,
        )),
        scope.clone(),
        CallBudget {
            request: RequestId::from_bytes(random_bytes_16()),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        },
    )
    .unwrap();
    store
        .update_space_schema(
            ctx.clone(),
            command(
                &ctx,
                UpdateSpaceSchema {
                    schema_note: sample_note_id(78),
                    parent: None,
                    slug: "fields".into(),
                    carrier: "# Fields\n".into(),
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
    let note = sample_note_id(79);
    let first = "\u{feff}# Draft 🚀\n";
    let created = store
        .create_note(
            ctx.clone(),
            command(
                &ctx,
                CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "draft".into(),
                    class: DocClass::UserDoc,
                    carrier: first.into(),
                },
            ),
        )
        .await
        .unwrap();
    let opened = store
        .open_collab_session(
            &ctx.budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "room-owner".into(),
                expected_carrier_rev: created.value.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: Some(vec![0, 0]),
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    let edit = command(&ctx, set_status(note.clone(), first, "done"));
    let updated = patch::apply(first, &edit.input.plan).unwrap();
    let settlement = RoomCommandSettlement {
        owner_id: "room-owner".into(),
        expected_lease: opened.lease_epoch,
        expected_lineage: opened.lineage_epoch,
        expected_base_rev: created.value.revision,
        final_carrier: updated.clone(),
        yrs_snapshot: vec![1, 0],
        compacted_through_update_seq: Some(0),
    };
    let committed = store
        .commit_intercepted_edit_note(
            ctx.clone(),
            edit.identity.clone(),
            edit.preconditions.clone(),
            edit.input.clone(),
            settlement.clone(),
        )
        .await
        .unwrap();
    assert_carrier_metadata(store, &ctx, &committed, &updated, Some("done")).await;

    // The observed file differs from the merged carrier by a pending peer edit.
    let observed =
        patch::apply(&updated, &set_status(note.clone(), &updated, "active").plan).unwrap();
    let observed_digest = content_digest(&observed);
    let observed_size = observed.len();
    let merged = format!("{observed}\nPeer edit.\n");
    let observation = command(
        &ctx,
        ExternalObservation {
            note: note.clone(),
            base_revision: committed.value.revision,
            observed_digest,
            disk_identity: content_digest("disk file"),
            content: ObservedContent::Carrier(observed),
        },
    );
    let ExternalObservationResult::Committed(second) = store
        .commit_intercepted_external_observation(
            ctx.clone(),
            observation.identity,
            observation.preconditions,
            observation.input.clone(),
            RoomCommandSettlement {
                expected_base_rev: observation.input.base_revision,
                final_carrier: merged.clone(),
                yrs_snapshot: vec![2, 0],
                ..settlement.clone()
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected a committed room observation");
    };
    assert_carrier_metadata(store, &ctx, &second, &merged, Some("active")).await;
    let replayed = store
        .commit_intercepted_edit_note(
            ctx.clone(),
            edit.identity,
            edit.preconditions,
            edit.input,
            settlement.clone(),
        )
        .await
        .unwrap();
    assert_eq!(replayed.receipt, committed.receipt);
    let durable = store
        .read_collab_session(Some(&ctx.budget), &scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(durable.session.carrier_rev_id, second.value.revision);
    assert_eq!(durable.session.yrs_snapshot_blob, Some(vec![2, 0]));
    assert!(!durable.session.carrier_dirty);
    assert!(durable.updates.is_empty());

    let body = frontmatter::analyze(&merged, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let edit = command(
        &ctx,
        EditNote {
            note: note.clone(),
            plan: patch::plan(
                &merged,
                body,
                vec![(
                    CarrierEditOrigin::Body,
                    ByteSpan::new(body.end(), body.end()).unwrap(),
                    "third".into(),
                )],
            )
            .unwrap(),
        },
    );
    let rejected = store
        .commit_intercepted_edit_note(
            ctx.clone(),
            edit.identity,
            edit.preconditions,
            edit.input,
            RoomCommandSettlement {
                owner_id: "different-room-owner".into(),
                expected_base_rev: second.value.revision.clone(),
                final_carrier: merged.clone(),
                ..settlement
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        rejected,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::InvalidAuthority
    ));
    rejects_superseded_filename_pin(store, &ctx, note, durable.session, &merged).await;
    ObservationEvidence {
        committed: second,
        observed_digest,
        observed_size,
        grant: ctx.auth().grant().clone(),
    }
}

type PinPause = (oneshot::Sender<()>, oneshot::Receiver<FilenamePin>);

struct PinGate(Mutex<Option<PinPause>>);

impl LiveCollabInterceptor for PinGate {
    fn intercept(&self, _: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async {
            Ok(InterceptionResult::Conflict(DomainError::validation(
                ValidationReason::FmNotWritable,
            )))
        })
    }

    fn reserve_rollback(
        &self,
        _: SpaceContext,
        _: NoteId,
        _: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        panic!("this fixture only serves filename pins");
    }

    fn filename_pin(&self, _: SpaceContext, _: NoteId) -> PortFuture<'_, FilenamePin> {
        let pause = self.0.lock().unwrap().take();
        Box::pin(async move {
            if let Some((entered, release)) = pause {
                entered.send(()).unwrap();
                Ok(release.await.unwrap())
            } else {
                Ok(FilenamePin::Unpinned)
            }
        })
    }
}

async fn rejects_superseded_filename_pin(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: NoteId,
    first: CollabSessionRecord,
    carrier: &str,
) {
    let (entered, wait) = oneshot::channel();
    let (release, pause) = oneshot::channel();
    store
        .register_collab_interceptor(Arc::new(PinGate(Mutex::new(Some((entered, pause))))))
        .unwrap();
    let rename = |slug: &str| {
        command(
            ctx,
            RenameNote {
                note: note.clone(),
                slug: slug.into(),
                title: None,
            },
        )
    };
    let replace_room = async {
        wait.await.unwrap();
        let closed = store
            .close_collab_session(
                &ctx.budget,
                CloseCollabSession {
                    scope: ctx.scope().clone(),
                    note: note.clone(),
                    owner_id: first.owner_id,
                    expected_lease: first.lease_epoch,
                    expected_lineage: first.lineage_epoch,
                    final_yrs_snapshot: first.yrs_snapshot_blob.clone(),
                    compacted_through_update_seq: Some(0),
                    carrier_settlement: None,
                    unchanged_carrier_digest: Some(content_digest(carrier)),
                },
            )
            .await
            .unwrap();
        let renamed = store
            .rename_note(ctx.clone(), rename("renamed"))
            .await
            .unwrap();
        let second = store
            .open_collab_session(
                &ctx.budget,
                OpenCollabSession {
                    scope: ctx.scope().clone(),
                    note: note.clone(),
                    owner_id: "next-room-owner".into(),
                    expected_carrier_rev: renamed.value.revision.clone(),
                    expected_lease: Some(closed.lease_epoch),
                    expected_lineage: Some(closed.lineage_epoch),
                    initial_yrs_snapshot: None,
                    allow_fenced_recovery: false,
                },
            )
            .await
            .unwrap();
        release
            .send(FilenamePin::Pinned {
                note: note.clone(),
                filename: "draft".into(),
                lease: first.lease_epoch,
            })
            .unwrap();
        second
    };
    let (rolled_over, second) = tokio::join!(
        store.rename_note(ctx.clone(), rename("draft")),
        replace_room
    );
    assert!(matches!(rolled_over, Err(PortError::Unavailable(_))));
    assert_ne!(second.lease_epoch, first.lease_epoch);
    let latest = store
        .read_collab_session(Some(&ctx.budget), ctx.scope(), &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest.session, second);
    let observed = format!("{carrier}\nObservation after rename.\n");
    let result = store
        .accept_external_observation(
            ctx.clone(),
            command(
                ctx,
                ExternalObservation {
                    note,
                    base_revision: latest.session.carrier_rev_id,
                    observed_digest: content_digest(&observed),
                    disk_identity: content_digest("observation after rename"),
                    content: ObservedContent::Carrier(observed),
                },
            ),
        )
        .await;
    assert!(matches!(
        result,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::FmNotWritable
    ));
}

#[tokio::test]
async fn room_command_settlement_sqlite() {
    let root = TempDataRoot::new("l7-room-commands");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(77),
        root.data_root(),
    ))
    .await
    .unwrap();
    let evidence = canonical_room_command_settlement(&store).await;
    let mut connection = root.open_raw_sqlite().await;
    evidence.assert(
        sqlx::query_as(OBSERVATION_EVIDENCE_QUERY)
            .bind(evidence.receipt().scope().space_id.as_str())
            .bind(evidence.receipt().seq().get() as i64)
            .fetch_one(&mut connection)
            .await
            .unwrap(),
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn room_command_settlement_postgres_s3() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("l7-room-commands");
    let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let config = fixtures.pg_s3_config(sample_installation_id(77), &schema, s3);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let evidence = canonical_room_command_settlement(&store).await;
    let mut connection = fixtures.open_raw_pg().await;
    sqlx::query("SELECT pg_catalog.set_config('search_path', $1, false)")
        .bind(&schema)
        .execute(&mut connection)
        .await
        .unwrap();
    evidence.assert(
        sqlx::query_as(OBSERVATION_EVIDENCE_QUERY)
            .bind(evidence.receipt().scope().space_id.as_str())
            .bind(evidence.receipt().seq().get() as i64)
            .fetch_one(&mut connection)
            .await
            .unwrap(),
    );
    runtime.shutdown().await.unwrap();
}
