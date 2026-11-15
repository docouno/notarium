use notarium_core::{DomainError, auth::*, classes::*, ids::*, model::*};
use std::collections::{BTreeMap, BTreeSet};

fn grants(role: SpaceRole) -> BTreeMap<SpaceId, SpaceGrant> {
    [1, 2]
        .map(|n| {
            (
                SpaceId::from_bytes([n; 16]),
                SpaceGrant {
                    role,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                },
            )
        })
        .into()
}
fn human(role: SpaceRole, ability: bool) -> EngineAuthContext {
    EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([1; 16]),
        grants(role),
        ability,
    ))
}
fn facts(space: u8, class: DocClass) -> ResourceFacts {
    ResourceFacts {
        space: Space {
            id: SpaceId::from_bytes([space; 16]),
            lifecycle: SpaceLifecycle::Active,
            kind: SpaceKind::Shared,
        },
        class,
        ancestor_folders: vec![FolderId::from_bytes([3; 16])],
        folder_write_locked: false,
        ability_package: None,
    }
}
fn doc(facts: ResourceFacts) -> ClassifiedDocument {
    ClassifiedDocument::from_canonical(
        NoteRef {
            space_id: facts.space.id.clone(),
            note_id: NoteId::from_bytes([1; 16]),
        },
        RevisionId::from_bytes([1; 16]),
        facts,
        Lifecycle::Active,
        "secret-test-string".into(),
        ContentDigest::from_bytes([0; 32]),
    )
    .unwrap()
}

#[test]
fn only_explicitly_authorized_direct_humans_mutate_abilities() {
    let owner = human(SpaceRole::Owner, true);
    assert!(owner.authorize_ability_mutation().is_ok());
    assert_eq!(
        human(SpaceRole::Owner, false).authorize_ability_mutation(),
        Err(DomainError::AbilityWriteForbidden)
    );
    let agent = owner
        .for_agent_run(
            AgentRunId::from_bytes([1; 16]),
            SpaceId::from_bytes([1; 16]),
            ChatAudience::Personal,
            grants(SpaceRole::Owner),
        )
        .unwrap();
    let keeper = owner
        .for_keeper(
            AgentRunId::from_bytes([2; 16]),
            SpaceId::from_bytes([1; 16]),
            None,
            BTreeSet::new(),
        )
        .unwrap();
    let oauth = owner
        .for_oauth(GrantId::from_bytes([2; 16]), grants(SpaceRole::Owner))
        .unwrap();
    for auth in [agent, keeper, oauth] {
        assert!(!auth.has_cap(Cap::AbilityWrite));
        assert_eq!(
            auth.authorize_ability_mutation(),
            Err(DomainError::AbilityWriteForbidden)
        );
        let mut auxiliary = facts(1, DocClass::AgentMemory);
        auxiliary.ability_package = Some(AbilityId::from_bytes([1; 16]));
        assert_eq!(
            auth.authorize_direct_write(&auxiliary, &auxiliary),
            Err(DomainError::AbilityWriteForbidden)
        );
    }
}

#[test]
fn scope_narrowing_cannot_widen_roles_classes_or_write_space() {
    let viewer = human(SpaceRole::Viewer, true);
    let narrowed = viewer
        .for_oauth(GrantId::from_bytes([2; 16]), grants(SpaceRole::Owner))
        .unwrap();
    assert_eq!(
        narrowed.authorize_direct_write(&facts(1, DocClass::UserDoc), &facts(1, DocClass::UserDoc)),
        Err(DomainError::SpaceReadOnly)
    );
    let owner = human(SpaceRole::Owner, true);
    let mut locked = facts(1, DocClass::UserDoc);
    locked.folder_write_locked = true;
    assert!(owner.authorize_read(&locked).is_ok());
    assert_eq!(
        owner.authorize_direct_write(&locked, &locked),
        Err(DomainError::SpaceReadOnly)
    );
    let keeper = owner
        .for_keeper(
            AgentRunId::from_bytes([1; 16]),
            SpaceId::from_bytes([2; 16]),
            Some(FolderId::from_bytes([3; 16])),
            BTreeSet::new(),
        )
        .unwrap();
    assert!(
        keeper
            .authorize_read(&facts(2, DocClass::AgentMemory))
            .is_ok()
    );
    assert!(
        keeper
            .authorize_direct_write(
                &facts(2, DocClass::AgentMemory),
                &facts(2, DocClass::AgentMemory)
            )
            .is_ok()
    );
    assert!(
        keeper
            .authorize_read(&facts(1, DocClass::AgentMemory))
            .is_err()
    );
    assert!(
        keeper
            .authorize_direct_write(&facts(2, DocClass::UserDoc), &facts(2, DocClass::UserDoc))
            .is_err()
    );
    let mut elsewhere = facts(2, DocClass::AgentMemory);
    elsewhere.ancestor_folders.clear();
    assert!(keeper.authorize_read(&elsewhere).is_err());
    assert!(
        keeper
            .for_oauth(GrantId::from_bytes([3; 16]), grants(SpaceRole::Owner))
            .is_err()
    );
}

#[test]
fn external_reads_taint_existing_clones_before_returning_content() {
    let owner = human(SpaceRole::Owner, true);
    let agent = owner
        .for_agent_run(
            AgentRunId::from_bytes([1; 16]),
            SpaceId::from_bytes([1; 16]),
            ChatAudience::Personal,
            grants(SpaceRole::Owner),
        )
        .unwrap();
    let prior_clone = agent.clone();
    let local = facts(1, DocClass::AgentMemory);
    assert!(prior_clone.authorize_direct_write(&local, &local).is_ok());
    assert!(
        doc(facts(2, DocClass::UserDoc))
            .explicit_read(&agent)
            .is_ok()
    );
    assert_eq!(
        prior_clone.authorize_direct_write(&local, &local),
        Err(DomainError::CrossSpaceTainted)
    );
    assert!(agent.taint().fork().is_tainted());
    let merge = BranchTaint::default();
    merge.merge(agent.taint());
    assert!(merge.is_tainted());
    assert!(owner.authorize_direct_write(&local, &local).is_ok());
}

#[test]
fn shared_chat_cannot_read_external_spaces_or_sender_profile() {
    let agent = human(SpaceRole::Owner, true)
        .for_agent_run(
            AgentRunId::from_bytes([1; 16]),
            SpaceId::from_bytes([1; 16]),
            ChatAudience::Shared,
            grants(SpaceRole::Owner),
        )
        .unwrap();
    assert!(agent.authorize_read(&facts(2, DocClass::UserDoc)).is_err());
    assert!(agent.authorize_read(&facts(1, DocClass::Profile)).is_err());
    assert!(agent.authorize_read(&facts(1, DocClass::UserDoc)).is_ok());
}

#[test]
fn encrypted_content_has_no_secondary_egress_and_debug_redacts_content() {
    let auth = human(SpaceRole::Owner, true);
    let encrypted = doc(facts(1, DocClass::EncryptedNote));
    let policy = ProviderPolicy {
        provider: ProviderResourceId::from_bytes([1; 16]),
        audience: ProviderAudience::Shared {
            space: SpaceId::from_bytes([1; 16]),
            attached: true,
            space_consented: true,
            sender_consented: true,
        },
        allowed_classes: DocClass::all(),
    };
    assert!(!format!("{encrypted:?}").contains("secret-test-string"));
    assert!(encrypted.explicit_read(&auth).is_ok());
    assert!(ClassEgressFence::projection(encrypted.clone(), &auth).is_err());
    assert!(ClassEgressFence::search(encrypted.clone(), &auth).is_err());
    assert!(ClassEgressFence::provider(encrypted, &auth, &policy).is_err());
    let memory = doc(facts(1, DocClass::AgentMemory));
    assert!(ClassEgressFence::provider(memory.clone(), &auth, &policy).is_ok());
    let personal = ProviderPolicy {
        audience: ProviderAudience::Personal { consented: true },
        ..policy.clone()
    };
    assert!(ClassEgressFence::provider(memory.clone(), &auth, &personal).is_err());
    for audience in [
        ProviderAudience::Shared {
            space: SpaceId::from_bytes([1; 16]),
            attached: false,
            space_consented: true,
            sender_consented: true,
        },
        ProviderAudience::Shared {
            space: SpaceId::from_bytes([1; 16]),
            attached: true,
            space_consented: false,
            sender_consented: true,
        },
        ProviderAudience::Shared {
            space: SpaceId::from_bytes([1; 16]),
            attached: true,
            space_consented: true,
            sender_consented: false,
        },
    ] {
        assert!(
            ClassEgressFence::provider(
                memory.clone(),
                &auth,
                &ProviderPolicy {
                    audience,
                    ..policy.clone()
                }
            )
            .is_err()
        );
    }
}
