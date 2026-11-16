use notarium_core::{
    auth::{Cap, EngineAuthContext, PrincipalKind, VerifiedHuman},
    ids::{GrantId, KeyId, PrincipalId},
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
