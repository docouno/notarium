#![forbid(unsafe_code)]

mod support;

use std::collections::{BTreeMap, BTreeSet};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
    S3BucketModePolicy, SpaceSchemaRevision, UpdateSpaceSchema, blobs::s3::admin_ensure_bucket,
};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::{AbilityKind, DocClass},
    error::{CommitEffect, PortError, ValidationReason},
    ids::{
        AbilityId, AgentRunId, CommandKey, ContentDigest, FolderId, GrantId, HistoryIncarnation,
        LeaseEpoch, PrincipalId, ProjectionGeneration, RequestId, RevisionId, SpaceId, SpaceSeq,
    },
    model::{AbilityResourceName, FolderRef, HistoryScope, NoteRef, SnapshotCut},
    ports::{
        AbilityFile, AcceptBatch, AppendMemory, BatchItem, CallBudget, Cancellation, ChangeRead,
        ChangeReadResult, Committed, CreateNote, DeleteDisposition, DeleteNote, EditNote,
        ExternalObservation, ExternalObservationResult, GetNote, Link, LinkBatch, LinkTarget,
        MemoryTarget, MintAndPurge, MoveFolder, MoveNote, Mutation, NoteRevision, NoteWritePort,
        ObservedContent, PageLimit, Preconditions, PublishAbilityPackage, ReadAbilityResource,
        RenameFolder, RenameNote, RenameProject, ResolvedMemoryTarget, SpaceContext,
    },
    query::{FieldObservation, FieldSchema, FieldType, FieldValue, ScalarType},
    receipt::{
        AwaitReason, CausalBasis, ChangeCursor, CommandIdentity, MutationEffect, ReceiptSet,
    },
    value::{ExactNumber, ScalarValue, YamlValue},
};
use notarium_syntax::{extract, frontmatter::FieldEdit};

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, random_bytes_16, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_note_id, sample_principal_id, sample_run_id,
    sample_space_id,
};

const AGE_ARMOR_FIXTURE: &str = "-----BEGIN AGE ENCRYPTED FILE-----\n\
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBURWlGMHlwcXIrYnB2Y3FY\n\
TnlDVkpwTDdPdXdQZFZ3UEw3S1FFYkZET0NjCmhqYWJHWHdTTFE5YzNTNkx3Mmkr\n\
UzJUdTJmaXdRSEhzbGJCTjZCNDFGTEUKLS0tIFd5SnA5Ri85Rk9aaDdnSmRoZXEy\n\
V0lKY3dIZ1ljOE5JVmgzZGR3aHJjTmcK7s9ix86RtDMnTmjU8vkTTLdMW/73vqpS\n\
yPC8DpksHoMx+2Y=\n\
-----END AGE ENCRYPTED FILE-----\n";

fn make_budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(random_bytes_16()),
        cancellation: Cancellation::default(),
        remaining: std::time::Duration::from_secs(30),
    }
}

fn make_human_ctx(
    scope: &HistoryScope,
    principal: PrincipalId,
    role: SpaceRole,
    read_classes: BTreeSet<DocClass>,
    write_classes: BTreeSet<DocClass>,
    project_root: Option<FolderId>,
    ability_write: bool,
) -> SpaceContext {
    let grant = SpaceGrant {
        role,
        read_classes,
        write_classes,
        project_root,
    };
    let verified = VerifiedHuman::attest(
        principal,
        GrantId::from_bytes([7u8; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        ability_write,
    );
    let auth = EngineAuthContext::for_human(verified);
    SpaceContext::new(auth, scope.clone(), make_budget()).expect("valid human SpaceContext")
}

fn owner_ctx(scope: &HistoryScope, principal: PrincipalId, ability_write: bool) -> SpaceContext {
    make_human_ctx(
        scope,
        principal,
        SpaceRole::Owner,
        DocClass::all(),
        DocClass::all(),
        None,
        ability_write,
    )
}

fn next_mutation<T>(scope: &HistoryScope, actor: &PrincipalId, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes(random_bytes_16()),
            hash: ContentDigest::from_bytes(*blake3::hash(&random_bytes_16()).as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

fn next_mutation_rev<T>(
    scope: &HistoryScope,
    actor: &PrincipalId,
    expected_rev: RevisionId,
    input: T,
) -> Mutation<T> {
    let mut m = next_mutation(scope, actor, input);
    m.preconditions.revision = Some(expected_rev);
    m
}

fn valid_encrypted_carrier(title: &str) -> String {
    format!(
        "---\nclass: encrypted-note\ntitle: {title}\n---\n# {title}\n\n```age\n{AGE_ARMOR_FIXTURE}```\n"
    )
}

async fn seed_default_space(
    store: &CanonicalStore,
    space_id: SpaceId,
    incarnation: HistoryIncarnation,
    owner: PrincipalId,
) -> (HistoryScope, FolderId) {
    let root_folder_id = sample_folder_id(1);
    let rec = store
        .create_space(CreateSpaceSpec {
            space_id,
            incarnation,
            root_folder_id: root_folder_id.clone(),
            slug: "main-space".to_owned(),
            kind: SpaceKind::Personal,
            owner,
            active_epoch: LeaseEpoch::new(1).expect("epoch 1"),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create_space");
    (rec.scope, root_folder_id)
}

async fn run_domain_and_security_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(10);
    let viewer = sample_principal_id(11);
    let (scope, _root_folder) = seed_default_space(
        store,
        sample_space_id(1),
        sample_incarnation(1),
        owner.clone(),
    )
    .await;
    let epoch = LeaseEpoch::new(1).expect("epoch 1");
    let ctx = owner_ctx(&scope, owner.clone(), true);

    // 1. Folder & project invariants: root-child project check, depth <= 256, cycle check, O(1) subtree move.
    let proj_a = sample_folder_id(10);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: proj_a.clone(),
            parent: None,
            slug: "alpha-proj".to_owned(),
            display_name: "Alpha Project".to_owned(),
            is_project: true,
            project_slug: Some("alpha".to_owned()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .expect("create root-child project");

    // Non-root project creation must fail closed.
    let bad_nested_proj = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: sample_folder_id(11),
            parent: Some(proj_a.clone()),
            slug: "nested-proj".to_owned(),
            display_name: "Nested Project".to_owned(),
            is_project: true,
            project_slug: Some("nested".to_owned()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await;
    assert_validation_err(&bad_nested_proj, ValidationReason::InvalidState);

    let docs_folder = sample_folder_id(12);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: docs_folder.clone(),
            parent: Some(proj_a.clone()),
            slug: "docs".to_owned(),
            display_name: "Docs".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .expect("create docs child folder");

    let sub_folder = sample_folder_id(13);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: sub_folder.clone(),
            parent: Some(docs_folder.clone()),
            slug: "specs".to_owned(),
            display_name: "Specs".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .expect("create specs grandchild folder");

    // Cycle check: moving `docs_folder` under its own child `sub_folder` must fail.
    let cycle_res = store
        .move_folder(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveFolder {
                    folder: docs_folder.clone(),
                    new_parent: Some(sub_folder.clone()),
                },
            ),
        )
        .await;
    assert_validation_err(&cycle_res, ValidationReason::InvalidState);

    // Moving a project folder under a non-root parent must also fail.
    let archive_root = sample_folder_id(14);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: archive_root.clone(),
            parent: None,
            slug: "archive".to_owned(),
            display_name: "Archive".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .expect("create archive root child");

    let move_proj_nested = store
        .move_folder(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveFolder {
                    folder: proj_a.clone(),
                    new_parent: Some(archive_root.clone()),
                },
            ),
        )
        .await;
    assert_validation_err(&move_proj_nested, ValidationReason::InvalidState);

    // Depth <= 256 check on create_folder and subtree move_folder:
    // Build a 255-deep chain under `archive_root` (total depth 256 below root), verify 257th fails!
    let mut tip = archive_root.clone();
    for depth in 2..=256u16 {
        let mut raw = [0u8; 16];
        raw[0] = 0xAA;
        raw[1..3].copy_from_slice(&depth.to_be_bytes());
        let fid = FolderId::from_bytes(raw);
        store
            .create_folder(CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: epoch,
                folder_id: fid.clone(),
                parent: Some(tip),
                slug: format!("d{depth}"),
                display_name: format!("D{depth}"),
                is_project: false,
                project_slug: None,
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .expect("create folder up to depth 256");
        tip = fid;
    }
    let over_depth_create = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: epoch,
            folder_id: FolderId::from_bytes([0xAB; 16]),
            parent: Some(tip.clone()),
            slug: "d257".to_owned(),
            display_name: "D257".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await;
    assert_validation_err(&over_depth_create, ValidationReason::InvalidState);

    // Moving `docs_folder` (which has child `sub_folder`, subtree rel_depth = 1) onto `tip` (depth 256)
    // would produce depth 258 > 256 -> rejected!
    let over_depth_move = store
        .move_folder(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveFolder {
                    folder: docs_folder.clone(),
                    new_parent: Some(tip),
                },
            ),
        )
        .await;
    assert_validation_err(&over_depth_move, ValidationReason::InvalidState);

    // Rename project succeeds on root-child project and fails on non-project folder.
    store
        .rename_project(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RenameProject {
                    folder: proj_a.clone(),
                    name: "alpha-prime".to_owned(),
                    display_name: "Alpha Prime".to_owned(),
                },
            ),
        )
        .await
        .expect("rename_project on root-child project");

    let bad_rename_project = store
        .rename_project(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RenameProject {
                    folder: docs_folder.clone(),
                    name: "not-a-proj".to_owned(),
                    display_name: "Not A Project".to_owned(),
                },
            ),
        )
        .await;
    assert_validation_err(&bad_rename_project, ValidationReason::InvalidState);

    // 2. Note CRUD, O(1) subtree move (0 descendant note rewrites), aliases, historical get_note, hydrate_cards.
    let note_1 = sample_note_id(20);
    let c1_carrier = "---\ntitle: Architecture Overview\nstatus: draft\n---\n# Architecture Overview\n\nInitial body.\n";
    let c1 = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: note_1.clone(),
                    parent: Some(sub_folder.clone()),
                    slug: "arch-overview".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: c1_carrier.to_owned(),
                },
            ),
        )
        .await
        .expect("create_note note_1");
    let rev_1 = c1.value.revision.clone();

    let note_1_updated_seq_before_folder_move = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT updated_seq FROM note_heads WHERE space_id = '{}' AND note_id = '{}'",
                scope.space_id.as_str(),
                note_1.as_str()
            ),
        )
        .await
        .expect("read note_1 updated_seq");

    // Move `docs_folder` under `archive_root`: O(1) folder head update, 0 descendant note_heads writes!
    store
        .move_folder(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveFolder {
                    folder: docs_folder.clone(),
                    new_parent: Some(archive_root.clone()),
                },
            ),
        )
        .await
        .expect("move docs_folder under archive_root");

    let note_1_updated_seq_after_folder_move = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT updated_seq FROM note_heads WHERE space_id = '{}' AND note_id = '{}'",
                scope.space_id.as_str(),
                note_1.as_str()
            ),
        )
        .await
        .expect("read note_1 updated_seq after folder move");
    assert_eq!(
        note_1_updated_seq_before_folder_move, note_1_updated_seq_after_folder_move,
        "moving ancestor folder must rewrite 0 descendant note_heads rows"
    );

    // Folder alias under old parent `proj_a` resolves to `docs_folder`, and rename_folder records alias too.
    let resolved_moved_folder = store
        .resolve_folder_alias(ctx.clone(), Some(proj_a.clone()), "DOCS")
        .await
        .expect("resolve_folder_alias after move");
    assert_eq!(
        resolved_moved_folder,
        Some(FolderRef {
            space_id: scope.space_id.clone(),
            folder_id: docs_folder.clone(),
        })
    );

    store
        .rename_folder(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RenameFolder {
                    folder: docs_folder.clone(),
                    name: "handbook".to_owned(),
                },
            ),
        )
        .await
        .expect("rename_folder");

    let resolved_renamed_folder = store
        .resolve_folder_alias(ctx.clone(), Some(archive_root.clone()), "docs")
        .await
        .expect("resolve_folder_alias after rename");
    assert_eq!(
        resolved_renamed_folder.map(|f| f.folder_id),
        Some(docs_folder.clone())
    );

    // Edit note_1 via syntax finalized plan.
    let edit_plan = extract::finalize_document(
        c1_carrier,
        DocClass::UserDoc,
        &note_1,
        &[FieldEdit::Set {
            key: "status".to_owned(),
            value: YamlValue::String("published".to_owned()),
        }],
    )
    .expect("build edit plan");

    let edited = store
        .edit_note(
            ctx.clone(),
            next_mutation_rev(
                &scope,
                &owner,
                rev_1.clone(),
                EditNote {
                    note: note_1.clone(),
                    plan: edit_plan,
                },
            ),
        )
        .await
        .expect("edit_note note_1");
    let rev_2 = edited.value.revision.clone();
    assert_ne!(rev_1, rev_2);

    // Historical `get_note` at `rev_1` sees `status: draft`, while latest `get_note` sees `status: published`!
    let snap_v1 = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: note_1.clone(),
                revision: Some(rev_1.clone()),
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get_note historical rev_1");
    assert!(
        snap_v1
            .document
            .explicit_read(ctx.auth())
            .expect("explicit_read")
            .contains("status: draft")
    );

    let snap_latest = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: note_1.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get_note latest");
    assert!(
        snap_latest
            .document
            .explicit_read(ctx.auth())
            .expect("explicit_read")
            .contains("status: published")
    );

    // Move & rename note_1 -> alias lookup resolves old slug and title!
    store
        .move_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveNote {
                    note: note_1.clone(),
                    parent: Some(proj_a.clone()),
                    slug: "arch-v2".to_owned(),
                },
            ),
        )
        .await
        .expect("move_note");

    store
        .rename_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RenameNote {
                    note: note_1.clone(),
                    slug: "arch-final".to_owned(),
                    title: Some("Architecture Final".to_owned()),
                },
            ),
        )
        .await
        .expect("rename_note");

    let alias_from_sub = store
        .resolve_note_alias(ctx.clone(), Some(sub_folder.clone()), "arch-overview")
        .await
        .expect("resolve_note_alias from old folder");
    assert_eq!(alias_from_sub.map(|r| r.note_id), Some(note_1.clone()));

    let alias_from_proj = store
        .resolve_note_alias(ctx.clone(), Some(proj_a.clone()), "arch-v2")
        .await
        .expect("resolve_note_alias from old slug");
    assert_eq!(alias_from_proj.map(|r| r.note_id), Some(note_1.clone()));

    // Trash & Restore + `is_live_visible`.
    assert!(
        store
            .is_live_visible(&ctx, &note_1)
            .await
            .expect("live vis")
    );
    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                DeleteNote {
                    note: note_1.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .expect("trash note_1");
    assert!(
        !store
            .is_live_visible(&ctx, &note_1)
            .await
            .expect("trashed vis")
    );

    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                DeleteNote {
                    note: note_1.clone(),
                    disposition: DeleteDisposition::Restore,
                },
            ),
        )
        .await
        .expect("restore note_1");
    assert!(
        store
            .is_live_visible(&ctx, &note_1)
            .await
            .expect("restored vis")
    );

    // 3. EncryptedNote validation & hydrate_cards non-leakage + order preservation.
    let enc_note = sample_note_id(21);
    let bad_enc = "---\nclass: encrypted-note\ntitle: Leak\n---\n# Leak\n\nPlaintext leak outside fence!\n\n```age\n"
        .to_owned()
        + AGE_ARMOR_FIXTURE
        + "```\n";
    let bad_enc_res = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: enc_note.clone(),
                    parent: Some(proj_a.clone()),
                    slug: "secret-bad".to_owned(),
                    class: DocClass::EncryptedNote,
                    carrier: bad_enc,
                },
            ),
        )
        .await;
    assert!(matches!(
        bad_enc_res,
        Err(PortError::Domain(
            DomainError::UnsafePlaintextOutsideAgeFence
        ))
    ));

    store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: enc_note.clone(),
                    parent: Some(proj_a.clone()),
                    slug: "secret-ok".to_owned(),
                    class: DocClass::EncryptedNote,
                    carrier: valid_encrypted_carrier("Vault Key"),
                },
            ),
        )
        .await
        .expect("create valid EncryptedNote");

    let cur_space = store.read_space(&scope.space_id).await.expect("read_space");
    let cut = SnapshotCut {
        scope: scope.clone(),
        generation: ProjectionGeneration::new(1).expect("gen 1"),
        canonical_seq: cur_space.last_seq,
        projected_seq: cur_space.last_seq,
    };
    let cards = store
        .hydrate_cards(
            ctx.clone(),
            cut,
            vec![
                sample_note_id(99), // absent
                enc_note.clone(),   // EncryptedNote -> never hydrated as SearchMetadata card!
                note_1.clone(),     // active UserDoc
            ],
        )
        .await
        .expect("hydrate_cards");
    assert_eq!(cards.len(), 3);
    assert!(cards[0].is_none(), "absent note must hydrate as None");
    assert!(
        cards[1].is_none(),
        "EncryptedNote must never leak into secondary SearchMetadata NoteCard"
    );
    let card_note_1 = cards[2].as_ref().expect("active UserDoc hydrated");
    assert_eq!(card_note_1.title, "Architecture Final");
    assert!(card_note_1.path.ends_with("arch-final.md"));

    // 4. Forged-hash idempotency collision -> DomainError::IdempotencyKeyReused.
    let reused_key = CommandKey::from_bytes([0x55; 16]);
    let forged_hash = ContentDigest::from_bytes([0x66; 32]);
    let idemp_note_a = sample_note_id(22);
    let idemp_note_b = sample_note_id(23);

    let mut m_first = next_mutation(
        &scope,
        &owner,
        CreateNote {
            note: idemp_note_a.clone(),
            parent: Some(proj_a.clone()),
            slug: "idemp-a".to_owned(),
            class: DocClass::UserDoc,
            carrier: "# Idemp A\n".to_owned(),
        },
    );
    m_first.identity.key = reused_key.clone();
    m_first.identity.hash = forged_hash;

    let first_ok = store
        .create_note(ctx.clone(), m_first.clone())
        .await
        .expect("first create_note");
    let replay_ok = store
        .create_note(ctx.clone(), m_first)
        .await
        .expect("exact retry replay");
    assert_eq!(first_ok.value, replay_ok.value);
    assert_eq!(first_ok.receipt, replay_ok.receipt);

    let mut m_forged = next_mutation(
        &scope,
        &owner,
        CreateNote {
            note: idemp_note_b,
            parent: Some(proj_a.clone()),
            slug: "idemp-b".to_owned(),
            class: DocClass::UserDoc,
            carrier: "# Idemp B\n".to_owned(),
        },
    );
    m_forged.identity.key = reused_key;
    m_forged.identity.hash = forged_hash; // Caller lies and supplies the exact same hash!
    let forged_res = store.create_note(ctx.clone(), m_forged).await;
    assert!(
        matches!(
            forged_res,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ),
        "forged identical caller hash on distinct input must trigger IdempotencyKeyReused, got {forged_res:?}"
    );

    // 5. `accept_batch`: intra-batch `Create(N) -> Edit(N)` + per-item savepoint isolation.
    let batch_note = sample_note_id(24);
    let batch_carrier = "---\ntitle: Batch Item\n---\n# Batch Item\n\nStep one.\n";
    let batch_plan = extract::finalize_document(
        batch_carrier,
        DocClass::UserDoc,
        &batch_note,
        &[FieldEdit::Set {
            key: "tag".to_owned(),
            value: YamlValue::String("batched".to_owned()),
        }],
    )
    .expect("batch edit plan");

    let batch_res = store
        .accept_batch(
            ctx.clone(),
            AcceptBatch {
                items: vec![
                    next_mutation(
                        &scope,
                        &owner,
                        BatchItem::Create(CreateNote {
                            note: batch_note.clone(),
                            parent: Some(proj_a.clone()),
                            slug: "batch-seq".to_owned(),
                            class: DocClass::UserDoc,
                            carrier: batch_carrier.to_owned(),
                        }),
                    ),
                    // Bad middle item: edits non-existent note -> rolls back ONLY its savepoint!
                    next_mutation(
                        &scope,
                        &owner,
                        BatchItem::Edit(EditNote {
                            note: sample_note_id(98),
                            plan: batch_plan.clone(),
                        }),
                    ),
                    // Subsequent item in SAME batch sees `batch_note` created by item 0!
                    next_mutation(
                        &scope,
                        &owner,
                        BatchItem::Edit(EditNote {
                            note: batch_note.clone(),
                            plan: batch_plan,
                        }),
                    ),
                ],
            },
        )
        .await
        .expect("accept_batch");
    assert_eq!(batch_res.items.len(), 3);
    assert!(batch_res.items[0].is_ok());
    assert!(matches!(
        batch_res.items[1],
        Err(DomainError::ResourceNotFound)
    ));
    assert!(batch_res.items[2].is_ok());
    let snap_batched = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: batch_note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get_note batch_note");
    assert_eq!(
        snap_batched.fields.get("tag"),
        Some(&FieldObservation::Ok(FieldValue::Scalar(
            ScalarValue::String("batched".to_owned())
        )))
    );
    assert!(
        snap_batched
            .document
            .explicit_read(ctx.auth())
            .expect("explicit_read")
            .contains("batched")
    );

    // 6. `append_memory`, `link` & `link_many`, `accept_external_observation`, `update_space_schema`.
    let mem_note = sample_note_id(25);
    store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: mem_note.clone(),
                    parent: Some(proj_a.clone()),
                    slug: "project-memory".to_owned(),
                    class: DocClass::AgentMemory,
                    carrier:
                        "---\nclass: agent-memory\ntitle: Project Memory\n---\n# Project Memory\n"
                            .to_owned(),
                },
            ),
        )
        .await
        .expect("create AgentMemory note");

    store
        .append_memory(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                AppendMemory {
                    target: ResolvedMemoryTarget {
                        target: MemoryTarget::Project {
                            folder: FolderRef {
                                space_id: scope.space_id.clone(),
                                folder_id: proj_a.clone(),
                            },
                        },
                        note: NoteRef {
                            space_id: scope.space_id.clone(),
                            note_id: mem_note.clone(),
                        },
                        category: "Architecture".to_owned(),
                    },
                    text: "Canonical store owns CAS references.".to_owned(),
                },
            ),
        )
        .await
        .expect("append_memory");

    // `append_memory` against a non-AgentMemory note must fail.
    let bad_mem = store
        .append_memory(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                AppendMemory {
                    target: ResolvedMemoryTarget {
                        target: MemoryTarget::Project {
                            folder: FolderRef {
                                space_id: scope.space_id.clone(),
                                folder_id: proj_a.clone(),
                            },
                        },
                        note: NoteRef {
                            space_id: scope.space_id.clone(),
                            note_id: note_1.clone(),
                        },
                        category: "Oops".to_owned(),
                    },
                    text: "Wrong class.".to_owned(),
                },
            ),
        )
        .await;
    assert!(bad_mem.is_err(), "append_memory on UserDoc must fail");

    // `link` & `link_many`.
    store
        .link(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                Link {
                    source: note_1.clone(),
                    target: LinkTarget::Note(batch_note.clone()),
                    relation: "related".to_owned(),
                },
            ),
        )
        .await
        .expect("link note_1 -> batch_note");

    let lm = store
        .link_many(
            ctx.clone(),
            LinkBatch {
                items: vec![
                    next_mutation(
                        &scope,
                        &owner,
                        Link {
                            source: note_1.clone(),
                            target: LinkTarget::Folder(proj_a.clone()),
                            relation: "belongs_to".to_owned(),
                        },
                    ),
                    next_mutation(
                        &scope,
                        &owner,
                        Link {
                            source: note_1.clone(),
                            target: LinkTarget::Note(sample_note_id(97)), // missing target
                            relation: "broken".to_owned(),
                        },
                    ),
                ],
            },
        )
        .await
        .expect("link_many");
    assert!(lm.items[0].is_ok());
    assert!(matches!(lm.items[1], Err(DomainError::ResourceNotFound)));

    // `accept_external_observation`: Committed -> NoChange -> Conflict.
    let snap_for_obs = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: batch_note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get_note before external observation");
    let base_rev_obs = snap_for_obs.document.metadata().revision().clone();
    let ext_carrier =
        "---\ntitle: Batch Item\ntag: synced\n---\n# Batch Item\n\nSynced from vault.\n";
    let ext_digest = notarium_syntax::content_digest(ext_carrier);
    let disk_id = ContentDigest::from_bytes([0x77; 32]);

    let obs_committed = store
        .accept_external_observation(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                ExternalObservation {
                    note: batch_note.clone(),
                    observed_digest: ext_digest,
                    base_revision: base_rev_obs.clone(),
                    disk_identity: disk_id,
                    content: ObservedContent::Carrier(ext_carrier.to_owned()),
                },
            ),
        )
        .await
        .expect("external observation commit");
    let committed_obs_rev = match obs_committed {
        ExternalObservationResult::Committed(c) => c.value.revision,
        other => panic!("expected Committed, got {other:?}"),
    };

    let obs_no_change = store
        .accept_external_observation(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                ExternalObservation {
                    note: batch_note.clone(),
                    observed_digest: ext_digest,
                    base_revision: committed_obs_rev.clone(),
                    disk_identity: disk_id,
                    content: ObservedContent::Carrier(ext_carrier.to_owned()),
                },
            ),
        )
        .await
        .expect("external observation no_change");
    assert!(matches!(
        obs_no_change,
        ExternalObservationResult::NoChange { revision } if revision == committed_obs_rev
    ));

    let diverged_carrier =
        "---\ntitle: Batch Item\ntag: diverged\n---\n# Batch Item\n\nDiverged.\n";
    let obs_conflict = store
        .accept_external_observation(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                ExternalObservation {
                    note: batch_note.clone(),
                    observed_digest: notarium_syntax::content_digest(diverged_carrier),
                    base_revision: base_rev_obs, // stale base revision!
                    disk_identity: disk_id,
                    content: ObservedContent::Carrier(diverged_carrier.to_owned()),
                },
            ),
        )
        .await
        .expect("external observation conflict");
    assert!(matches!(
        obs_conflict,
        ExternalObservationResult::Conflict { current } if current == committed_obs_rev
    ));

    // `update_space_schema` flips typed schema & emits `AwaitProjection { Structural }`.
    let schema_note_id = sample_note_id(26);
    let mut schema_map = BTreeMap::new();
    schema_map.insert(
        "priority".to_owned(),
        FieldSchema {
            kind: FieldType::Scalar(ScalarType::Number),
            nullable: true,
        },
    );
    let schema_committed: notarium_core::ports::Committed<SpaceSchemaRevision> = store
        .update_space_schema(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                UpdateSpaceSchema {
                    schema_note: schema_note_id,
                    parent: None,
                    slug: "space-schema".to_owned(),
                    carrier: "---\ntitle: Space Schema\n---\n# Space Schema\n".to_owned(),
                    schema: schema_map,
                    expected_schema_revision: None,
                },
            ),
        )
        .await
        .expect("update_space_schema");

    let resolved_eff = store
        .resolve_receipt_effects(
            &scope,
            &ReceiptSet::new([schema_committed.receipt.clone()]).expect("receipt set"),
        )
        .await
        .expect("resolve_receipt_effects for schema change");
    assert_eq!(resolved_eff.len(), 1);
    assert!(matches!(
        resolved_eff[0].effect,
        MutationEffect::AwaitProjection {
            reason: AwaitReason::Structural
        }
    ));

    // Typed coercion check: creating a note with `priority: 42` observes `FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Number(_)))`!
    let typed_note = sample_note_id(27);
    store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: typed_note.clone(),
                    parent: Some(proj_a.clone()),
                    slug: "typed-prio".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Typed Note\npriority: 42\n---\n# Typed Note\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create typed note");
    let typed_snap = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: typed_note,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get typed note");
    assert_eq!(
        typed_snap.fields.get("priority"),
        Some(&FieldObservation::Ok(FieldValue::Scalar(
            ScalarValue::Number(ExactNumber::from(42i64))
        )))
    );

    // 7. `publish_ability_package` & `read_ability_resource` (Cap::AbilityWrite + exact revision pinning).
    let ability_id = AbilityId::from_bytes([0x31; 16]);
    let skill_entry_note = sample_note_id(28);
    let skill_md_v1 = "---\nclass: skill\ntitle: Audit Skill\n---\n# Audit Skill\n\nVersion 1.\n";
    let helper_v1 = "print('helper v1')\n";

    store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: skill_entry_note.clone(),
                    parent: Some(proj_a.clone()),
                    slug: "audit-skill".to_owned(),
                    class: DocClass::Skill,
                    carrier: skill_md_v1.to_owned(),
                },
            ),
        )
        .await
        .expect("create DocClass::Skill entrypoint note");

    // Human WITHOUT `ability_write` capability is forbidden!
    let no_ability_ctx = owner_ctx(&scope, owner.clone(), false);
    let denied_pub = store
        .publish_ability_package(
            no_ability_ctx,
            next_mutation(
                &scope,
                &owner,
                PublishAbilityPackage {
                    ability: ability_id.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: skill_entry_note.clone(),
                    files: vec![],
                    expected_package_revision: None,
                },
            ),
        )
        .await;
    assert!(matches!(
        denied_pub,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));

    // Path traversal in auxiliary file must be rejected!
    let traversal_pub = store
        .publish_ability_package(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                PublishAbilityPackage {
                    ability: ability_id.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: skill_entry_note.clone(),
                    files: vec![AbilityFile {
                        path: "../escape.py".to_owned(),
                        content: helper_v1.to_owned(),
                        digest: notarium_syntax::content_digest(helper_v1),
                    }],
                    expected_package_revision: None,
                },
            ),
        )
        .await;
    assert!(traversal_pub.is_err(), "path traversal aux file must fail");

    let pkg_v1 = store
        .publish_ability_package(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                PublishAbilityPackage {
                    ability: ability_id.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: skill_entry_note.clone(),
                    files: vec![AbilityFile {
                        path: "scripts/helper.py".to_owned(),
                        content: helper_v1.to_owned(),
                        digest: notarium_syntax::content_digest(helper_v1),
                    }],
                    expected_package_revision: None,
                },
            ),
        )
        .await
        .expect("publish_ability_package v1");

    let pkg_v2 = store
        .publish_ability_package(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                PublishAbilityPackage {
                    ability: ability_id.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: skill_entry_note.clone(),
                    files: vec![],
                    expected_package_revision: Some(pkg_v1.value.revision.clone()),
                },
            ),
        )
        .await
        .expect("publish_ability_package v2 without helper.py");

    // Exact package_revision read: v1 serves Entrypoint + `scripts/helper.py`, while v2 returns `ResourceNotFound` for `scripts/helper.py`!
    let res_v1_entry = store
        .read_ability_resource(
            ctx.clone(),
            ReadAbilityResource {
                ability: ability_id.clone(),
                package_revision: pkg_v1.value.revision.clone(),
                resource: AbilityResourceName::Entrypoint,
            },
        )
        .await
        .expect("read v1 Entrypoint");
    assert_eq!(
        res_v1_entry.digest(),
        notarium_syntax::content_digest(skill_md_v1)
    );

    let res_v1_aux = store
        .read_ability_resource(
            ctx.clone(),
            ReadAbilityResource {
                ability: ability_id.clone(),
                package_revision: pkg_v1.value.revision.clone(),
                resource: AbilityResourceName::Auxiliary("scripts/helper.py".to_owned()),
            },
        )
        .await
        .expect("read v1 helper.py");
    assert_eq!(
        res_v1_aux.digest(),
        notarium_syntax::content_digest(helper_v1)
    );

    let res_v2_missing_aux = store
        .read_ability_resource(
            ctx.clone(),
            ReadAbilityResource {
                ability: ability_id,
                package_revision: pkg_v2.value.revision,
                resource: AbilityResourceName::Auxiliary("scripts/helper.py".to_owned()),
            },
        )
        .await;
    assert!(matches!(
        res_v2_missing_aux,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    // 8. Authorization fences: Viewer role, folder_write_lock, project_root scope, CrossSpaceTainted.
    let viewer_ctx = make_human_ctx(
        &scope,
        viewer.clone(),
        SpaceRole::Viewer,
        BTreeSet::from([DocClass::UserDoc]),
        BTreeSet::new(),
        None,
        false,
    );
    let viewer_write = store
        .create_note(
            viewer_ctx.clone(),
            next_mutation(
                &scope,
                &viewer,
                CreateNote {
                    note: sample_note_id(40),
                    parent: Some(proj_a.clone()),
                    slug: "viewer-denied".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "# Denied\n".to_owned(),
                },
            ),
        )
        .await;
    assert!(viewer_write.is_err(), "Viewer must not create notes");

    // Folder write lock blocks descendant writes until unlocked!
    store
        .set_folder_write_lock(ctx.clone(), proj_a.clone(), true)
        .await
        .expect("lock proj_a");
    let locked_write = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: sample_note_id(41),
                    parent: Some(proj_a.clone()),
                    slug: "locked-denied".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "# Locked\n".to_owned(),
                },
            ),
        )
        .await;
    assert!(
        matches!(
            locked_write,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "expected SpaceReadOnly on locked folder, got {locked_write:?}"
    );
    store
        .set_folder_write_lock(ctx.clone(), proj_a.clone(), false)
        .await
        .expect("unlock proj_a");

    // Project-pinned context cannot read or write outside `proj_a` (`archive_root`).
    let pinned_ctx = make_human_ctx(
        &scope,
        owner.clone(),
        SpaceRole::Editor,
        DocClass::all(),
        DocClass::all(),
        Some(proj_a.clone()),
        false,
    );
    let outside_proj_write = store
        .create_note(
            pinned_ctx,
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: sample_note_id(42),
                    parent: Some(archive_root.clone()),
                    slug: "outside-proj".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "# Outside\n".to_owned(),
                },
            ),
        )
        .await;
    assert!(
        outside_proj_write.is_err(),
        "project_root pin must block outside writes"
    );

    // Tainted agent run (`CrossSpaceTainted`) cannot write!
    let run_id: AgentRunId = sample_run_id(50);
    let run_auth = ctx
        .auth()
        .for_agent_run(
            run_id,
            scope.space_id.clone(),
            ChatAudience::Personal,
            ctx.auth().spaces().clone(),
        )
        .expect("derive agent run auth");
    run_auth.taint().mark_external_read();
    let tainted_ctx =
        SpaceContext::new(run_auth, scope.clone(), make_budget()).expect("tainted ctx");
    let tainted_write = store
        .create_note(
            tainted_ctx,
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: sample_note_id(43),
                    parent: Some(proj_a.clone()),
                    slug: "tainted-write".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "# Tainted\n".to_owned(),
                },
            ),
        )
        .await;
    assert!(matches!(
        tainted_write,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));

    // `recent_activity` / `read_changes` filters unauthorized classes for `viewer_ctx` (only `UserDoc` granted).
    let latest_space = store.read_space(&scope.space_id).await.expect("read_space");
    let ChangeReadResult::Log(viewer_log) = store
        .recent_activity(
            viewer_ctx,
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope.clone(),
                    after: SpaceSeq::ZERO,
                },
                through: latest_space.last_seq,
                limit: PageLimit::new(200).expect("limit"),
            },
        )
        .await
        .expect("recent_activity for viewer")
    else {
        panic!("expected ChangeReadResult::Log");
    };
    assert!(
        viewer_log.changes.iter().all(
            |ch| ch.class != Some(DocClass::EncryptedNote) && ch.class != Some(DocClass::Skill)
        ),
        "viewer without EncryptedNote/Skill read grant must not see protected classes in recent_activity"
    );
}

#[tokio::test]
async fn l5_domain_crud_batches_packages_and_security_parity() {
    // 1. SQLite + LocalZstdV1
    {
        let root = TempDataRoot::new("l5-domain-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(1), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_domain_and_security_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }

    // 2. PostgreSQL 16 + MinIO CE S3ChunkedV1
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l5dom");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure versioned S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(2), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_domain_and_security_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

async fn run_purge_and_mint_suite(
    store: &CanonicalStore,
) -> (
    HistoryScope,
    SpaceContext,
    Mutation<DeleteNote>,
    Committed<NoteRevision>,
    ContentDigest,
) {
    let owner = sample_principal_id(70);
    let (scope, _root) = seed_default_space(
        store,
        sample_space_id(7),
        sample_incarnation(7),
        owner.clone(),
    )
    .await;
    let ctx = owner_ctx(&scope, owner.clone(), true);

    let shared_carrier = "---\ntitle: Shared Carrier\n---\n# Shared Carrier\n\nCommon text.\n";
    let shared_digest = notarium_syntax::content_digest(shared_carrier);

    let note_keep = sample_note_id(71);
    store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: note_keep.clone(),
                    parent: None,
                    slug: "shared-keep".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: shared_carrier.to_owned(),
                },
            ),
        )
        .await
        .expect("create note_keep");

    let note_purge = sample_note_id(72);
    let created_purge = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: note_purge.clone(),
                    parent: None,
                    slug: "to-be-purged".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: shared_carrier.to_owned(),
                },
            ),
        )
        .await
        .expect("create note_purge");

    // Advance `note_purge` to a unique secret revision + external observation row.
    let unique_secret = "---\ntitle: Secret Purge Target\n---\n# Secret Purge Target\n\nTOP_SECRET_PURGE_TOKEN_9911\n";
    let unique_digest = notarium_syntax::content_digest(unique_secret);
    let obs_res = store
        .accept_external_observation(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                ExternalObservation {
                    note: note_purge.clone(),
                    observed_digest: unique_digest,
                    base_revision: created_purge.value.revision.clone(),
                    disk_identity: ContentDigest::from_bytes([0x88; 32]),
                    content: ObservedContent::Carrier(unique_secret.to_owned()),
                },
            ),
        )
        .await
        .expect("external observation on note_purge");
    let purge_head_rev = match obs_res {
        ExternalObservationResult::Committed(c) => c.value.revision,
        other => panic!("expected Committed, got {other:?}"),
    };

    // Active `backup_holds` row MUST block `Purge` before any erasure!
    store
        .execute_diagnostic_write_sql_for_test(&format!(
            "INSERT INTO backup_holds (backup_id, space_id, history_incarnation, owner_installation_id, \
             phase, cutoff_seq, witness_json, created_at_ms) \
             SELECT 'hold_test_1', space_id, history_incarnation, 'inst_test_hold', 'holding', last_seq, '{{}}', 1000 \
             FROM spaces WHERE space_id = '{}'",
            scope.space_id.as_str()
        ))
        .await
        .expect("insert active backup_hold");

    let blocked_by_hold = store
        .delete_note(
            ctx.clone(),
            next_mutation_rev(
                &scope,
                &owner,
                purge_head_rev.clone(),
                DeleteNote {
                    note: note_purge.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await;
    assert!(
        matches!(
            blocked_by_hold,
            Err(PortError::Unavailable(f)) if f.effect() == CommitEffect::NotCommitted
        ),
        "active backup hold must block Purge, got {blocked_by_hold:?}"
    );

    // Release backup hold -> `Purge` succeeds!
    store
        .execute_diagnostic_write_sql_for_test(
            "DELETE FROM backup_holds WHERE backup_id = 'hold_test_1'",
        )
        .await
        .expect("release backup_hold");

    let purged_res = store
        .delete_note(
            ctx.clone(),
            next_mutation_rev(
                &scope,
                &owner,
                purge_head_rev,
                DeleteNote {
                    note: note_purge.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .expect("Purge note_purge after hold release");

    // Shared digest is retained and readable; unique secret digest is physically retired and unreadable!
    let kept_bytes = store
        .read_verified_blob(&scope, shared_digest)
        .await
        .expect("shared_digest must remain readable for note_keep");
    assert_eq!(kept_bytes, shared_carrier.as_bytes());
    assert!(
        store
            .read_verified_blob(&scope, unique_digest)
            .await
            .is_err(),
        "unique purged digest must no longer be readable"
    );

    // SQL erasure verification on `note_purge`:
    let rev_rows = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM revisions WHERE space_id = '{}' AND entity_key = '{}'",
                scope.space_id.as_str(),
                note_purge.as_str()
            ),
        )
        .await
        .expect("count revisions");
    assert_eq!(
        rev_rows, 0,
        "all historical revisions of purged note must be deleted"
    );

    let obs_rows = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM materialized_observations WHERE space_id = '{}' AND note_id = '{}'",
                scope.space_id.as_str(),
                note_purge.as_str()
            ),
        )
        .await
        .expect("count materialized_observations");
    assert_eq!(
        obs_rows, 0,
        "materialized_observations for purged note must be deleted"
    );

    let unerased_cp = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM change_payloads cp \
                 JOIN payload_owners po ON cp.space_id = po.space_id AND cp.payload_id = po.payload_id \
                 WHERE po.space_id = '{}' AND po.note_id = '{}' AND po.payload_kind = 'change_payload' \
                   AND (cp.erased_by_purge = 0 OR cp.effect_msgpack IS NOT NULL)",
                scope.space_id.as_str(),
                note_purge.as_str()
            ),
        )
        .await
        .expect("count unerased change_payloads");
    assert_eq!(
        unerased_cp, 0,
        "change_payloads owned by purged note must be erased"
    );

    let unsanitized_receipts = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM command_receipts cr \
                 JOIN payload_owners po ON cr.space_id = po.space_id \
                  AND cr.response_payload_id = ('rcpt_pay:' || po.payload_id) \
                 WHERE po.space_id = '{}' AND po.note_id = '{}' AND po.payload_kind = 'command_receipt'",
                scope.space_id.as_str(),
                note_purge.as_str()
            ),
        )
        .await
        .expect("count unsanitized command_receipts");
    assert_eq!(
        unsanitized_receipts, 0,
        "command_receipts response_payload_id must be cleared and detail payload erased"
    );

    let purge_eff = store
        .resolve_receipt_effects(
            &scope,
            &ReceiptSet::new([purged_res.receipt]).expect("receipt set"),
        )
        .await
        .expect("resolve_receipt_effects for purge");
    assert!(matches!(
        purge_eff[0].effect,
        MutationEffect::AwaitProjection {
            reason: AwaitReason::Structural
        }
    ));

    // `MintAndPurge`: active room blocks BEFORE creating `new_note`; once closed, atomically mints + purges + replays idempotently!
    let old_plain = sample_note_id(73);
    let plain_secret =
        "---\ntitle: Plain Before Encrypt\n---\n# Plain Before Encrypt\n\nMINT_SECRET_4455\n";
    let plain_digest = notarium_syntax::content_digest(plain_secret);
    let old_created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: old_plain.clone(),
                    parent: None,
                    slug: "sensitive-doc".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: plain_secret.to_owned(),
                },
            ),
        )
        .await
        .expect("create old_plain");

    let successor = sample_note_id(74);
    store
        .room_fences()
        .open_room(&scope, &old_plain)
        .await
        .expect("open collaborative room on old_plain");

    let blocked_mint = store
        .mint_and_purge(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MintAndPurge {
                    old_note: old_plain.clone(),
                    expected_revision: old_created.value.revision.clone(),
                    new_note: successor.clone(),
                    new_slug: None, // reuse `sensitive-doc` slug!
                    encrypted_carrier: valid_encrypted_carrier("Encrypted Successor"),
                },
            ),
        )
        .await;
    assert!(
        matches!(
            blocked_mint,
            Err(PortError::Unavailable(f)) if f.effect() == CommitEffect::NotCommitted
        ),
        "active collaborative room must block MintAndPurge before creating successor"
    );
    let succ_lookup = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: successor.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await;
    assert!(
        matches!(
            succ_lookup,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "successor note must NOT be created when MintAndPurge is blocked by active room"
    );

    store
        .room_fences()
        .close_room(&scope, &old_plain)
        .await
        .expect("close room on old_plain");

    let mint_mut = next_mutation(
        &scope,
        &owner,
        MintAndPurge {
            old_note: old_plain.clone(),
            expected_revision: old_created.value.revision,
            new_note: successor.clone(),
            new_slug: None,
            encrypted_carrier: valid_encrypted_carrier("Encrypted Successor"),
        },
    );
    let minted = store
        .mint_and_purge(ctx.clone(), mint_mut.clone())
        .await
        .expect("mint_and_purge");
    assert_eq!(minted.value.old_note, old_plain);
    assert_eq!(minted.value.new_note.note, successor);
    assert!(
        store
            .read_verified_blob(&scope, plain_digest)
            .await
            .is_err(),
        "old plaintext digest must be physically retired by MintAndPurge"
    );

    // Idempotent retry of `mint_and_purge` replays sanitized outcome without duplicate successor!
    let minted_replay = store
        .mint_and_purge(ctx.clone(), mint_mut)
        .await
        .expect("idempotent replay of mint_and_purge");
    assert_eq!(minted.value, minted_replay.value);
    assert_eq!(minted.receipt, minted_replay.receipt);

    // Execute Step-1 SQL erasure of `note_crash` and simulate process crash right before Step-2/3 CAS retirement!
    let note_crash = sample_note_id(75);
    let crash_secret =
        "---\ntitle: Crash Purge\n---\n# Crash Purge\n\nCRASH_RECOVERY_SECRET_8822\n";
    let crash_digest = notarium_syntax::content_digest(crash_secret);
    let crash_created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: note_crash.clone(),
                    parent: None,
                    slug: "crash-purge".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: crash_secret.to_owned(),
                },
            ),
        )
        .await
        .expect("create note_crash");

    let crash_purge_mut = next_mutation_rev(
        &scope,
        &owner,
        crash_created.value.revision,
        DeleteNote {
            note: note_crash,
            disposition: DeleteDisposition::Purge,
        },
    );
    let step1_committed = store
        .simulate_interrupted_purge_step1_for_test(ctx.clone(), crash_purge_mut.clone())
        .await
        .expect("commit step 1 of interrupted purge");

    let pending_before_restart = store
        .execute_diagnostic_read_sql_for_test(
            None,
            "SELECT COUNT(*) FROM pending_purges WHERE phase <> 'completed'",
        )
        .await
        .expect("count incomplete pending_purges before restart");
    assert_eq!(
        pending_before_restart, 1,
        "interrupted purge must leave 1 incomplete pending_purges row"
    );

    (scope, ctx, crash_purge_mut, step1_committed, crash_digest)
}

#[tokio::test]
async fn l5_purge_and_mint_and_purge_erasure_and_crash_recovery_parity() {
    // 1. SQLite + LocalZstdV1 (including restart recovery + idempotent replay)
    {
        let root = TempDataRoot::new("l5-purge-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(1), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg.clone())
            .await
            .expect("open sqlite");
        let (scope, ctx, crash_purge_mut, step1_committed, crash_digest) =
            run_purge_and_mint_suite(&store).await;
        runtime.shutdown().await.expect("shutdown before reopen");

        // Reopen runtime -> `resume_pending_purges_on_startup` drives interrupted purge to `completed`!
        let (store2, runtime2) = CanonicalRuntime::open(cfg).await.expect("reopen sqlite");
        let pending_left = store2
            .execute_diagnostic_read_sql_for_test(
                None,
                "SELECT COUNT(*) FROM pending_purges WHERE phase <> 'completed'",
            )
            .await
            .expect("count incomplete pending_purges");
        assert_eq!(
            pending_left, 0,
            "startup recovery must complete interrupted pending_purges"
        );
        assert!(
            store2
                .read_verified_blob(&scope, crash_digest)
                .await
                .is_err(),
            "startup recovery must physically retire crash_digest"
        );
        let replay_after_recovery = store2
            .delete_note(ctx, crash_purge_mut)
            .await
            .expect("idempotent replay of recovered purge");
        assert_eq!(replay_after_recovery.value, step1_committed.value);
        assert_eq!(replay_after_recovery.receipt, step1_committed.receipt);
        runtime2.shutdown().await.expect("shutdown reopened sqlite");
    }

    // 2. PostgreSQL 16 + MinIO CE S3ChunkedV1 (including restart recovery + idempotent replay)
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l5prg");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(2), &schema, s3_cfg);

        let (store, runtime) = CanonicalRuntime::open(cfg.clone())
            .await
            .expect("open pg+s3");
        let (scope, ctx, crash_purge_mut, step1_committed, crash_digest) =
            run_purge_and_mint_suite(&store).await;
        runtime
            .shutdown()
            .await
            .expect("shutdown pg+s3 before reopen");

        let (store2, runtime2) = CanonicalRuntime::open(cfg).await.expect("reopen pg+s3");
        let pending_left = store2
            .execute_diagnostic_read_sql_for_test(
                None,
                "SELECT COUNT(*) FROM pending_purges WHERE phase <> 'completed'",
            )
            .await
            .expect("count incomplete pending_purges pg");
        assert_eq!(
            pending_left, 0,
            "PG startup recovery must complete interrupted pending_purges"
        );
        assert!(
            store2
                .read_verified_blob(&scope, crash_digest)
                .await
                .is_err(),
            "PG startup recovery must physically retire crash_digest from S3"
        );
        let replay_after_recovery = store2
            .delete_note(ctx, crash_purge_mut)
            .await
            .expect("idempotent replay of recovered purge on PG+S3");
        assert_eq!(replay_after_recovery.value, step1_committed.value);
        assert_eq!(replay_after_recovery.receipt, step1_committed.receipt);
        runtime2.shutdown().await.expect("shutdown reopened pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}
