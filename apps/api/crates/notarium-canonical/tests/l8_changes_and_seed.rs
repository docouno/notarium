mod support;

use std::collections::BTreeMap;

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec, S3BucketModePolicy,
    blobs::s3::admin_ensure_bucket,
    changes::{EFFECT_CODEC_V1, EffectEnvelopeV1, SyntheticNoteSpec},
    codec::EFFECT_PAYLOAD_BUDGET_BYTES,
};
use notarium_core::{
    auth::SpaceKind,
    classes::DocClass,
    error::{Diagnostic, ValidationReason},
    ids::{ChatThreadId, HistoryIncarnation, LeaseEpoch, NoteId, SpaceSeq},
    model::Lifecycle,
    ports::{
        ChangeBroadcast, ChangeKind, ChangeNotice, ChangeRead, ChangeReadResult, PageLimit,
        SeedPosition, ServicePurpose,
    },
    query::{FieldObservation, FieldValue},
    receipt::{
        AwaitReason, ChangeCursor, MutationEffect, MutationReceiptToken, OverlayDecision,
        ReceiptSet, plan_overlay,
    },
    value::{Date, ExactNumber, ScalarValue, Timestamp},
};

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_principal_id, sample_space_id,
};

fn note_id_seq(seed: u8, idx: u16) -> NoteId {
    let mut b = [0u8; 16];
    b[0] = seed;
    b[14..16].copy_from_slice(&idx.to_be_bytes());
    NoteId::from_bytes(b)
}

fn thread_id_seq(seed: u8, idx: u16) -> ChatThreadId {
    let mut b = [0u8; 16];
    b[0] = seed;
    b[14..16].copy_from_slice(&idx.to_be_bytes());
    ChatThreadId::from_bytes(b)
}

async fn run_changes_and_seed_suite(store: &CanonicalStore, seed: u8) {
    let epoch = LeaseEpoch::new(1).unwrap();
    let actor = sample_principal_id(seed);

    // -------------------------------------------------------------------------
    // Part 1: Multi-event atomic command (101..=102), InvalidCutoff, safe_ack_end,
    //         EffectV1 budgets (<=8 notes, >8 notes, >64KiB), and PurgeResync.
    // -------------------------------------------------------------------------
    let s1 = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed),
            incarnation: sample_incarnation(seed),
            root_folder_id: sample_folder_id(seed),
            slug: format!("l8-log-space-{seed}"),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space 1");
    let scope1 = s1.scope.clone();

    // Advance Space 1 cleanly to seq 100 so our multi-note atomic command lands literally on 101..=102!
    store
        .fast_forward_space_to_seq_for_test(&scope1, epoch, SpaceSeq::new(100).unwrap())
        .await
        .expect("fast-forward to seq 100");

    let mut sub_at_100 = store
        .subscribe(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeCursor {
                scope: scope1.clone(),
                after: SpaceSeq::new(100).unwrap(),
            },
        )
        .await
        .expect("subscribe at 100");

    // Rich typed field observations (Null, Absent, Bad, Number, Date, Timestamp) for lossless EffectV1 check.
    let mut rich_fields = BTreeMap::new();
    rich_fields.insert(
        "null_field".to_owned(),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Null)),
    );
    rich_fields.insert("absent_field".to_owned(), FieldObservation::Absent);
    rich_fields.insert(
        "bad_field".to_owned(),
        FieldObservation::Bad {
            diagnostic: Diagnostic {
                reason: ValidationReason::InvalidNumber,
                location: None,
            },
        },
    );
    rich_fields.insert(
        "num_field".to_owned(),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Number(
            ExactNumber::from_f64(42.5).unwrap(),
        ))),
    );
    rich_fields.insert(
        "date_field".to_owned(),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Date(
            Date::parse("2026-11-15").unwrap(),
        ))),
    );
    rich_fields.insert(
        "ts_field".to_owned(),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Timestamp(
            Timestamp::from_unix_parts(1_794_761_700, 123_456_789).unwrap(),
        ))),
    );

    let note_a = note_id_seq(seed, 1);
    let note_b = note_id_seq(seed, 2);
    let (range_ab, pairs_ab) = store
        .commit_synthetic_note_batch_for_test(
            &scope1,
            epoch,
            &actor,
            vec![
                SyntheticNoteSpec {
                    note_id: note_a.clone(),
                    parent_folder: None,
                    slug: "note-a".to_owned(),
                    title: "Note A".to_owned(),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: "# Note A\nBody A".to_owned(),
                    fields: rich_fields.clone(),
                },
                SyntheticNoteSpec {
                    note_id: note_b.clone(),
                    parent_folder: None,
                    slug: "note-b".to_owned(),
                    title: "Note B".to_owned(),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: "# Note B\nBody B".to_owned(),
                    fields: BTreeMap::new(),
                },
            ],
        )
        .await
        .expect("commit atomic 2-note command on 101..=102");

    assert_eq!(range_ab.first_seq.get(), 101);
    assert_eq!(range_ab.last_seq.get(), 102);

    // Confirm broadcast hint arrived at 102 AFTER commit!
    let adv_102 = sub_at_100.next().await.expect("next").expect("some notice");
    match adv_102 {
        ChangeNotice::Advanced(cur) => assert_eq!(cur.after.get(), 102),
        other => panic!("expected Advanced(102), got {other:?}"),
    }

    // Mid-command cutoff 101 MUST fail with InvalidCutoff everywhere (no silent rounding!).
    let mid_seed_res = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Seed {
                scope: scope1.clone(),
                cutoff: Some(SpaceSeq::new(101).unwrap()),
                limit: PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert_validation_err(&mid_seed_res, ValidationReason::InvalidCutoff);

    let mid_log_res = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope1.clone(),
                    after: SpaceSeq::new(100).unwrap(),
                },
                through: SpaceSeq::new(101).unwrap(),
                limit: PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert_validation_err(&mid_log_res, ValidationReason::InvalidCutoff);

    let mid_point_res = store
        .read_entity_revision_at_cutoff(
            &scope1,
            "note",
            note_a.as_str(),
            Some(SpaceSeq::new(101).unwrap()),
        )
        .await;
    assert_validation_err(&mid_point_res, ValidationReason::InvalidCutoff);

    // Cutoff 102 returns BOTH versions A and B!
    let rev_a_102 = store
        .read_entity_revision_at_cutoff(
            &scope1,
            "note",
            note_a.as_str(),
            Some(SpaceSeq::new(102).unwrap()),
        )
        .await
        .expect("point read A at 102")
        .expect("A exists at 102");
    let rev_b_102 = store
        .read_entity_revision_at_cutoff(
            &scope1,
            "note",
            note_b.as_str(),
            Some(SpaceSeq::new(102).unwrap()),
        )
        .await
        .expect("point read B at 102")
        .expect("B exists at 102");
    assert_eq!(rev_a_102.revision_id, pairs_ab[0].1);
    assert_eq!(rev_b_102.revision_id, pairs_ab[1].1);

    // Log PageLimit=1 across 101..=102:
    // Page 1 returns seq 101 with `safe_ack_end = 100` (NOT 101!); ack(101) is rejected;
    // Page 2 returns seq 102 with `safe_ack_end = 102`, `complete = true`; ack(102) succeeds!
    let page1 = match store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope1.clone(),
                    after: SpaceSeq::new(100).unwrap(),
                },
                through: SpaceSeq::new(102).unwrap(),
                limit: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .expect("log page 1")
    {
        ChangeReadResult::Log(p) => p,
        other => panic!("expected Log page, got {other:?}"),
    };
    assert_eq!(page1.changes.len(), 1);
    assert_eq!(page1.changes[0].cursor.after.get(), 101);
    assert_eq!(page1.changes[0].command_range, range_ab);
    assert_eq!(page1.next.after.get(), 101);
    assert_eq!(
        page1.safe_ack_end.get(),
        100,
        "incomplete command page must hold safe_ack_end at prior complete command (100)"
    );
    assert!(!page1.complete);

    let bad_mid_ack = sub_at_100
        .acknowledge(ChangeCursor {
            scope: scope1.clone(),
            after: SpaceSeq::new(101).unwrap(),
        })
        .await;
    assert_validation_err(&bad_mid_ack, ValidationReason::InvalidCutoff);

    let page2 = match store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: page1.next.clone(),
                through: SpaceSeq::new(102).unwrap(),
                limit: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .expect("log page 2")
    {
        ChangeReadResult::Log(p) => p,
        other => panic!("expected Log page, got {other:?}"),
    };
    assert_eq!(page2.changes.len(), 1);
    assert_eq!(page2.changes[0].cursor.after.get(), 102);
    assert_eq!(page2.changes[0].command_range, range_ab);
    assert_eq!(page2.safe_ack_end.get(), 102);
    assert!(page2.complete);

    match &page2.changes[0].effect {
        MutationEffect::Notes {
            versions,
            payload_bytes,
        } => {
            assert_eq!(versions.len(), 2);
            assert!(*payload_bytes > 0 && *payload_bytes <= EFFECT_PAYLOAD_BUDGET_BYTES);
        }
        other => panic!("expected bounded MutationEffect::Notes, got {other:?}"),
    }

    sub_at_100
        .acknowledge(ChangeCursor {
            scope: scope1.clone(),
            after: page2.safe_ack_end,
        })
        .await
        .expect("acknowledge complete command-end 102");
    assert_eq!(sub_at_100.processed().after.get(), 102);

    // Causal overlay resolution for receipt at 102 -> Bounded(2 notes).
    let rcpt_102 = MutationReceiptToken::new(scope1.clone(), SpaceSeq::new(102).unwrap()).unwrap();
    let rset_102 = ReceiptSet::new([rcpt_102]).unwrap();
    let trusted_102 = store
        .resolve_receipt_effects(&scope1, &rset_102)
        .await
        .expect("resolve receipt effects");
    let decision_102 = plan_overlay(
        &scope1,
        SpaceSeq::new(100).unwrap(),
        &rset_102,
        &trusted_102,
        EFFECT_PAYLOAD_BUDGET_BYTES,
    )
    .expect("plan overlay");
    match decision_102 {
        OverlayDecision::Bounded { versions } => assert_eq!(versions.len(), 2),
        other => panic!("expected Bounded overlay for 2-note command, got {other:?}"),
    }

    // >8 distinct notes (9 notes) -> AwaitProjection(TooManyNotes)!
    let mut nine_specs = Vec::with_capacity(9);
    for idx in 10..19u16 {
        nine_specs.push(SyntheticNoteSpec {
            note_id: note_id_seq(seed, idx),
            parent_folder: None,
            slug: format!("nine-{idx}"),
            title: format!("Nine {idx}"),
            doc_class: DocClass::UserDoc,
            lifecycle: Lifecycle::Active,
            carrier: format!("# Nine {idx}"),
            fields: BTreeMap::new(),
        });
    }
    let (range_9, _) = store
        .commit_synthetic_note_batch_for_test(&scope1, epoch, &actor, nine_specs)
        .await
        .expect("commit 9-note batch");
    let rcpt_9 = MutationReceiptToken::new(scope1.clone(), range_9.last_seq).unwrap();
    let rset_9 = ReceiptSet::new([rcpt_9]).unwrap();
    let trusted_9 = store
        .resolve_receipt_effects(&scope1, &rset_9)
        .await
        .expect("resolve 9-note effect");
    assert_eq!(
        plan_overlay(
            &scope1,
            SpaceSeq::new(102).unwrap(),
            &rset_9,
            &trusted_9,
            EFFECT_PAYLOAD_BUDGET_BYTES
        )
        .unwrap(),
        OverlayDecision::AwaitProjection {
            watermarks: notarium_core::receipt::AwaitWatermarks::from_receipts([
                MutationReceiptToken::new(scope1.clone(), range_9.last_seq).unwrap()
            ]),
            reason: AwaitReason::TooManyNotes,
        }
    );

    // >64 KiB field summary -> stored & read as AwaitProjection(PayloadBudget) without buffering >64 KiB!
    let mut huge_fields = BTreeMap::new();
    huge_fields.insert(
        "huge_summary".to_owned(),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(
            "Z".repeat(70 * 1024),
        ))),
    );
    let (range_huge, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope1,
            epoch,
            &actor,
            vec![SyntheticNoteSpec {
                note_id: note_id_seq(seed, 30),
                parent_folder: None,
                slug: "huge-effect".to_owned(),
                title: "Huge Effect".to_owned(),
                doc_class: DocClass::UserDoc,
                lifecycle: Lifecycle::Active,
                carrier: "# Huge".to_owned(),
                fields: huge_fields,
            }],
        )
        .await
        .expect("commit oversized field summary");

    let log_huge = match store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope1.clone(),
                    after: range_9.last_seq,
                },
                through: range_huge.last_seq,
                limit: PageLimit::new(10).unwrap(),
            },
        )
        .await
        .expect("read huge effect log")
    {
        ChangeReadResult::Log(p) => p,
        other => panic!("expected Log, got {other:?}"),
    };
    assert!(matches!(
        log_huge.changes[0].effect,
        MutationEffect::AwaitProjection {
            reason: AwaitReason::PayloadBudget
        }
    ));

    // Direct EffectEnvelopeV1 roundtrip check on rich_fields (Null/Absent/Bad/Number/Date/Timestamp).
    let draft = notarium_canonical::build_effect_payload_draft(
        "pay_roundtrip".to_owned(),
        scope1.clone(),
        range_ab,
        "test",
        notarium_canonical::EffectBodyV1::Notes {
            notes: vec![notarium_canonical::ChangedNoteSummaryV1 {
                note_id: note_a.clone(),
                revision: pairs_ab[0].1.clone(),
                rank_version: notarium_core::ids::ContentDigest::from_bytes([7u8; 32]),
                lifecycle: Lifecycle::Active,
                doc_class: DocClass::UserDoc,
                changed_fields: rich_fields.clone(),
            }],
        },
        vec![note_a.clone()],
    )
    .unwrap();
    assert_eq!(draft.codec, EFFECT_CODEC_V1);
    let decoded_env = EffectEnvelopeV1::decode(&draft.effect_msgpack).unwrap();
    match decoded_env.body {
        notarium_canonical::EffectBodyV1::Notes { notes } => {
            assert_eq!(notes[0].changed_fields, rich_fields);
        }
        other => panic!("expected Notes, got {other:?}"),
    }

    // Purge `note_a` (which participated in multi-note command 101..=102):
    // - Erases the entire multi-note `change_payload` for 101..=102 (`erased_by_purge = 1`)
    // - Reading Log across 101..=102 returns `ValidationReason::PurgeResync` (no partial effect, no latest fallback!)
    // - Consumer already at `range_huge.last_seq` reads the new Purge event cleanly!
    // - `change_log` has ZERO sequence holes from 1..=purge_seq!
    let purge_seq = store
        .commit_synthetic_note_purge_for_test(&scope1, epoch, &note_a)
        .await
        .expect("purge note_a");

    let lag_over_purged = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope1.clone(),
                    after: SpaceSeq::new(100).unwrap(),
                },
                through: purge_seq,
                limit: PageLimit::new(50).unwrap(),
            },
        )
        .await;
    assert_validation_err(&lag_over_purged, ValidationReason::PurgeResync);

    // Consumer already past 102 reads the Purge event cleanly.
    let post_purge_log = match store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope1.clone(),
                    after: range_huge.last_seq,
                },
                through: purge_seq,
                limit: PageLimit::new(10).unwrap(),
            },
        )
        .await
        .expect("read purge event")
    {
        ChangeReadResult::Log(p) => p,
        other => panic!("expected Log, got {other:?}"),
    };
    assert_eq!(post_purge_log.changes.len(), 1);
    assert_eq!(post_purge_log.changes[0].kind, ChangeKind::Purge);
    assert_eq!(post_purge_log.changes[0].lifecycle, Lifecycle::Purged);

    // Subscribing from 100 (before erased payload) immediately delivers `ChangeNotice::PurgeResync`!
    let mut sub_erased = store
        .subscribe(
            maintenance_ctx(ServicePurpose::Search),
            ChangeCursor {
                scope: scope1.clone(),
                after: SpaceSeq::new(100).unwrap(),
            },
        )
        .await
        .expect("subscribe over erased range");
    match sub_erased.next().await.unwrap().unwrap() {
        ChangeNotice::PurgeResync { cutoff } => assert_eq!(cutoff.after, purge_seq),
        other => panic!("expected PurgeResync notice, got {other:?}"),
    }

    // Verify 1..=purge_seq has ZERO holes in `change_log`!
    let all_seqs = store
        .read_all_change_log_seqs_for_test(&scope1)
        .await
        .expect("read all change_log seqs");
    let expected_seqs: Vec<u64> = (1..=purge_seq.get()).collect();
    assert_eq!(
        all_seqs, expected_seqs,
        "purge must never create sequence holes in change_log"
    );

    // -------------------------------------------------------------------------
    // Part 2: Broadcast SeedRequired, independent acks, Lagged catch_up, Resync,
    //         and Seed (0 notes + many threads, concurrent head writes, CursorStale).
    // -------------------------------------------------------------------------
    let s2 = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed.wrapping_add(1)),
            incarnation: sample_incarnation(seed.wrapping_add(1)),
            root_folder_id: sample_folder_id(seed.wrapping_add(1)),
            slug: format!("l8-threads-only-{seed}"),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space 2 (0 notes + 12 threads)");
    let scope2 = s2.scope.clone();

    for idx in 1..=12u16 {
        store
            .commit_synthetic_thread_for_test(
                &scope2,
                epoch,
                &thread_id_seq(seed, idx),
                &actor,
                &format!("Thread {idx:02}"),
                u64::from(idx),
            )
            .await
            .expect("create thread");
    }

    // Subscribe at seq 0 -> `SeedRequired` with pinned cutoff = 12!
    let mut sub_zero = store
        .subscribe(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeCursor {
                scope: scope2.clone(),
                after: SpaceSeq::ZERO,
            },
        )
        .await
        .expect("subscribe at seq 0");
    match sub_zero.next().await.unwrap().unwrap() {
        ChangeNotice::SeedRequired { cutoff } => assert_eq!(cutoff.after.get(), 12),
        other => panic!("expected SeedRequired(12), got {other:?}"),
    }

    // Seed on 0 notes + 12 threads with limit = 5 transitions directly to Threads without dummy NoteId!
    let mut seeded_threads = Vec::new();
    let mut seed_res = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Seed {
                scope: scope2.clone(),
                cutoff: None,
                limit: PageLimit::new(5).unwrap(),
            },
        )
        .await
        .expect("initial seed on 0-note space");

    let mut page_count = 0usize;
    loop {
        page_count += 1;
        let ChangeReadResult::Seed(seed_page) = seed_res else {
            panic!("expected Seed result");
        };
        assert!(
            seed_page.notes.is_empty(),
            "0-note space must return empty notes"
        );
        assert_eq!(seed_page.cutoff.after.get(), 12);
        seeded_threads.extend(seed_page.threads);

        match seed_page.next {
            Some(cursor) => {
                assert!(
                    matches!(cursor.after, SeedPosition::ThreadsAfter(_)),
                    "0-note seed must paginate via ThreadsAfter without fabricated NoteId"
                );
                seed_res = store
                    .catch_up(
                        maintenance_ctx(ServicePurpose::Projection),
                        ChangeRead::ContinueSeed { cursor },
                    )
                    .await
                    .expect("continue seed");
            }
            None => break,
        }
    }
    assert_eq!(
        page_count, 3,
        "12 threads at limit 5 -> 5 + 5 + 2 (3 pages)"
    );
    assert_eq!(seeded_threads.len(), 12);

    // Space 3: Mixed 5 notes + 4 threads, concurrent writes between Seed pages,
    // independent subscriber acks, Lagged durable catch_up, CursorStale, and Resync!
    let s3 = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed.wrapping_add(2)),
            incarnation: sample_incarnation(seed.wrapping_add(2)),
            root_folder_id: sample_folder_id(seed.wrapping_add(2)),
            slug: format!("l8-mixed-seed-{seed}"),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space 3");
    let scope3 = s3.scope.clone();

    let mut initial_revs = BTreeMap::new();
    for idx in 1..=5u16 {
        let nid = note_id_seq(seed.wrapping_add(2), idx);
        let (_, pairs) = store
            .commit_synthetic_note_batch_for_test(
                &scope3,
                epoch,
                &actor,
                vec![SyntheticNoteSpec {
                    note_id: nid.clone(),
                    parent_folder: None,
                    slug: format!("seed-note-{idx}"),
                    title: format!("Seed Note {idx} v1"),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: format!("# Seed Note {idx}\nImmutable v1 content"),
                    fields: BTreeMap::new(),
                }],
            )
            .await
            .expect("create seed note");
        initial_revs.insert(nid, pairs[0].1.clone());
    }
    for idx in 1..=4u16 {
        store
            .commit_synthetic_thread_for_test(
                &scope3,
                epoch,
                &thread_id_seq(seed.wrapping_add(2), idx),
                &actor,
                &format!("Mixed Thread {idx} v1"),
                1,
            )
            .await
            .expect("create mixed thread");
    }

    // Cut C is now seq 9 (5 notes + 4 threads). Start Seed with limit = 3 -> Page 1 gets notes 1..=3.
    let ChangeReadResult::Seed(sp1) = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Seed {
                scope: scope3.clone(),
                cutoff: None,
                limit: PageLimit::new(3).unwrap(),
            },
        )
        .await
        .expect("seed page 1")
    else {
        panic!("expected Seed");
    };
    assert_eq!(sp1.cutoff.after.get(), 9);
    assert_eq!(sp1.notes.len(), 3);
    assert_eq!(sp1.threads.len(), 0);
    let cursor_after_p1 = sp1.next.expect("more seed items after page 1");

    // Mutate note 4, note 5, thread 1 AND create brand-new note 6 and thread 5 WHILE Seed is mid-flight!
    for idx in [4u16, 5u16, 6u16] {
        let nid = note_id_seq(seed.wrapping_add(2), idx);
        store
            .commit_synthetic_note_batch_for_test(
                &scope3,
                epoch,
                &actor,
                vec![SyntheticNoteSpec {
                    note_id: nid,
                    parent_folder: None,
                    slug: format!("seed-note-{idx}"),
                    title: format!("Seed Note {idx} v2-concurrent"),
                    doc_class: DocClass::UserDoc,
                    lifecycle: Lifecycle::Active,
                    carrier: format!("# Seed Note {idx}\nMutated v2 after cutoff"),
                    fields: BTreeMap::new(),
                }],
            )
            .await
            .expect("concurrent note write during seed");
    }
    for idx in [1u16, 5u16] {
        store
            .commit_synthetic_thread_for_test(
                &scope3,
                epoch,
                &thread_id_seq(seed.wrapping_add(2), idx),
                &actor,
                &format!("Mixed Thread {idx} v2-concurrent"),
                99,
            )
            .await
            .expect("concurrent thread write during seed");
    }

    // Page 2 (`ContinueSeed`) MUST still return pinned cut 9 (2 remaining notes at v1 + 1 thread at head=1)!
    let ChangeReadResult::Seed(sp2) = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::ContinueSeed {
                cursor: cursor_after_p1.clone(),
            },
        )
        .await
        .expect("seed page 2")
    else {
        panic!("expected Seed");
    };
    assert_eq!(sp2.cutoff.after.get(), 9);
    assert_eq!(sp2.notes.len(), 2);
    assert_eq!(sp2.threads.len(), 1);
    assert_eq!(
        sp2.threads[0].head.get(),
        1,
        "thread must reflect pinned cutoff 9, not head=99"
    );
    for nsnap in &sp2.notes {
        let expected_v1 = initial_revs
            .get(&nsnap.document.reference().note_id)
            .unwrap();
        assert_eq!(
            nsnap.document.revision(),
            expected_v1,
            "seed page 2 must return immutable v1 revision at cutoff 9"
        );
    }

    // Page 3 finishes remaining 3 threads (`2..=4`), excluding post-cutoff note 6 and thread 5!
    let ChangeReadResult::Seed(sp3) = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::ContinueSeed {
                cursor: sp2.next.expect("cursor to page 3"),
            },
        )
        .await
        .expect("seed page 3")
    else {
        panic!("expected Seed");
    };
    assert_eq!(sp3.notes.len(), 0);
    assert_eq!(sp3.threads.len(), 3);
    assert!(sp3.next.is_none());

    // Independent subscriber acks + Lagged broadcast recovery:
    store.reconfigure_broadcast_capacity_for_test(4);
    let head_before_lag = store.get_space(&scope3.space_id).await.unwrap().last_seq;
    let mut sub_indep_a = store
        .subscribe(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeCursor {
                scope: scope3.clone(),
                after: head_before_lag,
            },
        )
        .await
        .expect("sub A");
    let sub_indep_b = store
        .subscribe(
            maintenance_ctx(ServicePurpose::Search),
            ChangeCursor {
                scope: scope3.clone(),
                after: head_before_lag,
            },
        )
        .await
        .expect("sub B");

    // Overflow the 4-slot broadcast ring with 12 sequential commits while neither subscriber polls!
    for round in 0..12u32 {
        store
            .commit_synthetic_thread_for_test(
                &scope3,
                epoch,
                &thread_id_seq(seed.wrapping_add(2), 1),
                &actor,
                &format!("Lag burst {round}"),
                u64::from(100 + round),
            )
            .await
            .expect("burst commit");
    }
    let head_after_lag = store.get_space(&scope3.space_id).await.unwrap().last_seq;
    assert_eq!(head_after_lag.get(), head_before_lag.get() + 12);

    // Subscriber A receives `Lagged { resume }`, runs durable `catch_up`, recovers all 12 events without gaps,
    // and acknowledges `head_after_lag` WITHOUT advancing Subscriber B!
    let lag_notice = sub_indep_a.next().await.unwrap().unwrap();
    let resume_cursor = match lag_notice {
        ChangeNotice::Lagged { resume } => resume,
        other => panic!("expected Lagged notice after ring overflow, got {other:?}"),
    };
    assert_eq!(resume_cursor.after, head_before_lag);

    let caught_up_page = match store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: resume_cursor,
                through: head_after_lag,
                limit: PageLimit::new(50).unwrap(),
            },
        )
        .await
        .expect("durable catch_up after Lagged")
    {
        ChangeReadResult::Log(p) => p,
        other => panic!("expected Log, got {other:?}"),
    };
    assert_eq!(caught_up_page.changes.len(), 12);
    assert!(caught_up_page.complete);

    sub_indep_a
        .acknowledge(ChangeCursor {
            scope: scope3.clone(),
            after: caught_up_page.safe_ack_end,
        })
        .await
        .expect("ack sub A");
    assert_eq!(sub_indep_a.processed().after, head_after_lag);
    assert_eq!(
        sub_indep_b.processed().after,
        head_before_lag,
        "Subscriber A ack must never advance Subscriber B"
    );
    assert_eq!(
        store.min_consumer_watermark(&scope3.space_id, &scope3.incarnation),
        Some(head_before_lag),
        "minimum active consumer watermark must track lagging Subscriber B"
    );

    // Missing retained revision at cutoff 9 -> `ContinueSeed` returns `CursorStale`!
    let n4_id = note_id_seq(seed.wrapping_add(2), 4);
    let n4_v1 = initial_revs.get(&n4_id).unwrap().clone();
    store
        .evict_retained_revision_for_test(&scope3, "note", n4_id.as_str(), &n4_v1)
        .await
        .expect("evict old v1 revision");
    let stale_missing_res = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::ContinueSeed {
                cursor: cursor_after_p1.clone(),
            },
        )
        .await;
    assert_validation_err(&stale_missing_res, ValidationReason::CursorStale);

    // Post-cutoff purge of note 1 (which existed at cutoff 9) -> `Seed` at cutoff 9 returns `CursorStale`!
    let n1_id = note_id_seq(seed.wrapping_add(2), 1);
    store
        .commit_synthetic_note_purge_for_test(&scope3, epoch, &n1_id)
        .await
        .expect("purge n1 after cutoff 9");
    let stale_purge_res = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Seed {
                scope: scope3.clone(),
                cutoff: Some(SpaceSeq::new(9).unwrap()),
                limit: PageLimit::new(3).unwrap(),
            },
        )
        .await;
    assert_validation_err(&stale_purge_res, ValidationReason::CursorStale);

    // Restore default broadcast capacity.
    store.reconfigure_broadcast_capacity_for_test(1024);

    // HistoryIncarnation mismatch -> `ChangeNotice::Resync` on `subscribe` BEFORE comparing seq,
    // and `HistoryIncarnationMismatch` on `catch_up`!
    let new_inc = HistoryIncarnation::from_bytes([0xEE; 16]);
    let rotated_scope = store
        .rotate_incarnation_for_test(&scope3, new_inc)
        .await
        .expect("rotate incarnation");

    let mut sub_stale_inc = store
        .subscribe(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeCursor {
                scope: scope3.clone(),
                // Intentionally huge out-of-range seq: history check MUST run BEFORE seq comparison!
                after: SpaceSeq::new(999_999).unwrap(),
            },
        )
        .await
        .expect("subscribe with stale incarnation");
    match sub_stale_inc.next().await.unwrap().unwrap() {
        ChangeNotice::Resync { scope } => assert_eq!(scope, rotated_scope),
        other => panic!("expected Resync notice on incarnation mismatch, got {other:?}"),
    }

    let catch_up_stale_inc = store
        .catch_up(
            maintenance_ctx(ServicePurpose::Projection),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope3,
                    after: SpaceSeq::new(999_999).unwrap(),
                },
                through: SpaceSeq::new(999_999).unwrap(),
                limit: PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert_validation_err(
        &catch_up_stale_inc,
        ValidationReason::HistoryIncarnationMismatch,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_changes_effects_broadcast_and_seed_parity() {
    let temp = TempDataRoot::new("l8-sqlite");
    let cfg = CanonicalConfig::local_default(sample_installation_id(0x81), temp.data_root());
    let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");

    run_changes_and_seed_suite(&store, 0x81).await;

    runtime.shutdown().await.expect("shutdown sqlite");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_s3_changes_effects_broadcast_and_seed_parity() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("l8-changes");
    let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3_cfg, Some("Enabled"))
        .await
        .expect("create versioned S3 bucket");

    let cfg = fixtures.pg_s3_config(sample_installation_id(0x82), &schema, s3_cfg);
    let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");

    run_changes_and_seed_suite(&store, 0x85).await;

    runtime.shutdown().await.expect("shutdown pg+s3");
    fixtures.drop_pg_schema(&schema).await;
}
