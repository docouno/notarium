use super::*;
use notarium_canonical::{
    AppendCollabUpdate, CloseCollabSession, CollabCarrierSettlement, OpenCollabSession,
};

pub(super) async fn write_and_reconcile_schema(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    scope: &HistoryScope,
    owner: &PrincipalId,
    mut input: UpdateSpaceSchema,
) -> Committed<SpaceSchemaRevision> {
    let note = input.schema_note.clone();
    let budget = make_budget();
    let request = |input: &UpdateSpaceSchema| next_mutation(scope, owner, input.clone());

    let mut wrong = request(&input);
    wrong.preconditions.lineage = Some(notarium_core::ids::LineageEpoch::new(1).unwrap());
    assert!(store.update_space_schema(ctx.clone(), wrong).await.is_err());
    store.room_fences().open_room(scope, &note).await.unwrap();
    assert!(
        store
            .update_space_schema(ctx.clone(), request(&input))
            .await
            .is_err()
    );
    store.room_fences().close_room(scope, &note).await.unwrap();

    let first = store
        .update_space_schema(ctx.clone(), request(&input))
        .await
        .unwrap()
        .value;
    input.expected_schema_revision = Some(first.schema_revision);
    let mut open = OpenCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: "schema-room".into(),
        expected_carrier_rev: first.note_revision.clone(),
        expected_lease: None,
        expected_lineage: None,
        initial_yrs_snapshot: None,
        allow_fenced_recovery: false,
    };
    let active = store
        .open_collab_session(&budget, open.clone())
        .await
        .unwrap();
    store
        .append_collab_update(
            &budget,
            AppendCollabUpdate {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: open.owner_id.clone(),
                expected_lease: active.lease_epoch,
                expected_lineage: active.lineage_epoch,
                update_seq: 1,
                update_bytes: vec![42],
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .update_space_schema(ctx.clone(), request(&input))
            .await
            .is_err()
    );
    let mut close = CloseCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: Some(open.owner_id.clone()),
        expected_lease: active.lease_epoch,
        expected_lineage: active.lineage_epoch,
        final_yrs_snapshot: None,
        compacted_through_update_seq: None,
        carrier_settlement: None,
    };
    let closed = store
        .close_collab_session(&budget, close.clone())
        .await
        .unwrap();
    assert!(closed.carrier_dirty);
    assert!(
        store
            .update_space_schema(ctx.clone(), request(&input))
            .await
            .is_err()
    );
    let suffix = "\nLocal edit";
    let span =
        notarium_core::span::ByteSpan::new(input.carrier.len(), input.carrier.len()).unwrap();
    let body = notarium_syntax::frontmatter::analyze(&input.carrier, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        &input.carrier,
        body,
        vec![(
            notarium_core::patch::CarrierEditOrigin::Body,
            span,
            suffix.into(),
        )],
    )
    .unwrap();
    assert!(matches!(
        store
            .edit_note(
                ctx.clone(),
                next_mutation(
                    scope,
                    owner,
                    EditNote {
                        note: note.clone(),
                        plan
                    }
                )
            )
            .await,
        Err(PortError::Unavailable(_))
    ));
    let observed = format!("{}{suffix}", input.carrier);
    let digest = notarium_syntax::content_digest(&observed);
    assert!(matches!(
        store
            .accept_external_observation(
                ctx.clone(),
                next_mutation(
                    scope,
                    owner,
                    ExternalObservation {
                        note: note.clone(),
                        observed_digest: digest,
                        base_revision: first.note_revision.clone(),
                        disk_identity: digest,
                        content: ObservedContent::Carrier(observed),
                    }
                )
            )
            .await,
        Err(PortError::Unavailable(_))
    ));
    let durable = store
        .read_collab_session(None, scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(durable.session.carrier_rev_id, first.note_revision);
    assert_eq!(durable.updates[0].update_bytes, vec![42]);

    open.expected_lease = Some(closed.lease_epoch);
    let active = store.open_collab_session(&budget, open).await.unwrap();
    // Moving a note changes its metadata revision while keeping its Yrs state.
    let moved = store
        .move_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                MoveNote {
                    note: note.clone(),
                    parent: None,
                    slug: "moved-space-schema".into(),
                },
            ),
        )
        .await
        .unwrap();
    let after_move = store
        .read_collab_session(None, scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after_move.session.carrier_rev_id, moved.value.revision);
    assert_eq!(after_move.session.lineage_epoch, active.lineage_epoch);
    assert_eq!(after_move.updates[0].update_bytes, vec![42]);
    close.expected_lease = active.lease_epoch;
    close.final_yrs_snapshot = Some(vec![42]);
    close.compacted_through_update_seq = Some(0);
    close.carrier_settlement = Some(CollabCarrierSettlement {
        auth: ctx.auth().clone(),
        carrier: input.carrier.clone(),
    });
    let settled = store.close_collab_session(&budget, close).await.unwrap();
    assert!(!settled.carrier_dirty);

    let next = store
        .update_space_schema(ctx.clone(), request(&input))
        .await
        .unwrap();
    let durable = store
        .read_collab_session(None, scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(durable.session.carrier_rev_id, next.value.note_revision);
    assert_eq!(
        durable.session.lineage_epoch,
        settled.lineage_epoch.checked_next().unwrap()
    );
    assert!(durable.session.yrs_snapshot_blob.is_none());
    assert!(durable.updates.is_empty());
    next
}
