use notarium_core::ids::{NoteId, RevisionId};
use notarium_syntax::content_digest;
use yrs::{encoding::write::Write, updates::encoder::Encode};

use super::*;

fn carrier(source: &str) -> (RoomCarrierState, String) {
    let (state, body) = RoomCarrierState::from_carrier(
        RevisionId::from_bytes([1; 16]),
        content_digest(source),
        source,
    )
    .unwrap();
    (state, body.to_owned())
}

fn note() -> NoteId {
    NoteId::from_bytes([2; 16])
}

fn author(twin: &TwinDoc) -> Replica {
    let replica = Replica::new_live(|id| twin.client_ids().contains(&id));
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
    let (carrier, _) = carrier(source);
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
    let (carrier, _) = carrier(source);
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
    let (carrier, _) = carrier(source);
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
    let (carrier, _) = carrier(source);
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
    let (carrier, body) = carrier("Проза");
    let mut twin = TwinDoc::seed(&body).unwrap();
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
    let (carrier, body) = carrier("---\nstatus: todo # comment\n---\nbody");
    let mut twin = TwinDoc::seed(&body).unwrap();
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
    let (carrier, body) = carrier("Проза 🚀");
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
    assert_eq!(twin.live_body(), body);
    assert_eq!(
        twin.live_overrides().unwrap().get("status"),
        Some(&AppliedFmEntry::Unset)
    );
}

#[test]
fn protected_and_locked_frontmatter_does_not_disable_typing() {
    let (carrier, body) = carrier("---\nstatus: &x todo\nother: *x\n---\nprose");
    assert!(!carrier.fm_writable);
    let mut twin = TwinDoc::seed(&body).unwrap();
    let actor = author(&twin);
    let bytes = edit(&actor, |txn| {
        actor.fields.insert(txn, "status", "done");
    });
    assert!(matches!(
        twin.stage_peer(&bytes, &carrier, &note()),
        Err(Reject::FrontmatterNotWritable)
    ));
    let (writable, _) = self::carrier("prose");
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
    let (carrier, body) = carrier("🚀a");
    let mut twin = TwinDoc::seed(&body).unwrap();
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
    assert_eq!(twin.staging_body(), body);

    // A continuation without any preceding client clocks is not a usable
    // state-vector diff for this room.
    let gap = [1, 1, 123, 1, 4, 1, 4, b'b', b'o', b'd', b'y', 1, b'a', 0];
    assert!(matches!(
        twin.stage_peer(&gap, &carrier, &note()),
        Err(Reject::PendingClockGap)
    ));
    assert_eq!(twin.live_body(), body);
}

#[test]
fn peer_update_rejects_dos_client_block_and_delete_caps() {
    let (carrier, body) = carrier("Base prose\n");
    let mut twin = TwinDoc::seed(&body).unwrap();

    // 1. Excessive distinct clients in a single peer update (> MAX_PEER_UPDATE_CLIENTS).
    let mut many_clients = Vec::new();
    let client_count = (update::MAX_PEER_UPDATE_CLIENTS + 1) as u32;
    many_clients.write_var(client_count);
    for k in 1..=client_count as u64 {
        many_clients.write_var(1_u32); // 1 block
        many_clients.write_var(k << 19); // colliding ClientID
        many_clients.write_var(0_u32); // clock 0
        many_clients.write_u8(0); // Block::GC
        many_clients.write_var(1_u32); // len 1
    }
    many_clients.write_var(0_u32);
    assert_eq!(
        twin.stage_peer(&many_clients, &carrier, &note())
            .unwrap_err(),
        Reject::MalformedUpdate
    );

    // 2. Excessive blocks in a single peer update (> MAX_PEER_UPDATE_BLOCKS).
    let mut many_blocks = Vec::new();
    let block_count = (update::MAX_PEER_UPDATE_BLOCKS + 1) as u32;
    many_blocks.write_var(1_u32);
    many_blocks.write_var(block_count);
    many_blocks.write_var(999_u64);
    many_blocks.write_var(0_u32);
    for _ in 0..block_count {
        many_blocks.write_u8(0); // Block::GC
        many_blocks.write_var(1_u32);
    }
    many_blocks.write_var(0_u32);
    assert_eq!(
        twin.stage_peer(&many_blocks, &carrier, &note())
            .unwrap_err(),
        Reject::MalformedUpdate
    );

    // 3. Excessive delete ranges in a single peer update (> MAX_PEER_UPDATE_DELETE_RANGES).
    let mut many_deletes = Vec::new();
    let del_count = (update::MAX_PEER_UPDATE_DELETE_RANGES + 1) as u32;
    many_deletes.write_var(0_u32);
    many_deletes.write_var(1_u32);
    many_deletes.write_var(999_u64);
    many_deletes.write_var(del_count);
    for i in 0..del_count {
        many_deletes.write_var(i * 2);
        many_deletes.write_var(1_u32);
    }
    assert_eq!(
        twin.stage_peer(&many_deletes, &carrier, &note())
            .unwrap_err(),
        Reject::MalformedUpdate
    );
}

#[test]
fn sequential_keystrokes_coalesce_without_run_fragmentation() {
    let source = "Start ";
    let (carrier, body) = carrier(source);
    let mut twin = TwinDoc::seed(&body).unwrap();
    let peer = author(&twin);
    let base = source.encode_utf16().count() as u32;
    for i in 0..10_000u32 {
        let ch = if i % 16 == 0 { " " } else { "a" };
        let bytes = edit(&peer, |txn| peer.body.insert(txn, base + i, ch));
        let (staged, path) = twin
            .stage_peer_with_path(&bytes, &carrier, &note(), false)
            .unwrap();
        assert_eq!(path, GuardPath::Ordinary);
        twin.publish(&staged.bytes).unwrap();
    }
    // 10k sequential units across PAGE_UNITS=1024 should coalesce into ~11 runs,
    // never 10,000 fragmented runs.
    assert!(
        twin.body.run_count() <= 20,
        "expected coalesced runs <= 20, got {}",
        twin.body.run_count()
    );
    assert_eq!(twin.live_body().len(), source.len() + 10_000);
}

#[test]
fn realistic_markdown_typing_stays_ordinary_and_matches_structural_oracle() {
    let source = concat!(
        "## Architecture (v1): notes\n",
        "\n",
        "- handle foo/bar (baz)\n",
        "- [x] write parser_tests\n",
        "> Important: keep [docs](https://example.com) and **bold**\n",
        "\n",
        "Inline `code` line stays conservative.\n",
        "\n",
        "```nota\n",
        "id: 0000000000000001\n",
        "type: table\n",
        "```\n",
        "\n",
        "Regular prose paragraph with Cyrillic (текст) and emoji 🚀.\n",
    );
    let (carrier, body) = carrier(source);
    let mut ordinary = TwinDoc::seed(&body).unwrap();
    let mut structural = TwinDoc::restore(&ordinary.live_snapshot()).unwrap();
    let peer = author(&ordinary);

    let targets = [
        ("notes", " [updated]"),
        ("foo/bar", " - extra: (1+2)"),
        ("parser_tests", "_v2"),
        ("**bold**", " & *italic*"),
        ("emoji 🚀", " 🦀/ok"),
    ];
    for (anchor, insertion) in targets {
        let current = peer.body.get_string(&peer.doc.transact());
        let byte_pos = current.find(anchor).unwrap() + anchor.len();
        let utf16_pos = current[..byte_pos].encode_utf16().count() as u32;
        let bytes = edit(&peer, |txn| peer.body.insert(txn, utf16_pos, insertion));
        let (ord_staged, ord_path) = ordinary
            .stage_peer_with_path(&bytes, &carrier, &note(), false)
            .unwrap();
        let (str_staged, str_path) = structural
            .stage_peer_with_path(&bytes, &carrier, &note(), true)
            .unwrap();
        assert_eq!(
            ord_path,
            GuardPath::Ordinary,
            "typing after {anchor:?} should stay on Ordinary path"
        );
        assert_eq!(str_path, GuardPath::Structural);
        ordinary.publish(&ord_staged.bytes).unwrap();
        structural.publish(&str_staged.bytes).unwrap();
        assert_eq!(ordinary.live_body(), structural.live_body());
    }
}

#[test]
fn frontmatter_only_edit_and_command_skip_body_index_rebuild() {
    let big_body = "Paragraph line for testing.\n".repeat(4000);
    let source = format!("---\nstatus: todo\n---\n{big_body}");
    let (carrier, body) = carrier(&source);
    let mut twin = TwinDoc::seed(&body).unwrap();
    let peer = author(&twin);

    let fm_update = edit(&peer, |txn| {
        peer.fields.insert(txn, "status", "done");
    });
    let before_runs = twin.body.run_count();
    let staged = twin.stage_peer(&fm_update, &carrier, &note()).unwrap();
    twin.publish(&staged.bytes).unwrap();
    assert_eq!(twin.body.run_count(), before_runs);
    assert_eq!(
        twin.live_overrides().unwrap().get("status"),
        Some(&AppliedFmEntry::Set(
            notarium_core::value::YamlValue::String("done".into())
        ))
    );

    // Integer frontmatter value matches existing Float(42.0) semantically without
    // writing a redundant CRDT update.
    let float_update = edit(&peer, |txn| {
        peer.fields
            .insert(txn, "count", Any::Number(yrs::Number::Float(42.0)));
    });
    let staged = twin.stage_peer(&float_update, &carrier, &note()).unwrap();
    twin.publish(&staged.bytes).unwrap();
    let int_delta = AppliedFm::from([(
        "count".into(),
        AppliedFmEntry::Set(notarium_core::value::YamlValue::Number(42_i64.into())),
    )]);
    let (cmd_bytes, _, _) = twin
        .stage_command(None, &int_delta, &carrier, &note())
        .unwrap();
    assert_eq!(cmd_bytes, EMPTY_UPDATE);
}

#[test]
fn batch_replay_and_single_replica_recovery_match_live_state() {
    let source = "---\nstatus: todo\n---\nInitial body.\n";
    let (carrier, body) = carrier(source);
    let mut live = TwinDoc::seed(&body).unwrap();
    let snapshot = live.live_snapshot();
    let peer = author(&live);
    let mut updates = Vec::new();
    for i in 0..64 {
        let raw = edit(&peer, |txn| {
            peer.body.push(txn, &format!("line {i}\n"));
            if i == 10 {
                peer.fields.insert(txn, "status", "active");
            }
        });
        let staged = live.stage_peer(&raw, &carrier, &note()).unwrap();
        live.publish(&staged.bytes).unwrap();
        updates.push(staged.bytes);
    }

    let mut replayed = TwinDoc::restore(&snapshot).unwrap();
    replayed.replay_batch(&updates).unwrap();
    assert_eq!(replayed.live_body(), live.live_body());
    assert_eq!(
        replayed.live_overrides().unwrap(),
        live.live_overrides().unwrap()
    );

    let refs: Vec<&[u8]> = updates.iter().map(Vec::as_slice).collect();
    let recovered = replay_for_recovery(&body, Some(&snapshot), &refs).unwrap();
    assert_eq!(recovered.final_body, live.live_body());
    assert_eq!(recovered.final_overrides, live.live_overrides().unwrap());
    let from_recovered = TwinDoc::restore(&recovered.final_snapshot).unwrap();
    assert_eq!(from_recovered.live_body(), live.live_body());
}

#[test]
fn adversarial_multiblock_surrogate_and_non_ascii_update_validates_in_linear_time() {
    use std::time::Instant;
    use yrs::{encoding::write::Write, updates::encoder::Encoder};

    let (carrier, body) = carrier("seed\n");
    let mut twin = TwinDoc::seed(&body).unwrap();
    let base_client = 9001u64;
    let payload_text: String = "🚀".repeat(200_000); // 800 KB UTF-8, 400_000 UTF-16 units
    let text_utf16_len = 400_000u32;

    // Craft a valid-structure update containing 1 large emoji block + 4095
    // anchored 1-unit blocks + 4096 delete ranges pointing near the tail of the
    // large block (previously O(B * L) quadratic UTF-16 scanning).
    let mut enc = yrs::updates::encoder::EncoderV1::new();
    enc.write_var(1u32); // 1 client
    enc.write_var(4096u32); // 4096 blocks (MAX_PEER_UPDATE_BLOCKS)
    enc.write_var(base_client);
    enc.write_var(0u32); // start clock 0
    // Block 0: root "body", tag 4 (String), no origins
    enc.write_u8(4);
    enc.write_var(1u32); // parent info = named root
    enc.write_string("body");
    enc.write_string(&payload_text);
    // Blocks 1..4096: anchored with left = (base_client, text_utf16_len - 1) (low surrogate - valid left!)
    // and right = None. Each inserts "a" (1 UTF-16 unit).
    for _ in 1..4096u32 {
        enc.write_u8(0x80 | 4); // ORIGIN | String
        enc.write_var(base_client);
        enc.write_var(text_utf16_len - 1);
        enc.write_string("a");
    }
    // Delete set: 1 client, 4096 non-overlapping 2-unit emoji ranges near the tail.
    enc.write_var(1u32);
    enc.write_var(base_client);
    enc.write_var(4096u32);
    let first_del = text_utf16_len - 4096 * 4;
    for i in 0..4096u32 {
        enc.write_var(first_del + i * 4);
        enc.write_var(2u32);
    }
    let raw = enc.to_vec();
    assert!(raw.len() < crate::wire::MAX_FRAME_BYTES);

    let start = Instant::now();
    let frame = update::inspect_peer(&raw, carrier.fm_writable).unwrap();
    let reserved = twin.client_ids();
    let evidence = twin
        .topology
        .prove(&frame, &twin.body, &reserved, Some(MAX_ROOM_CLIENTS))
        .unwrap();
    let elapsed = start.elapsed();
    assert!(evidence.touches_body);
    assert!(
        elapsed.as_millis() < 1500,
        "surrogate/anchor validation must stay linear (took {elapsed:?})"
    );

    // Splitting a surrogate pair via a bad delete boundary is still rejected.
    let mut bad = yrs::updates::encoder::EncoderV1::new();
    bad.write_var(1u32);
    bad.write_var(1u32);
    bad.write_var(base_client);
    bad.write_var(0u32);
    bad.write_u8(4);
    bad.write_var(1u32);
    bad.write_string("body");
    bad.write_string("🚀ok");
    bad.write_var(1u32);
    bad.write_var(base_client);
    bad.write_var(1u32);
    bad.write_var(1u32); // starts on low surrogate of 🚀
    bad.write_var(1u32);
    let bad_raw = bad.to_vec();
    assert_eq!(
        twin.stage_peer(&bad_raw, &carrier, &note()).unwrap_err(),
        Reject::InvalidBodyContent
    );
}

#[test]
fn consecutive_backspaces_then_retype_stay_on_ordinary_fast_path() {
    let source = "---\nstatus: todo\n---\nIntro paragraph with words.\n\n```nota\nid: v_0000000000000001\ntype: table\n```\n";
    let (carrier, body) = carrier(source);
    let mut twin = TwinDoc::seed(&body).unwrap();
    let peer = author(&twin);

    // Delete 5 consecutive single characters (chained tombstones) then retype.
    let mut pos = "Intro paragraph".encode_utf16().count() as u32;
    for _ in 0..5 {
        pos -= 1;
        let del = edit(&peer, |txn| peer.body.remove_range(txn, pos, 1));
        let (staged, path) = twin
            .stage_peer_with_path(&del, &carrier, &note(), false)
            .unwrap();
        assert_eq!(
            path,
            GuardPath::Ordinary,
            "single backspace must be Ordinary"
        );
        twin.publish(&staged.bytes).unwrap();
    }
    let retype = edit(&peer, |txn| peer.body.insert(txn, pos, "graph"));
    let (staged, path) = twin
        .stage_peer_with_path(&retype, &carrier, &note(), false)
        .unwrap();
    assert_eq!(
        path,
        GuardPath::Ordinary,
        "retyping after consecutive backspaces must stay Ordinary via chained deleted_anchors"
    );
    twin.publish(&staged.bytes).unwrap();
    assert_eq!(twin.live_body(), body);
}

mod differential_oracle {
    use proptest::prelude::*;

    use super::*;

    const SEED_LINES: &[&str] = &[
        "Plain paragraph with (parens) and foo/bar.",
        "## Heading: section (v1)",
        "- bullet item: alpha/beta",
        "- [x] task item_one",
        "> Blockquote: keep **bold** and *italic*",
        "See `inline` code here",
        "```nota\nid: 0000000000000001\ntype: table\n```",
        "```nota\ntype: board",
        "```",
        "<!-- html comment -->",
        "<pre>\nraw html\n</pre>",
        "<x>",
        "> a | b",
        "> --- | ---",
        "[a]:",
        "url bad",
        "===",
        "[ref]: https://example.com",
        "---",
        "Кириллица и эмодзи 🚀 🦀",
        "",
    ];

    const INSERT_SNIPPETS: &[&str] = &[
        "a",
        "Z",
        " ",
        " (v2): foo/bar-baz",
        "🚀",
        "🦀",
        "!",
        "-",
        "|",
        "=",
        "#",
        ">",
        "<",
        "[",
        "`",
        "```",
        "~",
        "\n",
        "\r\n",
        "\n```\n",
        "---\n",
    ];

    #[derive(Clone, Debug)]
    enum Step {
        Insert {
            pos_seed: u16,
            snippet_idx: usize,
        },
        Delete {
            pos_seed: u16,
            len: u8,
        },
        Replace {
            pos_seed: u16,
            len: u8,
            snippet_idx: usize,
        },
    }

    fn step_strategy() -> impl Strategy<Value = Step> {
        prop_oneof![
            (any::<u16>(), 0..INSERT_SNIPPETS.len()).prop_map(|(pos_seed, snippet_idx)| {
                Step::Insert {
                    pos_seed,
                    snippet_idx,
                }
            }),
            (any::<u16>(), 1..=6u8).prop_map(|(pos_seed, len)| Step::Delete { pos_seed, len }),
            (any::<u16>(), 1..=4u8, 0..INSERT_SNIPPETS.len()).prop_map(
                |(pos_seed, len, snippet_idx)| Step::Replace {
                    pos_seed,
                    len,
                    snippet_idx,
                }
            ),
        ]
    }

    fn char_boundaries_utf16(text: &str) -> Vec<u32> {
        let mut offsets = Vec::with_capacity(text.len() + 1);
        let mut acc = 0u32;
        offsets.push(0);
        for ch in text.chars() {
            acc += ch.len_utf16() as u32;
            offsets.push(acc);
        }
        offsets
    }

    #[test]
    fn block_boundary_counterexamples_take_structural_and_finalize_nota() {
        // Counterexample A (GFM table + lazy blockquote + HTML type 7 + nota, LF and CRLF).
        for eol in ["\n", "\r\n"] {
            let body =
                format!("> a | b{eol}> --- | ---{eol}<x>{eol}```nota{eol}type: table{eol}```{eol}");
            let source = format!("---{eol}status: todo{eol}---{eol}{body}");
            let (carrier, body_slice) = carrier(&source);
            let mut fast = TwinDoc::seed(&body_slice).unwrap();
            let mut oracle = TwinDoc::restore(&fast.live_snapshot()).unwrap();
            let peer = author(&fast);
            let pipe_offset = body_slice.find('|').unwrap() as u32;
            let bytes = edit(&peer, |txn| peer.body.remove_range(txn, pipe_offset, 1));
            let (f_upd, f_path) = fast
                .stage_peer_with_path(&bytes, &carrier, &note(), false)
                .unwrap();
            let (o_upd, _) = oracle
                .stage_peer_with_path(&bytes, &carrier, &note(), true)
                .unwrap();
            assert_eq!(f_path, GuardPath::Structural);
            assert_eq!(fast.staging_body(), oracle.staging_body());
            assert!(
                fast.staging_body().contains("\"id\": \"v_"),
                "counterexample A (eol={eol:?}) did not finalize nota:\n{}",
                fast.staging_body()
            );
            fast.publish(&f_upd.bytes).unwrap();
            oracle.publish(&o_upd.bytes).unwrap();
            assert_eq!(fast.live_body(), oracle.live_body());
        }

        // Counterexample B (Link RefDef + Setext === + HTML type 7 + nota).
        let body = "[a]:\nurl bad\n===\n<x>\n```nota\ntype: table\n```\n";
        let source = format!("---\nstatus: todo\n---\n{body}");
        let (carrier, body_slice) = carrier(&source);
        let mut fast = TwinDoc::seed(&body_slice).unwrap();
        let mut oracle = TwinDoc::restore(&fast.live_snapshot()).unwrap();
        let peer = author(&fast);
        let bad_offset = body_slice.find(" bad").unwrap() as u32;
        let bytes = edit(&peer, |txn| peer.body.remove_range(txn, bad_offset, 4));
        let (f_upd, f_path) = fast
            .stage_peer_with_path(&bytes, &carrier, &note(), false)
            .unwrap();
        let (o_upd, _) = oracle
            .stage_peer_with_path(&bytes, &carrier, &note(), true)
            .unwrap();
        assert_eq!(f_path, GuardPath::Structural);
        assert_eq!(fast.staging_body(), oracle.staging_body());
        assert!(
            fast.staging_body().contains("\"id\": \"v_"),
            "counterexample B did not finalize nota:\n{}",
            fast.staging_body()
        );
        fast.publish(&f_upd.bytes).unwrap();
        oracle.publish(&o_upd.bytes).unwrap();
        assert_eq!(fast.live_body(), oracle.live_body());
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 64,
            failure_persistence: None,
            ..ProptestConfig::default()
        })]

        #[test]
        fn ordinary_guard_matches_structural_oracle_on_random_markdown(
            line_indices in prop::collection::vec(0..SEED_LINES.len(), 2..8),
            steps in prop::collection::vec(step_strategy(), 1..16),
        ) {
            let mut body_text = line_indices
                .iter()
                .map(|&i| SEED_LINES[i])
                .collect::<Vec<_>>()
                .join("\n");
            body_text.push('\n');
            // Canonical note heads are always finalized before a room opens.
            let initial_source = format!("---\nstatus: todo\n---\n{body_text}");
            let (initial_carrier, initial_body) = carrier(&initial_source);
            let identity =
                notarium_canonical::CanonicalStore::derive_carrier_identities(&initial_carrier.carrier_rev_id).0;
            if let Ok(Some(plan)) = crate::carrier::finalize_nota_body(
                &initial_carrier,
                &initial_body,
                &AppliedFm::new(),
                &note(),
                identity,
            ) {
                let finalized_doc = TwinDoc::seed(&initial_body).unwrap();
                let mut txn = finalized_doc.staging.doc.transact_mut();
                apply_splices(&finalized_doc.staging.body, &mut txn, &plan);
                txn.commit();
                body_text = finalized_doc.staging.body.get_string(&txn);
            }
            let source = format!("---\nstatus: todo\n---\n{body_text}");
            let (carrier, body) = carrier(&source);
            let mut fast = TwinDoc::seed(&body).unwrap();
            let mut oracle = TwinDoc::restore(&fast.live_snapshot()).unwrap();
            let peer = author(&fast);

            for step in steps {
                let current = peer.body.get_string(&peer.doc.transact());
                let boundaries = char_boundaries_utf16(&current);
                let max_idx = boundaries.len() - 1;
                let bytes = match step {
                    Step::Insert { pos_seed, snippet_idx } => {
                        let idx = (pos_seed as usize) % (max_idx + 1);
                        let pos = boundaries[idx];
                        let text = INSERT_SNIPPETS[snippet_idx];
                        edit(&peer, |txn| peer.body.insert(txn, pos, text))
                    }
                    Step::Delete { pos_seed, len } => {
                        if max_idx == 0 {
                            continue;
                        }
                        let start_idx = (pos_seed as usize) % max_idx;
                        let end_idx = (start_idx + len as usize).min(max_idx);
                        let start = boundaries[start_idx];
                        let count = boundaries[end_idx] - start;
                        edit(&peer, |txn| peer.body.remove_range(txn, start, count))
                    }
                    Step::Replace { pos_seed, len, snippet_idx } => {
                        if max_idx == 0 {
                            continue;
                        }
                        let start_idx = (pos_seed as usize) % max_idx;
                        let end_idx = (start_idx + len as usize).min(max_idx);
                        let start = boundaries[start_idx];
                        let count = boundaries[end_idx] - start;
                        let text = INSERT_SNIPPETS[snippet_idx];
                        edit(&peer, |txn| {
                            peer.body.remove_range(txn, start, count);
                            peer.body.insert(txn, start, text);
                        })
                    }
                };
                let fast_res = fast.stage_peer_with_path(&bytes, &carrier, &note(), false);
                let oracle_res = oracle.stage_peer_with_path(&bytes, &carrier, &note(), true);
                prop_assert_eq!(fast_res.is_ok(), oracle_res.is_ok());
                if let (Ok((f_upd, _)), Ok((o_upd, _))) = (fast_res, oracle_res) {
                    prop_assert_eq!(fast.staging_body(), oracle.staging_body());
                    fast.publish(&f_upd.bytes).unwrap();
                    oracle.publish(&o_upd.bytes).unwrap();
                    peer.apply(&f_upd.bytes).unwrap();
                    prop_assert_eq!(fast.live_body(), oracle.live_body());
                    prop_assert_eq!(
                        peer.body.get_string(&peer.doc.transact()),
                        oracle.live_body()
                    );
                    // When server-side nota finalization injected IDs under
                    // each replica's independent random ClientID, resync the
                    // oracle's CRDT history from `fast` so subsequent peer
                    // edits anchored to server-inserted IDs stay causally valid.
                    if f_upd.bytes != bytes {
                        oracle = TwinDoc::restore(&fast.live_snapshot()).unwrap();
                    }
                } else {
                    fast.reset_staging::<&[u8]>(&[]).unwrap();
                    oracle.reset_staging::<&[u8]>(&[]).unwrap();
                    break;
                }
            }
        }

        #[test]
        fn two_peer_cross_page_edits_match_structural_oracle(
            steps in prop::collection::vec((any::<bool>(), step_strategy()), 1..20),
        ) {
            // Seed a >PAGE_UNITS (1024 UTF-16 units) document with a nota fence so
            // page-boundary splits/merges and multi-peer interleaving are exercised.
            let mut body_text = String::from("Alpha prose line.\n");
            for i in 0..40 {
                body_text.push_str(&format!("Paragraph line {i:02} with 🚀 emoji and words.\n"));
            }
            body_text.push_str("\n```nota\nid: v_0000000000000099\ntype: table\n```\n");
            let source = format!("---\nstatus: todo\n---\n{body_text}");
            let (carrier, body) = carrier(&source);
            let mut fast = TwinDoc::seed(&body).unwrap();
            let mut oracle = TwinDoc::restore(&fast.live_snapshot()).unwrap();
            let peer_a = author(&fast);
            let peer_b = Replica::new_live(|id| {
                fast.client_ids().contains(&id) || id == peer_a.doc.client_id()
            });
            peer_b.apply(&fast.live_snapshot()).unwrap();

            for (use_b, step) in steps {
                let active = if use_b { &peer_b } else { &peer_a };
                let other = if use_b { &peer_a } else { &peer_b };
                let current = active.body.get_string(&active.doc.transact());
                let boundaries = char_boundaries_utf16(&current);
                let max_idx = boundaries.len() - 1;
                let bytes = match step {
                    Step::Insert { pos_seed, snippet_idx } => {
                        let idx = (pos_seed as usize) % (max_idx + 1);
                        let pos = boundaries[idx];
                        edit(active, |txn| active.body.insert(txn, pos, INSERT_SNIPPETS[snippet_idx]))
                    }
                    Step::Delete { pos_seed, len } => {
                        if max_idx == 0 {
                            continue;
                        }
                        let start_idx = (pos_seed as usize) % max_idx;
                        let end_idx = (start_idx + len as usize).min(max_idx);
                        let start = boundaries[start_idx];
                        let count = boundaries[end_idx] - start;
                        edit(active, |txn| active.body.remove_range(txn, start, count))
                    }
                    Step::Replace { pos_seed, len, snippet_idx } => {
                        if max_idx == 0 {
                            continue;
                        }
                        let start_idx = (pos_seed as usize) % max_idx;
                        let end_idx = (start_idx + len as usize).min(max_idx);
                        let start = boundaries[start_idx];
                        let count = boundaries[end_idx] - start;
                        edit(active, |txn| {
                            active.body.remove_range(txn, start, count);
                            active.body.insert(txn, start, INSERT_SNIPPETS[snippet_idx]);
                        })
                    }
                };
                let fast_res = fast.stage_peer_with_path(&bytes, &carrier, &note(), false);
                let oracle_res = oracle.stage_peer_with_path(&bytes, &carrier, &note(), true);
                prop_assert_eq!(fast_res.is_ok(), oracle_res.is_ok());
                if let (Ok((f_upd, _)), Ok((o_upd, _))) = (fast_res, oracle_res) {
                    prop_assert_eq!(fast.staging_body(), oracle.staging_body());
                    fast.publish(&f_upd.bytes).unwrap();
                    oracle.publish(&o_upd.bytes).unwrap();
                    active.apply(&f_upd.bytes).unwrap();
                    other.apply(&f_upd.bytes).unwrap();
                    prop_assert_eq!(fast.live_body(), oracle.live_body());
                    if f_upd.bytes != bytes {
                        oracle = TwinDoc::restore(&fast.live_snapshot()).unwrap();
                    }
                } else {
                    fast.reset_staging::<&[u8]>(&[]).unwrap();
                    oracle.reset_staging::<&[u8]>(&[]).unwrap();
                    break;
                }
            }
        }
    }
}
