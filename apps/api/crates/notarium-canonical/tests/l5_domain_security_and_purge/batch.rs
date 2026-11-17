use super::*;

pub(super) async fn check(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    scope: &HistoryScope,
    owner: &PrincipalId,
    postgres: bool,
) {
    use notarium_canonical::{CloseCollabSession, OpenCollabSession};
    use notarium_core::error::RetryAdvice;

    let note = sample_note_id(0xd8);
    let other = sample_note_id(0xd9);
    let base = "Initial text.\n";
    let create = |note: &NoteId, slug: &str, carrier: &str| {
        next_mutation(
            scope,
            owner,
            BatchItem::Create(CreateNote {
                note: note.clone(),
                slug: slug.into(),
                parent: None,
                class: DocClass::UserDoc,
                carrier: carrier.into(),
            }),
        )
    };
    let edit = |note: &NoteId, carrier: &str, tag: &str| {
        next_mutation(
            scope,
            owner,
            BatchItem::Edit(EditNote {
                note: note.clone(),
                plan: extract::finalize_document(
                    carrier,
                    DocClass::UserDoc,
                    note,
                    &[FieldEdit::Set {
                        key: "tag".into(),
                        value: YamlValue::String(tag.into()),
                    }],
                )
                .unwrap(),
            }),
        )
    };
    let first = create(&note, "batch-source-a", base);
    let mut reused = create(&note, "batch-source-b", "Rejected bytes.");
    reused.identity = first.identity.clone();
    let initial = store
        .accept_batch(
            ctx.clone(),
            AcceptBatch {
                items: vec![first, reused, edit(&note, base, "accepted")],
            },
        )
        .await
        .unwrap();
    assert!(initial.items[0].is_ok());
    assert!(matches!(
        initial.items[1],
        Err(DomainError::IdempotencyKeyReused)
    ));
    let initial_edit = initial.items[2].as_ref().unwrap();
    let read = |note: &NoteId| GetNote {
        note: note.clone(),
        revision: None,
        causal: CausalBasis::Exact(ReceiptSet::default()),
    };
    let initial_doc = store
        .get_note(ctx.clone(), read(&note))
        .await
        .unwrap()
        .document;
    let initial_carrier = initial_doc.explicit_read(ctx.auth()).unwrap();
    let mut stale_edit = edit(&note, initial_carrier, "rejected");
    let stale = initial.items[0].as_ref().unwrap().value.revision.clone();
    stale_edit.preconditions.revision = Some(stale.clone());
    let stale_trash = next_mutation_rev(
        scope,
        owner,
        stale.clone(),
        BatchItem::Delete(DeleteNote {
            note: note.clone(),
            disposition: DeleteDisposition::Trash,
        }),
    );
    let second = store
        .accept_batch(
            ctx.clone(),
            AcceptBatch {
                items: vec![
                    stale_edit,
                    stale_trash,
                    edit(&note, initial_carrier, "second"),
                ],
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        second.items[0],
        Err(DomainError::RevisionConflict { .. })
    ));
    assert!(matches!(
        second.items[1],
        Err(DomainError::RevisionConflict { .. })
    ));
    let current = second.items[2].as_ref().unwrap();
    assert!(current.receipt.seq() > initial_edit.receipt.seq());
    let snapshot = store
        .get_note(ctx.clone(), read(&note))
        .await
        .unwrap()
        .document;
    let carrier = snapshot.explicit_read(ctx.auth()).unwrap();
    assert!(carrier.contains("second"));
    let room = store
        .open_collab_session(
            &ctx.budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "batch-room".into(),
                expected_carrier_rev: current.value.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(room.room_state, notarium_canonical::CollabRoomState::Active);
    assert!(!room.carrier_dirty);
    let assert_effect = |error: PortError, effect: CommitEffect| {
        let PortError::Unavailable(failure) = error else {
            panic!("expected room contention, got {error:?}");
        };
        assert_eq!(failure.effect(), effect);
        if effect == CommitEffect::Unknown {
            assert_eq!(failure.retry(), RetryAdvice::RetrySameCommand);
        }
    };
    let blocked = edit(&note, carrier, "after-close");
    assert_effect(
        store
            .accept_batch(
                ctx.clone(),
                AcceptBatch {
                    items: vec![blocked.clone()],
                },
            )
            .await
            .unwrap_err(),
        CommitEffect::NotCommitted,
    );
    let mixed = AcceptBatch {
        items: vec![blocked, create(&other, "batch-independent", base)],
    };
    assert_effect(
        store
            .accept_batch(ctx.clone(), mixed.clone())
            .await
            .unwrap_err(),
        CommitEffect::Unknown,
    );
    let other_before = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    let link = |source: &NoteId, target| {
        next_mutation(
            scope,
            owner,
            Link {
                source: source.clone(),
                target,
                relation: "related".into(),
            },
        )
    };
    let link_batch = LinkBatch {
        items: vec![
            link(&other, LinkTarget::Note(note.clone())),
            link(&note, LinkTarget::Note(other.clone())),
        ],
    };
    assert_effect(
        store
            .link_many(ctx.clone(), link_batch.clone())
            .await
            .unwrap_err(),
        CommitEffect::Unknown,
    );
    let other_linked = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    assert_ne!(
        other_before.metadata().revision(),
        other_linked.metadata().revision()
    );
    let closed = store
        .close_collab_session(
            &ctx.budget,
            CloseCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: Some("batch-room".into()),
                expected_lease: room.lease_epoch,
                expected_lineage: room.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: None,
            },
        )
        .await
        .unwrap();

    assert_eq!(
        closed.room_state,
        notarium_canonical::CollabRoomState::Closed
    );
    assert!(!closed.carrier_dirty);
    assert_eq!(closed.carrier_rev_id, current.value.revision);

    let accepted = store.accept_batch(ctx.clone(), mixed).await.unwrap();
    assert!(accepted.items[0].is_ok());
    assert_eq!(
        &accepted.items[1].as_ref().unwrap().value.revision,
        other_before.metadata().revision()
    );
    // Existing link-batch receipts included the old base digest. The retry must
    // recover it from the original revision after this source already advanced.
    let identity = &link_batch.items[0].identity;
    let legacy = format!(
        "src={}\0base={}\0line=- related: [[{}]]\n",
        other.as_str(),
        other_before.digest().to_hex(),
        note.as_str()
    );
    let mut hash = blake3::Hasher::new();
    hash.update(b"notarium-cmd-v1:link\0");
    hash.update(identity.hash.as_bytes());
    hash.update(&[0]);
    hash.update(legacy.as_bytes());
    let hash = hash.finalize().to_hex();
    let literal = if postgres {
        format!("decode('{hash}', 'hex')")
    } else {
        format!("X'{hash}'")
    };
    let count = store.execute_diagnostic_write_sql_for_test(&format!(
        "UPDATE command_receipts SET command_hash={literal} WHERE space_id='{}' AND idempotency_key='{}'",
        scope.space_id.as_str(), identity.key.as_str())).await.unwrap();
    assert_eq!(count, 1);
    let linked = store
        .link_many(ctx.clone(), link_batch.clone())
        .await
        .unwrap();
    assert!(linked.items.iter().all(Result::is_ok));
    let repeated = store.link_many(ctx.clone(), link_batch).await.unwrap();
    assert_eq!(
        linked.committed_high_watermark,
        repeated.committed_high_watermark
    );
    assert_eq!(
        linked.items[0].as_ref().unwrap().receipt,
        repeated.items[0].as_ref().unwrap().receipt
    );
    let after = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    assert_eq!(
        after.metadata().revision(),
        other_linked.metadata().revision()
    );

    let chained = LinkBatch {
        items: vec![
            link(&other, LinkTarget::Note(sample_note_id(0xda))),
            link(&other, LinkTarget::AuthoredName("last-target".into())),
        ],
    };
    let result = store.link_many(ctx.clone(), chained).await.unwrap();
    assert!(matches!(
        result.items[0],
        Err(DomainError::ResourceNotFound)
    ));
    assert!(result.items[1].is_ok());
    let doc = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    assert!(
        doc.explicit_read(ctx.auth())
            .unwrap()
            .contains("[[last-target]]")
    );
}
