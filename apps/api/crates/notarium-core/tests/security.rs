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
    EngineAuthContext::for_human(
        VerifiedHuman::attest(
            PrincipalId::from_bytes([1; 16]),
            GrantId::from_bytes([1; 16]),
            grants(role),
            ability,
        )
        .with_human_management(true),
    )
}

#[test]
fn folder_metadata_obeys_project_scope_and_shared_branch_taint() {
    let owner = human(SpaceRole::Owner, true);
    let first = facts(1, DocClass::AgentMemory).space;
    let second = facts(2, DocClass::UserDoc).space;
    let root = FolderId::from_bytes([3; 16]);
    let child = FolderId::from_bytes([4; 16]);
    let keeper = owner
        .for_keeper(
            AgentRunId::from_bytes([6; 16]),
            first.id.clone(),
            Some(root.clone()),
            BTreeSet::new(),
        )
        .unwrap();
    keeper.authorize_folder_read(&first, &root, &[]).unwrap();
    keeper
        .authorize_folder_read(&first, &child, std::slice::from_ref(&root))
        .unwrap();
    assert!(keeper.authorize_folder_read(&first, &child, &[]).is_err());
    let mut closed = first.clone();
    closed.lifecycle = SpaceLifecycle::Archived;
    assert!(keeper.authorize_folder_read(&closed, &root, &[]).is_err());
    let mut wanted = grants(SpaceRole::Owner);
    wanted.get_mut(&first.id).unwrap().read_classes.clear();
    let unreadable = owner.for_pat(wanted).unwrap();
    assert!(
        unreadable
            .authorize_folder_read(&first, &root, &[])
            .is_err()
    );
    let agent = owner
        .for_agent_run(
            AgentRunId::from_bytes([7; 16]),
            first.id.clone(),
            ChatAudience::Personal,
            grants(SpaceRole::Owner),
        )
        .unwrap();
    let sibling = agent.clone();
    let memory = facts(1, DocClass::AgentMemory);
    sibling.authorize_direct_write(&memory, &memory).unwrap();
    agent.authorize_folder_read(&second, &child, &[]).unwrap();
    assert!(sibling.taint().is_tainted());
    assert!(sibling.authorize_direct_write(&memory, &memory).is_err());
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
fn provider_wrappers_are_rechecked_against_current_class_lifecycle_and_provenance() {
    let auth = human(SpaceRole::Owner, true);
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
    let original = doc(facts(1, DocClass::UserDoc));
    let admitted = ProviderMessage::Document(
        ClassEgressFence::provider(original.clone(), &auth, &policy).unwrap(),
    );
    let current = ProviderCurrentContent::Note(original.metadata());
    ClassEgressFence::revalidate(&admitted, &auth, &policy, &current).unwrap();
    let encrypted = ProviderCurrentContent::Note(doc(facts(1, DocClass::EncryptedNote)).metadata());
    assert!(ClassEgressFence::revalidate(&admitted, &auth, &policy, &encrypted).is_err());
    let metadata = |revision, lifecycle| {
        ProviderCurrentContent::Note(
            ClassifiedMetadata::from_canonical(
                original.reference().clone(),
                revision,
                facts(1, DocClass::UserDoc),
                lifecycle,
                original.digest(),
            )
            .unwrap(),
        )
    };
    assert!(
        ClassEgressFence::revalidate(
            &admitted,
            &auth,
            &policy,
            &metadata(RevisionId::from_bytes([2; 16]), Lifecycle::Active)
        )
        .is_err()
    );
    assert!(
        ClassEgressFence::revalidate(
            &admitted,
            &auth,
            &policy,
            &metadata(original.revision().clone(), Lifecycle::Trashed)
        )
        .is_err()
    );
    let mut revoked = policy.clone();
    revoked.audience = ProviderAudience::Shared {
        space: SpaceId::from_bytes([1; 16]),
        attached: true,
        space_consented: true,
        sender_consented: false,
    };
    assert!(ClassEgressFence::revalidate(&admitted, &auth, &revoked, &current).is_err());
    let mut grants = grants(SpaceRole::Owner);
    grants
        .get_mut(&SpaceId::from_bytes([1; 16]))
        .unwrap()
        .read_classes
        .clear();
    let reduced = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([1; 16]),
        grants,
        false,
    ));
    assert!(ClassEgressFence::revalidate(&admitted, &reduced, &policy, &current).is_err());
    let space = facts(1, DocClass::UserDoc).space;
    let thread = ChatThreadId::from_bytes([1; 16]);
    let entry = ThreadEntrySeq::new(1).unwrap();
    let digest = ContentDigest::from_bytes([1; 32]);
    let chat = ProviderMessage::Chat(
        ClassEgressFence::chat(
            CanonicalChatContent::from_canonical(
                space.clone(),
                thread.clone(),
                entry,
                false,
                "chat".into(),
                digest,
                None,
            ),
            &auth,
            &policy,
        )
        .unwrap(),
    );
    let current = ProviderCurrentContent::Chat {
        space,
        thread,
        entry,
        digest,
        lifecycle: Lifecycle::Active,
        tainted: true,
        project: None,
    };
    assert!(ClassEgressFence::revalidate(&chat, &auth, &policy, &current).is_err());
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

#[test]
fn nested_keepers_can_only_retain_parent_package_exceptions() {
    let owner = human(SpaceRole::Owner, true);
    let approved = AbilityId::from_bytes([4; 16]);
    let outside = AbilityId::from_bytes([5; 16]);
    let parent = owner
        .for_keeper(
            AgentRunId::from_bytes([1; 16]),
            SpaceId::from_bytes([1; 16]),
            Some(FolderId::from_bytes([3; 16])),
            [approved.clone()].into(),
        )
        .unwrap();
    let child = parent
        .for_keeper(
            AgentRunId::from_bytes([2; 16]),
            SpaceId::from_bytes([1; 16]),
            Some(FolderId::from_bytes([3; 16])),
            [approved.clone(), outside.clone()].into(),
        )
        .unwrap();
    let mut resource = facts(1, DocClass::Skill);
    resource.ancestor_folders.clear();
    resource.ability_package = Some(outside);
    assert_eq!(
        parent.authorize_read(&resource),
        Err(DomainError::ResourceNotFound)
    );
    assert_eq!(
        child.authorize_read(&resource),
        Err(DomainError::ResourceNotFound)
    );
    resource.ability_package = Some(approved);
    assert!(parent.authorize_read(&resource).is_ok());
    assert!(child.authorize_read(&resource).is_ok());
    assert_eq!(
        child.authorize_ability_mutation(),
        Err(DomainError::AbilityWriteForbidden)
    );
    let without = parent
        .for_keeper(
            AgentRunId::from_bytes([3; 16]),
            SpaceId::from_bytes([1; 16]),
            Some(FolderId::from_bytes([3; 16])),
            BTreeSet::new(),
        )
        .unwrap();
    assert!(without.authorize_read(&resource).is_err());

    let mut scoped_grants = grants(SpaceRole::Owner);
    scoped_grants
        .get_mut(&SpaceId::from_bytes([1; 16]))
        .unwrap()
        .project_root = Some(FolderId::from_bytes([3; 16]));
    let scoped_human = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([2; 16]),
        scoped_grants,
        true,
    ));
    let scoped_keeper = scoped_human
        .for_keeper(
            AgentRunId::from_bytes([4; 16]),
            SpaceId::from_bytes([1; 16]),
            Some(FolderId::from_bytes([3; 16])),
            [resource.ability_package.clone().unwrap()].into(),
        )
        .unwrap();
    assert!(scoped_human.authorize_read(&resource).is_err());
    assert!(scoped_keeper.authorize_read(&resource).is_err());
}

#[test]
fn metadata_visibility_checks_do_not_taint_and_keeper_reads_only_pinned_project_chats() {
    let owner = EngineAuthContext::for_human(
        VerifiedHuman::attest(
            PrincipalId::from_bytes([1; 16]),
            GrantId::from_bytes([1; 16]),
            grants(SpaceRole::Owner),
            false,
        )
        .with_human_management(true)
        .with_credential(AuthenticatedCredential::Session(AuthSessionId::from_bytes(
            [1; 16],
        ))),
    );
    assert!(owner.human_management());
    assert!(owner.authorize_human_management().is_ok());
    assert_eq!(
        owner.authorize_ability_mutation(),
        Err(DomainError::AbilityWriteForbidden)
    );
    let ambient_ability = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([1; 16]),
        grants(SpaceRole::Owner),
        true,
    ));
    assert_eq!(
        ambient_ability.authorize_human_management(),
        Err(DomainError::AccessDenied)
    );
    assert_eq!(
        ambient_ability.authorize_ability_mutation(),
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
    assert!(!agent.human_management());
    let external = facts(2, DocClass::UserDoc);
    agent.can_view_resource(&external).unwrap();
    agent
        .can_view_folder(&external.space, &FolderId::from_bytes([3; 16]), &[])
        .unwrap();
    assert!(!agent.taint().is_tainted());
    let local = facts(1, DocClass::AgentMemory);
    agent.authorize_direct_write(&local, &local).unwrap();

    let project_root = FolderId::from_bytes([3; 16]);
    let other_project = FolderId::from_bytes([9; 16]);
    let keeper = owner
        .for_keeper(
            AgentRunId::from_bytes([2; 16]),
            SpaceId::from_bytes([1; 16]),
            Some(project_root.clone()),
            BTreeSet::new(),
        )
        .unwrap();
    let space = local.space;
    assert_eq!(
        keeper.authorize_chat_read(&space, None, false),
        Err(DomainError::ResourceNotFound)
    );
    assert_eq!(
        keeper.authorize_chat_read(&space, Some(&other_project), false),
        Err(DomainError::ResourceNotFound)
    );
    keeper
        .authorize_chat_read(&space, Some(&project_root), false)
        .unwrap();
}

#[test]
fn cancellation_future_wakes_registered_task_and_tool_call_ids_accept_provider_delimiters() {
    use notarium_core::ports::{Cancellation, ProviderToolCallId};
    use std::{
        future::Future,
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        task::{Context, Poll, Wake, Waker},
    };

    struct CountWake(AtomicUsize);
    impl Wake for CountWake {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    let cancellation = Cancellation::default();
    for _ in 0..1_000 {
        let transient = Arc::new(CountWake(AtomicUsize::new(0)));
        let transient_waker = Waker::from(transient.clone());
        let mut transient_cx = Context::from_waker(&transient_waker);
        {
            let mut fut = cancellation.cancelled();
            assert_eq!(Pin::new(&mut fut).poll(&mut transient_cx), Poll::Pending);
        }
        drop(transient_waker);
        assert_eq!(
            Arc::strong_count(&transient),
            1,
            "dropped Cancelled future must release its registered Waker in O(1)"
        );
    }
    let counter = Arc::new(CountWake(AtomicUsize::new(0)));
    let waker = Waker::from(counter.clone());
    let mut cx = Context::from_waker(&waker);
    let mut fut = cancellation.cancelled();
    assert_eq!(Pin::new(&mut fut).poll(&mut cx), Poll::Pending);
    assert_eq!(Pin::new(&mut fut).poll(&mut cx), Poll::Pending);
    cancellation.cancel();
    assert_eq!(counter.0.load(Ordering::SeqCst), 1);
    assert_eq!(Pin::new(&mut fut).poll(&mut cx), Poll::Ready(()));

    ProviderToolCallId::new("functions.search:0".into()).unwrap();
    ProviderToolCallId::new("call_abc-123.v2:4".into()).unwrap();
    assert!(ProviderToolCallId::new("call/bad".into()).is_err());
}
