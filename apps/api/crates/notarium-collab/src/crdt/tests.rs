use notarium_core::ids::{NoteId, RevisionId};
use notarium_syntax::content_digest;
use yrs::{encoding::write::Write, updates::encoder::Encode};

use super::*;

fn carrier(source: &str) -> RoomCarrierState {
    RoomCarrierState::new(
        RevisionId::from_bytes([1; 16]),
        content_digest(source),
        source.to_owned(),
    )
    .unwrap()
}

fn note() -> NoteId {
    NoteId::from_bytes([2; 16])
}

fn author(twin: &TwinDoc) -> Replica {
    let replica = Replica::new(|id| twin.client_ids().contains(&id));
    replica.apply(&twin.live_snapshot()).unwrap();
    replica
}

fn edit(replica: &Replica, run: impl FnOnce(&mut TransactionMut<'_>)) -> Vec<u8> {
    let mut txn = replica.doc.transact_mut();
    run(&mut txn);
    txn.commit();
    txn.encode_update_v1()
}

#[test]
fn ordinary_unicode_uses_local_proof_and_matches_structural_oracle() {
    let source = "Обычная проза 🚀 здесь";
    let carrier = carrier(source);
    let ordinary = TwinDoc::seed(source).unwrap();
    let mut structural = TwinDoc::restore(&ordinary.live_snapshot()).unwrap();
    let mut ordinary = ordinary;
    let peer = author(&ordinary);
    let added = edit(&peer, |txn| peer.body.insert(txn, 13, "🦀"));
    let removed = edit(&peer, |txn| peer.body.remove_range(txn, 13, 2));

    for bytes in [&added, &removed] {
        let (update, path) = ordinary
            .stage_peer_with_path(bytes, &carrier, &note(), false)
            .unwrap();
        let (oracle, oracle_path) = structural
            .stage_peer_with_path(bytes, &carrier, &note(), true)
            .unwrap();
        assert_eq!(path, GuardPath::Ordinary);
        assert_eq!(oracle_path, GuardPath::Structural);
        assert_eq!(ordinary.staging_body(), structural.staging_body());
        ordinary.publish(&update.bytes).unwrap();
        structural.publish(&oracle.bytes).unwrap();
        assert_eq!(ordinary.live_body(), structural.live_body());
    }
    assert_eq!(ordinary.live_body(), source);
}

#[test]
fn ordinary_edit_before_after_and_beside_a_nota_stays_local() {
    let source = "English prose\n\n```nota\nid: 0000000000000001\n```\n\nПростой абзац";
    let carrier = carrier(source);
    let mut twin = TwinDoc::seed(source).unwrap();
    let peer = author(&twin);
    for index in [Some(0), Some(4), None] {
        let index = index.unwrap_or_else(|| peer.body.len(&peer.doc.transact()));
        let bytes = edit(&peer, |txn| peer.body.insert(txn, index, "🚀"));
        let (update, path) = twin
            .stage_peer_with_path(&bytes, &carrier, &note(), false)
            .unwrap();
        assert_eq!(path, GuardPath::Ordinary);
        twin.publish(&update.bytes).unwrap();
    }
    assert_eq!(twin.live_body(), peer.body.get_string(&peer.doc.transact()));
}

#[test]
fn an_ordinary_replacement_shares_the_deleted_ranges_visible_gap() {
    let source = "left prose\n\n```nota\nid: 0000000000000001\n```\n";
    let carrier = carrier(source);
    let mut twin = TwinDoc::seed(source).unwrap();
    let peer = author(&twin);
    for replacement in ["L", "Л", "🚀", "l"] {
        let existing = peer.body.get_string(&peer.doc.transact());
        let units = existing.chars().next().unwrap().len_utf16() as u32;
        let bytes = edit(&peer, |txn| {
            peer.body.remove_range(txn, 0, units);
            peer.body.insert(txn, 0, replacement);
        });
        let (staged, path) = twin
            .stage_peer_with_path(&bytes, &carrier, &note(), false)
            .unwrap();
        assert_eq!(path, GuardPath::Ordinary);
        twin.publish(&staged.bytes).unwrap();
        assert_eq!(twin.live_body(), peer.body.get_string(&peer.doc.transact()));
    }
}

#[test]
fn finishing_a_nota_produces_exactly_one_identity_before_publish_and_replay() {
    let source = "Prose\n\n```nota\nname: Inbox\n";
    let carrier = carrier(source);
    let mut twin = TwinDoc::seed(source).unwrap();
    let mut restored = TwinDoc::restore(&twin.live_snapshot()).unwrap();
    let peer = author(&twin);
    let bytes = edit(&peer, |txn| peer.body.push(txn, "```\n"));
    let (staged, path) = twin
        .stage_peer_with_path(&bytes, &carrier, &note(), false)
        .unwrap();

    assert_eq!(path, GuardPath::Structural);
    assert_eq!(twin.live_body(), source);
    let staged_body = twin.staging_body();
    let scan = notarium_syntax::carrier::Carrier::scan(&staged_body).unwrap();
    let markdown = notarium_syntax::markdown::analyze(&staged_body, scan.body).unwrap();
    let analysis =
        notarium_syntax::nota::analyze(&staged_body, scan.body, &note(), &markdown, false).unwrap();
    assert_eq!(analysis.blocks.len(), 1);
    assert_eq!(
        analysis.blocks[0].state,
        notarium_core::document::ViewState::Ready
    );
    assert!(analysis.blocks[0].id.is_some());
    assert_ne!(staged.bytes, bytes);
    twin.publish(&staged.bytes).unwrap();
    restored.replay(&staged.bytes).unwrap();
    peer.apply(&staged.bytes).unwrap();
    assert_eq!(restored.live_body(), twin.live_body());
    assert_eq!(
        restored.staging_overrides().unwrap(),
        twin.live_overrides().unwrap()
    );
    assert_eq!(peer.body.get_string(&peer.doc.transact()), twin.live_body());
}

#[test]
fn rejects_policy_mutations_and_replays_the_accepted_prefix() {
    let carrier = carrier("Проза");
    let mut twin = TwinDoc::seed(carrier.body()).unwrap();
    let writer = author(&twin);
    let offending = author(&twin);
    let first = edit(&writer, |txn| writer.body.push(txn, "🚀"));
    let first = twin.stage_peer(&first, &carrier, &note()).unwrap();
    let invalid = edit(&offending, |txn| {
        offending.fields.insert(txn, "draft", "temporary");
        offending.fields.remove(txn, "draft");
    });
    assert!(matches!(
        twin.stage_peer(&invalid, &carrier, &note()),
        Err(Reject::FrontmatterKeyDeleted)
    ));
    assert_eq!(twin.live_body(), "Проза");
    twin.reset_staging(&[&first.bytes]).unwrap();

    let dependent = edit(&writer, |txn| writer.body.push(txn, "ok"));
    let accepted = twin.stage_peer(&dependent, &carrier, &note()).unwrap();
    twin.publish(&first.bytes).unwrap();
    twin.publish(&accepted.bytes).unwrap();
    assert_eq!(twin.live_body(), "Проза🚀ok");
    assert!(twin.live_overrides().unwrap().is_empty());
}

#[test]
fn gc_compacted_multi_set_and_explicit_unset_preserve_the_map_domain() {
    let carrier = carrier("---\nstatus: todo # comment\n---\nbody");
    let mut twin = TwinDoc::seed(carrier.body()).unwrap();
    let peer = author(&twin);
    edit(&peer, |txn| {
        peer.fields.insert(txn, "status", "todo");
        peer.fields.insert(txn, "status", "done");
    });
    // Full state sent by an offline peer includes the GC'd old map value.
    let bytes = peer
        .doc
        .transact()
        .encode_state_as_update_v1(&twin.live_state_vector());
    let staged = twin.stage_peer(&bytes, &carrier, &note()).unwrap();
    twin.publish(&staged.bytes).unwrap();
    let fm = twin.live_overrides().unwrap();
    assert_eq!(
        carrier.materialize(&twin.live_body(), &fm).unwrap(),
        "---\nstatus: done # comment\n---\nbody"
    );

    let bytes = edit(&peer, |txn| {
        peer.fields
            .insert(txn, "status", AppliedFmEntry::Unset.to_any().unwrap());
    });
    let staged = twin.stage_peer(&bytes, &carrier, &note()).unwrap();
    twin.publish(&staged.bytes).unwrap();
    assert_eq!(
        twin.live_overrides().unwrap().get("status"),
        Some(&AppliedFmEntry::Unset)
    );
}

#[test]
fn integrates_yjs_utf16_and_frontmatter_updates() {
    // Yjs 13.6.27 v1 updates from two documents, with client IDs 10 and 20.
    // The writer inserts and removes a surrogate pair, then uses an offline
    // batched map replacement and the unset sentinel.
    let messages = [
        "01010a00040104626f64790fd09fd180d0bed0b7d0b020f09f9a8000",
        "01011400c40a050a0604f09fa68000",
        "000114010002",
        "0102140221010c666d5f6f76657272696465730673746174757301a81402017704646f6e650114010201",
        "01011404a814030176010624756e736574780114010301",
    ]
    .map(|value| hex::decode(value).unwrap());
    let carrier = carrier("Проза 🚀");
    let mut twin = TwinDoc::restore(&messages[0]).unwrap();
    for (index, bytes) in messages[1..].iter().enumerate() {
        let (staged, path) = twin
            .stage_peer_with_path(bytes, &carrier, &note(), false)
            .unwrap();
        assert_eq!(path == GuardPath::Ordinary, index < 2);
        twin.publish(&staged.bytes).unwrap();
        if index == 0 {
            assert_eq!(twin.live_body(), "Проза 🦀🚀");
        }
    }
    assert_eq!(twin.live_body(), carrier.body());
    assert_eq!(
        twin.live_overrides().unwrap().get("status"),
        Some(&AppliedFmEntry::Unset)
    );
}

#[test]
fn protected_and_locked_frontmatter_does_not_disable_typing() {
    let carrier = carrier("---\nstatus: &x todo\nother: *x\n---\nprose");
    assert!(!carrier.fm_writable);
    let mut twin = TwinDoc::seed(carrier.body()).unwrap();
    let actor = author(&twin);
    let bytes = edit(&actor, |txn| {
        actor.fields.insert(txn, "status", "done");
    });
    assert!(matches!(
        twin.stage_peer(&bytes, &carrier, &note()),
        Err(Reject::FrontmatterNotWritable)
    ));
    let writable = self::carrier("prose");
    let actor = author(&twin);
    let bytes = edit(&actor, |txn| {
        actor.fields.insert(txn, "class", "skill");
    });
    assert!(matches!(
        twin.stage_peer(&bytes, &writable, &note()),
        Err(Reject::ProtectedFrontmatterKey)
    ));
    let actor = author(&twin);
    let bytes = edit(&actor, |txn| actor.body.push(txn, "!"));
    assert!(twin.stage_peer(&bytes, &carrier, &note()).is_ok());
}

#[test]
fn structural_and_surrogate_guards_reject_before_publication() {
    let carrier = carrier("🚀a");
    let mut twin = TwinDoc::seed(carrier.body()).unwrap();
    let mut state = twin.live_state_vector().encode_v1();
    assert!(!state.is_empty());
    let seed = *twin.live_state_vector().iter().next().unwrap().0;
    let writer = ClientID::new(123);

    // One string struct with a left origin inside the surrogate pair.
    state.clear();
    state.write_var(1_u32);
    state.write_var(1_u32);
    state.write_var(writer.get());
    state.write_var(0_u32);
    state.write_u8(0x84);
    state.write_var(seed.get());
    state.write_var(0_u32);
    state.write_string("!");
    state.write_var(0_u32);
    assert!(matches!(
        twin.stage_peer(&state, &carrier, &note()),
        Err(Reject::InvalidBodyContent)
    ));
    assert_eq!(twin.staging_body(), carrier.body());

    // A continuation without any preceding client clocks is not a usable
    // state-vector diff for this room.
    let gap = [1, 1, 123, 1, 4, 1, 4, b'b', b'o', b'd', b'y', 1, b'a', 0];
    assert!(matches!(
        twin.stage_peer(&gap, &carrier, &note()),
        Err(Reject::PendingClockGap)
    ));
    assert_eq!(twin.live_body(), carrier.body());
}
