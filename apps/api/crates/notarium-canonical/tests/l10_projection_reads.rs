#![forbid(unsafe_code)]

mod support;

use std::collections::{BTreeMap, BTreeSet};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
    UpdateSpaceSchema,
    changes::SyntheticNoteSpec,
    projection_read::{ProjectionAlias, ProjectionDelta, ProjectionOverlaySelection},
};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::{AbilityKind, DocClass},
    error::ValidationReason,
    ids::{
        AbilityId, AgentRunId, CommandKey, ContentDigest, GrantId, LeaseEpoch,
        ProjectionGeneration, SpaceSeq,
    },
    model::{Lifecycle, SnapshotCut},
    ports::{
        CreateNote, DeleteDisposition, DeleteNote, MoveFolder, MoveNote, Mutation, NoteWritePort,
        PageLimit, Preconditions, PublishAbilityPackage, RenameNote, ServicePurpose, SpaceContext,
    },
    query::{FieldObservation, FieldSchema, FieldType, FieldValue, ScalarType},
    receipt::{CommandIdentity, MutationEffect, ReceiptSet},
    value::{ScalarValue, YamlValue},
};

use support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_note_id, sample_principal_id,
    sample_space_id,
};

async fn run_projection_reads(store: &CanonicalStore) {
    let actor = sample_principal_id(1);
    let epoch = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(1),
            incarnation: sample_incarnation(1),
            root_folder_id: sample_folder_id(1),
            slug: "projection-reads".into(),
            kind: SpaceKind::Shared,
            owner: actor.clone(),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let projection = maintenance_ctx(ServicePurpose::Projection);
    let wrong_purpose = maintenance_ctx(ServicePurpose::Search);
    let scope = &space.scope;
    let limit = PageLimit::new(1).unwrap();

    assert_validation_err(
        &store.list_spaces(&wrong_purpose).await,
        ValidationReason::InvalidAuthority,
    );
    let records = store.list_spaces(&projection).await.unwrap();
    assert_eq!(
        records,
        [(
            space.space.clone(),
            scope.clone(),
            space.root_folder_id.clone(),
            SpaceSeq::ZERO
        )]
    );
    let zero = store
        .read_projection_folders_page(&projection, scope, SpaceSeq::ZERO, None, limit)
        .await
        .unwrap();
    assert_eq!(zero.rows[0].metadata.folder_id, space.root_folder_id);
    assert!(zero.next.is_none());

    let clear = sample_note_id(10);
    let encrypted = sample_note_id(11);
    let carrier = "---\npriority: high\n---\n# Plain\n";
    let (batch, _) = store
        .commit_synthetic_note_batch_for_test(
            scope,
            epoch,
            &actor,
            vec![
                SyntheticNoteSpec {
                    note_id: clear.clone(),
                    parent_folder: None,
                    slug: "plain".into(),
                    title: "Plain".into(),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: carrier.into(),
                    fields: BTreeMap::new(),
                },
                SyntheticNoteSpec {
                    note_id: encrypted.clone(),
                    parent_folder: None,
                    slug: "private".into(),
                    title: "Private".into(),
                    doc_class: DocClass::EncryptedNote,
                    lifecycle: Lifecycle::Active,
                    carrier: "This sentinel must stay outside projection access".into(),
                    fields: BTreeMap::from([(
                        "private".into(),
                        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(
                            "sentinel".into(),
                        ))),
                    )]),
                },
            ],
        )
        .await
        .unwrap();
    let invalid = store
        .read_projection_space_header(&projection, &scope.space_id, Some(batch.first_seq))
        .await;
    assert_validation_err(&invalid, ValidationReason::InvalidCutoff);

    let page1 = store
        .read_projection_notes_page(&projection, scope, batch.last_seq, None, limit)
        .await
        .unwrap();
    assert_eq!(page1.rows[0].metadata.note_id, clear);
    assert_eq!(page1.rows[0].visibility_seq, batch.last_seq);
    assert_eq!(
        page1.rows[0].metadata.raw_fields,
        Some(BTreeMap::from([(
            "priority".into(),
            YamlValue::String("high".into()),
        )]))
    );
    assert!(page1.rows[0].metadata.evaluated_fields.is_empty());
    assert_eq!(
        store
            .read_projection_note_carrier(&projection, scope, batch.last_seq, &page1.rows[0])
            .await
            .unwrap()
            .as_deref(),
        Some(carrier)
    );
    let page2 = store
        .read_projection_notes_page(
            &projection,
            scope,
            batch.last_seq,
            page1.next.clone(),
            limit,
        )
        .await
        .unwrap();
    assert_eq!(page2.rows[0].metadata.note_id, encrypted);
    assert!(page2.rows[0].metadata.evaluated_fields.is_empty());
    assert!(
        store
            .read_projection_note_carrier(&projection, scope, batch.last_seq, &page2.rows[0])
            .await
            .unwrap()
            .is_none()
    );
    assert!(page2.next.is_none());

    let delta1 = store
        .read_projection_delta_batch(
            &projection,
            scope,
            SpaceSeq::ZERO,
            batch.last_seq,
            None,
            limit,
        )
        .await
        .unwrap();
    assert!(
        matches!(&delta1.rows[..], [ProjectionDelta::Note(note)] if note.metadata.note_id == clear)
    );
    assert_eq!(delta1.next, Some(batch.first_seq));
    let delta2 = store
        .read_projection_delta_batch(
            &projection,
            scope,
            SpaceSeq::ZERO,
            batch.last_seq,
            delta1.next,
            limit,
        )
        .await
        .unwrap();
    assert!(
        matches!(&delta2.rows[..], [ProjectionDelta::Note(note)] if note.metadata.note_id == encrypted)
    );
    assert!(delta2.next.is_none());

    let auth = EngineAuthContext::for_human(
        VerifiedHuman::attest(
            actor.clone(),
            GrantId::from_bytes([1; 16]),
            BTreeMap::from([(
                scope.space_id.clone(),
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                },
            )]),
            true,
        )
        .with_human_management(true),
    );
    let human = SpaceContext::new(auth, scope.clone(), projection.budget.clone()).unwrap();
    let identity = |n| CommandIdentity {
        scope: scope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([n; 16]),
        hash: ContentDigest::from_bytes([n; 32]),
    };
    let renamed = store
        .rename_note(
            human.clone(),
            Mutation {
                identity: identity(1),
                preconditions: Preconditions {
                    revision: Some(page1.rows[0].revision_id.clone()),
                    ..Preconditions::default()
                },
                input: RenameNote {
                    note: clear.clone(),
                    slug: "renamed".into(),
                    title: Some("Renamed".into()),
                },
            },
        )
        .await
        .unwrap();

    let aliases_at_before = store
        .read_projection_aliases_page(&projection, scope, batch.last_seq, None, limit)
        .await
        .unwrap();
    assert!(aliases_at_before.rows.is_empty());
    let aliases = store
        .read_projection_aliases_page(&projection, scope, renamed.receipt.seq(), None, limit)
        .await
        .unwrap();
    assert!(matches!(&aliases.rows[..], [ProjectionAlias::Note(alias)]
        if alias.target_note_id == clear && alias.old_slug_fold == "plain" && alias.old_title_norm == "plain"));

    let keeper_project = sample_folder_id(4);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: keeper_project.clone(),
            parent: None,
            slug: "keeper-project".into(),
            display_name: "Keeper Project".into(),
            is_project: true,
            project_slug: Some("keeper-project".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let after_keeper_folder = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let skill = sample_note_id(12);
    let skill_create = store
        .create_note(
            human.clone(),
            Mutation {
                identity: identity(2),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: skill.clone(),
                    parent: None,
                    slug: "skill".into(),
                    class: DocClass::Skill,
                    carrier: "---\nclass: skill\ntitle: Audit Skill\n---\n# Audit Skill\n".into(),
                },
            },
        )
        .await
        .unwrap();
    let ability = AbilityId::from_bytes([9; 16]);
    let published = store
        .publish_ability_package(
            human.clone(),
            Mutation {
                identity: identity(3),
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: ability.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: skill.clone(),
                    files: vec![],
                    expected_package_revision: None,
                },
            },
        )
        .await
        .unwrap();
    let old = store
        .read_projection_note(&projection, scope, skill_create.receipt.seq(), &skill)
        .await
        .unwrap()
        .unwrap();
    let new = store
        .read_projection_note(&projection, scope, published.receipt.seq(), &skill)
        .await
        .unwrap()
        .unwrap();
    assert!(old.metadata.ability_id.is_none());
    assert_eq!(new.metadata.ability_id, Some(ability.clone()));
    assert_eq!(old.revision_id, new.revision_id);
    assert_ne!(old.rank_version, new.rank_version);

    let keeper = SpaceContext::new(
        human
            .auth()
            .for_keeper(
                AgentRunId::from_bytes([4; 16]),
                scope.space_id.clone(),
                Some(keeper_project.clone()),
                BTreeSet::from([ability]),
            )
            .unwrap(),
        scope.clone(),
        projection.budget.clone(),
    )
    .unwrap();
    for (receipt, visible) in [(&skill_create.receipt, false), (&published.receipt, true)] {
        let cut = SnapshotCut {
            scope: scope.clone(),
            generation: ProjectionGeneration::new(1).unwrap(),
            projected_seq: receipt.seq(),
            canonical_seq: receipt.seq(),
        };
        let cards = store
            .hydrate_cards(keeper.clone(), cut, vec![skill.clone()])
            .await
            .unwrap();
        let carriers = store
            .read_authorized_documents_for_search(
                keeper.clone(),
                vec![notarium_canonical::changes::search::SearchDocumentTarget {
                    note_id: skill.clone(),
                    revision: old.revision_id.clone(),
                    projected_at: Some(receipt.seq()),
                }],
            )
            .await
            .unwrap();
        assert_eq!(carriers[0].is_some(), visible);
        assert_eq!(
            cards[0].is_some(),
            visible,
            "historical cards must bind the ability visible at the command cut"
        );
    }

    let effects = store
        .resolve_receipt_effects(
            scope,
            &ReceiptSet::new([skill_create.receipt.clone(), published.receipt.clone()]).unwrap(),
        )
        .await
        .unwrap();
    for effect in effects {
        let MutationEffect::Notes { versions, .. } = effect.effect else {
            panic!("expected a bounded note effect");
        };
        let chosen = ProjectionOverlaySelection {
            version: versions[0].clone(),
            receipt: effect.receipt,
        };
        // Intervening folder creation before after_keeper_folder must reject the overlay shortcut.
        assert!(
            store
                .read_projection_overlay_notes(
                    &projection,
                    scope,
                    SpaceSeq::ZERO,
                    std::slice::from_ref(&chosen),
                )
                .await
                .unwrap()
                .is_none()
        );
        let exact = store
            .read_projection_overlay_notes(
                &projection,
                scope,
                after_keeper_folder,
                std::slice::from_ref(&chosen),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exact[0].note.rank_version, chosen.version.rank_version);
        assert_eq!(exact[0].receipt, chosen.receipt);
        assert_eq!(
            exact[0].note.metadata.ability_id.is_some(),
            chosen.receipt == published.receipt
        );
        assert!(exact[0].ranks.is_empty());
        let mut mismatch = chosen;
        mismatch.version.rank_version = ContentDigest::from_bytes([1; 32]);
        assert!(
            store
                .read_projection_overlay_notes(&projection, scope, after_keeper_folder, &[mismatch])
                .await
                .unwrap()
                .is_none()
        );
    }

    // A later receipt for another note must not pull the skill forward through
    // the unrelated publication of its package at an intermediate command.
    let later = store
        .create_note(
            human.clone(),
            Mutation {
                identity: identity(4),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: sample_note_id(13),
                    parent: None,
                    slug: "later".into(),
                    class: DocClass::UserDoc,
                    carrier: "---\npriority: urgent\n---\n# Later".into(),
                },
            },
        )
        .await
        .unwrap();
    let receipts = ReceiptSet::new([skill_create.receipt.clone(), later.receipt.clone()]).unwrap();
    let selected = store
        .resolve_projection_receipt_effects(&projection, scope, &receipts)
        .await
        .unwrap()
        .into_iter()
        .map(|effect| {
            let MutationEffect::Notes { versions, .. } = effect.effect else {
                panic!("expected a bounded note effect");
            };
            ProjectionOverlaySelection {
                version: versions[0].clone(),
                receipt: effect.receipt,
            }
        })
        .collect::<Vec<_>>();
    let exact = store
        .read_projection_overlay_notes(&projection, scope, after_keeper_folder, &selected)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(exact[0].receipt, skill_create.receipt);
    assert!(exact[0].note.metadata.ability_id.is_none());
    assert_eq!(exact[1].receipt, later.receipt);

    let fields = BTreeMap::from([(
        "priority".to_owned(),
        FieldSchema {
            kind: FieldType::Scalar(ScalarType::Number),
            nullable: true,
        },
    )]);
    let schema = store
        .update_space_schema(
            human.clone(),
            Mutation {
                identity: identity(5),
                preconditions: Preconditions::default(),
                input: UpdateSpaceSchema {
                    schema_note: sample_note_id(14),
                    parent: None,
                    slug: "space-schema".into(),
                    carrier: "---\ntitle: Space Schema\n---\n# Space Schema\n".into(),
                    schema: fields.clone(),
                    expected_schema_revision: None,
                },
            },
        )
        .await
        .unwrap();
    // An intervening schema change between base_seq and the receipt cutoff must
    // reject the overlay shortcut so the caller falls back to full projection catch-up.
    let after_schema = store
        .create_note(
            human.clone(),
            Mutation {
                identity: identity(6),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: sample_note_id(15),
                    parent: None,
                    slug: "after-schema".into(),
                    class: DocClass::UserDoc,
                    carrier: "# After Schema".into(),
                },
            },
        )
        .await
        .unwrap();
    let after_schema_effects = store
        .resolve_projection_receipt_effects(
            &projection,
            scope,
            &ReceiptSet::new([after_schema.receipt.clone()]).unwrap(),
        )
        .await
        .unwrap();
    let MutationEffect::Notes { versions, .. } = &after_schema_effects[0].effect else {
        panic!("expected note effect");
    };
    let after_schema_selection = ProjectionOverlaySelection {
        version: versions[0].clone(),
        receipt: after_schema.receipt.clone(),
    };
    assert!(
        store
            .read_projection_overlay_notes(
                &projection,
                scope,
                later.receipt.seq(),
                std::slice::from_ref(&after_schema_selection),
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_projection_overlay_notes(
                &projection,
                scope,
                schema.receipt.seq(),
                std::slice::from_ref(&after_schema_selection),
            )
            .await
            .unwrap()
            .is_some()
    );
    let search = maintenance_ctx(ServicePurpose::Search);
    let receipts = ReceiptSet::new([after_schema.receipt.clone()]).unwrap();
    for (base, eligible) in [(later.receipt.seq(), false), (schema.receipt.seq(), true)] {
        let versions = store
            .plan_search_overlay(&search.authority, &search.budget, scope, base, &receipts)
            .await
            .unwrap();
        assert_eq!(versions.is_some(), eligible);
    }
    // Moving a note retains its last evaluation, even if the schema has changed.
    let moved = store
        .move_note(
            human.clone(),
            Mutation {
                identity: identity(7),
                preconditions: Preconditions::default(),
                input: MoveNote {
                    note: sample_note_id(13),
                    parent: None,
                    slug: "later-moved".into(),
                },
            },
        )
        .await
        .unwrap();
    let overlay = store
        .read_note_revisions_for_overlay(
            &search.authority,
            human.clone(),
            schema.receipt.seq(),
            vec![(sample_note_id(13), moved.value.revision)],
        )
        .await
        .unwrap();
    assert!(matches!(
        overlay[0].1.as_ref().unwrap().fields.get("priority"),
        Some(FieldObservation::Bad { .. })
    ));
    let before_schema = store
        .read_projection_space_header(&projection, &scope.space_id, Some(later.receipt.seq()))
        .await
        .unwrap();
    assert!(before_schema.schema.is_none());
    let current_schema = store
        .read_projection_space_header(&projection, &scope.space_id, None)
        .await
        .unwrap()
        .schema
        .unwrap();
    assert_eq!(
        current_schema.descriptor_fingerprint,
        schema.value.descriptor_fingerprint
    );
    assert_eq!(current_schema.fields, fields);
    let delta = store
        .read_projection_delta_batch(
            &projection,
            scope,
            later.receipt.seq(),
            schema.receipt.seq(),
            None,
            limit,
        )
        .await
        .unwrap();
    assert!(
        delta
            .rows
            .contains(&ProjectionDelta::Schema(Some(current_schema)))
    );

    let purged = store
        .commit_synthetic_note_purge_for_test(scope, epoch, &clear)
        .await
        .unwrap();
    assert_validation_err(
        &store
            .read_projection_notes_page(&projection, scope, batch.last_seq, None, limit)
            .await,
        ValidationReason::CursorStale,
    );
    assert_validation_err(
        &store
            .read_projection_note_carrier(&projection, scope, batch.last_seq, &page1.rows[0])
            .await,
        ValidationReason::CursorStale,
    );
    let at_purge = store
        .read_projection_note(&projection, scope, purged, &clear)
        .await
        .unwrap();
    assert!(at_purge.is_none());
    let fences = store
        .read_projection_purge_fences_page(&projection, scope, None, limit)
        .await
        .unwrap();
    assert_eq!(fences.rows[0].note_id, clear);
    assert_eq!(fences.rows[0].purge_seq, purged);

    // Purging a published ability entrypoint note via real `delete_note(Purge)`
    // clears ability revision metadata and marks `ability_packages` purged;
    // delta batches crossing both publication and purge must not wedge on
    // `CursorStale` when the ability revision metadata is NULL.
    let skill_purged = store
        .delete_note(
            human.clone(),
            Mutation {
                identity: identity(99),
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: skill.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap()
        .receipt
        .seq();
    let delta_across_purged_ability = store
        .read_projection_delta_batch(
            &projection,
            scope,
            skill_create.receipt.seq(),
            skill_purged,
            None,
            PageLimit::new(64).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        delta_across_purged_ability
            .rows
            .iter()
            .any(|row| matches!(row, ProjectionDelta::Purge(id) if *id == skill))
    );
    assert!(
        !delta_across_purged_ability
            .rows
            .iter()
            .any(|row| matches!(row, ProjectionDelta::Ability(ability) if ability.note.is_some())),
        "purged ability delta must not surface a hydrated note snapshot"
    );

    // Search folder-placement & trashed-folder regressions:
    // 1. Moving a root folder into a project changes exact enclosing_project,
    //    so `can_index_remote_search_note(..., None)` flips to `false`.
    // 2. Trashing the parent folder hides the note from exact & projected search reads
    //    and returns `None` from `read_projection_folder_ancestry_at_cut`.
    let movable_folder = sample_folder_id(20);
    let (_, movable_rev, _) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: movable_folder.clone(),
            parent: None,
            slug: "movable".into(),
            display_name: "Movable".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let nested_note = sample_note_id(20);
    let nested_created = store
        .create_note(
            human.clone(),
            Mutation {
                identity: identity(100),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: nested_note.clone(),
                    parent: Some(movable_folder.clone()),
                    slug: "nested-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Nested\n\nBody text.\n".into(),
                },
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .can_index_remote_search_note(
                &search.authority,
                search.budget.clone(),
                scope.clone(),
                nested_note.clone(),
                None,
            )
            .await
            .unwrap()
    );
    assert!(
        !store
            .can_index_remote_search_note(
                &search.authority,
                search.budget.clone(),
                scope.clone(),
                nested_note.clone(),
                Some(keeper_project.clone()),
            )
            .await
            .unwrap()
    );
    let moved_folder = store
        .move_folder(
            human.clone(),
            Mutation {
                identity: identity(101),
                preconditions: Preconditions {
                    revision: Some(movable_rev),
                    ..Preconditions::default()
                },
                input: MoveFolder {
                    folder: movable_folder.clone(),
                    new_parent: Some(keeper_project.clone()),
                },
            },
        )
        .await
        .unwrap();
    let after_move_seq = moved_folder.receipt.seq();
    assert!(
        !store
            .can_index_remote_search_note(
                &search.authority,
                search.budget.clone(),
                scope.clone(),
                nested_note.clone(),
                None,
            )
            .await
            .unwrap(),
        "root->project folder move must deny space-wide (project=None) remote indexing"
    );
    assert!(
        store
            .can_index_remote_search_note(
                &search.authority,
                search.budget.clone(),
                scope.clone(),
                nested_note.clone(),
                Some(keeper_project.clone()),
            )
            .await
            .unwrap()
    );
    let active_ancestry = store
        .read_projection_folder_ancestry_at_cut(&projection, scope, after_move_seq, &movable_folder)
        .await
        .unwrap()
        .expect("active folder ancestry resolves at cut");
    assert_eq!(active_ancestry.1, Some(keeper_project.clone()));
    assert_eq!(
        active_ancestry.0,
        vec![
            movable_folder.clone(),
            keeper_project.clone(),
            space.root_folder_id.clone()
        ]
    );
    let moved_folder_rev = store
        .read_projection_folders_page(
            &projection,
            scope,
            after_move_seq,
            None,
            PageLimit::new(200).unwrap(),
        )
        .await
        .unwrap()
        .rows
        .into_iter()
        .find(|row| row.metadata.folder_id == movable_folder)
        .expect("moved folder exists at cut")
        .revision_id;
    let (_, trashed_seq) = store
        .set_folder_lifecycle(
            scope,
            epoch,
            &movable_folder,
            &moved_folder_rev,
            Lifecycle::Trashed,
            &actor,
            None,
        )
        .await
        .unwrap();
    assert!(
        store
            .read_projection_folder_ancestry_at_cut(
                &projection,
                scope,
                trashed_seq,
                &movable_folder,
            )
            .await
            .unwrap()
            .is_none(),
        "trashed folder ancestry must return None"
    );
    let hidden_projected = store
        .read_authorized_documents_for_search(
            human.clone(),
            vec![
                notarium_canonical::changes::search::SearchDocumentTarget {
                    note_id: nested_note.clone(),
                    revision: nested_created.value.revision.clone(),
                    projected_at: Some(after_move_seq),
                },
                notarium_canonical::changes::search::SearchDocumentTarget {
                    note_id: nested_note.clone(),
                    revision: nested_created.value.revision.clone(),
                    projected_at: None,
                },
            ],
        )
        .await
        .unwrap();
    assert_eq!(hidden_projected.len(), 2);
    assert!(
        hidden_projected[0].is_none() && hidden_projected[1].is_none(),
        "notes under a trashed folder must be hidden from search document reads"
    );
    let hidden_overlay = store
        .read_note_revisions_for_overlay(
            &search.authority,
            human.clone(),
            after_move_seq,
            vec![(nested_note, nested_created.value.revision)],
        )
        .await
        .unwrap();
    assert!(
        hidden_overlay[0].1.is_none(),
        "notes under a trashed folder must be hidden from search overlay reads"
    );
}

#[tokio::test]
async fn sqlite_projection_reads() {
    let path = TempDataRoot::new("projection-reads-sqlite");
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        sample_installation_id(1),
        path.data_root(),
    ))
    .await
    .unwrap();
    run_projection_reads(&store).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn postgres_projection_reads() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let path = TempDataRoot::new("projection-reads-postgres");
    let config = fixtures.pg_local_config(sample_installation_id(2), &schema, path.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    run_projection_reads(&store).await;
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}
