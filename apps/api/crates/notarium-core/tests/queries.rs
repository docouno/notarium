use notarium_core::{DomainError, error::*, ids::*, model::*, query::*, receipt::*, value::*};
use std::{cmp::Ordering, collections::BTreeMap};

fn scope(history: u8) -> HistoryScope {
    HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([history; 16]),
    }
}
fn seq(n: u64) -> SpaceSeq {
    SpaceSeq::new(n).unwrap()
}
fn receipt(n: u64) -> MutationReceiptToken {
    MutationReceiptToken::new(scope(1), seq(n)).unwrap()
}
fn version(note: u8, revision: u8) -> OverlayRowVersion {
    OverlayRowVersion {
        note_id: NoteId::from_bytes([note; 16]),
        revision: RevisionId::from_bytes([revision; 16]),
        rank_version: ContentDigest::from_bytes([revision; 32]),
    }
}

#[test]
fn exact_numbers_compare_represented_values_without_f64_rounding() {
    let a = ExactNumber::from(9_007_199_254_740_992_u64);
    let b = ExactNumber::from(9_007_199_254_740_993_u64);
    assert!(a < b);
    assert!(b > ExactNumber::from_f64(9_007_199_254_740_992.0).unwrap());
    assert!(
        ExactNumber::from(u64::MAX) < ExactNumber::from_f64(18_446_744_073_709_551_616.0).unwrap()
    );
    assert_eq!(
        ExactNumber::from(i64::MIN),
        ExactNumber::from_f64(-9_223_372_036_854_775_808.0).unwrap()
    );
    assert!(
        ExactNumber::from(i64::MAX) < ExactNumber::from_f64(9_223_372_036_854_775_808.0).unwrap()
    );
    for i in -20..20_i64 {
        let n = ExactNumber::from(i);
        assert_eq!(n, ExactNumber::from_f64(i as f64).unwrap());
        assert!(n < ExactNumber::from_f64(i as f64 + 0.5).unwrap());
        assert!(n > ExactNumber::from_f64(i as f64 - 0.5).unwrap());
    }
    assert_eq!(
        ExactNumber::from(0_i64),
        ExactNumber::from_f64(-0.0).unwrap()
    );
    assert!(ExactNumber::from(0_i64) < ExactNumber::from_f64(f64::MIN_POSITIVE).unwrap());
    assert!(ExactNumber::from_f64(f64::NAN).is_err());
    assert!(ExactNumber::from_f64(f64::INFINITY).is_err());
}

#[test]
fn dates_validate_calendar_and_timestamps_keep_precision_and_offsets() {
    assert!(Date::parse("2024-02-29").is_ok());
    for invalid in [
        "2023-02-29",
        "2024-04-31",
        "2024-2-29",
        "2024-13-01",
        "2024-01-01Z",
    ] {
        assert!(Date::parse(invalid).is_err());
    }
    let a = Timestamp::parse("2024-01-01T01:00:00.123456789+01:00").unwrap();
    let b = Timestamp::parse("2024-01-01T00:00:00.123456789Z").unwrap();
    assert_eq!(a, b);
    assert_eq!(a.nanosecond(), 123456789);
    assert_eq!(String::from(a), "2024-01-01T00:00:00.123456789Z");
    assert!(Timestamp::parse("2024-01-01T00:00:00.1234567891Z").is_err());
}

#[test]
fn timestamp_admission_rejects_unrepresentable_instants_without_rounding_or_panics() {
    for value in [
        "9999-12-31T23:59:59-00:01",
        "9999-12-31T23:59:59.999999999-23:59",
        "0000-01-01T00:00:00+00:01",
        "0000-01-01T00:00:00.000000001+23:59",
        "2016-12-31T23:59:60Z",
        "2016-12-31T23:59:60.100000001Z",
        "2016-12-31T23:59:60.200000002Z",
        "2017-01-01T00:59:60+01:00",
        "2024-01-01T00:00:00.1234567890Z",
    ] {
        assert_eq!(
            Timestamp::parse(value),
            Err(DomainError::validation(ValidationReason::InvalidTimestamp)),
            "{value}"
        );
        assert!(serde_json::from_str::<Timestamp>(&serde_json::to_string(value).unwrap()).is_err());
    }
    for (input, expected) in [
        ("0000-01-01T00:00:00Z", "0000-01-01T00:00:00Z"),
        ("0000-01-01T23:59:00+23:59", "0000-01-01T00:00:00Z"),
        (
            "9999-12-31T23:59:59.999999999Z",
            "9999-12-31T23:59:59.999999999Z",
        ),
        (
            "9999-12-31T00:00:59.999999999-23:59",
            "9999-12-31T23:59:59.999999999Z",
        ),
        (
            "2016-12-31T23:59:59.100000001Z",
            "2016-12-31T23:59:59.100000001Z",
        ),
        (
            "2016-12-31T23:59:59.200000002Z",
            "2016-12-31T23:59:59.200000002Z",
        ),
    ] {
        let value = Timestamp::parse(input).unwrap();
        assert_eq!(String::from(value), expected);
        let decoded: Timestamp =
            serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
        assert_eq!(decoded, value);
    }
}

#[test]
fn field_truth_tables_keep_null_empty_bad_and_absent_distinct() {
    let empty = ScalarValue::String(String::new());
    let observations = [
        FieldObservation::Ok(FieldValue::Scalar(empty.clone())),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Null)),
        FieldObservation::Ok(FieldValue::List(vec![])),
        FieldObservation::Bad {
            diagnostic: Diagnostic {
                reason: ValidationReason::InvalidQuery,
                location: None,
            },
        },
        FieldObservation::Absent,
    ];
    for (index, value) in observations.into_iter().enumerate() {
        let fields = BTreeMap::from([("status".into(), value)]);
        let eval = |predicate| {
            FieldFilterAstV1 {
                version: 1,
                predicate,
            }
            .matches(
                &fields,
                &BTreeMap::from([(
                    "status".into(),
                    FieldSchema {
                        kind: FieldType::Scalar(ScalarType::String),
                        nullable: true,
                    },
                )]),
            )
            .unwrap()
        };
        assert_eq!(
            eval(Predicate::Eq {
                key: "status".into(),
                value: empty.clone()
            }),
            index == 0
        );
        assert_eq!(
            eval(Predicate::Not(Box::new(Predicate::Eq {
                key: "status".into(),
                value: empty.clone()
            }))),
            index != 0
        );
        assert_eq!(
            eval(Predicate::Exists {
                key: "status".into()
            }),
            index != 4
        );
        assert_eq!(
            eval(Predicate::IsBad {
                key: "status".into()
            }),
            index == 3
        );
        assert_eq!(
            eval(Predicate::IsAbsent {
                key: "status".into()
            }),
            index == 4
        );
    }
    let schema = BTreeMap::from([(
        "status".into(),
        FieldSchema {
            kind: FieldType::Scalar(ScalarType::String),
            nullable: true,
        },
    )]);
    assert!(
        FieldFilterAstV1 {
            version: 2,
            predicate: Predicate::Exists {
                key: "status".into()
            }
        }
        .validate(&schema)
        .is_err()
    );
    assert!(
        FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::Contains {
                key: "status".into(),
                value: empty
            }
        }
        .validate(&schema)
        .is_err()
    );
    assert!(
        ValueRange {
            lower: Some(Bound {
                value: 2,
                inclusive: true
            }),
            upper: Some(Bound {
                value: 1,
                inclusive: true
            })
        }
        .validate()
        .is_err()
    );
}

#[test]
fn descending_only_reverses_scalars_and_note_tie_break_is_always_ascending() {
    let cells = [
        SortCell::Value(ScalarValue::String("".into())),
        SortCell::Value(ScalarValue::String("z".into())),
        SortCell::Null,
        SortCell::Bad,
        SortCell::Absent,
    ];
    for direction in [Direction::Asc, Direction::Desc] {
        let spec = SortSpec::new(vec![SortKey {
            column: SortColumn::Field {
                key: "field".into(),
                schema: FieldSchema {
                    kind: FieldType::Scalar(ScalarType::String),
                    nullable: true,
                },
            },
            direction,
        }])
        .unwrap();
        let tuple = |cell: SortCell, id| SortTuple {
            cells: vec![cell],
            entity_id: NoteId::from_bytes([id; 16]),
        };
        let mut rows: Vec<_> = cells
            .iter()
            .enumerate()
            .map(|(i, c)| tuple(c.clone(), i as u8))
            .collect();
        rows.sort_by(|a, b| spec.compare(a, b).unwrap());
        assert_eq!(rows[2].cells, vec![SortCell::Null]);
        assert_eq!(rows[3].cells, vec![SortCell::Bad]);
        assert_eq!(rows[4].cells, vec![SortCell::Absent]);
        assert_eq!(
            rows[0].cells,
            vec![cells[usize::from(direction == Direction::Desc)].clone()]
        );
        assert_eq!(
            spec.compare(&tuple(cells[0].clone(), 1), &tuple(cells[0].clone(), 2))
                .unwrap(),
            Ordering::Less
        );
    }
    for kind in [FieldType::List(ScalarType::String), FieldType::Map] {
        assert!(
            SortSpec::new(vec![SortKey {
                column: SortColumn::Field {
                    key: "x".into(),
                    schema: FieldSchema {
                        kind,
                        nullable: true
                    }
                },
                direction: Direction::Asc
            }])
            .is_err()
        );
    }
}

#[test]
fn exact_receipts_survive_large_gaps_and_bulk_effects_force_waiting() {
    let receipts = ReceiptSet::new([receipt(101), receipt(50102), receipt(101)]).unwrap();
    assert_eq!(receipts.tokens().len(), 2);
    assert_eq!(
        AwaitWatermarks::from_receipts(receipts.tokens().to_vec())
            .required(&scope(1))
            .unwrap(),
        seq(50102)
    );
    let effects = vec![
        TrustedMutationEffect {
            receipt: receipt(101),
            effect: MutationEffect::Notes {
                versions: vec![version(1, 1)],
                payload_bytes: 10,
            },
        },
        TrustedMutationEffect {
            receipt: receipt(50102),
            effect: MutationEffect::Notes {
                versions: vec![version(2, 2)],
                payload_bytes: 10,
            },
        },
    ];
    assert_eq!(
        plan_overlay(&scope(1), seq(100), &receipts, &effects, 100).unwrap(),
        OverlayDecision::Bounded {
            versions: vec![version(1, 1), version(2, 2)]
        }
    );
    assert!(ReceiptSet::new((1..=9).map(receipt)).is_err());
    assert!(MutationReceiptToken::new(scope(1), SpaceSeq::ZERO).is_err());
    let bulk = TrustedMutationEffect {
        receipt: receipt(101),
        effect: MutationEffect::Notes {
            versions: (0..100).map(|id| version(id, 1)).collect(),
            payload_bytes: 100,
        },
    };
    assert!(matches!(
        plan_overlay(
            &scope(1),
            seq(100),
            &ReceiptSet::new([receipt(101)]).unwrap(),
            &[bulk],
            1000
        )
        .unwrap(),
        OverlayDecision::AwaitProjection {
            reason: AwaitReason::TooManyNotes,
            ..
        }
    ));
    let same_note = vec![
        effects[0].clone(),
        TrustedMutationEffect {
            receipt: receipt(50102),
            effect: MutationEffect::Notes {
                versions: vec![version(1, 2)],
                payload_bytes: 10,
            },
        },
    ];
    assert_eq!(
        plan_overlay(&scope(1), seq(100), &receipts, &same_note, 100).unwrap(),
        OverlayDecision::Bounded {
            versions: vec![version(1, 2)]
        }
    );
}

#[test]
fn restored_history_invalidates_receipts_cursors_commands_and_external_ack() {
    assert!(receipt(101).scope().check(&scope(2)).is_err());
    assert!(
        ChangeCursor {
            scope: scope(1),
            after: seq(101)
        }
        .check(&scope(2))
        .unwrap_err()
        .requires_resync()
    );
    let mut ack = AcknowledgedCursor {
        scope: scope(1),
        seq: seq(101),
    }
    .restore(scope(2), seq(100))
    .unwrap();
    assert_eq!(ack.seq, seq(100));
    assert!(
        ack.acknowledge(&ChangeCursor {
            scope: scope(1),
            after: seq(101)
        })
        .is_err()
    );
    let command = CommandIdentity {
        scope: scope(1),
        actor: PrincipalId::from_bytes([1; 16]),
        key: CommandKey::from_bytes([1; 16]),
        hash: ContentDigest::from_bytes([1; 32]),
    };
    assert!(
        command
            .check_retry(&command, &scope(2))
            .unwrap_err()
            .requires_resync()
    );
    let reused = CommandIdentity {
        hash: ContentDigest::from_bytes([2; 32]),
        ..command.clone()
    };
    assert_eq!(
        command.check_retry(&reused, &scope(1)),
        Err(DomainError::IdempotencyKeyReused)
    );
}

#[test]
fn continuation_retains_the_effective_overlay_after_client_receipt_eviction() {
    let read = EffectiveRead {
        id: EffectiveReadId::from_bytes([1; 16]),
        cut: SnapshotCut {
            scope: scope(1),
            generation: ProjectionGeneration::new(1).unwrap(),
            canonical_seq: seq(101),
            projected_seq: seq(100),
        },
        fingerprint: ContentDigest::from_bytes([1; 32]),
        exact_receipts: ReceiptSet::new([receipt(101)]).unwrap(),
        overlay: vec![version(3, 2)],
    };
    let cursor = KeysetCursor {
        version: 1,
        scope: scope(1),
        fingerprint: read.fingerprint,
        effective_read: read.id.clone(),
        generation: read.cut.generation,
        base_cut: seq(100),
        last: SortTuple {
            cells: vec![SortCell::Value(ScalarValue::Number(0_i64.into()))],
            entity_id: NoteId::from_bytes([3; 16]),
        },
    };
    let mut client = read.exact_receipts.clone();
    client.discard_caught_up(&scope(1), seq(101));
    assert!(client.tokens().is_empty());
    assert!(cursor.check(&read).is_ok());
    assert_eq!(read.overlay, vec![version(3, 2)]);
    let renewed = EffectiveRead {
        id: EffectiveReadId::from_bytes([2; 16]),
        ..read.clone()
    };
    assert!(cursor.check(&renewed).unwrap_err().requires_resync());
    let restored = EffectiveRead {
        cut: SnapshotCut {
            scope: scope(2),
            ..read.cut.clone()
        },
        ..read
    };
    assert!(cursor.check(&restored).unwrap_err().requires_resync());
}

#[test]
fn operational_failures_do_not_claim_rollback_or_allow_non_idempotent_retries() {
    let failure = OperationalFailure::new(
        ContentDigest::from_bytes([0; 32]),
        CommitEffect::Unknown,
        RetryAdvice::RetrySameCommand,
        true,
    )
    .unwrap();
    assert_eq!(failure.effect(), CommitEffect::Unknown);
    assert_eq!(
        PortError::DeadlineExceeded(failure).code(),
        "deadline_exceeded"
    );
    assert!(
        OperationalFailure::new(
            ContentDigest::from_bytes([0; 32]),
            CommitEffect::Unknown,
            RetryAdvice::RetrySameCommand,
            false
        )
        .is_err()
    );
}

#[test]
fn every_domain_error_has_a_unique_serialized_code_and_safe_typed_details() {
    let revision = RevisionId::from_bytes([1; 16]);
    let errors = [
        DomainError::ResourceNotFound,
        DomainError::RevisionConflict {
            current: revision.clone(),
            lineage: None,
        },
        DomainError::PathConflict {
            target: PathTarget {
                space_id: SpaceId::from_bytes([1; 16]),
                parent: None,
                component: "collision.md".into(),
            },
        },
        DomainError::UnsafePlaintextOutsideAgeFence,
        DomainError::AbilityWriteForbidden,
        DomainError::CrossSpaceTainted,
        DomainError::RoleModifiedReconsent {
            approved: revision.clone(),
            current: revision,
        },
        DomainError::IdempotencyKeyReused,
        DomainError::RateLimited {
            retry_after_ms: 1000,
            budget: BudgetKind::Requests,
        },
        DomainError::MigrationInProgress,
        DomainError::validation(ValidationReason::InvalidSpan),
        DomainError::SpaceReadOnly,
    ];
    let mut codes = std::collections::BTreeSet::new();
    for error in errors {
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], error.code());
        assert!(codes.insert(error.code()));
        assert_eq!(serde_json::from_value::<DomainError>(value).unwrap(), error);
    }
    assert_eq!(codes.len(), 12);
}
