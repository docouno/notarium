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
            fixtures.pg_local_config(installation, &schema, root.data_root())
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
