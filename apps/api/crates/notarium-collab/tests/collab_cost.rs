#![forbid(unsafe_code)]

#[path = "support/cost_cases.rs"]
mod cases;
mod support;

use std::{fs, time::Duration};

use cases::{HISTORIES, History, SAMPLES, SIZES_KIB, Shape, Typing, WARMUP};

use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CanonicalStore};
use notarium_collab::{
    CollabConfig, CollabHub,
    wire::{self, LineageHello},
};
use notarium_core::{
    classes::DocClass,
    ids::{InstallationId, NoteId},
    patch::CarrierEditOrigin,
    ports::NoteWritePort,
};
use notarium_syntax::{carrier::Carrier, extract, markdown, nota, patch};
use support::*;
use tokio::time::Instant;
use yrs::{
    Any, Doc, GetString, Map, Options, Out, ReadTxn, StateVector, Text, Transact, Update,
    sync::{Message, SyncMessage},
    updates::decoder::Decode,
};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn rss_kib() -> usize {
    let status = fs::read_to_string("/proc/self/smaps_rollup").expect("Linux smaps_rollup");
    status
        .lines()
        .find_map(|line| line.strip_prefix("Rss:"))
        .and_then(|line| line.split_ascii_whitespace().next())
        .and_then(|value| value.parse().ok())
        .expect("process RSS in KiB")
}

fn report(label: &str, kib: usize, mut samples: Vec<Duration>, wire_bytes: usize) {
    samples.sort_unstable();
    let percentile = |p: usize| samples[(samples.len() * p).div_ceil(100) - 1].as_micros();
    println!(
        "{label},carrier_kib={kib},samples={},wire_bytes={},p50_us={},p95_us={},p99_us={}",
        samples.len(),
        wire_bytes,
        percentile(50),
        percentile(95),
        percentile(99),
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "run explicitly for release-profile latency and Linux RSS measurements"]
async fn collab_cost() {
    let root = TempDataRoot::new("collab-cost");
    let canonical =
        CanonicalConfig::local_default(InstallationId::from_bytes([74; 16]), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(canonical).await.unwrap();
    let scope = test_scope();
    create_space(&store, &scope).await;
    let owner = owner_context(&scope);
    let settings = CollabConfig {
        idle_checkpoint: Duration::from_secs(1),
        idle_unload: Duration::from_secs(2),
        ..Default::default()
    };
    println!(
        "collab_cost,profile={},allocator=mimalloc,backend=sqlite_full,tokio_workers=2,intercept_coalesce_config_us={}",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        settings.intercept_coalesce.as_micros(),
    );
    let hub = CollabHub::new(store.clone(), settings).unwrap();
    hub.register().unwrap();

    let mut notes = Vec::new();
    for seed in 1..=50 {
        let prefix = format!("Room {seed:02}.\n\n");
        let mut carrier = prefix.clone();
        carrier.push_str(&"x".repeat(100 * 1024 - prefix.len()));
        notes.push(create_note(&store, &owner, seed, &carrier, None).await.note);
    }
    // Warm the fixed runtime and one room before sampling. Retained client
    // handles do not contain replicas, isolating room memory from editor RAM.
    let (warm, _) = synced_client(&hub, &owner, &notes[0], 700).await;
    drop(warm);
    wait_until(async || hub.active_room_count() == 0).await;
    let idle_rss = rss_kib();
    let mut peers = Vec::new();
    for note in notes {
        let mut peer = open(&hub, &owner, &note).await;
        peer.send(LineageHello::Fresh.encode()).await.unwrap();
        custom(&mut peer, wire::LINEAGE_READY).await;
        let notarium_collab::SessionEvent::Binary(frame) = recv(&mut peer).await else {
            panic!("expected active room SyncStep1");
        };
        assert!(matches!(
            messages(&frame).as_slice(),
            [Message::Sync(SyncMessage::SyncStep1(_))]
        ));
        peers.push(peer);
    }
    assert_eq!(hub.active_room_count(), 50);
    let active_rss = rss_kib();
    drop(peers);
    wait_until(async || hub.active_room_count() == 0).await;
    let unloaded_rss = rss_kib();
    println!(
        "room_rss_kib,rooms=50,each_carrier_kib=100,baseline={idle_rss},active={active_rss},unloaded={unloaded_rss},delta={}",
        active_rss.saturating_sub(idle_rss)
    );

    let mut seed = 64;
    for kib in SIZES_KIB {
        for history in HISTORIES {
            for shape in Shape::ALL {
                let source = cases::carrier(kib, shape);
                let note = create_note(&store, &owner, seed, &source, None).await.note;
                seed += 1;
                // Keep the room open while disconnected historical authors
                // leave distinct clocks and deletion ranges in its history.
                let (mut writer, _) = synced_client(&hub, &owner, &note, cases::WRITER).await;
                let baseline = writer.text();
                let pad = cases::history_offset(&baseline);
                for author in 0..history.authors {
                    let (mut historical, _) = synced_client(
                        &hub,
                        &owner,
                        &note,
                        cases::HISTORICAL_WRITER + author as u64,
                    )
                    .await;
                    let update = historical.update(|txn| {
                        cases::build_history(&historical.body, txn, pad, history, author);
                        if author == 0 {
                            historical.fields.insert(txn, "status", "done");
                        }
                    });
                    historical.send_update(&update).await;
                    historical.ack().await;
                    assert_eq!(historical.text(), baseline);
                    // The timed peer receives these broadcasts during
                    // preparation, too. Drain before its bounded queue fills.
                    writer.sync().await;
                }
                assert_eq!(writer.text(), baseline);
                let (prior_authors, historical_deleted_units) = {
                    let snapshot = writer.doc.transact().snapshot();
                    let prior_authors = snapshot.state_map.len() - 1;
                    let deleted = snapshot
                        .delete_set
                        .iter()
                        .flat_map(|(_, ranges)| ranges.iter())
                        .map(|range| range.end - range.start)
                        .sum::<u32>();
                    assert_eq!(prior_authors, history.authors);
                    assert_eq!(deleted, history.replacements as u32 * 2);
                    (prior_authors, deleted)
                };
                let label = Campaign {
                    kib,
                    shape,
                    history,
                    prior_authors,
                    historical_deleted_units,
                    note: &note,
                };
                for typing in cases::typing(&baseline, shape) {
                    measure_typing(&mut writer, &label, typing).await;
                }
                if shape == Shape::NearbyNota {
                    measure_finish_nota(&mut writer, &label).await;
                    let (mut competing, _) =
                        synced_client(&hub, &owner, &note, cases::COMPETING).await;
                    measure_concurrent_fallback(&mut writer, &mut competing, &label).await;
                }
                if shape == Shape::Prose && history.label == "short" {
                    measure_wal_prepare(&store, &mut writer, &label).await;
                }
                assert_eq!(writer.text(), baseline);

                wait_until(async || {
                    !store
                        .read_collab_session(None, &scope, &note)
                        .await
                        .unwrap()
                        .unwrap()
                        .session
                        .carrier_dirty
                })
                .await;
                let expected = expected_carrier(&baseline, &note);
                assert_eq!(note_head(&store, &owner, &note).await.1, expected);
                if shape == Shape::Prose && history.label == "short" {
                    let mut samples = Vec::new();
                    let mut carrier = expected;
                    // The full Notes port call also includes plan validation,
                    // CAS and SQLite durability.
                    for sample in 0..WARMUP + SAMPLES {
                        let size = carrier.len();
                        let command = edit(
                            &owner,
                            &note,
                            &carrier,
                            CarrierEditOrigin::Body,
                            size,
                            size,
                            "x",
                        );
                        let started = Instant::now();
                        store.edit_note(owner.clone(), command).await.unwrap();
                        if sample >= WARMUP {
                            samples.push(started.elapsed());
                        }
                        carrier.push('x');
                        writer.sync().await;
                    }
                    assert_eq!(
                        writer.text(),
                        Carrier::scan(&carrier)
                            .unwrap()
                            .body
                            .slice(&carrier)
                            .unwrap()
                    );
                    report("intercept_total", kib, samples, 0);
                }
            }
        }
    }
    wait_until(async || hub.active_room_count() == 0).await;
    runtime.shutdown().await.unwrap();
}

struct Campaign<'a> {
    kib: usize,
    shape: Shape,
    history: History,
    prior_authors: usize,
    historical_deleted_units: u32,
    note: &'a NoteId,
}

#[derive(Default)]
struct AckSamples {
    elapsed: Vec<Duration>,
    min_frame_bytes: usize,
    max_frame_bytes: usize,
}

impl AckSamples {
    fn push(&mut self, sample: usize, elapsed: Duration, bytes: usize) {
        if sample < WARMUP {
            return;
        }
        if self.elapsed.is_empty() {
            self.min_frame_bytes = bytes;
        }
        self.elapsed.push(elapsed);
        self.min_frame_bytes = self.min_frame_bytes.min(bytes);
        self.max_frame_bytes = self.max_frame_bytes.max(bytes);
    }

    fn report(&mut self, phase: &str, run: &Campaign<'_>, lane: &str, action: &str) {
        self.elapsed.sort_unstable();
        assert_eq!(self.elapsed.len(), SAMPLES);
        let quantile = |p: usize| self.elapsed[(p * SAMPLES).div_ceil(100) - 1].as_nanos();
        println!(
            "{phase},carrier_kib={},shape={},history={},prior_authors={},historical_deleted_units={},lane={lane},action={action},samples={SAMPLES},wire_bytes_min={},wire_bytes_max={},p50_ns={},p95_ns={},p99_ns={}",
            run.kib,
            run.shape.label(),
            run.history.label,
            run.prior_authors,
            run.historical_deleted_units,
            self.min_frame_bytes,
            self.max_frame_bytes,
            quantile(50),
            quantile(95),
            quantile(99),
        );
    }
}

async fn send_to_ack(writer: &mut Client, raw: &[u8]) -> (Duration, usize) {
    let payload = wire::encode_update(raw);
    let bytes = payload.len();
    let start = Instant::now();
    writer.peer.send(payload).await.unwrap();
    writer.ack().await;
    (start.elapsed(), bytes)
}

async fn measure_typing(writer: &mut Client, run: &Campaign<'_>, typing: Typing) {
    let mut inserts = AckSamples::default();
    let mut backspaces = AckSamples::default();
    for sample in 0..WARMUP + SAMPLES {
        let added = writer.update(|txn| writer.body.insert(txn, typing.position, typing.input));
        let authored = writer.text();
        let (elapsed, bytes) = send_to_ack(writer, &added).await;
        inserts.push(sample, elapsed, bytes);
        check_oracle(writer, &authored, run.note);

        let removed = writer.update(|txn| {
            writer.body.remove_range(
                txn,
                typing.position,
                typing.input.encode_utf16().count() as u32,
            )
        });
        let authored = writer.text();
        let (elapsed, bytes) = send_to_ack(writer, &removed).await;
        backspaces.push(sample, elapsed, bytes);
        check_oracle(writer, &authored, run.note);
    }
    let lane = if typing.ordinary {
        "durable_ack_ordinary"
    } else {
        "durable_ack_structural"
    };
    inserts.report(lane, run, typing.label, "insert");
    backspaces.report(lane, run, typing.label, "backspace");
}

async fn measure_finish_nota(writer: &mut Client, run: &Campaign<'_>) {
    let mut samples = AckSamples::default();
    let baseline = writer.text();
    for sample in 0..WARMUP + SAMPLES {
        let raw = writer.append(cases::CLOSE_FENCE);
        let authored = writer.text();
        let (elapsed, bytes) = send_to_ack(writer, &raw).await;
        samples.push(sample, elapsed, bytes);
        check_oracle(writer, &authored, run.note);
        let normalized = writer.text();
        assert_eq!(ids(&normalized, run.note).into_iter().flatten().count(), 2);

        let reset = writer
            .update(|txn| cases::remove_added_suffix(&writer.body, txn, &baseline, &normalized));
        send_to_ack(writer, &reset).await;
        assert_eq!(writer.text(), baseline);
    }
    samples.report("durable_ack", run, "finish_nota", "insert");
}

async fn measure_concurrent_fallback(
    writer: &mut Client,
    competing: &mut Client,
    run: &Campaign<'_>,
) {
    let mut samples = AckSamples::default();
    let baseline = writer.text();
    let middle = cases::typing(&baseline, run.shape)[1].position;
    for sample in 0..WARMUP + SAMPLES {
        let offset = middle + 4 + sample as u32;
        let stale = competing.update(|txn| competing.body.insert(txn, offset, "🚀"));
        let first = writer.update(|txn| writer.body.insert(txn, offset, "x"));
        send_to_ack(writer, &first).await;

        // An independent UTF-16 document applies the stale frame to the
        // durable predecessor; the real competing peer has yet to receive it.
        let expected = {
            let oracle = Doc::with_options(Options {
                offset_kind: yrs::OffsetKind::Utf16,
                ..Options::default()
            });
            let body = oracle.get_or_insert_text("body");
            let state = writer
                .doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let mut txn = oracle.transact_mut();
            txn.apply_update(Update::decode_v1(&state).unwrap())
                .unwrap();
            txn.apply_update(Update::decode_v1(&stale).unwrap())
                .unwrap();
            body.get_string(&txn)
        };
        let (elapsed, bytes) = send_to_ack(competing, &stale).await;
        samples.push(sample, elapsed, bytes);
        check_oracle(competing, &expected, run.note);
        writer.sync().await;

        let reset = writer.update(|txn| writer.body.remove_range(txn, offset, 3));
        send_to_ack(writer, &reset).await;
        competing.sync().await;
        assert_eq!(competing.text(), baseline);
    }
    samples.report("durable_ack", run, "same_gap_concurrency", "insert");
}

async fn measure_wal_prepare(store: &CanonicalStore, writer: &mut Client, run: &Campaign<'_>) {
    let position = cases::typing(&writer.text(), run.shape)[1].position;
    let mut samples = AckSamples::default();
    for sample in 0..WARMUP + SAMPLES {
        let raw = writer.update(|txn| writer.body.insert(txn, position, "🚀"));
        let frame = wire::encode_update(&raw);
        let bytes = frame.len();
        let (entered, release) = pause_wal_admission(store);
        let started = Instant::now();
        writer.peer.send(frame).await.unwrap();
        tokio::time::timeout(WAIT, entered)
            .await
            .expect("WAL permit deadline")
            .unwrap();
        samples.push(sample, started.elapsed(), bytes);
        release.send(()).unwrap();
        writer.ack().await;

        let reset = writer.update(|txn| writer.body.remove_range(txn, position, 2));
        send_to_ack(writer, &reset).await;
    }
    // The hook runs after the staged-byte permit and before enqueue to the
    // canonical writer, so the timing includes no database commit.
    samples.report("wal_pre_enqueue", run, "prose_middle", "insert");
}

fn check_oracle(writer: &Client, authored: &str, note: &NoteId) {
    let expected = expected_carrier(authored, note);
    let span = Carrier::scan(&expected).unwrap().body;
    let body = span.slice(&expected).unwrap();
    let actual = writer.text();
    assert_eq!(actual, body);
    assert_eq!(ids(&actual, note), ids(body, note));

    let txn = writer.doc.transact();
    assert_eq!(writer.fields.len(&txn), 1);
    assert_eq!(
        writer.fields.get(&txn, "status"),
        Some(Out::Any(Any::from("done")))
    );
}

fn expected_carrier(body: &str, note: &NoteId) -> String {
    let source = format!("---\nstatus: done # retained\n---\n{body}");
    let plan = extract::finalize_document(&source, DocClass::UserDoc, note, &[]).unwrap();
    patch::apply(&source, &plan).unwrap()
}

fn ids(body: &str, note: &NoteId) -> Vec<Option<notarium_core::ids::ViewKey>> {
    let span = Carrier::scan(body).unwrap().body;
    let structure = markdown::analyze(body, span).unwrap();
    nota::analyze(body, span, note, &structure, false)
        .unwrap()
        .blocks
        .into_iter()
        .map(|view| view.id)
        .collect()
}
