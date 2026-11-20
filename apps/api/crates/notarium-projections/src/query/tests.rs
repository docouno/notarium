use notarium_core::{
    error::Diagnostic,
    ids::ViewKey,
    ports::ViewRef,
    query::{Direction, FieldFilterAstV1, SortKey},
};
use proptest::prelude::*;

use super::*;

fn ts(nanoseconds: u32) -> Timestamp {
    Timestamp::from_unix_parts(-1, nanoseconds).unwrap()
}

fn id(ordinal: u64) -> NoteId {
    NoteId::from_bytes(u128::from(ordinal).to_be_bytes())
}

fn string_group(value: &str) -> GroupKey {
    GroupKey::Value(ScalarValue::String(value.to_owned()))
}

fn fixture_tuple(
    sort: &SortSpec,
    columns: &[GroupKey],
    ordinal: u64,
    group: &GroupKey,
    rank: Option<&str>,
    time: Timestamp,
) -> SortTuple {
    let mut tuple = sort_tuple(sort, &id(ordinal), time, &BTreeMap::new());
    tuple.cells.splice(..0, cursor_prefix(columns, group, rank));
    tuple
}

#[test]
fn group_cursor_tracks_declared_order_ranks_and_exact_sort_suffix() {
    let sort = SortSpec::default();
    let done = string_group("done");
    let todo = string_group("todo");
    let other = string_group("aa");
    let columns = [todo.clone(), done.clone()];
    let tuple = |ordinal, group: &GroupKey, rank, time| {
        fixture_tuple(&sort, &columns, ordinal, group, rank, time)
    };
    let ranked = tuple(2, &todo, Some("b"), ts(700));
    let tied_rank = tuple(3, &todo, Some("b"), ts(900));
    let unranked_new = tuple(4, &todo, None, ts(302));
    let unranked_old = tuple(1, &todo, None, ts(300));
    let next_column = tuple(2, &done, Some("a"), ts(2));
    let extra_column = tuple(2, &other, Some("a"), ts(2));

    for window in [
        ranked,
        tied_rank,
        unranked_new,
        unranked_old,
        next_column,
        extra_column,
    ]
    .windows(2)
    {
        assert_eq!(
            compare_view_cursor_tuple(&sort, &window[0], &window[1]).unwrap(),
            Ordering::Less
        );
    }

    let mut malformed = tuple(2, &done, Some("a"), ts(2));
    malformed.cells[2] = SortCell::Null;
    assert_eq!(
        compare_view_cursor_tuple(&sort, &malformed, &malformed),
        Err(invalid_query()),
    );
}

#[test]
fn grouping_distinguishes_null_bad_empty_and_absent() {
    let field = |value| FieldObservation::Ok(value);
    assert_eq!(group_key(None), GroupKey::Absent);
    assert_eq!(
        group_key(Some(&field(FieldValue::Scalar(ScalarValue::Null)))),
        GroupKey::Value(ScalarValue::Null),
    );
    assert_eq!(
        group_key(Some(&field(FieldValue::List(Vec::new())))),
        GroupKey::EmptyList,
    );
    assert_eq!(
        group_key(Some(&field(FieldValue::List(vec![ScalarValue::Bool(
            true
        )])))),
        GroupKey::Bad,
    );
    assert_eq!(
        group_key(Some(&FieldObservation::Bad {
            diagnostic: Diagnostic {
                reason: ValidationReason::InvalidState,
                location: None,
            }
        })),
        GroupKey::Bad,
    );
}

#[test]
fn source_filter_keeps_legacy_shaped_relative_paths_and_nearest_project() {
    let root = FolderId::from_bytes([1; 16]);
    let project = FolderId::from_bytes([2; 16]);
    let path = FolderId::from_bytes([3; 16]);
    let mut source = ViewSource {
        scope: SourceScope::Project,
        ..ViewSource::default()
    };
    assert_eq!(
        resolve_source_folder(&source, &root, Some(&project), |_| None),
        Ok(Some(project)),
    );
    assert_eq!(
        resolve_source_folder(&source, &root, None, |_| None),
        Err(DomainError::ResourceNotFound),
    );
    source.folder = Some(SourceFolder::Path("Architecture".into()));
    assert_eq!(
        resolve_source_folder(&source, &root, None, |normalized| {
            assert_eq!(normalized, "architecture");
            Some(path.clone())
        }),
        Ok(Some(path)),
    );
}

#[test]
fn view_plan_binds_revisions_and_preserves_author_owned_board_order() {
    let descriptor = NotaDescriptor {
        kind: ViewKind::Board,
        source: ViewSource::default(),
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::Exists {
                key: "status".into(),
            },
        },
        sort: SortSpec::default(),
        group_by: Some("status".into()),
        date_field: None,
        columns: vec![string_group("todo"), string_group("done")],
        presentation: BTreeMap::new(),
    };
    let mut request = ViewQuery {
        view: ViewRef {
            note: id(1),
            key: ViewKey::from_bytes([1; 16]),
        },
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::Eq {
                key: "flag".into(),
                value: ScalarValue::Bool(true),
            },
        },
        sort: None,
        group_by: None,
        limit: PageLimit::new(50).unwrap(),
    };
    let schema = BTreeMap::new();
    let revision = RevisionId::from_bytes([2; 16]);
    let plan = plan_view(&descriptor, &request, &revision, None, &schema).unwrap();
    let alternate = RevisionId::from_bytes([3; 16]);
    let later = plan_view(&descriptor, &request, &revision, Some(&alternate), &schema).unwrap();
    assert_ne!(plan.fingerprint, later.fingerprint);
    let observations = BTreeMap::from([(
        "flag".to_owned(),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Bool(true))),
    )]);
    assert!(!plan.filter.matches(&observations));
    request.sort = Some(descriptor.sort.clone());
    request.group_by = Some("status".into());
    let identical = plan_view(&descriptor, &request, &revision, None, &schema).unwrap();
    assert_eq!(identical.fingerprint, plan.fingerprint);
    request.group_by = Some("assignee".into());
    assert_eq!(
        plan_view(&descriptor, &request, &revision, None, &schema).unwrap_err(),
        invalid_query(),
    );
}

proptest! {
    #[test]
    fn bounded_grouped_keysets_equal_a_full_stable_sort(
        cases in prop::collection::vec((0_u8..6, any::<u8>(), 0_u32..60, any::<bool>()), 0..150),
        limit in 1_usize..25,
    ) {
        let sort = SortSpec::new(vec![SortKey { column: SortColumn::UpdatedAt, direction: Direction::Desc }]).unwrap();
        let columns = [string_group("todo"), string_group("done")];
        let fixtures: Vec<_> = cases.into_iter().enumerate().map(|(ordinal, (group, rank, nanos, ranked))| {
            let (group, category) = match group {
                0 => (columns[0].clone(), 0),
                1 => (columns[1].clone(), 1),
                2 => (string_group("elsewhere"), 2),
                3 => (GroupKey::EmptyList, 3),
                4 => (GroupKey::Bad, 4),
                _ => (GroupKey::Absent, 5),
            };
            let rank = ranked.then(|| format!("{rank:02x}"));
            let fixture = fixture_tuple(&sort, &columns, ordinal as u64, &group, rank.as_deref(), ts(nanos));
            (fixture, (category, !ranked, rank, if ranked { 0 } else { u32::MAX - nanos }, ordinal))
        }).collect();
        let mut reference: Vec<_> = fixtures.iter().collect();
        reference.sort_unstable_by(|(_, left), (_, right)| left.cmp(right));
        let reference: Vec<_> = reference.into_iter().map(|(tuple, _)| tuple).collect();
        let compare = |left: &&SortTuple, right: &&SortTuple| compare_view_cursor_tuple(&sort, left, right);
        let mut observed = Vec::new();
        for round in 0..=(fixtures.len() / limit) {
            let mut heap = BoundedHeap::new(limit);
            for (tuple, _) in &fixtures {
                if let Some(last) = observed.last()
                    && compare(&tuple, last).unwrap() != Ordering::Greater
                {
                    continue;
                }
                heap.push(tuple, compare).unwrap();
            }
            observed.extend(heap.finish(compare).unwrap());
            prop_assert!(observed.len() <= (round + 1) * limit);
        }
        prop_assert_eq!(observed, reference);
    }
}

#[tokio::test]
async fn retained_board_pages_match_ordered_sql_ranks_and_exact_overlay() {
    use std::{fs, num::NonZeroUsize, path::PathBuf, sync::Arc};

    use notarium_core::{
        epoch::DataRoot,
        ids::{HistoryIncarnation, ProjectionGeneration, SpaceId},
        model::Lifecycle,
        query::{Bound, ValueRange},
        value::Date,
    };

    use crate::index::{
        FastIndexBuilder, IndexIdentity, IndexNote, L0Delta, MmapPool, NoteSortHeader,
    };

    struct Directory(PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    let directory = Directory(std::env::temp_dir().join(format!(
        "notarium-board-window-{:016x}",
        getrandom::u64().unwrap()
    )));
    let layout = DataRoot::new(directory.0.clone());
    let generation = ProjectionGeneration::new(1).unwrap();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([9; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let cut = SpaceSeq::new(17).unwrap();
    let folder = FolderId::from_bytes([2; 16]);
    let focus = FolderId::from_bytes([3; 16]);

    // Compare the in-memory and indexed SQL rank paths against the same exact
    // reference, including a bounded replacement and ranks from an old group.
    let store = DerivedStore::open_sqlite(&layout, generation)
        .await
        .unwrap();
    let mut index = FastIndexBuilder::default();
    index.add_folder(0, &folder, Lifecycle::Active).unwrap();
    index.add_folder(1, &focus, Lifecycle::Active).unwrap();
    let date = Date::parse("2026-01-04").unwrap();
    let outside = Date::parse("2026-02-01").unwrap();
    let observations = |phase, status: &str, due| {
        BTreeMap::from([
            (
                "phase".into(),
                FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Bool(phase))),
            ),
            (
                "status".into(),
                FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(status.into()))),
            ),
            (
                "due".into(),
                FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Date(due))),
            ),
        ])
    };
    let ordinal = |dense| u64::from(512 - dense);
    let updated = |dense| ts(dense % 5 * 1_000 + dense % 3 * 23);
    for dense in 0_u32..512 {
        let fields = observations(
            dense % 13 != 12,
            if dense.is_multiple_of(2) {
                "todo"
            } else {
                "done"
            },
            if dense % 11 == 10 { outside } else { date },
        );
        let tags = if dense % 7 == 6 {
            &[][..]
        } else {
            &["focus".into()][..]
        };
        index
            .add_note(IndexNote {
                dense,
                id: &id(ordinal(dense)),
                header: NoteSortHeader::new(
                    updated(dense),
                    ts(dense),
                    if dense % 17 == 16 { 0 } else { 1 },
                    DocClass::UserDoc,
                    Lifecycle::Active,
                ),
                ancestors: &[0],
                trashed_ancestor: false,
                fields: &fields,
                tags,
                ability: None,
            })
            .unwrap();
    }
    let identity = IndexIdentity {
        generation,
        scope: scope.clone(),
        seq: cut,
    };
    let path = layout.space_fast_index(generation, &scope.space_id, cut);
    let (handle, _) = index.publish(&path, identity).unwrap();
    let pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let mut delta = L0Delta::default();
    let l0_updated = ts(4_023);
    delta
        .replace_note(IndexNote {
            dense: 2,
            id: &id(ordinal(2)),
            header: NoteSortHeader::new(l0_updated, ts(2), 1, DocClass::UserDoc, Lifecycle::Active),
            ancestors: &[0],
            trashed_ancestor: false,
            fields: &observations(true, "todo", date),
            tags: &["focus".into()],
            ability: None,
        })
        .unwrap();
    let index = IndexView::new(handle.open(&pool).unwrap(), Arc::new(delta));
    let source = ViewSource {
        tags: BTreeSet::from(["focus".into()]),
        ..ViewSource::default()
    };
    let universe = view_source_candidates(
        &index,
        &source,
        Some(&focus),
        posting(&index, &PostingKey::Active).unwrap(),
    )
    .unwrap();

    let filter = Predicate::All(vec![
        Predicate::Eq {
            key: "phase".into(),
            value: ScalarValue::Bool(true),
        },
        Predicate::DateRange {
            key: "due".into(),
            range: ValueRange {
                lower: Some(Bound {
                    value: date,
                    inclusive: true,
                }),
                upper: Some(Bound {
                    value: outside,
                    inclusive: false,
                }),
            },
        },
    ]);
    let columns = [
        string_group("todo"),
        string_group("done"),
        string_group("waiting"),
    ];
    let ranks: BTreeMap<_, _> = (0_u32..150)
        .map(|dense| {
            let rank = format!("{:03}", dense / 5);
            (
                dense,
                BoardRank {
                    group: string_group("done"),
                    rank,
                },
            )
        })
        .collect();
    let replacement = ProjectedNote {
        space_id: scope.space_id.clone(),
        dense_id: 0,
        note_id: id(ordinal(0)),
        rev_id: RevisionId::from_bytes([4; 16]),
        parent_folder_id: focus,
        dense_folder_id: 1,
        ability_id: None,
        slug: "moved".into(),
        slug_fold: "moved".into(),
        title: "Moved".into(),
        title_fold: "moved".into(),
        preview: String::new(),
        doc_class: DocClass::UserDoc,
        lifecycle: Lifecycle::Active,
        byte_size: 0,
        content_digest: None,
        tags_msgpack: Vec::new(),
        view_blocks_msgpack: Vec::new(),
        created_at_sec: -1,
        created_at_nsec: 0,
        updated_at_sec: -1,
        updated_at_nsec: 999,
        raw_fields_msgpack: Vec::new(),
        header_diagnostic_msgpack: Vec::new(),
        evaluated_fields_msgpack: encode_msgpack(&observations(true, "done", date)).unwrap(),
        diagnostics_msgpack: Vec::new(),
        rank_version: ContentDigest::from_bytes([0; 32]),
        has_pending_nota: false,
        has_invalid_nota: false,
    };
    use crate::derived::{DerivedMutation, ProjectedViewRank, ProjectionWatermark, SpaceApply};
    let view = ViewRef {
        note: id(9999),
        key: ViewKey::from_bytes([9; 16]),
    };
    let mut mutations = Vec::new();
    for dense in 0..512 {
        let note = id(ordinal(dense));
        let mut row = replacement.clone();
        row.dense_id = dense;
        row.note_id = note.clone();
        row.slug = format!("card-{dense}");
        row.slug_fold = row.slug.clone();
        mutations.push(DerivedMutation::UpsertNote(Box::new(row)));
        if let Some(rank) = ranks.get(&dense) {
            let (group_key_msgpack, group_key_hex) = group_key_hex(&rank.group).unwrap();
            mutations.push(DerivedMutation::UpsertViewRank(ProjectedViewRank {
                space_id: scope.space_id.clone(),
                view_note_id: view.note.clone(),
                view_key: view.key.clone(),
                target_note_id: note,
                rank_rev_id: replacement.rev_id.clone(),
                placement_revision: replacement.rev_id.clone(),
                group_key_msgpack,
                group_key_hex,
                sort_rank_lexo: rank.rank.clone(),
                updated_seq: cut,
            }));
        }
    }
    store
        .apply(&SpaceApply {
            expected: None,
            watermark: ProjectionWatermark {
                scope: scope.clone(),
                root_folder_id: folder,
                next_dense_id: 512,
                next_dense_folder_id: 2,
                projected_seq: cut,
                snapshot_seq: cut,
                graph_settled_seq: cut,
                schema: None,
                seed_in_progress: false,
                updated_at_ms: 0,
            },
            mutations,
        })
        .await
        .unwrap();
    let overlay = BTreeMap::from([(0, replacement)]);
    let matches: Vec<_> = (0_u32..512)
        .filter(|n| n % 7 != 6 && n % 11 != 10 && n % 13 != 12 && n % 17 != 16)
        .collect();
    let todo_count = matches.iter().filter(|&&n| n != 0 && n % 2 == 0).count() as u64;
    let expected_counts = [todo_count, matches.len() as u64 - todo_count, 0];

    for direction in [Direction::Asc, Direction::Desc] {
        let sort = SortSpec::new(vec![SortKey {
            column: SortColumn::UpdatedAt,
            direction,
        }])
        .unwrap();
        // Compare every cursor and row against the exact, unbounded tuple
        // sort. Dense IDs run opposite to NoteIds, timestamps share a
        // microsecond, and several rows share a placement rank.
        let mut expected: Vec<_> = matches
            .iter()
            .map(|&dense| {
                let group = &columns[usize::from(dense == 0 || dense % 2 != 0)];
                let rank = ranks
                    .get(&dense)
                    .filter(|rank| &rank.group == group)
                    .map(|rank| rank.rank.as_str());
                let time = match dense {
                    0 => ts(999),
                    2 => l0_updated,
                    _ => updated(dense),
                };
                (
                    dense,
                    fixture_tuple(&sort, &columns, ordinal(dense), group, rank, time),
                )
            })
            .collect();
        expected.sort_unstable_by(|(_, left), (_, right)| {
            compare_view_cursor_tuple(&sort, left, right).unwrap()
        });

        let limit = PageLimit::new(6).unwrap();
        let size = usize::from(limit.get());
        let mut after = None;
        for (page_index, window) in expected.chunks(size).enumerate() {
            let input = WindowInput {
                index: &index,
                store: &store,
                scope: &scope,
                cut,
                candidates: &universe,
                filter: &filter,
                sort: &sort,
                group_by: Some("status"),
                columns: &columns,
                board: true,
                ranks: &ranks,
                overlay: &overlay,
                after: after.as_ref(),
                limit,
            };
            let page = select_window(input).await.unwrap();
            let exact_ranks = BTreeMap::from([(0, ranks[&0].clone())]);
            let from_sql = select_view_window(
                WindowInput {
                    ranks: &exact_ranks,
                    ..input
                },
                Some(&view),
            )
            .await
            .unwrap();
            assert_eq!(from_sql.groups, page.groups);
            assert_eq!(from_sql.has_more, page.has_more);
            assert!(
                from_sql
                    .rows
                    .iter()
                    .map(|r| (r.dense_id, &r.tuple, &r.rank))
                    .eq(page.rows.iter().map(|r| (r.dense_id, &r.tuple, &r.rank)))
            );
            assert_eq!(
                page.groups
                    .iter()
                    .map(|group| group.count)
                    .collect::<Vec<_>>(),
                expected_counts
            );
            assert_eq!(page.rows.len(), window.len());
            assert_eq!(page.has_more, (page_index + 1) * size < expected.len());
            for (row, (dense, tuple)) in page.rows.iter().zip(window) {
                assert_eq!((row.dense_id, &row.tuple), (*dense, tuple));
            }
            after = page.rows.into_iter().last().map(|row| row.tuple);
        }
    }

    // No stored ranks for this group, while other groups have 150. The first
    // row carries an exact-overlay rank; the subsequent cursor is unranked.
    let mode = SortSpec::default();
    let all = Predicate::All(Vec::new());
    let candidates = Bitmap::from_range(0..512);
    let current_group = GroupKey::Value(ScalarValue::Bool(true));
    let overlay_rank = BTreeMap::from([(
        0,
        BoardRank {
            group: current_group.clone(),
            rank: "first".into(),
        },
    )]);
    let mut cursor = None;
    for (page, max_transactions) in [1, 2, 1].into_iter().enumerate() {
        store.take_sqlite_read_work();
        let result = select_view_window(
            WindowInput {
                index: &index,
                store: &store,
                scope: &scope,
                cut,
                candidates: &candidates,
                filter: &all,
                sort: &mode,
                group_by: Some("phase"),
                columns: std::slice::from_ref(&current_group),
                board: true,
                ranks: &overlay_rank,
                overlay: &overlay,
                after: cursor.as_ref(),
                limit: PageLimit::new(1).unwrap(),
            },
            Some(&view),
        )
        .await
        .unwrap();
        let (transactions, progress) = store.take_sqlite_read_work();
        assert!(
            (1..=max_transactions).contains(&transactions),
            "page {page} took {transactions} transactions"
        );
        assert!(
            progress < 8,
            "page {page} used at least {} SQLite VM steps",
            progress * 128
        );
        let row = result.rows.first().unwrap();
        assert_eq!(row.rank.is_some(), page == 0);
        if let Some(previous) = &cursor {
            assert_eq!(
                compare_view_cursor_tuple(&mode, previous, &row.tuple).unwrap(),
                Ordering::Less
            );
        }
        cursor = Some(row.tuple.clone());
    }
}
