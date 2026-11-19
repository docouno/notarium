use super::*;
use notarium_core::{
    auth::{AuthenticatedCredential, ChatAudience, SpaceGrant, SpaceRole, VerifiedHuman},
    classes::DocClass,
    ports::CallBudget,
};
use std::time::Duration;

fn context(event: u8) -> MaintenanceContext {
    MaintenanceContext {
        authority: notarium_core::ports::ServiceAuthority::admit(ServicePurpose::Revocation),
        budget: CallBudget {
            request: RequestId::from_bytes([event; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(3),
        },
    }
}

fn caller(
    principal: u8,
    space: &SpaceId,
    credential: AuthenticatedCredential,
) -> EngineAuthContext {
    let spaces = BTreeMap::from([(
        space.clone(),
        SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        },
    )]);
    EngineAuthContext::for_human(
        VerifiedHuman::attest(
            PrincipalId::from_bytes([principal; 16]),
            GrantId::from_bytes([principal; 16]),
            spaces,
            false,
        )
        .with_credential(credential),
    )
}

#[tokio::test]
async fn intersecting_fences_drain_sockets_without_waiting_for_runs() {
    let hub = RevocationHub::new_local();
    let space = SpaceId::from_bytes([1; 16]);
    let auth = caller(2, &space, AuthenticatedCredential::TrustedNone);
    let run = auth
        .for_agent_run(
            AgentRunId::from_bytes([3; 16]),
            space.clone(),
            ChatAudience::Shared,
            auth.spaces().clone(),
        )
        .unwrap();
    let running = hub
        .register_run(context(4), &run, None, Cancellation::default())
        .unwrap();
    let member = RevocationSelector::Membership {
        space: space.clone(),
        principal: auth.principal().clone(),
    };
    let selectors = vec![member, RevocationSelector::Space(space)];
    let token = Cancellation::default();
    let socket = hub
        .register_provider(context(5), selectors.clone(), token.clone())
        .await
        .unwrap();
    let unrelated = hub
        .register_provider(
            context(6),
            vec![RevocationSelector::Principal(PrincipalId::from_bytes(
                [9; 16],
            ))],
            Cancellation::default(),
        )
        .await
        .unwrap();
    let mut first = hub.fence_provider(context(7), selectors.clone());
    let mut second = hub.fence_provider(context(8), selectors.clone());

    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(first.as_mut().poll(cx).is_pending()))
            .await
    );
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(second.as_mut().poll(cx).is_pending()))
            .await
    );
    assert!(token.is_cancelled());
    assert!(running.cancellation().is_cancelled());
    assert!(unrelated.check().is_ok());
    drop(socket);

    let first = first.await.unwrap();
    let second = second.await.unwrap();
    let mut register = hub.register_provider(context(10), selectors, Cancellation::default());
    drop(first);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(register.as_mut().poll(cx).is_pending()))
            .await
    );
    drop(second);
    assert!(register.await.unwrap().check().is_ok());
    // Both fences resolved while an affected task still held its run lease.
    assert!(running.check().is_err());
}

#[tokio::test]
async fn viewer_revocation_closes_only_that_viewer_without_draining_the_stream() {
    let hub = RevocationHub::new_local();
    let space = SpaceId::from_bytes([1; 16]);
    let sender = caller(2, &space, AuthenticatedCredential::TrustedNone);
    let run = sender
        .for_agent_run(
            AgentRunId::from_bytes([3; 16]),
            space.clone(),
            ChatAudience::Shared,
            sender.spaces().clone(),
        )
        .unwrap();
    let running = hub
        .register_run(context(4), &run, None, Cancellation::default())
        .unwrap();
    let session = AuthSessionId::from_bytes([5; 16]);
    let reader = caller(6, &space, AuthenticatedCredential::Session(session.clone()));
    let token = Cancellation::default();
    let viewer = hub
        .register_viewer(context(7), &reader, &space, token.clone())
        .unwrap();
    let membership = RevocationSelector::Membership {
        space: space.clone(),
        principal: reader.principal().clone(),
    };
    let fence = hub
        .fence_provider(context(8), vec![membership])
        .await
        .unwrap();
    assert!(token.is_cancelled());
    assert!(viewer.check().is_err());
    assert!(running.check().is_ok());
    drop(fence);
    drop(viewer);
    assert!(hub.inner.lock().viewers.is_empty());

    let viewer = hub
        .register_viewer(context(9), &reader, &space, Cancellation::default())
        .unwrap();
    hub.revoke(
        context(10),
        RevocationSelector::Session(session),
        RevocationReason::Logout,
    )
    .await
    .unwrap();
    assert!(viewer.check().is_err());
    assert!(running.check().is_ok());
}

#[tokio::test]
async fn cancelled_fence_wait_keeps_the_independent_fence() {
    let hub = RevocationHub::new_local();
    let call = RequestId::from_bytes([1; 16]);
    let selectors = vec![RevocationSelector::ProviderCall(call.clone())];
    let socket = hub
        .register_provider(context(2), selectors.clone(), Cancellation::default())
        .await
        .unwrap();
    assert!(
        hub.fence_inactive_provider(context(3), call.clone())
            .await
            .unwrap()
            .is_none()
    );
    let ctx = context(4);
    let cancel = ctx.budget.cancellation.clone();
    let mut first = hub.fence_provider(ctx, selectors.clone());
    let mut second = hub.fence_provider(context(5), selectors);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(first.as_mut().poll(cx).is_pending()))
            .await
    );
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(second.as_mut().poll(cx).is_pending()))
            .await
    );
    cancel.cancel();
    assert!(matches!(first.await, Err(PortError::Cancelled(_))));
    drop(socket);

    let second = second.await.unwrap();
    assert!(
        hub.fence_inactive_provider(context(6), call.clone())
            .await
            .unwrap()
            .is_none()
    );
    drop(second);
    assert!(
        hub.fence_inactive_provider(context(7), call)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn revoke_clears_sender_and_stable_event_replay_does_not_revoke_a_new_run() {
    let hub = RevocationHub::new_local();
    let space = SpaceId::from_bytes([1; 16]);
    let family = OAuthFamilyId::from_bytes([2; 16]);
    let authority = caller(
        3,
        &space,
        AuthenticatedCredential::OAuth {
            token: CredentialTokenId::parse("0123456789ab").unwrap(),
            grant: OAuthGrantId::from_bytes([4; 16]),
            family: Some(family.clone()),
        },
    );
    let key = PendingCredentialKey {
        scope: HistoryScope {
            space_id: space.clone(),
            incarnation: HistoryIncarnation::from_bytes([5; 16]),
        },
        thread: ChatThreadId::from_bytes([6; 16]),
        input: PendingInputId::from_bytes([7; 16]),
    };
    let command = ContentDigest::from_bytes([8; 32]);
    let options = ChatRunOptions {
        role: Some("selected-role".into()),
        ..ChatRunOptions::default()
    };
    hub.register_pending(
        context(9),
        key.clone(),
        authority.clone(),
        command,
        options.clone(),
    )
    .unwrap();
    let snapshot = hub.pending(&key).unwrap();
    assert_eq!(snapshot.options(), &options);
    let different = caller(10, &space, AuthenticatedCredential::TrustedNone);
    assert!(matches!(
        hub.register_pending(context(11), key.clone(), different, command, options),
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));

    let selector = RevocationSelector::OAuthFamily(family);
    hub.revoke(context(12), selector.clone(), RevocationReason::Logout)
        .await
        .unwrap();
    assert!(hub.pending(&key).is_none());
    assert!(snapshot.cancellation().is_cancelled());

    let newer = hub
        .register_provider(context(13), vec![selector.clone()], Cancellation::default())
        .await
        .unwrap();
    hub.revoke(context(12), selector, RevocationReason::Logout)
        .await
        .unwrap();
    assert!(newer.check().is_ok());
    hub.close();
    assert!(newer.check().is_err());
}

#[tokio::test]
async fn every_selector_participates_in_exact_matching() {
    let principal = PrincipalId::from_bytes([1; 16]);
    let space = SpaceId::from_bytes([2; 16]);
    let selectors = [
        RevocationSelector::Principal(principal.clone()),
        RevocationSelector::Session(AuthSessionId::from_bytes([1; 16])),
        RevocationSelector::Credential(CredentialId::from_bytes([1; 16])),
        RevocationSelector::ProviderResource(ProviderResourceId::from_bytes([1; 16])),
        RevocationSelector::ProviderCall(RequestId::from_bytes([1; 16])),
        RevocationSelector::Schedule(ScheduleId::from_bytes([1; 16])),
        RevocationSelector::ScheduledRun(AgentRunId::from_bytes([1; 16])),
        RevocationSelector::Grant(GrantId::from_bytes([1; 16])),
        RevocationSelector::OAuthGrant(OAuthGrantId::from_bytes([1; 16])),
        RevocationSelector::OAuthFamily(OAuthFamilyId::from_bytes([1; 16])),
        RevocationSelector::OAuthAccess(CredentialTokenId::parse("0123456789ab").unwrap()),
        RevocationSelector::Membership {
            space: space.clone(),
            principal,
        },
        RevocationSelector::Space(space),
    ];
    for (index, selector) in selectors.iter().enumerate() {
        let hub = RevocationHub::new_local();
        let mut sockets = Vec::new();
        for socket in &selectors {
            let token = Cancellation::default();
            let proof = hub
                .register_provider(context(1), vec![socket.clone()], token.clone())
                .await
                .unwrap();
            sockets.push((proof, token));
        }
        hub.revoke(
            context(2),
            selector.clone(),
            RevocationReason::PermissionChanged,
        )
        .await
        .unwrap();
        for (socket_index, (_, token)) in sockets.iter().enumerate() {
            assert_eq!(token.is_cancelled(), index == socket_index);
        }
    }
}
