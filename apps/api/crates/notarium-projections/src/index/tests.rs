use std::{collections::BTreeMap, fs, num::NonZeroUsize, path::PathBuf, sync::Arc};

use croaring::Bitmap;
use notarium_core::{
    classes::DocClass,
    error::{Diagnostic, ValidationReason},
    ids::{
        ClusterId, FolderId, HistoryIncarnation, NoteId, ProjectionGeneration, SpaceId, SpaceSeq,
    },
    model::{HistoryScope, Lifecycle},
    query::{Bound, FieldObservation, FieldValue, Predicate, ValueRange},
    value::{Date, ExactNumber, ScalarValue, Timestamp},
};

use super::*;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let mut id = [0; 16];
        getrandom::fill(&mut id).unwrap();
        Self(
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("notarium-index-{}", hex::encode(id))),
        )
    }

    fn path(&self, space: u32, seq: u64) -> PathBuf {
        self.0
            .join(format!("{space}"))
            .join(format!("fast_index_{seq}.mmap"))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn identity(space: u32, seq: u64) -> IndexIdentity {
    IndexIdentity {
        generation: ProjectionGeneration::new(1).unwrap(),
        scope: HistoryScope {
            space_id: SpaceId::from_bytes(u128::from(space).to_be_bytes()),
            incarnation: HistoryIncarnation::from_bytes([2; 16]),
        },
        seq: SpaceSeq::new(seq).unwrap(),
    }
}

fn pool(size: usize) -> MmapPool {
    MmapPool::new(NonZeroUsize::new(size).unwrap())
}

fn fixture_root() -> FolderId {
    FolderId::from_bytes([4; 16])
}

fn note(dense: u32) -> NoteId {
    NoteId::from_bytes(u128::from(dense + 1).to_be_bytes())
}

const EARLY: &str = "1969-12-31T23:59:59.999999999Z";
const EPOCH: &str = "1970-01-01T00:00:00Z";

type Fields = BTreeMap<String, FieldObservation<FieldValue>>;

fn row<'a>(
    dense: u32,
    id: &'a NoteId,
    fields: &'a Fields,
    class: DocClass,
    lifecycle: Lifecycle,
    trashed_ancestor: bool,
) -> IndexNote<'a> {
    let stamp = Timestamp::parse(EARLY).unwrap();
    IndexNote {
        dense,
        id,
        header: NoteSortHeader::new(stamp, stamp, 0, class, lifecycle),
        ancestors: &[],
        trashed_ancestor,
        fields,
        tags: &[],
        ability: None,
    }
}

fn scalar(value: ScalarValue) -> FieldObservation<FieldValue> {
    FieldObservation::Ok(FieldValue::Scalar(value))
}

fn number(value: u64) -> ScalarValue {
    ScalarValue::Number(ExactNumber::from(value))
}

fn equals(key: &str, value: ScalarValue) -> Predicate {
    Predicate::Eq {
        key: key.to_owned(),
        value,
    }
}

fn contains(key: &str, value: ScalarValue) -> Predicate {
    Predicate::Contains {
        key: key.to_owned(),
        value,
    }
}

fn strings(value: &str) -> ScalarValue {
    ScalarValue::String(value.to_owned())
}

fn flags(rows: &[u32]) -> Bitmap {
    Bitmap::of(rows)
}

#[test]
fn mmap_slots_header_precision_graph_and_file_lifetime() {
    let scratch = Scratch::new();
    let path = scratch.path(0, 2);
    let folder = fixture_root();
    let mut builder = FastIndexBuilder::default();
    builder.add_folder(0, &folder, Lifecycle::Active).unwrap();
    let fields = Fields::new();
    for dense in [2, 0] {
        builder
            .add_note(row(
                dense,
                &note(dense),
                &fields,
                DocClass::UserDoc,
                Lifecycle::Active,
                false,
            ))
            .unwrap();
    }
    let cluster = ClusterId::from_bytes([9; 16]);
    builder.set_graph(GraphSections {
        outgoing: vec![vec![2], vec![], vec![]],
        incoming: vec![vec![], vec![], vec![0]],
        clusters: vec![Some(cluster.clone()), None, Some(cluster.clone())],
    });
    let (handle, _) = builder.publish(&path, identity(0, 2)).unwrap();
    let maps = pool(1);
    let view = IndexView::new(handle.open(&maps).unwrap(), Arc::new(L0Delta::default()));
    assert_eq!(view.node_count(), 3);
    assert_eq!(view.folder_count(), 1);
    assert_eq!(view.folder_id_str(0), Some(folder.as_str()));
    assert_eq!(view.folder_lifecycle(0), Some(Lifecycle::Active));
    assert_eq!(view.dense_folder_id(&folder), Some(0));
    assert_eq!(view.dense_id(&note(2)), Some(2));
    assert_eq!(view.note_id(view.dense(2)).unwrap(), &note(2));
    assert!(view.note_id(view.dense(1)).is_err());
    assert_eq!(view.note_id_str(1), None);
    assert_eq!(view.note_header(1), None);
    assert_eq!(view.note_header(0).unwrap().updated_at_ms, -1);
    assert_eq!(
        view.updated_at(0).unwrap(),
        Timestamp::parse(EARLY).unwrap()
    );
    assert_eq!(view.outgoing(0).collect::<Vec<_>>(), [2]);
    assert_eq!(view.incoming(2).collect::<Vec<_>>(), [0]);
    assert_eq!(view.cluster(2).as_ref(), Some(&cluster));
    assert_eq!(
        view.posting(&PostingKey::ClusterMembers(cluster)).unwrap(),
        flags(&[0, 2])
    );

    let retained = handle.clone();
    handle.retire(&maps);
    drop(handle);
    assert!(path.is_file());
    drop(view);
    assert_eq!(maps.live_mmap_count(), 0);
    assert!(path.is_file());
    let reopened = retained.open(&maps).unwrap();
    drop(retained);
    assert!(path.is_file());
    drop(reopened);
    assert!(!path.exists());
}

#[test]
fn encrypted_metadata_and_trashed_folder_postings_remain_separate() {
    let scratch = Scratch::new();
    let mut builder = FastIndexBuilder::default();
    builder
        .add_folder(0, &fixture_root(), Lifecycle::Active)
        .unwrap();
    let fields = Fields::from([("sensitive".to_owned(), scalar(strings("secret")))]);
    let id = note(0);
    let mut encrypted = row(
        0,
        &id,
        &fields,
        DocClass::EncryptedNote,
        Lifecycle::Active,
        false,
    );
    let tags = ["private".to_owned()];
    encrypted.tags = &tags;
    builder.add_note(encrypted).unwrap();
    builder
        .add_note(row(
            1,
            &note(1),
            &fields,
            DocClass::UserDoc,
            Lifecycle::Active,
            true,
        ))
        .unwrap();
    builder
        .add_note(row(
            2,
            &note(2),
            &fields,
            DocClass::UserDoc,
            Lifecycle::Trashed,
            false,
        ))
        .unwrap();
    let (handle, _) = builder
        .publish(&scratch.path(0, 8), identity(0, 8))
        .unwrap();
    let maps = pool(1);
    let view = IndexView::new(handle.open(&maps).unwrap(), Arc::new(L0Delta::default()));
    assert_eq!(view.posting(&PostingKey::Active).unwrap(), flags(&[0, 1]));
    assert_eq!(view.posting(&PostingKey::Trashed).unwrap(), flags(&[2]));
    assert_eq!(
        view.posting(&PostingKey::TrashedSubtree).unwrap(),
        flags(&[1])
    );
    assert_eq!(view.posting(&PostingKey::Encrypted).unwrap(), flags(&[0]));
    assert_eq!(
        view.posting(&PostingKey::FieldOk("sensitive".into()))
            .unwrap(),
        flags(&[1, 2])
    );
    assert!(
        view.posting(&PostingKey::Tag("private".into()))
            .unwrap()
            .is_empty()
    );
    assert!(view.outgoing(0).next().is_none());
}

#[test]
fn overlay_and_folded_checkpoint_match_typed_state_and_exact_boundaries() {
    let scratch = Scratch::new();
    let negative_zero = ScalarValue::Number(ExactNumber::from_f64(-0.0).unwrap());
    let small = 9_007_199_254_740_992;
    let large = small + 1;
    let earlier = Timestamp::parse(EARLY).unwrap();
    let date1 = Date::parse("2024-02-28").unwrap();
    let date2 = Date::parse("2024-02-29").unwrap();
    let rows = [
        Fields::from([("mixed".into(), scalar(strings("one")))]),
        Fields::from([("mixed".into(), scalar(negative_zero.clone()))]),
        Fields::from([("mixed".into(), scalar(number(small)))]),
        Fields::from([("mixed".into(), scalar(number(large)))]),
        Fields::from([(
            "mixed".into(),
            FieldObservation::Ok(FieldValue::List(vec![number(large)])),
        )]),
        Fields::from([(
            "mixed".into(),
            FieldObservation::Ok(FieldValue::List(vec![strings("one")])),
        )]),
        Fields::from([("mixed".into(), scalar(ScalarValue::Timestamp(earlier)))]),
        Fields::from([("mixed".into(), scalar(ScalarValue::Date(date1)))]),
        Fields::from([("mixed".into(), scalar(ScalarValue::Date(date2)))]),
        Fields::from([(
            "mixed".into(),
            FieldObservation::Bad {
                diagnostic: Diagnostic {
                    reason: ValidationReason::InvalidQuery,
                    location: None,
                },
            },
        )]),
        Fields::from([("mixed".into(), scalar(ScalarValue::Null))]),
        Fields::new(),
    ];
    let mut builder = FastIndexBuilder::default();
    builder
        .add_folder(0, &fixture_root(), Lifecycle::Active)
        .unwrap();
    let mut folded = FastIndexBuilder::default();
    folded
        .add_folder(0, &fixture_root(), Lifecycle::Active)
        .unwrap();
    let mut l0 = L0Delta::default();
    let universal = Bitmap::from_range(0..rows.len() as u32);
    for (dense, fields) in rows.iter().enumerate() {
        let dense = dense as u32;
        let id = note(dense);
        let indexed = || {
            row(
                dense,
                &id,
                fields,
                DocClass::UserDoc,
                Lifecycle::Active,
                false,
            )
        };
        folded.add_note(indexed()).unwrap();
        if dense.is_multiple_of(2) {
            builder.add_note(indexed()).unwrap();
        } else {
            l0.replace_note(indexed()).unwrap();
        }
    }
    let (handle, _) = builder
        .publish(&scratch.path(0, 0), identity(0, 0))
        .unwrap();
    let (folded, _) = folded.publish(&scratch.path(0, 1), identity(0, 1)).unwrap();
    let maps = pool(2);
    let over = IndexView::new(handle.open(&maps).unwrap(), Arc::new(l0));
    let materialized = IndexView::new(folded.open(&maps).unwrap(), Arc::new(L0Delta::default()));
    let lower = |value| Bound {
        value,
        inclusive: false,
    };
    let upper = |value| Bound {
        value,
        inclusive: true,
    };
    let predicates = [
        (equals("mixed", strings("one")), vec![0]),
        (equals("mixed", negative_zero), vec![1]),
        (equals("mixed", number(large)), vec![3]),
        (equals("mixed", number(small)), vec![2]),
        (equals("mixed", ScalarValue::Null), vec![10]),
        (contains("mixed", number(large)), vec![4]),
        (contains("mixed", strings("one")), vec![5]),
        (
            Predicate::NumberRange {
                key: "mixed".into(),
                range: ValueRange {
                    lower: Some(lower(ExactNumber::from(small))),
                    upper: Some(upper(ExactNumber::from(large))),
                },
            },
            vec![3],
        ),
        (
            Predicate::DateRange {
                key: "mixed".into(),
                range: ValueRange {
                    lower: Some(Bound {
                        value: date1,
                        inclusive: false,
                    }),
                    upper: Some(Bound {
                        value: date2,
                        inclusive: true,
                    }),
                },
            },
            vec![8],
        ),
        (
            Predicate::TimestampRange {
                key: "mixed".into(),
                range: ValueRange {
                    lower: None,
                    upper: Some(Bound {
                        value: Timestamp::parse(EPOCH).unwrap(),
                        inclusive: false,
                    }),
                },
            },
            vec![6],
        ),
        (
            Predicate::IsAbsent {
                key: "mixed".into(),
            },
            vec![11],
        ),
        (
            Predicate::IsBad {
                key: "mixed".into(),
            },
            vec![9],
        ),
    ];
    for (predicate, expected) in predicates {
        for view in [&over, &materialized] {
            let result = view.filter_candidates(&predicate, &universal).unwrap();
            assert_eq!(result.definite, flags(&expected), "{predicate:?}");
            assert_eq!(result.possible, result.definite);
        }
    }
}

#[test]
fn lru_resident_count_excludes_unmapped_retained_leases() {
    let scratch = Scratch::new();
    let maps = pool(16);
    let mut logical = Vec::new();
    let mut held = None;
    for space in 0..100 {
        let (handle, _) = FastIndexBuilder::default()
            .publish(&scratch.path(space, 0), identity(space, 0))
            .unwrap();
        let map = handle.open(&maps).unwrap();
        if space == 0 {
            held = Some(map)
        }
        logical.push(handle);
        assert!(maps.live_mmap_count() <= 17);
    }
    assert_eq!(maps.live_mmap_count(), 17);
    drop(held);
    assert_eq!(maps.live_mmap_count(), 16);
    logical[0].open(&maps).unwrap();
    assert_eq!(maps.live_mmap_count(), 16);
}

#[test]
fn high_cardinality_lists_require_exact_witnesses_even_under_negation() {
    use super::model::{FIELD_LIST_ELEM, bucket_key, field_prefix, value_key};

    let scratch = Scratch::new();
    let mut builder = FastIndexBuilder::default();
    builder
        .add_folder(0, &fixture_root(), Lifecycle::Active)
        .unwrap();
    let key = "list";
    let target = strings("entry-0");
    let prefix = field_prefix(FIELD_LIST_ELEM, key);
    let value_bucket = |value: &ScalarValue| {
        bucket_key(
            &prefix,
            &value_key(FIELD_LIST_ELEM, key, value)[prefix.len()..],
        )
    };
    let collision = (1..65_536)
        .map(|value| strings(&format!("entry-{value}")))
        .find(|candidate| value_bucket(candidate) == value_bucket(&target))
        .unwrap();
    let rows = [
        Fields::from([(
            key.into(),
            FieldObservation::Ok(FieldValue::List(
                (0..65_537)
                    .map(|value| strings(&format!("entry-{value}")))
                    .collect(),
            )),
        )]),
        Fields::from([(
            key.into(),
            FieldObservation::Ok(FieldValue::List(vec![collision])),
        )]),
        Fields::new(),
    ];
    for (dense, fields) in rows.iter().enumerate() {
        let dense = dense as u32;
        builder
            .add_note(row(
                dense,
                &note(dense),
                fields,
                DocClass::UserDoc,
                Lifecycle::Active,
                false,
            ))
            .unwrap();
    }
    let (handle, _) = builder
        .publish(&scratch.path(0, 2), identity(0, 2))
        .unwrap();
    let maps = pool(1);
    let view = IndexView::new(handle.open(&maps).unwrap(), Arc::new(L0Delta::default()));
    let universe = flags(&[0, 1, 2]);
    let query = Predicate::Not(Box::new(contains(key, target)));
    let candidates = view.filter_candidates(&query, &universe).unwrap();
    assert_eq!(candidates.definite, flags(&[2]));
    assert_eq!(candidates.needs_check(), flags(&[0, 1]));
    let exact = view
        .filter(&query, &universe, |dense, predicate| {
            Ok(predicate.matches(&rows[dense.index(view.generation()).unwrap() as usize]))
        })
        .unwrap();
    assert_eq!(exact, flags(&[1, 2]));
}

#[test]
fn folder_subtree_moves_compose_with_note_replacements_and_purge() {
    let scratch = Scratch::new();
    let maps = pool(2);
    let fields = Fields::new();
    let root = 0;
    let old_parent = 1;
    let new_parent = 2;
    let moved = 3;
    let nested = 4;

    let make_builder = || {
        let mut builder = FastIndexBuilder::default();
        for dense in [root, old_parent, new_parent, moved, nested] {
            let id = FolderId::from_bytes(u128::from(dense).to_be_bytes());
            builder.add_folder(dense, &id, Lifecycle::Active).unwrap();
        }
        builder
    };
    fn placed<'a>(
        dense: u32,
        id: &'a NoteId,
        fields: &'a Fields,
        parent: u32,
        ancestors: &'a [u32],
    ) -> IndexNote<'a> {
        let mut note = row(
            dense,
            id,
            fields,
            DocClass::UserDoc,
            Lifecycle::Active,
            false,
        );
        note.header.parent_dense_folder_id = parent;
        note.ancestors = ancestors;
        note
    }
    let ids = (0..6).map(note).collect::<Vec<_>>();
    let mut builder = make_builder();
    for (dense, parent, ancestors) in [
        (0, moved, &[old_parent, root][..]),
        (1, nested, &[moved, old_parent, root][..]),
        (2, new_parent, &[root][..]),
        (3, old_parent, &[root][..]),
        (5, moved, &[old_parent, root][..]),
    ] {
        builder
            .add_note(placed(
                dense,
                &ids[dense as usize],
                &fields,
                parent,
                ancestors,
            ))
            .unwrap();
    }
    let (handle, _) = builder
        .publish(&scratch.path(0, 1), identity(0, 1))
        .unwrap();
    let map = handle.open(&maps).unwrap();
    let mut delta = L0Delta::default();
    delta
        .replace_note(placed(
            4,
            &ids[4],
            &fields,
            nested,
            &[moved, old_parent, root],
        ))
        .unwrap();

    let subtree =
        |view: &IndexView, folder| view.posting(&PostingKey::FolderSubtree(folder)).unwrap();
    let before = IndexView::new(Arc::clone(&map), Arc::new(delta.clone()));
    let members = subtree(&before, moved);
    assert_eq!(members, flags(&[0, 1, 4, 5]));
    delta.set_subtree_membership(old_parent, &members, false);
    delta.set_subtree_membership(new_parent, &members, true);
    let moved_view = IndexView::new(Arc::clone(&map), Arc::new(delta.clone()));
    assert_eq!(subtree(&moved_view, old_parent), flags(&[3]));
    assert_eq!(subtree(&moved_view, new_parent), flags(&[0, 1, 2, 4, 5]));
    assert_eq!(subtree(&before, old_parent), flags(&[0, 1, 3, 4, 5]));

    delta
        .replace_note(placed(0, &ids[0], &fields, old_parent, &[root]))
        .unwrap();
    delta
        .replace_note(placed(3, &ids[3], &fields, moved, &[new_parent, root]))
        .unwrap();
    delta.remove_note(5);
    let edited = IndexView::new(Arc::clone(&map), Arc::new(delta.clone()));
    assert_eq!(subtree(&edited, old_parent), flags(&[0]));
    assert_eq!(subtree(&edited, new_parent), flags(&[1, 2, 3, 4]));
    assert_eq!(subtree(&edited, moved), flags(&[1, 3, 4]));

    let members = subtree(&edited, moved);
    delta.set_subtree_membership(new_parent, &members, false);
    delta.set_subtree_membership(old_parent, &members, true);
    let reopened = IndexView::new(map, Arc::new(delta));
    let mut folded = make_builder();
    for (dense, parent, ancestors) in [
        (0, old_parent, &[root][..]),
        (1, nested, &[moved, old_parent, root][..]),
        (2, new_parent, &[root][..]),
        (3, moved, &[old_parent, root][..]),
        (4, nested, &[moved, old_parent, root][..]),
    ] {
        folded
            .add_note(placed(
                dense,
                &ids[dense as usize],
                &fields,
                parent,
                ancestors,
            ))
            .unwrap();
    }
    let (folded, _) = folded.publish(&scratch.path(0, 2), identity(0, 2)).unwrap();
    let folded = IndexView::new(folded.open(&maps).unwrap(), Arc::new(L0Delta::default()));
    for folder in [root, old_parent, new_parent, moved, nested] {
        assert_eq!(subtree(&reopened, folder), subtree(&folded, folder));
        let direct = PostingKey::FolderDirect(folder);
        assert_eq!(
            reopened.posting(&direct).unwrap(),
            folded.posting(&direct).unwrap()
        );
    }
}

#[test]
fn large_subtree_delta_keeps_membership_compressed() {
    let mut delta = L0Delta::default();
    let members = Bitmap::from_range(0..100_000);
    delta.set_subtree_membership(1, &members, false);
    delta.set_subtree_membership(2, &members, true);
    assert!(delta.approx_bytes() < 1_024);
    assert_eq!(delta.subtree_overrides[&1].removed, members);
    assert_eq!(delta.subtree_overrides[&2].added, members);
    assert!(delta.notes.is_empty());
}

proptest::proptest! {
    #![proptest_config({
        let mut config = proptest::test_runner::Config::default();
        config.cases = config.cases.max(2_000);
        config
    })]

    #[test]
    fn generated_postings_agree_with_scalar_evaluator(
        states in proptest::collection::vec((0u8..15, -3i64..4), 1..36),
        point in -3i64..4,
    ) {
        let scratch = Scratch::new();
        let mut empty = FastIndexBuilder::default();
        let mut partial = FastIndexBuilder::default();
        let mut final_index = FastIndexBuilder::default();
        for builder in [&mut empty, &mut partial, &mut final_index] {
            builder.add_folder(0, &fixture_root(), Lifecycle::Active).unwrap();
        }
        let mut l0 = L0Delta::default();
        let mut overlay_only = L0Delta::default();
        let mixed = "mixed";
        let mut source = Vec::new();
        let exact = |offset| ScalarValue::Number(ExactNumber::from(9_007_199_254_740_992i64 + offset));
        let boolean = |offset| ScalarValue::Bool(offset >= 0);
        let date = |offset| ScalarValue::Date(Date::parse(
            if offset < 0 { "2024-02-28" } else { "2024-02-29" },
        ).unwrap());
        let instant = |offset| ScalarValue::Timestamp(Timestamp::parse(
            if offset < 0 { EARLY } else { EPOCH },
        ).unwrap());
        for (dense, (state, offset)) in states.into_iter().enumerate() {
            let field = match state {
                0 => FieldObservation::Absent,
                1 => FieldObservation::Bad { diagnostic: Diagnostic { reason: ValidationReason::InvalidQuery, location: None } },
                2 => scalar(strings("orange")),
                3 => FieldObservation::Ok(FieldValue::List(vec![strings("orange"), exact(offset)])),
                4 => scalar(ScalarValue::Number(ExactNumber::from_f64(-0.0).unwrap())),
                5 => FieldObservation::Ok(FieldValue::List(vec![number(0)])),
                6 => scalar(ScalarValue::Null),
                7 => FieldObservation::Ok(FieldValue::List(Vec::new())),
                8 => scalar(date(offset)),
                9 => scalar(instant(offset)),
                11 => FieldObservation::Ok(FieldValue::List(vec![boolean(offset)])),
                12 => FieldObservation::Ok(FieldValue::List(vec![date(offset)])),
                13 => FieldObservation::Ok(FieldValue::List(vec![instant(offset)])),
                14 => scalar(boolean(offset)),
                _ => scalar(exact(offset)),
            };
            source.push(Fields::from([(mixed.into(), field)]));
            let fields = source.last().unwrap();
            let dense = dense as u32;
            let id = note(dense);
            let indexed = || row(dense, &id, fields, DocClass::UserDoc, Lifecycle::Active, false);
            overlay_only.replace_note(indexed()).unwrap();
            final_index.add_note(indexed()).unwrap();
            match dense % 3 {
                0 => partial.add_note(indexed()).unwrap(),
                1 => {
                    let before = Fields::from([(mixed.into(), scalar(strings("old")))]);
                    partial.add_note(row(dense, &id, &before, DocClass::UserDoc, Lifecycle::Active, false)).unwrap();
                    l0.replace_note(indexed()).unwrap();
                }
                _ => l0.replace_note(indexed()).unwrap(),
            }
        }
        let maps = pool(3);
        let (empty, _) = empty.publish(&scratch.path(0, 0), identity(0, 0)).unwrap();
        let (partial, _) = partial.publish(&scratch.path(0, 1), identity(0, 1)).unwrap();
        let (final_index, _) = final_index.publish(&scratch.path(0, 2), identity(0, 2)).unwrap();
        let delta_only = IndexView::new(empty.open(&maps).unwrap(), Arc::new(overlay_only));
        let with_delta = IndexView::new(partial.open(&maps).unwrap(), Arc::new(l0));
        let checkpoint = IndexView::new(final_index.open(&maps).unwrap(), Arc::new(L0Delta::default()));
        let universal = Bitmap::from_range(0..source.len() as u32);
        let predicates = [
            equals(mixed, number(0)),
            equals(mixed, exact(point)),
            equals(mixed, strings("orange")),
            equals(mixed, boolean(point)),
            contains(mixed, strings("orange")),
            contains(mixed, exact(point)),
            contains(mixed, boolean(point)),
            contains(mixed, date(point)),
            contains(mixed, instant(point)),
            Predicate::NumberRange { key: mixed.into(), range: ValueRange {
                lower: Some(Bound { value: ExactNumber::from(9_007_199_254_740_992i64 + point), inclusive: false }),
                upper: None,
            }},
            Predicate::IsAbsent { key: mixed.into() },
            Predicate::IsBad { key: mixed.into() },
            Predicate::Not(Box::new(Predicate::All(vec![
                contains(mixed, exact(point)), Predicate::Exists { key: mixed.into() },
            ]))),
        ];
        for predicate in predicates {
            let expected: Bitmap = universal.iter().filter(|&dense| predicate.matches(&source[dense as usize])).collect();
            for view in [&delta_only, &with_delta, &checkpoint] {
                let actual = view.filter_candidates(&predicate, &universal).unwrap();
                proptest::prop_assert_eq!(&actual.possible, &expected, "{:?}", predicate);
                proptest::prop_assert_eq!(&actual.definite, &expected, "{:?}", predicate);
            }
        }
    }
}
