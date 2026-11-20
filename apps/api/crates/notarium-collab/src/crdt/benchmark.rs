//! Explicit campaigns for latency and guard work. The syntax oracle and
//! unmeasured setup run outside each timed section. The counters record
//! application call sites, including inputs passed to syntax and Yrs helpers.
//! Their internal allocation and scan costs are part of timings.

#[path = "../../tests/support/cost_cases.rs"]
mod cases;

use std::{
    cell::Cell,
    time::{Duration, Instant},
};

use notarium_core::{classes::DocClass, ids::RevisionId};
use notarium_syntax::{carrier::Carrier, content_digest, extract, markdown, nota};

use super::*;
use cases::{HISTORIES, History, SAMPLES, SIZES_KIB, Shape, Typing, WARMUP};

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Work {
    pub(super) update_elements: usize,
    pub(super) scanned_update_bytes: usize,
    pub(super) page_lookups: usize,
    pub(super) causal_probes: usize,
    pub(super) causal_blocks: usize,
    pub(super) unproved_gaps: usize,
    pub(super) body_items: usize,
    pub(super) map_entries: usize,
    pub(super) whole_body_passes: usize,
    pub(super) body_input_bytes: usize,
    pub(super) body_copy_bytes: usize,
    pub(super) utf16_writes: usize,
    pub(super) snapshot_exports: usize,
    pub(super) generated_binary_bytes: usize,
    pub(super) wal_copy_bytes: usize,
    pub(super) carrier_projections: usize,
    pub(super) nota_finalizations: usize,
    pub(super) nota_input_bytes: usize,
}

thread_local! {
    static WORK: Cell<Option<Work>> = const { Cell::new(None) };
}

pub(super) fn record(record: impl FnOnce(&mut Work)) {
    WORK.with(|meter| {
        if let Some(mut work) = meter.get() {
            record(&mut work);
            meter.set(Some(work));
        }
    });
}

#[derive(Clone, Copy)]
enum Expected {
    Ordinary,
    Structural,
    Fallback,
}

#[derive(Default)]
struct Samples {
    elapsed: Vec<Duration>,
    min_frame_bytes: usize,
    max_frame_bytes: usize,
    work: Option<Work>,
}

impl Samples {
    fn report(&mut self, fixture: &Fixture, lane: &str, action: &str, expected: Expected) {
        assert_eq!(self.elapsed.len(), SAMPLES);
        let work = self.work.take().expect("separate metered sample");
        match expected {
            Expected::Ordinary => {
                assert_eq!(
                    work.whole_body_passes
                        + work.snapshot_exports
                        + work.carrier_projections
                        + work.nota_finalizations,
                    0
                );
                assert_eq!(
                    work.body_input_bytes + work.body_copy_bytes + work.map_entries,
                    0
                );
                assert_eq!(
                    work.causal_probes + work.causal_blocks + work.body_items + work.unproved_gaps,
                    0
                );
                assert_eq!(work.update_elements, 1);
                assert!(
                    work.page_lookups <= 16 && work.utf16_writes <= body::PAGE_UNITS as usize + 4,
                    "{work:?}"
                );
            }
            Expected::Structural => {
                assert!(
                    work.whole_body_passes > 0 && work.nota_finalizations == 1,
                    "{work:?}"
                );
            }
            Expected::Fallback => {
                assert!(
                    work.unproved_gaps > 0 && work.whole_body_passes > 0,
                    "{work:?}"
                );
            }
        }
        self.elapsed.sort_unstable();
        let quantile = |p: usize| self.elapsed[(p * SAMPLES).div_ceil(100) - 1].as_nanos();
        println!(
            "guard_stage,carrier_kib={},shape={},history={},prior_authors={},historical_deleted_units={},lane={lane},action={action},samples={SAMPLES},v1_bytes_min={},v1_bytes_max={},p50_ns={},p95_ns={},p99_ns={},metered_work={work:?}",
            fixture.kib,
            fixture.shape.label(),
            fixture.history.label,
            fixture.prior_authors,
            fixture.historical_deleted_units,
            self.min_frame_bytes,
            self.max_frame_bytes,
            quantile(50),
            quantile(95),
            quantile(99),
        );
    }
}

struct Fixture {
    kib: usize,
    shape: Shape,
    history: History,
    prior_authors: usize,
    historical_deleted_units: u32,
    note: NoteId,
    carrier: RoomCarrierState,
    base_body: String,
    twin: TwinDoc,
    writer: Replica,
    oracle: Replica,
}

impl Fixture {
    fn new(kib: usize, shape: Shape, history: History) -> Self {
        let source = cases::carrier(kib, shape);
        let (carrier, base_body) = RoomCarrierState::from_carrier(
            RevisionId::from_bytes([77; 16]),
            content_digest(&source),
            &source,
        )
        .unwrap();
        let base_body = base_body.to_owned();
        let note = NoteId::from_bytes([82; 16]);
        let mut twin = TwinDoc::seed(&base_body).unwrap();
        let pad = cases::history_offset(&base_body);
        for author in 0..history.authors {
            let historical = replica(&twin, cases::HISTORICAL_WRITER + author as u64);
            let bytes = version(&historical, |txn| {
                cases::build_history(&historical.body, txn, pad, history, author);
                if author == 0 {
                    historical.fields.insert(txn, "status", "done");
                }
            });
            twin.replay(&bytes).unwrap();
        }
        assert_eq!(twin.live_body(), base_body);
        let snapshot = twin.live.doc.transact().snapshot();
        let prior_authors = snapshot.state_map.len() - 1;
        assert_eq!(prior_authors, history.authors);
        let historical_deleted_units: u32 = snapshot
            .delete_set
            .iter()
            .flat_map(|(_, spans)| spans.iter())
            .map(|span| span.end - span.start)
            .sum();
        assert_eq!(historical_deleted_units, history.replacements as u32 * 2);
        let writer = replica(&twin, cases::WRITER);
        let oracle = replica(&twin, cases::WRITER - 1);
        Self {
            kib,
            shape,
            history,
            prior_authors,
            historical_deleted_units,
            note,
            carrier,
            base_body,
            twin,
            writer,
            oracle,
        }
    }

    fn sample(&mut self, frame: &[u8], expected: Expected, series: Option<(&mut Samples, usize)>) {
        let measured_work = series.as_ref().is_some_and(|(_, index)| *index == WARMUP);
        if measured_work {
            WORK.with(|meter| meter.set(Some(Work::default())));
        }
        let start = Instant::now();
        let candidate = self
            .twin
            .stage_peer_with_path(frame, &self.carrier, &self.note, false);
        let elapsed = start.elapsed();
        let work = WORK.with(|meter| meter.take());
        let (staged, path) = candidate.expect("valid browser edit");
        assert_eq!(
            path,
            match expected {
                Expected::Ordinary => GuardPath::Ordinary,
                Expected::Structural | Expected::Fallback => GuardPath::Structural,
            }
        );
        if let Some((samples, index)) = series {
            if let Some(work) = work {
                samples.work = Some(work);
            }
            if index > WARMUP {
                if samples.elapsed.is_empty() {
                    samples.min_frame_bytes = frame.len();
                }
                samples.min_frame_bytes = samples.min_frame_bytes.min(frame.len());
                samples.max_frame_bytes = samples.max_frame_bytes.max(frame.len());
                samples.elapsed.push(elapsed);
            }
        }
        self.check_oracle(frame, &staged.bytes);
        self.twin.publish(&staged.bytes).unwrap();
        self.writer.apply(&staged.bytes).unwrap();
    }

    fn check_oracle(&self, raw: &[u8], published: &[u8]) {
        // Integrate the client's raw update in an independent document and
        // finalize its projected carrier using the full syntax pipeline.
        self.oracle.apply(raw).unwrap();
        let fields = self.oracle.overrides(&self.oracle.doc.transact()).unwrap();
        assert_eq!(self.twin.staging_overrides().unwrap(), fields);
        assert_eq!(
            fields.get("status"),
            Some(&AppliedFmEntry::Set(
                notarium_core::value::YamlValue::String("done".into())
            ))
        );
        let authored = self.oracle.body.get_string(&self.oracle.doc.transact());
        let source = self.carrier.materialize(&authored, &fields).unwrap();
        let plan = extract::finalize_document(&source, DocClass::UserDoc, &self.note, &[]).unwrap();
        let expected = patch::apply(&source, &plan).unwrap();
        let actual = self
            .carrier
            .materialize(&self.twin.staging_body(), &fields)
            .unwrap();
        assert_eq!(actual, expected);
        assert_eq!(
            note_ids(&actual, &self.note),
            note_ids(&expected, &self.note)
        );

        // Keep the exact finalized identifiers in the oracle and author so
        // the next operation uses the same causal coordinates as the room.
        self.oracle.apply(published).unwrap();
        let body = Carrier::scan(&expected)
            .unwrap()
            .body
            .slice(&expected)
            .unwrap();
        assert_eq!(
            self.oracle.body.get_string(&self.oracle.doc.transact()),
            body
        );
    }

    fn type_and_backspace(&mut self, typing: Typing) {
        let expected = if typing.ordinary {
            Expected::Ordinary
        } else {
            Expected::Structural
        };
        let units = typing.input.encode_utf16().count() as u32;
        let mut insert = Samples::default();
        let mut backspace = Samples::default();
        for index in 0..=WARMUP + SAMPLES {
            let frame = version(&self.writer, |txn| {
                self.writer.body.insert(txn, typing.position, typing.input)
            });
            self.sample(&frame, expected, Some((&mut insert, index)));
            let frame = version(&self.writer, |txn| {
                self.writer.body.remove_range(txn, typing.position, units)
            });
            self.sample(&frame, expected, Some((&mut backspace, index)));
        }
        insert.report(self, typing.label, "insert", expected);
        backspace.report(self, typing.label, "backspace", expected);
    }

    fn finish_nota(&mut self) {
        let before = self.writer.body.get_string(&self.writer.doc.transact());
        let mut samples = Samples::default();
        for index in 0..=WARMUP + SAMPLES {
            let frame = version(&self.writer, |txn| {
                self.writer.body.push(txn, cases::CLOSE_FENCE)
            });
            self.sample(&frame, Expected::Structural, Some((&mut samples, index)));
            let after = self.writer.body.get_string(&self.writer.doc.transact());
            assert_eq!(note_ids(&after, &self.note).iter().flatten().count(), 2);
            let reset = version(&self.writer, |txn| {
                cases::remove_added_suffix(&self.writer.body, txn, &before, &after)
            });
            self.sample(&reset, Expected::Structural, None);
            assert_eq!(self.twin.live_body(), before);
        }
        samples.report(self, "finish_nota", "insert", Expected::Structural);
    }

    fn concurrent_fallback(&mut self) {
        let stale = replica(&self.twin, cases::COMPETING);
        let middle = cases::typing(&self.base_body, self.shape)[1].position;
        let mut samples = Samples::default();
        for index in 0..=WARMUP + SAMPLES {
            // Each collision uses a fresh gap, away from the prose-middle
            // typing series and the tombstones from earlier collisions.
            let gap = middle + 4 + index as u32;
            let frame = version(&stale, |txn| stale.body.insert(txn, gap, "🚀"));
            let first = version(&self.writer, |txn| self.writer.body.insert(txn, gap, "x"));
            self.sample(&first, Expected::Ordinary, None);
            self.sample(&frame, Expected::Fallback, Some((&mut samples, index)));
            let reset = version(&self.writer, |txn| {
                self.writer.body.remove_range(txn, gap, 3)
            });
            self.sample(&reset, Expected::Structural, None);
            stale.apply(&self.twin.live_snapshot()).unwrap();
        }
        samples.report(self, "same_gap_concurrency", "insert", Expected::Fallback);
    }
}

fn note_ids(source: &str, note: &NoteId) -> Vec<Option<notarium_core::ids::ViewKey>> {
    let span = Carrier::scan(source).unwrap().body;
    let structure = markdown::analyze(source, span).unwrap();
    nota::analyze(source, span, note, &structure, false)
        .unwrap()
        .blocks
        .into_iter()
        .map(|view| view.id)
        .collect()
}

fn replica(twin: &TwinDoc, id: u64) -> Replica {
    let options = Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::with_client_id(ClientID::new(id))
    };
    let replica = Replica::from_doc(Doc::with_options(options));
    replica.apply(&twin.live_snapshot()).unwrap();
    replica
}

fn version(replica: &Replica, edit: impl FnOnce(&mut TransactionMut<'_>)) -> Vec<u8> {
    let mut transaction = replica.doc.transact_mut();
    edit(&mut transaction);
    transaction.commit();
    transaction.encode_update_v1()
}

fn measure_retained_indexes() {
    let twin = TwinDoc::seed(&"p".repeat(100 * 1024)).unwrap();
    drop(twin.staging.rebuild_index().unwrap());
    let mut indexes = Vec::with_capacity(50);
    let retained = allocation_counter::measure(|| {
        for _ in 0..50 {
            indexes.push(twin.staging.rebuild_index().unwrap());
        }
    });
    let released = allocation_counter::measure(|| indexes.clear());
    assert!(retained.bytes_current > 0);
    assert_eq!(retained.bytes_current, -released.bytes_current);
    println!(
        "guard_index_heap,rooms=50,body_kib=100,retained_requested_bytes={},released_requested_bytes={}",
        retained.bytes_current, -released.bytes_current,
    );
}

#[test]
#[ignore = "run explicitly for the guard performance and structural oracle campaign"]
fn guard_campaign() {
    println!(
        "guard_campaign,profile={},timing_excludes_metered_sample=true",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    measure_retained_indexes();
    for kib in SIZES_KIB {
        for history in HISTORIES {
            for shape in Shape::ALL {
                let mut fixture = Fixture::new(kib, shape, history);
                for typing in cases::typing(&fixture.base_body, shape) {
                    fixture.type_and_backspace(typing);
                }
                if shape == Shape::NearbyNota {
                    fixture.finish_nota();
                    fixture.concurrent_fallback();
                }
            }
        }
    }
}
