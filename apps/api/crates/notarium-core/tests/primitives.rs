use notarium_core::{
    DomainError,
    epoch::*,
    error::ValidationReason,
    ids::*,
    model::HistoryScope,
    span::{ByteSpan, Utf16Span, decode_utf8, decode_utf16},
};

#[test]
fn all_domain_brands_preserve_v1_and_legacy_identity() {
    macro_rules! check {
        ($($id:ident),+ $(,)?) => {$ ({
            let id = $id::from_bytes([0xab; 16]);
            assert_eq!($id::parse_v1(id.as_str()).unwrap(), id);
            assert_eq!(serde_json::from_str::<$id>(&serde_json::to_string(&id).unwrap()).unwrap(), id);
            for legacy in ["ab_CD-012345", "FEDCBA9876543210", "nt_123456789"] {
                let parsed = $id::parse(legacy).unwrap();
                assert_eq!(parsed.as_str(), legacy);
                assert!($id::parse_v1(legacy).is_err());
                assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
            }
            for bad in ["", "../file", " nt_123456789", "Тест01234567", "a" ] {
                assert!($id::parse(bad).is_err(), "{}", stringify!($id));
                assert!(serde_json::from_value::<$id>(serde_json::json!(bad)).is_err());
            }
        })+};
    }
    check!(
        SpaceId,
        FolderId,
        NoteId,
        RevisionId,
        ViewKey,
        ChatThreadId,
        AgentRunId,
        ScheduleId,
        JobId,
        EpisodeId,
        AbilityId,
        ProviderResourceId,
        CredentialId,
        ClusterId
    );
    assert!(NoteId::parse(SpaceId::from_bytes([2; 16]).as_str()).is_err());
    assert!(NoteId::parse(ClusterId::from_bytes([2; 16]).as_str()).is_err());
    assert!(ClusterId::parse(NoteId::from_bytes([2; 16]).as_str()).is_err());
    assert!(NoteId::parse_v1(&format!("nt_{}", "AB".repeat(16))).is_err());
}

#[test]
fn counters_cannot_overflow_sql_or_cross_history_on_restore() {
    assert_eq!(
        SpaceSeq::MAX.checked_next(),
        Err(DomainError::validation(ValidationReason::SequenceOverflow))
    );
    assert!(serde_json::from_value::<SpaceSeq>(serde_json::json!(u64::MAX)).is_err());
    let old = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let restored = HistoryScope {
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
        ..old.clone()
    };
    assert!(restored.check(&old).unwrap_err().requires_resync());
    assert!(old.check(&old).is_ok());
}

#[test]
fn unicode_units_match_an_independent_utf16_oracle_at_every_boundary() {
    for source in [
        "",
        "A🚀B",
        "Привет 世界 e\u{301} 👩\u{200d}🔬\r\nend",
        "\u{feff}---\nstatus: todo\n---\nA🚀B\n",
    ] {
        let boundaries: Vec<_> = source
            .char_indices()
            .map(|(i, _)| i)
            .chain([source.len()])
            .collect();
        let utf16: Vec<_> = source.encode_utf16().collect();
        for &start in &boundaries {
            for &end in boundaries.iter().filter(|&&n| n >= start) {
                let span = ByteSpan::checked(source, start, end).unwrap();
                let expected_start = source[..start].encode_utf16().count();
                let expected_end = source[..end].encode_utf16().count();
                let converted = span.to_utf16(source).unwrap();
                assert_eq!(
                    (converted.start(), converted.end()),
                    (expected_start, expected_end)
                );
                assert_eq!(converted.to_bytes(source).unwrap(), span);
                assert_eq!(
                    String::from_utf16(&utf16[expected_start..expected_end]).unwrap(),
                    &source[start..end]
                );
            }
        }
        for offset in 0..source.len() {
            if !source.is_char_boundary(offset) {
                assert!(ByteSpan::checked(source, offset, offset).is_err());
            }
        }
    }
    assert!(Utf16Span::new(2, 2).unwrap().to_bytes("A🚀B").is_err());
    assert!(ByteSpan::new(4, 3).is_err());
    assert!(serde_json::from_str::<ByteSpan>("[4,3]").is_err());
    assert!(decode_utf8(&[0xf0, 0x80]).is_err());
    assert!(decode_utf16(&[0xd800]).is_err());
    assert!(decode_utf16(&[0xdc00]).is_err());
}

fn empty() -> StorageEpochFacts {
    StorageEpochFacts {
        manifest: MarkerObservation::Missing,
        control: MarkerObservation::Missing,
        canonical: MarkerObservation::Missing,
        migration: MarkerObservation::Missing,
        keyring: MarkerObservation::Missing,
        key_rows_exist: false,
        legacy: MarkerObservation::Missing,
        has_unrecognized_entries: false,
        observation_complete: true,
    }
}
fn ready() -> StorageEpochFacts {
    let installation_id = InstallationId::from_bytes([1; 16]);
    let database = DatabaseWitness {
        epoch_version: 1,
        installation_id: installation_id.clone(),
        state: DatabaseState::Ready,
    };
    StorageEpochFacts {
        manifest: MarkerObservation::Present(EpochManifestV1 {
            epoch_version: 1,
            installation_id,
            state: ReadyState::V1Ready,
            receipt_sha256: None,
        }),
        control: MarkerObservation::Present(database.clone()),
        canonical: MarkerObservation::Present(database),
        ..empty()
    }
}

#[test]
fn epoch_classification_requires_positive_consistent_evidence() {
    use StorageEpochState::*;
    assert_eq!(classify(&empty()).state, EmptyRoot);
    assert_eq!(classify(&ready()).state, V1Ready);
    let mut facts = empty();
    facts.legacy = MarkerObservation::Present(());
    assert_eq!(classify(&facts).state, V0Detected);
    facts.migration = MarkerObservation::Present(MigrationWitness {
        epoch_version: 1,
        installation_id: InstallationId::from_bytes([1; 16]),
        completed: false,
        receipt_sha256: None,
    });
    assert_eq!(classify(&facts).state, V0MigrationInterrupted);
    facts.control = ready().control;
    assert_eq!(classify(&facts).state, V0MigrationInterrupted);
    facts.canonical = MarkerObservation::Invalid;
    assert_eq!(classify(&facts).state, CorruptOrDowngrade);

    let mut facts = ready();
    facts.manifest = MarkerObservation::Missing;
    assert_eq!(classify(&facts).reason, EpochReason::IncompleteV1);
    let mut facts = ready();
    if let MarkerObservation::Present(m) = &mut facts.manifest {
        m.epoch_version = 2;
    }
    assert_eq!(classify(&facts).reason, EpochReason::UnsupportedEpoch);
    let mut facts = ready();
    facts.canonical = MarkerObservation::Missing;
    assert_eq!(classify(&facts).reason, EpochReason::IncompleteV1);
    let mut facts = ready();
    facts.key_rows_exist = true;
    assert_eq!(classify(&facts).reason, EpochReason::MissingKeyring);
    facts.keyring = MarkerObservation::Present(InstallationId::from_bytes([2; 16]));
    assert_eq!(classify(&facts).reason, EpochReason::InstallationMismatch);
}

#[test]
fn unknown_or_unreadable_is_never_empty() {
    type EpochMutation = Box<dyn Fn(&mut StorageEpochFacts)>;
    let mutations: Vec<EpochMutation> = vec![
        Box::new(|f| f.manifest = MarkerObservation::Unreadable),
        Box::new(|f| f.control = MarkerObservation::Invalid),
        Box::new(|f| f.canonical = MarkerObservation::Unreadable),
        Box::new(|f| f.migration = MarkerObservation::Invalid),
        Box::new(|f| f.keyring = MarkerObservation::Unreadable),
        Box::new(|f| f.legacy = MarkerObservation::Invalid),
        Box::new(|f| f.observation_complete = false),
        Box::new(|f| f.has_unrecognized_entries = true),
    ];
    for mutate in mutations {
        let mut facts = empty();
        mutate(&mut facts);
        assert_eq!(
            classify(&facts).state,
            StorageEpochState::CorruptOrDowngrade
        );
    }
}

#[test]
fn data_root_never_branches_on_delivery_profile_and_rejects_traversal_inputs() {
    let root = DataRoot::new("/data");
    assert_eq!(root.control().to_str(), Some("/data/v1/control.sqlite"));
    assert_eq!(root.canonical().to_str(), Some("/data/v1/canonical.sqlite"));
    assert_eq!(root.manifest().to_str(), Some("/data/v1-epoch.json"));
    let space = SpaceId::parse("LegacySpace1").unwrap();
    let digest = ContentDigest::from_bytes([0xab; 32]);
    assert_eq!(
        root.blob(&space, digest),
        std::path::PathBuf::from(format!(
            "/data/blobs/LegacySpace1/ab/{}.zst",
            "ab".repeat(32)
        ))
    );
    assert_eq!(ContentDigest::parse_hex(&digest.to_hex()).unwrap(), digest);
    assert!(ContentDigest::parse_hex("../file").is_err());
    assert!(SpaceId::parse("../file").is_err());
}
