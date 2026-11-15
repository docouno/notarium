use notarium_core::{auth::*, classes::*, ids::*, model::*, query::*, value::*};
use std::{
    cmp::Ordering,
    collections::BTreeMap,
    sync::atomic::{AtomicUsize, Ordering as AtomicOrdering},
};

#[test]
fn numeric_json_cursors_preserve_equal_value_continuation() {
    for value in [
        f64::from_bits(1.0_f64.to_bits() - 1),
        -f64::from_bits(1.0_f64.to_bits() - 1),
        f64::from_bits(1),
        f64::MIN_POSITIVE,
        f64::MAX,
        f64::MIN,
    ] {
        let number = ExactNumber::from_f64(value).unwrap();
        let wire = serde_json::to_string(&number).unwrap();
        assert_eq!(serde_json::from_str::<ExactNumber>(&wire).unwrap(), number);
        for direction in [Direction::Asc, Direction::Desc] {
            let sort = SortSpec::new(vec![SortKey {
                column: SortColumn::Field {
                    key: "weight".into(),
                    schema: FieldSchema {
                        kind: FieldType::Scalar(ScalarType::Number),
                        nullable: false,
                    },
                },
                direction,
            }])
            .unwrap();
            let cells = vec![SortCell::Value(ScalarValue::Number(number.clone()))];
            let cursor = KeysetCursor {
                version: 1,
                scope: HistoryScope {
                    space_id: SpaceId::from_bytes([1; 16]),
                    incarnation: HistoryIncarnation::from_bytes([1; 16]),
                },
                fingerprint: ContentDigest::from_bytes([1; 32]),
                effective_read: EffectiveReadId::from_bytes([1; 16]),
                generation: ProjectionGeneration::new(1).unwrap(),
                base_cut: SpaceSeq::new(1).unwrap(),
                last: SortTuple {
                    cells: cells.clone(),
                    entity_id: NoteId::from_bytes([1; 16]),
                },
            };
            let next = SortTuple {
                cells,
                entity_id: NoteId::from_bytes([2; 16]),
            };
            let decoded: KeysetCursor =
                serde_json::from_str(&serde_json::to_string(&cursor).unwrap()).unwrap();
            assert_eq!(
                sort.compare(&next, &decoded.last).unwrap(),
                Ordering::Greater
            );
        }
    }
}

#[test]
fn metadata_only_cards_preserve_class_lifecycle_and_authority_fences() {
    let space = SpaceId::from_bytes([1; 16]);
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([1; 16]),
        BTreeMap::from([(
            space.clone(),
            SpaceGrant {
                role: SpaceRole::Viewer,
                read_classes: DocClass::all(),
                write_classes: Default::default(),
                project_root: None,
            },
        )]),
        false,
    ));
    for class in DocClass::all() {
        for lifecycle in [Lifecycle::Active, Lifecycle::Trashed, Lifecycle::Purged] {
            for actual_space in [space.clone(), SpaceId::from_bytes([2; 16])] {
                let metadata = ClassifiedMetadata::from_canonical(
                    NoteRef {
                        space_id: actual_space.clone(),
                        note_id: NoteId::from_bytes([3; 16]),
                    },
                    RevisionId::from_bytes([4; 16]),
                    ResourceFacts {
                        space: Space {
                            id: actual_space.clone(),
                            lifecycle: SpaceLifecycle::Active,
                            kind: SpaceKind::Personal,
                        },
                        class,
                        ancestor_folders: vec![],
                        folder_write_locked: false,
                        ability_package: None,
                    },
                    lifecycle,
                    ContentDigest::from_bytes([5; 32]),
                )
                .unwrap();
                assert_eq!(
                    metadata.listing(&auth).is_ok(),
                    actual_space == space && lifecycle != Lifecycle::Purged
                );
                let result = ClassEgressFence::search_metadata(metadata, &auth);
                assert_eq!(
                    result.is_ok(),
                    actual_space == space
                        && lifecycle == Lifecycle::Active
                        && class != DocClass::EncryptedNote
                );
                if let Ok(document) = result {
                    let card = notarium_core::ports::NoteCard {
                        document,
                        title: "Title".into(),
                        path: "Folder/title".into(),
                        preview: "preview".into(),
                    };
                    assert_eq!(card.document.provenance().class(), class);
                    assert_eq!(
                        card.document.provenance().revision(),
                        &RevisionId::from_bytes([4; 16])
                    );
                }
            }
        }
    }
}

#[test]
fn compressed_indices_are_lazy_and_keep_the_originating_generation() {
    let generation = ProjectionGeneration::new(1).unwrap();
    let other = ProjectionGeneration::new(2).unwrap();
    let visits = AtomicUsize::new(0);
    let source = (0..1_000_000).inspect(|_| {
        visits.fetch_add(1, AtomicOrdering::Relaxed);
    });
    let mut nodes = DenseNodeIter::from_iter(generation, source);
    assert_eq!(visits.load(AtomicOrdering::Relaxed), 0);
    let first = nodes.next().unwrap();
    assert_eq!(first.index(generation).unwrap(), 0);
    assert!(first.index(other).is_err());
    assert_eq!(visits.load(AtomicOrdering::Relaxed), 1);
    let native = [3, 7, 11];
    assert_eq!(
        DenseNodeIter::from_slice(generation, &native)
            .map(|node| node.index(generation).unwrap())
            .collect::<Vec<_>>(),
        native
    );
    fn send<T: Send>(_: T) {}
    send(nodes);
}
