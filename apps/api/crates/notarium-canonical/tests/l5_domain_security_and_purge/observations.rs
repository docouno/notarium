use super::*;
use notarium_core::{patch::CarrierEditOrigin, span::ByteSpan};

fn planned(base: &str, replacement: &str) -> ObservedContent {
    let span = ByteSpan::checked(base, 0, base.len()).unwrap();
    ObservedContent::Planned(
        notarium_syntax::patch::plan(
            base,
            span,
            vec![(CarrierEditOrigin::Body, span, replacement.into())],
        )
        .unwrap(),
    )
}

fn committed(result: ExternalObservationResult) -> Committed<NoteRevision> {
    let ExternalObservationResult::Committed(result) = result else {
        panic!("expected a committed observation");
    };
    result
}

#[tokio::test]
async fn observed_digest_matches_content_on_no_change_and_replay() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    for postgres in [false, true] {
        let root = TempDataRoot::new("observation-digest");
        let installation = sample_installation_id(93);
        let cfg = if postgres {
            fixtures.open_pg_s3_config(installation, &schema).await
        } else {
            CanonicalConfig::local_default(installation, root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
        let owner = sample_principal_id(93);
        let (scope, _) = seed_default_space(
            &store,
            sample_space_id(93),
            sample_incarnation(93),
            owner.clone(),
        )
        .await;
        let ctx = owner_ctx(&scope, owner.clone(), true, true);
        let note = sample_note_id(93);
        let base = store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: note.clone(),
                        parent: None,
                        slug: "observed".into(),
                        class: DocClass::UserDoc,
                        carrier: "first".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let observe = |base: &RevisionId, declared: &str, content: ObservedContent| {
            next_mutation(
                &scope,
                &owner,
                ExternalObservation {
                    note: note.clone(),
                    base_revision: base.clone(),
                    observed_digest: notarium_syntax::content_digest(declared),
                    disk_identity: ContentDigest::from_bytes([93; 32]),
                    content,
                },
            )
        };
        for content in [
            ObservedContent::Carrier("changed".into()),
            planned("first", "changed"),
        ] {
            let request = observe(&base.value.revision, "first", content);
            assert_validation_err(
                &store
                    .accept_external_observation(ctx.clone(), request)
                    .await,
                ValidationReason::InvalidDigest,
            );
        }
        for content in [
            ObservedContent::Carrier("first".into()),
            planned("first", "first"),
        ] {
            let request = observe(&base.value.revision, "first", content);
            assert!(
                matches!(store.accept_external_observation(ctx.clone(), request).await.unwrap(), ExternalObservationResult::NoChange {revision} if revision == base.value.revision)
            );
        }
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            base.receipt.seq()
        );

        // A full carrier has the same receipt fields as observations predating plan witnesses.
        let first = observe(
            &base.value.revision,
            "second",
            ObservedContent::Carrier("second".into()),
        );
        let changed = committed(
            store
                .accept_external_observation(ctx.clone(), first.clone())
                .await
                .unwrap(),
        );
        let second = observe(&changed.value.revision, "third", planned("second", "third"));
        let latest = committed(
            store
                .accept_external_observation(ctx.clone(), second.clone())
                .await
                .unwrap(),
        );
        for (request, original, original_text, result_text) in [
            (first, &changed, "first", "second"),
            (second, &latest, "second", "third"),
        ] {
            let write_only = make_human_ctx(
                &scope,
                owner.clone(),
                SpaceGrant {
                    role: SpaceRole::Editor,
                    read_classes: BTreeSet::new(),
                    write_classes: DocClass::all(),
                    project_root: None,
                },
                false,
                false,
            );
            for content in [
                ObservedContent::Carrier(result_text.into()),
                planned(original_text, result_text),
            ] {
                let mut retry = request.clone();
                retry.input.content = content;
                let result = committed(
                    store
                        .accept_external_observation(write_only.clone(), retry)
                        .await
                        .unwrap(),
                );
                assert_eq!(result.value, original.value);
                assert_eq!(result.receipt, original.receipt);
            }
            for content in [
                ObservedContent::Carrier("different".into()),
                planned(original_text, "different"),
            ] {
                let mut retry = request.clone();
                retry.input.content = content;
                let restricted = make_human_ctx(
                    &scope,
                    owner.clone(),
                    SpaceGrant {
                        role: SpaceRole::Editor,
                        read_classes: DocClass::all(),
                        write_classes: BTreeSet::new(),
                        project_root: None,
                    },
                    false,
                    false,
                );
                assert_eq!(
                    store
                        .accept_external_observation(restricted, retry.clone())
                        .await
                        .unwrap_err(),
                    PortError::Domain(DomainError::SpaceReadOnly)
                );
                assert_validation_err(
                    &store.accept_external_observation(ctx.clone(), retry).await,
                    ValidationReason::InvalidDigest,
                );
            }
            let mut wrong_base = request;
            wrong_base.input.content = planned("another version", result_text);
            assert_validation_err(
                &store
                    .accept_external_observation(ctx.clone(), wrong_base)
                    .await,
                ValidationReason::SourceMismatch,
            );
        }
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            latest.receipt.seq()
        );
        runtime.shutdown().await.unwrap();
    }
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn historical_observation_replay_bounds_paused_cas_read() {
    use std::time::Duration;

    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    {
        let installation = sample_installation_id(94);
        let bucket = fixtures.fresh_s3_bucket("observation-replay");
        let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3, None).await.unwrap();
        let gate = Arc::new(PausedObjectRead::new(&s3));
        let cfg = fixtures.pg_s3_config(installation, &schema, s3);
        let (store, runtime) = CanonicalRuntime::open_with_s3_transport(cfg, Some(gate.clone()))
            .await
            .unwrap();
        let owner = sample_principal_id(94);
        let (scope, _) = seed_default_space(
            &store,
            sample_space_id(94),
            sample_incarnation(94),
            owner.clone(),
        )
        .await;
        let ctx = owner_ctx(&scope, owner.clone(), true, true);
        let note = sample_note_id(94);
        let create = next_mutation(
            &scope,
            &owner,
            CreateNote {
                folder_page: false,
                note: note.clone(),
                parent: None,
                slug: "observed".into(),
                class: DocClass::UserDoc,
                carrier: "first".into(),
            },
        );
        let base = store.create_note(ctx.clone(), create).await.unwrap();
        let mut request = next_mutation(
            &scope,
            &owner,
            ExternalObservation {
                note,
                base_revision: base.value.revision,
                observed_digest: notarium_syntax::content_digest("second"),
                disk_identity: ContentDigest::from_bytes([94; 32]),
                content: ObservedContent::Carrier("second".into()),
            },
        );
        let original = committed(
            store
                .accept_external_observation(ctx.clone(), request.clone())
                .await
                .unwrap(),
        );
        // The original full carrier has no stored plan fingerprint. Verifying this
        // equivalent plan must read the original revision while the current head is newer.
        request.input.content = planned("first", "second");
        for cancel in [false, true] {
            let mut bounded = ctx.clone();
            bounded.budget = make_budget();
            if !cancel {
                bounded.budget.remaining = Duration::from_millis(450);
            }
            let cancellation = bounded.budget.cancellation.clone();
            gate.armed.store(true, Ordering::SeqCst);
            let (result, ()) = tokio::time::timeout(Duration::from_secs(3), async {
                tokio::join!(
                    store.accept_external_observation(bounded, request.clone()),
                    async {
                        gate.received.notified().await;
                        assert_eq!(gate.paused.available_permits(), 0);
                        if cancel {
                            cancellation.cancel();
                        }
                    }
                )
            })
            .await
            .expect("caller must finish while the historical GET stays paused");
            let failure = match (cancel, result.unwrap_err()) {
                (true, PortError::Cancelled(f)) | (false, PortError::DeadlineExceeded(f)) => f,
                other => panic!("unexpected replay outcome {other:?}"),
            };
            assert_eq!(failure.effect(), CommitEffect::NotCommitted);
            assert_eq!(gate.paused.available_permits(), 1);
        }
        let retry = committed(
            store
                .accept_external_observation(ctx.clone(), request)
                .await
                .unwrap(),
        );
        assert_eq!(retry.receipt, original.receipt);
        assert_eq!(retry.value, original.value);
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            original.receipt.seq()
        );
        runtime.shutdown().await.unwrap();
    }
    fixtures.drop_pg_schema(&schema).await;
}
