use super::*;
use notarium_core::auth::AuthenticatedCredential;
use std::{future::Future, time::Duration};
use tokio::{sync::oneshot, time::timeout};

pub(super) async fn bump_account_after_publication<T>(
    fixture: &RuntimeFixture,
    operation: impl Future<Output = T>,
) -> T {
    let (entered, release) = fixture.projections.pause_ability_publication();
    let bump = async {
        timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        fixture.pat(BearerScope::Read, false).await;
        release.send(()).unwrap();
    };
    tokio::join!(operation, bump).0
}

pub(super) async fn revoke_at_effect<T, R>(
    gate: (oneshot::Receiver<Cancellation>, oneshot::Sender<()>),
    mutation: impl Future<Output = Result<T, PortError>>,
    revocation: impl Future<Output = Result<R, PortError>>,
) -> PortError {
    let (entered, release) = gate;
    let revoke = async {
        let cancellation = entered
            .await
            .expect("mutation entered its canonical operation");
        tokio::pin!(revocation);
        tokio::select! {
            () = cancellation.cancelled() => (),
            _ = &mut revocation => panic!("revocation returned while the canonical operation was held"),
        }
        release.send(()).unwrap();
        revocation.await.unwrap();
    };
    let (result, ()) = timeout(Duration::from_secs(10), async {
        tokio::join!(mutation, revoke)
    })
    .await
    .expect("revocation and canonical effect settled");
    result.err().expect("the revoked effect must fail")
}

async fn check(pg: bool) {
    let mut fixture = RuntimeFixture::open_named(pg, "agents_authoring_authority").await;
    let owner = &fixture.human;
    let principal = owner.auth().principal();
    let space_id = fixture
        .control
        .whoami(owner.clone())
        .await
        .unwrap()
        .personal_space
        .unwrap();
    for (key, replay) in [(181, false), (183, true)] {
        let created = call(&fixture, owner, key, "create_ability", json!({
            "kind":"role", "name":format!("authoring-fixture-{key}"), "description":"Runtime role",
            "instructions":"Use the recorded procedure.", "placement":{"home":"personal"},
        })).await.unwrap();
        let input = json!({"ref":created.structured_content["ref"]});
        let author = fixture.pat(BearerScope::Write, true).await;
        if replay {
            call(&fixture, &author, key + 1, "delete_ability", input.clone())
                .await
                .unwrap();
        }
        let Some(AuthenticatedCredential::Pat(token)) = author.auth().credential() else {
            panic!("expected an opt-in PAT");
        };
        let before = fixture
            .canonical
            .read_space(&space_id)
            .await
            .unwrap()
            .last_seq;
        let revocation = AccountMutation {
            identity: runtime_ability_cases::identity(&fixture, owner, key + 1).await,
            input: RevokePat {
                account: principal.clone(),
                token: token.clone(),
            },
        };
        let denied = revoke_at_effect(
            fixture.projections.pause_ability_trash(),
            call(&fixture, &author, key + 1, "delete_ability", input.clone()),
            fixture.control.revoke_pat(owner.clone(), revocation),
        )
        .await;
        assert!(matches!(denied, PortError::Cancelled(_)), "{denied:?}");
        assert_eq!(
            fixture
                .canonical
                .read_space(&space_id)
                .await
                .unwrap()
                .last_seq,
            before
        );
        assert!(matches!(
            call(&fixture, &author, key + 1, "delete_ability", input).await,
            Err(PortError::Domain(DomainError::AuthenticationFailed))
        ));
    }
    proposal_cases::revoked_session_cannot_apply_or_replay(&mut fixture).await;
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_revocation_fences_canonical_authoring_and_proposal_replay() {
    check(false).await;
}

#[tokio::test]
async fn postgres_revocation_fences_canonical_authoring_and_proposal_replay() {
    check(true).await;
}
