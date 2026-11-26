use super::*;
use notarium_core::ports::EnsureFolderPath;

pub(super) async fn check(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    schema_revision: &RevisionId,
    postgres: bool,
) {
    let ctx = owner_ctx(scope, owner.clone(), true, true);
    let before_covers = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let path = next_mutation(
        scope,
        owner,
        EnsureFolderPath {
            base: None,
            path: "covers/Left".into(),
        },
    );
    let left = store
        .ensure_folder_path(ctx.clone(), path.clone())
        .await
        .unwrap();
    assert_eq!(
        store
            .ensure_folder_path(ctx.clone(), path.clone())
            .await
            .unwrap(),
        left
    );
    let wrong_retry = Mutation {
        input: EnsureFolderPath {
            base: None,
            path: "covers/not-created".into(),
        },
        ..path
    };
    assert_eq!(
        store
            .ensure_folder_path(ctx.clone(), wrong_retry)
            .await
            .unwrap_err(),
        PortError::Domain(DomainError::IdempotencyKeyReused),
    );
    let right = store
        .ensure_folder_path(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                EnsureFolderPath {
                    base: None,
                    path: "covers/Right".into(),
                },
            ),
        )
        .await
        .unwrap();
    let cover = |parent: FolderId, note: NoteId, slug: &str, folder_page| CreateNote {
        parent: Some(parent),
        note,
        slug: slug.into(),
        folder_page,
        class: DocClass::UserDoc,
        carrier: "# Cover\n\nBody\n".into(),
    };
    let left_note = sample_note_id(235);
    let right_note = sample_note_id(236);
    let bare_index = store
        .create_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                cover(left.folder_id.clone(), left_note.clone(), "INDEX", false),
            ),
        )
        .await;
    assert_validation_err(&bare_index, ValidationReason::InvalidPathComponent);
    for (folder, note) in [(&left, &left_note), (&right, &right_note)] {
        store
            .create_note(
                ctx.clone(),
                next_mutation(
                    scope,
                    owner,
                    cover(folder.folder_id.clone(), note.clone(), "index", true),
                ),
            )
            .await
            .unwrap();
    }
    let cover_at = async |folder: &FolderRef| {
        store
            .resolve_folder_path(ctx.clone(), Some(folder.folder_id.clone()), String::new())
            .await
            .unwrap()
            .unwrap()
            .cover_note
    };
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));
    assert_eq!(cover_at(&right).await.as_ref(), Some(&right_note));

    for (note, parent, slug) in [
        (
            left_note.clone(),
            right.folder_id.clone(),
            "relocated-schema",
        ),
        (left_note.clone(), left.folder_id.clone(), "renamed-schema"),
        (sample_note_id(237), left.folder_id.clone(), "INDEX"),
    ] {
        let request = next_mutation(
            scope,
            owner,
            UpdateSpaceSchema {
                schema_note: note,
                parent: Some(parent),
                slug: slug.into(),
                carrier: "# Schema\n".into(),
                schema: BTreeMap::new(),
                expected_schema_revision: Some(schema_revision.clone()),
            },
        );
        assert_validation_err(
            &store.update_space_schema(ctx.clone(), request).await,
            ValidationReason::InvalidPathComponent,
        );
    }
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));

    let rename = store
        .rename_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                RenameNote {
                    note: left_note.clone(),
                    slug: "index".into(),
                    title: Some("Renamed cover".into()),
                },
            ),
        )
        .await
        .unwrap();
    let metadata = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: left_note.clone(),
                revision: Some(rename.value.revision),
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap()
        .provenance
        .unwrap();
    assert_eq!(metadata.title, "Renamed cover");
    assert_eq!(metadata.path, "covers/Left/index.md");
    assert!(metadata.folder_page);

    let move_left = MoveNote {
        note: left_note.clone(),
        parent: Some(right.folder_id.clone()),
        slug: "index".into(),
    };
    assert!(matches!(
        store
            .move_note(ctx.clone(), next_mutation(scope, owner, move_left.clone()))
            .await,
        Err(PortError::Domain(DomainError::PathConflict { .. })),
    ));
    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: right_note.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(cover_at(&right).await, None);

    let run = sample_run_id(235);
    let agent_auth = ctx
        .auth()
        .for_agent_run(
            run.clone(),
            scope.space_id.clone(),
            ChatAudience::Personal,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    let agent = SpaceContext::new(agent_auth, scope.clone(), make_budget()).unwrap();
    store
        .move_note(agent, next_mutation(scope, owner, move_left))
        .await
        .unwrap();
    assert_eq!(cover_at(&left).await, None);
    assert_eq!(cover_at(&right).await.as_ref(), Some(&left_note));

    let plan = store
        .prepare_agent_run_rollback(ctx.clone(), run)
        .await
        .unwrap();
    let result = store
        .rollback_agent_run(ctx.clone(), next_mutation(scope, owner, plan))
        .await
        .unwrap();
    assert_eq!(result.value.restored[0].note, left_note);
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));
    assert_eq!(cover_at(&right).await, None);

    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: right_note.clone(),
                    disposition: DeleteDisposition::Restore,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(cover_at(&right).await.as_ref(), Some(&right_note));
    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: right_note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(cover_at(&right).await, None);
    let updated = store
        .update_space_schema(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                UpdateSpaceSchema {
                    schema_note: left_note.clone(),
                    parent: Some(left.folder_id.clone()),
                    slug: "index".into(),
                    carrier: "# Schema cover\n".into(),
                    schema: BTreeMap::new(),
                    expected_schema_revision: Some(schema_revision.clone()),
                },
            ),
        )
        .await
        .unwrap();
    let note = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: left_note.clone(),
                revision: Some(updated.value.note_revision),
                causal: CausalBasis::Exact(Default::default()),
            },
        )
        .await
        .unwrap();
    assert!(note.provenance.unwrap().folder_page);
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));

    // Purging a note erases its old effects. Activity still includes the surviving
    // cover with its authorized metadata; delta consumers must reseed.
    let query = ChangeRead::Log {
        after: ChangeCursor {
            scope: scope.clone(),
            after: before_covers,
        },
        through: store.read_space(&scope.space_id).await.unwrap().last_seq,
        limit: PageLimit::new(200).unwrap(),
    };
    assert_validation_err(
        &store.read_changes(ctx.clone(), query.clone()).await,
        ValidationReason::PurgeResync,
    );
    let ChangeReadResult::Log(activity) = store.recent_activity(ctx.clone(), query).await.unwrap()
    else {
        panic!("expected activity log");
    };
    assert!(activity.changes.iter().any(|row| row.entity
        == notarium_core::ports::EntityId::Note(left_note.clone())
        && row.provenance.is_some()));
    assert!(activity.changes.iter().all(|row| row.entity
        != notarium_core::ports::EntityId::Note(right_note.clone())
        || row.provenance.is_none()));

    // Legacy v1 ordinary `index` receipt replay on the single CreateNote path,
    // and refusal to match a `folder_page: true` request against a v1 ordinary receipt.
    let legacy_dir = store
        .ensure_folder_path(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                EnsureFolderPath {
                    base: None,
                    path: "covers/LegacyIndex".into(),
                },
            ),
        )
        .await
        .unwrap();
    let legacy_note = sample_note_id(238);
    let legacy_carrier = "# Legacy index\n\nOrdinary v1 body\n";
    let legacy_mutation = next_mutation(
        scope,
        owner,
        CreateNote {
            parent: Some(legacy_dir.folder_id.clone()),
            note: legacy_note.clone(),
            slug: "index".into(),
            folder_page: true,
            class: DocClass::UserDoc,
            carrier: legacy_carrier.into(),
        },
    );
    let legacy_created = store
        .create_note(ctx.clone(), legacy_mutation.clone())
        .await
        .unwrap();
    // Simulate a pre-upgrade v1 database row where `index` was an ordinary note
    // (no cover link, and v1 command hash without the `folder-page` suffix).
    let cleared = store
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE folder_heads SET cover_note_id=NULL WHERE space_id='{}' AND folder_id='{}'",
            scope.space_id.as_str(),
            legacy_dir.folder_id.as_str()
        ))
        .await
        .unwrap();
    assert_eq!(cleared, 1);
    let mut v1_payload = blake3::Hasher::new();
    for part in [
        legacy_note.as_str(),
        legacy_dir.folder_id.as_str(),
        "index",
        "user-doc",
    ] {
        v1_payload.update(part.as_bytes());
        v1_payload.update(&[0]);
    }
    v1_payload.update(notarium_syntax::content_digest(legacy_carrier).as_bytes());
    let mut v1_cmd_hash = blake3::Hasher::new();
    v1_cmd_hash.update(b"notarium-cmd-v1:create_note\0");
    v1_cmd_hash.update(legacy_mutation.identity.hash.as_bytes());
    v1_cmd_hash.update(&[0]);
    v1_cmd_hash.update(v1_payload.finalize().as_bytes());
    let hex_hash = v1_cmd_hash.finalize().to_hex();
    let hash_literal = if postgres {
        format!("decode('{hex_hash}', 'hex')")
    } else {
        format!("X'{hex_hash}'")
    };
    let patched = store
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE command_receipts SET command_hash={hash_literal} WHERE space_id='{}' AND idempotency_key='{}'",
            scope.space_id.as_str(),
            legacy_mutation.identity.key.as_str()
        ))
        .await
        .unwrap();
    assert_eq!(patched, 1);

    let legacy_ordinary_retry = Mutation {
        input: CreateNote {
            folder_page: false,
            ..legacy_mutation.input.clone()
        },
        ..legacy_mutation.clone()
    };
    let replayed = store
        .create_note(ctx.clone(), legacy_ordinary_retry)
        .await
        .expect("single CreateNote must replay historical v1 ordinary `index` receipt");
    assert_eq!(replayed.receipt, legacy_created.receipt);
    assert_eq!(replayed.value, legacy_created.value);

    let false_cover_retry = store.create_note(ctx.clone(), legacy_mutation).await;
    assert_eq!(
        false_cover_retry.unwrap_err(),
        PortError::Domain(DomainError::IdempotencyKeyReused),
        "folder_page=true must never match a legacy v1 ordinary note receipt"
    );
    assert_eq!(cover_at(&legacy_dir).await, None);

    let fresh_ordinary_index = store
        .create_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    parent: Some(legacy_dir.folder_id.clone()),
                    note: sample_note_id(239),
                    slug: "index".into(),
                    folder_page: false,
                    class: DocClass::UserDoc,
                    carrier: "# New index\n".into(),
                },
            ),
        )
        .await;
    assert_validation_err(
        &fresh_ordinary_index,
        ValidationReason::InvalidPathComponent,
    );

    // Space-root (`parent: None` / `Some(root)`) historical v1 ordinary `index`
    // receipts normalized parent to `""` in command_hash; single CreateNote must
    // replay both `parent: None` and `parent: Some(root)` cleanly while still
    // rejecting `folder_page: true`.
    let root_folder_id = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    let root_legacy_note = sample_note_id(240);
    let root_legacy_carrier = "# Legacy root index\n\nRoot content.\n";
    let root_legacy_mutation = next_mutation(
        scope,
        owner,
        CreateNote {
            parent: None,
            note: root_legacy_note.clone(),
            slug: "index".into(),
            folder_page: true,
            class: DocClass::UserDoc,
            carrier: root_legacy_carrier.into(),
        },
    );
    let root_legacy_created = store
        .create_note(ctx.clone(), root_legacy_mutation.clone())
        .await
        .unwrap();
    let cleared_root = store
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE folder_heads SET cover_note_id=NULL WHERE space_id='{}' AND folder_id='{}'",
            scope.space_id.as_str(),
            root_folder_id.as_str()
        ))
        .await
        .unwrap();
    assert_eq!(cleared_root, 1);
    let mut root_v1_payload = blake3::Hasher::new();
    for part in [root_legacy_note.as_str(), "", "index", "user-doc"] {
        root_v1_payload.update(part.as_bytes());
        root_v1_payload.update(&[0]);
    }
    root_v1_payload.update(notarium_syntax::content_digest(root_legacy_carrier).as_bytes());
    let mut root_v1_cmd_hash = blake3::Hasher::new();
    root_v1_cmd_hash.update(b"notarium-cmd-v1:create_note\0");
    root_v1_cmd_hash.update(root_legacy_mutation.identity.hash.as_bytes());
    root_v1_cmd_hash.update(&[0]);
    root_v1_cmd_hash.update(root_v1_payload.finalize().as_bytes());
    let root_hex_hash = root_v1_cmd_hash.finalize().to_hex();
    let root_hash_literal = if postgres {
        format!("decode('{root_hex_hash}', 'hex')")
    } else {
        format!("X'{root_hex_hash}'")
    };
    let patched_root = store
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE command_receipts SET command_hash={root_hash_literal} WHERE space_id='{}' AND idempotency_key='{}'",
            scope.space_id.as_str(),
            root_legacy_mutation.identity.key.as_str()
        ))
        .await
        .unwrap();
    assert_eq!(patched_root, 1);

    for retry_parent in [None, Some(root_folder_id.clone())] {
        let retry = Mutation {
            input: CreateNote {
                parent: retry_parent,
                folder_page: false,
                ..root_legacy_mutation.input.clone()
            },
            ..root_legacy_mutation.clone()
        };
        let replayed = store
            .create_note(ctx.clone(), retry)
            .await
            .expect("Space-root historical v1 ordinary `index` receipt must replay");
        assert_eq!(replayed.receipt, root_legacy_created.receipt);
        assert_eq!(replayed.value, root_legacy_created.value);
    }
    let root_false_cover = store.create_note(ctx.clone(), root_legacy_mutation).await;
    assert_eq!(
        root_false_cover.unwrap_err(),
        PortError::Domain(DomainError::IdempotencyKeyReused),
        "folder_page=true must not match Space-root legacy v1 ordinary index receipt"
    );

    // Batch child-folder listing with 100 active children (including cover notes)
    // must return all 100 snapshots accurately inside the single read transaction.
    let batch_parent = store
        .ensure_folder_path(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                EnsureFolderPath {
                    base: None,
                    path: "covers/BatchChildren".into(),
                },
            ),
        )
        .await
        .unwrap();
    let active_epoch = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    let mut covered_folders = BTreeMap::new();
    for idx in 0..100u16 {
        let mut raw = [0u8; 16];
        raw[0] = 0xB8;
        raw[14..16].copy_from_slice(&idx.to_be_bytes());
        let child_id = FolderId::from_bytes(raw);
        store
            .create_folder(notarium_canonical::CreateFolderSpec {
                scope: scope.clone(),
                active_epoch,
                folder_id: child_id.clone(),
                parent: Some(batch_parent.folder_id.clone()),
                slug: format!("child-{idx:03}"),
                display_name: format!("Child {idx:03}"),
                is_project: false,
                project_slug: None,
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
        if idx < 5 {
            let mut nraw = [0u8; 16];
            nraw[0] = 0xC8;
            nraw[14..16].copy_from_slice(&idx.to_be_bytes());
            let note_id = NoteId::from_bytes(nraw);
            store
                .create_note(
                    ctx.clone(),
                    next_mutation(
                        scope,
                        owner,
                        CreateNote {
                            parent: Some(child_id.clone()),
                            note: note_id.clone(),
                            slug: "index".into(),
                            folder_page: true,
                            class: DocClass::UserDoc,
                            carrier: format!("# Cover {idx}\n"),
                        },
                    ),
                )
                .await
                .unwrap();
            covered_folders.insert(child_id, note_id);
        }
    }
    let listed = store
        .list_child_folders(
            ctx.clone(),
            Some(batch_parent.folder_id.clone()),
            None,
            None,
            PageLimit::new(100).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.items.len(), 100);
    assert!(listed.next.is_none());
    for item in &listed.items {
        assert!(item.path.starts_with("covers/BatchChildren/child-"));
        assert!(item.ancestor_folders.contains(&batch_parent.folder_id));
        assert_eq!(
            item.cover_note.as_ref(),
            covered_folders.get(&item.reference.folder_id)
        );
    }

    // Folder cover notes must be `DocClass::UserDoc` at creation, and even for a legacy
    // non-`UserDoc` cover note a memory-only Keeper must not mutate `folder_heads.cover_note_id`
    // via `move_note`, `delete_note`, or `purge_note`.
    let bad_cover_dir = FolderId::from_bytes([0xD1; 16]);
    let other_cover_dir = FolderId::from_bytes([0xD2; 16]);
    for (fid, slug) in [
        (&bad_cover_dir, "cover-auth-src"),
        (&other_cover_dir, "cover-auth-dst"),
    ] {
        store
            .create_folder(notarium_canonical::CreateFolderSpec {
                scope: scope.clone(),
                active_epoch,
                folder_id: fid.clone(),
                parent: Some(batch_parent.folder_id.clone()),
                slug: slug.into(),
                display_name: slug.into(),
                is_project: false,
                project_slug: None,
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let owner_ctx_again = owner_ctx(scope, owner.clone(), true, true);
    let mem_cover_create = store
        .create_note(
            owner_ctx_again.clone(),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    parent: Some(bad_cover_dir.clone()),
                    note: sample_note_id(245),
                    slug: "index".into(),
                    folder_page: true,
                    class: DocClass::AgentMemory,
                    carrier: "---\nclass: agent-memory\ntitle: Memory Cover\n---\n# Bad\n".into(),
                },
            ),
        )
        .await;
    assert_validation_err(&mem_cover_create, ValidationReason::InvalidState);

    let legacy_mem_cover = sample_note_id(246);
    store
        .create_note(
            owner_ctx_again.clone(),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    parent: Some(bad_cover_dir.clone()),
                    note: legacy_mem_cover.clone(),
                    slug: "index".into(),
                    folder_page: true,
                    class: DocClass::UserDoc,
                    carrier: "# Cover Auth\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    // Simulate a legacy non-UserDoc cover row so defense-in-depth guards on move/delete/purge are exercised.
    let updated = store
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE note_heads SET doc_class='agent-memory' WHERE space_id='{}' AND note_id='{}'",
            scope.space_id.as_str(),
            legacy_mem_cover.as_str()
        ))
        .await
        .unwrap();
    assert_eq!(updated, 1);
    let keeper_auth = owner_ctx_again
        .auth()
        .for_keeper(
            AgentRunId::from_bytes([0xD3; 16]),
            scope.space_id.clone(),
            None,
            std::collections::BTreeSet::new(),
        )
        .unwrap();
    let keeper_ctx = SpaceContext::new(keeper_auth, scope.clone(), make_budget()).unwrap();
    let keeper_move = store
        .move_note(
            keeper_ctx.clone(),
            next_mutation(
                scope,
                owner,
                MoveNote {
                    note: legacy_mem_cover.clone(),
                    parent: Some(other_cover_dir),
                    slug: "index".into(),
                },
            ),
        )
        .await;
    assert!(
        matches!(
            keeper_move,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "memory-only Keeper must not move a folder cover note, got {keeper_move:?}"
    );
    let keeper_trash = store
        .delete_note(
            keeper_ctx.clone(),
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: legacy_mem_cover.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await;
    assert!(
        matches!(
            keeper_trash,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "memory-only Keeper must not trash a folder cover note, got {keeper_trash:?}"
    );
    let keeper_purge = store
        .delete_note(
            keeper_ctx,
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: legacy_mem_cover.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await;
    assert!(
        matches!(
            keeper_purge,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "memory-only Keeper must not purge a folder cover note, got {keeper_purge:?}"
    );
    assert_eq!(
        cover_at(&FolderRef {
            space_id: scope.space_id.clone(),
            folder_id: bad_cover_dir,
        })
        .await,
        Some(legacy_mem_cover),
        "failed Keeper mutations must leave folder cover binding intact"
    );
}
