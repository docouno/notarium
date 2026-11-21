use notarium_core::{
    auth::{
        AuthenticatedCredential, Cap, EngineAuthContext, PrincipalKind, SpaceRole, VerifiedHuman,
    },
    classes::DocClass,
    document::{estimate_conservative_tokens, estimate_token_twelfths},
    ids::{GrantId, KeyId, PrincipalId, ProviderResourceId, SpaceId},
    ports::{BackupBudget, BackupProgress, BackupRetentionBudget, BackupRetentionProgress},
};
use std::{collections::BTreeMap, time::Duration};

#[test]
fn native_key_ids_have_one_exact_encoding() {
    let id = KeyId::from_derived([0xab; 12]);
    assert_eq!(id.as_str(), "ck_abababababababababababab");
    assert_eq!(KeyId::parse(id.as_str()).unwrap(), id);
    for value in [
        "ck_ABABABABABABABABABABABAB",
        "ck_00",
        "key_00000000000000000000000000000000",
        "abcdefghijkl",
    ] {
        assert!(KeyId::parse(value).is_err());
    }
}

#[test]
fn pat_authority_never_mints_ability_write() {
    let ambient = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([2; 16]),
        BTreeMap::new(),
        true,
    ));
    assert!(!ambient.has_cap(Cap::AbilityWrite));
    let human = EngineAuthContext::for_human(
        VerifiedHuman::attest(
            PrincipalId::from_bytes([1; 16]),
            GrantId::from_bytes([2; 16]),
            BTreeMap::new(),
            true,
        )
        .with_human_management(true),
    );
    assert!(human.has_cap(Cap::AbilityWrite));
    let pat = human.for_pat(BTreeMap::new()).unwrap();
    assert_eq!(pat.kind(), &PrincipalKind::Pat);
    assert!(!pat.has_cap(Cap::AbilityWrite));
    assert!(pat.authorize_ability_mutation().is_err());
}

#[test]
fn backup_retention_requires_matching_backend_and_actual_bound() {
    let sqlite = BackupBudget {
        deadline: Duration::from_secs(5),
        max_spool_bytes: 100,
        retention: BackupRetentionBudget::SqliteWal {
            max_pinned_bytes: 20,
        },
    };
    let pg = BackupBudget {
        retention: BackupRetentionBudget::PostgresSnapshot {
            max_age: Duration::from_secs(2),
        },
        ..sqlite
    };
    let base = BackupProgress {
        elapsed: Duration::from_secs(1),
        spool_bytes: 100,
        retention: BackupRetentionProgress::SqliteWal { pinned_bytes: 20 },
    };
    assert!(sqlite.check(base).is_ok());
    assert!(pg.check(base).is_err());
    assert!(
        sqlite
            .check(BackupProgress {
                retention: BackupRetentionProgress::SqliteWal { pinned_bytes: 21 },
                ..base
            })
            .is_err()
    );
    let pinned = BackupProgress {
        retention: BackupRetentionProgress::PostgresSnapshot {
            age: Duration::from_secs(2),
        },
        ..base
    };
    assert!(pg.check(pinned).is_ok());
    assert!(sqlite.check(pinned).is_err());
    assert!(
        pg.check(BackupProgress {
            retention: BackupRetentionProgress::PostgresSnapshot {
                age: Duration::from_secs(3)
            },
            ..base
        })
        .is_err()
    );
    assert!(
        pg.check(BackupProgress {
            spool_bytes: 101,
            ..pinned
        })
        .is_err()
    );
    assert!(
        pg.check(BackupProgress {
            elapsed: Duration::from_secs(6),
            ..pinned
        })
        .is_err()
    );
}

#[test]
fn conservative_token_estimates_follow_utf8_and_punctuation_weights() {
    assert_eq!(estimate_token_twelfths(""), 0);
    assert_eq!(estimate_conservative_tokens(""), 0);

    // ASCII alphabetic and whitespace: 4/12 token per character.
    assert_eq!(estimate_token_twelfths("abc def"), 7 * 4);
    assert_eq!(estimate_conservative_tokens("abc def"), 3);

    // ASCII digits and punctuation: 12/12 token per character.
    assert_eq!(estimate_token_twelfths("123!@#"), 6 * 12);
    assert_eq!(estimate_conservative_tokens("123!@#"), 6);

    // 2-byte UTF-8 (Cyrillic): 12/12 token per character.
    assert_eq!(estimate_token_twelfths("привет"), 6 * 12);
    assert_eq!(estimate_conservative_tokens("привет"), 6);

    // 3-byte UTF-8 (CJK): 18/12 token per character.
    assert_eq!(estimate_token_twelfths("東京"), 2 * 18);
    assert_eq!(estimate_conservative_tokens("東京"), 3);

    // 4-byte UTF-8 (emoji): 24/12 token per character.
    assert_eq!(estimate_token_twelfths("🦀🚀"), 2 * 24);
    assert_eq!(estimate_conservative_tokens("🦀🚀"), 4);
}

#[test]
fn search_indexing_authority_is_single_space_viewer_without_encrypted_or_human_rights() {
    let principal = PrincipalId::from_bytes([11; 16]);
    let grant = GrantId::from_bytes([12; 16]);
    let space = SpaceId::from_bytes([13; 16]);
    let provider = ProviderResourceId::from_bytes([14; 16]);
    let auth = EngineAuthContext::for_search_indexing(
        principal.clone(),
        grant.clone(),
        space.clone(),
        provider.clone(),
    );

    assert_eq!(auth.kind(), &PrincipalKind::SearchIndexing);
    assert_ne!(auth.kind(), &PrincipalKind::DirectHuman);
    assert!(!auth.human_management());
    assert!(!auth.has_cap(Cap::AbilityWrite));
    assert!(auth.authorize_human_management().is_err());
    assert!(auth.authorize_ability_mutation().is_err());
    assert_eq!(
        auth.credential(),
        Some(&AuthenticatedCredential::SearchIndexing {
            space: space.clone(),
            provider: provider.clone(),
        })
    );
    assert_eq!(auth.spaces().len(), 1);
    let space_grant = &auth.spaces()[&space];
    assert_eq!(space_grant.role, SpaceRole::Viewer);
    assert!(space_grant.write_classes.is_empty());
    assert!(!space_grant.read_classes.contains(&DocClass::EncryptedNote));
    assert!(space_grant.read_classes.contains(&DocClass::UserDoc));
    assert!(space_grant.read_classes.contains(&DocClass::AgentMemory));
    assert!(space_grant.read_classes.contains(&DocClass::Skill));
    assert!(space_grant.read_classes.contains(&DocClass::Profile));

    let refreshed = EngineAuthContext::for_search_indexing(principal, grant, space, provider);
    let intersected = auth.intersect_current(&refreshed).unwrap();
    assert_eq!(intersected.kind(), &PrincipalKind::SearchIndexing);
    assert!(!intersected.human_management());
}
