#[allow(dead_code)]
mod support;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_control::{
    auth::token,
    keyring::{Keyring, KeyringLocation},
    outbound::{NetworkPolicy, OutboundTransport},
    service::{
        AuthenticationMode, ControlService,
        oauth::{OAuthConfig, OAuthService},
    },
    store::TargetRecord,
};
use notarium_core::{
    DomainError,
    auth::SecretString,
    error::{CommitEffect, PortError},
    ids::*,
    ports::{control::*, *},
};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
};
use support::*;

const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const BROWSER: &str = "a-random-browser-binding-with-at-least-32-bytes";
fn secret(v: &str) -> SecretString {
    SecretString::new(v.into())
}
fn oauth_error<T: std::fmt::Debug>(result: Result<T, PortError>, code: OAuthErrorCode) {
    assert!(
        matches!(result,Err(PortError::Domain(DomainError::OAuth {error})) if error==code),
        "{result:?}"
    );
}
async fn context(control: &ControlService, session: &str) -> AccountContext {
    AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, session))
            .await
            .unwrap(),
        budget(),
    )
}
async fn service(f: &mut Fixture) -> (Arc<ControlService>, Arc<OAuthService>, IssuedSession) {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/keyring/vectors.json")).unwrap();
    f.observer.execute("DELETE FROM v1_storage_epoch").await;
    f.store
        .import_target_batch(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Restore),
                budget: budget(),
            },
            &[
                TargetRecord::V1StorageEpoch {
                    singleton: 1,
                    epoch_version: 1,
                    state: "migrating".into(),
                    installation_id: InstallationId::from_bytes([1; 16]).to_string(),
                    receipt_sha256: None,
                    receipt_json: None,
                },
                TargetRecord::SecretKeyring {
                    key_id: v["keyId"].as_str().unwrap().into(),
                    key_hash: v["keyHash"].as_str().unwrap().into(),
                    generation: 1,
                    state: "active".into(),
                    canary: v["canaryEnvelope"].as_str().unwrap().into(),
                    created_at: 0,
                    retired_at: None,
                },
            ],
        )
        .await
        .unwrap();
    f.observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
    let control = f.service(AuthenticationMode::Password).await.unwrap();
    let session = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(secret("a test password")),
            },
        )
        .await
        .unwrap()
        .session
        .unwrap();
    let keys = Keyring::open(
        f.store.clone(),
        KeyringLocation::External(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native"),
        ),
        budget(),
    )
    .await
    .unwrap();
    let oauth = OAuthService::new(
        control.clone(),
        Arc::new(keys),
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        OAuthConfig {
            issuer: "https://auth.example/".into(),
            authorization_endpoint: "https://auth.example/authorize".into(),
            token_endpoint: "https://auth.example/token".into(),
            registration_endpoint: "https://auth.example/register".into(),
            revocation_endpoint: "https://auth.example/revoke".into(),
        },
    )
    .unwrap();
    (control, Arc::new(oauth), session)
}
fn authorization(client: &str, offline: bool) -> PrepareOAuthAuthorization {
    PrepareOAuthAuthorization {
        client_id: client.into(),
        redirect_uri: "http://127.0.0.1:54321/callback".into(),
        resource: "https://resource.example/".into(),
        scope: if offline {
            "read offline_access"
        } else {
            "read"
        }
        .into(),
        selected_spaces: Some(vec![]),
        code_challenge: URL_SAFE_NO_PAD.encode(token::digest(VERIFIER.as_bytes())),
        code_challenge_method: "S256".into(),
        browser_binding: secret(BROWSER),
    }
}
fn exchange(client: &str, code: &str) -> ExchangeOAuthCode {
    ExchangeOAuthCode {
        client_id: client.into(),
        code: secret(code),
        redirect_uri: "http://127.0.0.1:54321/callback".into(),
        resource: "https://resource.example/".into(),
        code_verifier: secret(VERIFIER),
    }
}
fn refresh(client: &str, token: &str) -> RefreshOAuthToken {
    RefreshOAuthToken {
        client_id: client.into(),
        refresh_token: secret(token),
        resource: "https://resource.example/".into(),
        scope: None,
    }
}
fn copy_intent(intent: &OAuthAuthorizationIntent) -> OAuthAuthorizationIntent {
    OAuthAuthorizationIntent {
        id: intent.id.clone(),
        protected: secret(intent.protected.expose()),
    }
}
async fn issue(
    oauth: &OAuthService,
    ctx: AccountContext,
    client: &str,
    offline: bool,
) -> IssuedOAuthTokens {
    let prepared = oauth
        .prepare_authorization(ctx.clone(), authorization(client, offline))
        .await
        .unwrap();
    let code = oauth
        .approve_authorization(
            ctx,
            OAuthConsent::attest_checked(prepared.intent, secret(BROWSER)),
        )
        .await
        .unwrap();
    oauth
        .exchange_code(budget(), exchange(client, code.code.expose()))
        .await
        .unwrap()
}
async fn lifecycle(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut f = Fixture::new(pg, "oauth_lifecycle").await;
    let (control, oauth, session) = service(&mut f).await;
    let ctx = context(&control, session.token.expose()).await;
    assert_eq!(oauth.metadata().resource, "https://resource.example/");
    assert_eq!(
        oauth.metadata().token_endpoint_auth_methods_supported,
        ["none"]
    );
    let client = oauth
        .register_client(
            budget(),
            RegisterOAuthClient {
                client_name: "Native app".into(),
                redirect_uris: vec!["http://127.0.0.1:1234/callback".into()],
            },
        )
        .await
        .unwrap();
    let id = &client.client_id;
    let prepared = oauth
        .prepare_authorization(ctx.clone(), authorization(id, true))
        .await
        .unwrap();
    let replay = copy_intent(&prepared.intent);
    let bad_browser = copy_intent(&prepared.intent);
    oauth_error(
        oauth
            .approve_authorization(
                ctx.clone(),
                OAuthConsent::attest_checked(
                    bad_browser,
                    secret("a different browser binding of sufficient length"),
                ),
            )
            .await,
        OAuthErrorCode::InvalidGrant,
    );
    assert_eq!(
        f.observer.count("SELECT COUNT(*) FROM oauth_grants").await,
        0
    );
    let code = oauth
        .approve_authorization(
            ctx.clone(),
            OAuthConsent::attest_checked(prepared.intent, secret(BROWSER)),
        )
        .await
        .unwrap();
    oauth_error(
        oauth
            .approve_authorization(
                ctx.clone(),
                OAuthConsent::attest_checked(replay, secret(BROWSER)),
            )
            .await,
        OAuthErrorCode::InvalidGrant,
    );
    for field in 0..4 {
        let mut bad = exchange(id, code.code.expose());
        match field {
            0 => bad.code_verifier = secret(&"x".repeat(43)),
            1 => bad.client_id = "another-client".into(),
            2 => bad.redirect_uri = "http://127.0.0.1:1234/callback".into(),
            _ => bad.resource = "https://elsewhere.example/".into(),
        }
        oauth_error(
            oauth.exchange_code(budget(), bad).await,
            OAuthErrorCode::InvalidGrant,
        );
    }
    assert_eq!(
        f.observer
            .count("SELECT COUNT(*) FROM oauth_auth_codes WHERE used_at IS NOT NULL")
            .await,
        0
    );
    let (a, b) = tokio::join!(
        oauth.exchange_code(budget(), exchange(id, code.code.expose())),
        oauth.exchange_code(budget(), exchange(id, code.code.expose()))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let tokens = a.or(b).unwrap();
    let resolved = control
        .resolve(evidence(
            AuthEvidenceKind::OAuth,
            tokens.access_token.expose(),
        ))
        .await
        .unwrap();
    assert!(
        resolved.spaces().is_empty(),
        "an empty selection must never become all memberships"
    );
    let raw = tokens.refresh_token.as_ref().unwrap().expose();
    let mut wrong = raw.to_string();
    wrong.pop();
    wrong.push(if raw.ends_with('0') { '1' } else { '0' });
    oauth_error(
        oauth.refresh(budget(), refresh(id, &wrong)).await,
        OAuthErrorCode::InvalidGrant,
    );
    assert_eq!(
        f.observer
            .count("SELECT COUNT(*) FROM oauth_refresh_families WHERE revoked_at IS NOT NULL")
            .await,
        0
    );
    let mut widening = refresh(id, raw);
    widening.scope = Some("write offline_access".into());
    oauth_error(
        oauth.refresh(budget(), widening).await,
        OAuthErrorCode::InvalidScope,
    );
    let rotated = oauth.refresh(budget(), refresh(id, raw)).await.unwrap();
    assert_ne!(rotated.refresh_token.as_ref().unwrap().expose(), raw);
    assert_eq!(f.observer.count("SELECT COUNT(*) FROM oauth_refresh_tokens WHERE used_at IS NOT NULL AND rotated_to IS NOT NULL").await,1);
    control
        .resolve(evidence(
            AuthEvidenceKind::OAuth,
            rotated.access_token.expose(),
        ))
        .await
        .unwrap();
    f.revoker.fail.store(true, Ordering::SeqCst);
    let failed = oauth.refresh(budget(), refresh(id, raw)).await.unwrap_err();
    assert!(matches!(failed,PortError::Unavailable(f) if f.effect()==CommitEffect::Unknown));
    assert!(
        control
            .resolve(evidence(
                AuthEvidenceKind::OAuth,
                rotated.access_token.expose()
            ))
            .await
            .is_err()
    );
    assert!(
        control
            .resolve(evidence(
                AuthEvidenceKind::OAuth,
                tokens.access_token.expose()
            ))
            .await
            .is_err()
    );
    assert_eq!(
        f.observer
            .count("SELECT COUNT(*) FROM revocation_events WHERE delivered_at IS NULL")
            .await,
        1
    );
    let delivered_id = f.revoker.calls.lock().unwrap().last().unwrap().clone();
    f.revoker.fail.store(false, Ordering::SeqCst);
    oauth_error(
        oauth.refresh(budget(), refresh(id, raw)).await,
        OAuthErrorCode::InvalidGrant,
    );
    assert_eq!(f.revoker.calls.lock().unwrap().last(), Some(&delivered_id));
    assert_eq!(
        f.observer
            .count("SELECT COUNT(*) FROM revocation_events WHERE delivered_at IS NULL")
            .await,
        0
    );

    let racing = issue(&oauth, ctx.clone(), id, true).await;
    let raw = racing.refresh_token.as_ref().unwrap().expose();
    let (a, b) = tokio::join!(
        oauth.refresh(budget(), refresh(id, raw)),
        oauth.refresh(budget(), refresh(id, raw))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let winner = a.or(b).unwrap();
    assert!(
        control
            .resolve(evidence(
                AuthEvidenceKind::OAuth,
                winner.access_token.expose()
            ))
            .await
            .is_err()
    );

    let standalone = issue(&oauth, ctx.clone(), id, false).await;
    assert!(standalone.refresh_token.is_none() && standalone.family.is_none());
    oauth
        .revoke(
            budget(),
            RevokeOAuthToken {
                client_id: "wrong-client".into(),
                token: secret(standalone.access_token.expose()),
            },
        )
        .await
        .unwrap();
    control
        .resolve(evidence(
            AuthEvidenceKind::OAuth,
            standalone.access_token.expose(),
        ))
        .await
        .unwrap();
    oauth
        .revoke(
            budget(),
            RevokeOAuthToken {
                client_id: id.clone(),
                token: secret(standalone.access_token.expose()),
            },
        )
        .await
        .unwrap();
    assert!(
        control
            .resolve(evidence(
                AuthEvidenceKind::OAuth,
                standalone.access_token.expose()
            ))
            .await
            .is_err()
    );

    let grant = issue(&oauth, ctx.clone(), id, true).await;
    let account = control
        .account(ctx.clone(), ctx.auth().principal().clone())
        .await
        .unwrap();
    let identity = command(
        ctx.auth().principal(),
        ctx.auth().principal(),
        30,
        account.revision,
    );
    oauth
        .revoke_grant(
            ctx.clone(),
            AccountMutation {
                identity: identity.clone(),
                input: grant.grant.clone(),
            },
        )
        .await
        .unwrap();
    oauth
        .revoke_grant(
            ctx.clone(),
            AccountMutation {
                identity,
                input: grant.grant.clone(),
            },
        )
        .await
        .unwrap();
    assert!(
        control
            .resolve(evidence(
                AuthEvidenceKind::OAuth,
                grant.access_token.expose()
            ))
            .await
            .is_err()
    );
    oauth_error(
        oauth
            .refresh(
                budget(),
                refresh(id, grant.refresh_token.as_ref().unwrap().expose()),
            )
            .await,
        OAuthErrorCode::InvalidGrant,
    );
    let list = oauth
        .list_grants(ctx.clone(), ControlPageRequest::new(2, None).unwrap())
        .await
        .unwrap();
    assert_eq!(list.items.len(), 2);
    assert!(list.continuation.is_some());
    let next = oauth
        .list_grants(
            ctx.clone(),
            ControlPageRequest::new(2, list.continuation).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(next.items.len(), 2);

    let prepared = oauth
        .prepare_authorization(ctx.clone(), authorization(id, true))
        .await
        .unwrap();
    let competing = copy_intent(&prepared.intent);
    let (a, b) = tokio::join!(
        oauth.approve_authorization(
            ctx.clone(),
            OAuthConsent::attest_checked(prepared.intent, secret(BROWSER))
        ),
        oauth.approve_authorization(
            ctx.clone(),
            OAuthConsent::attest_checked(competing, secret(BROWSER))
        )
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let expires = a.or(b).unwrap();
    f.clock.0.fetch_add(60_001, Ordering::SeqCst);
    let issued = f
        .observer
        .count("SELECT COUNT(*) FROM oauth_access_tokens")
        .await;
    oauth_error(
        oauth
            .exchange_code(budget(), exchange(id, expires.code.expose()))
            .await,
        OAuthErrorCode::InvalidGrant,
    );
    assert_eq!(
        f.observer
            .count("SELECT COUNT(*) FROM oauth_access_tokens")
            .await,
        issued
    );

    let stale = oauth
        .prepare_authorization(ctx.clone(), authorization(id, true))
        .await
        .unwrap();
    control
        .logout(evidence(AuthEvidenceKind::Session, session.token.expose()))
        .await
        .unwrap();
    assert!(
        oauth
            .approve_authorization(
                ctx,
                OAuthConsent::attest_checked(stale.intent, secret(BROWSER))
            )
            .await
            .is_err()
    );
    drop(oauth);
    drop(control);
    f.close().await;
}
#[tokio::test]
async fn sqlite_codes_rotation_reuse_revocation_and_consent() {
    lifecycle(false).await;
}
#[tokio::test]
async fn postgres_codes_rotation_reuse_revocation_and_consent() {
    lifecycle(true).await;
}

#[tokio::test]
async fn both_databases_bound_registration_and_expire_unactivated_clients() {
    let _serial = AUTH_TEST_LOCK.lock().await;
    for pg in [false, true] {
        let mut f = Fixture::new(pg, "oauth_registration").await;
        let (control, oauth, _session) = service(&mut f).await;
        f.observer.execute("WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<1000) INSERT INTO oauth_clients(client_id,kind,redirect_uris,client_name,created_at) SELECT 'pending_' || n,'dcr','[\"https://client.example/cb\"]','Pending',1700000000000 FROM entries").await;
        let request = || RegisterOAuthClient {
            client_name: "New app".into(),
            redirect_uris: vec!["https://client.example/cb".into()],
        };
        assert!(matches!(
            oauth.register_client(budget(), request()).await,
            Err(PortError::Domain(DomainError::RateLimited { .. }))
        ));
        assert_eq!(
            f.observer.count("SELECT COUNT(*) FROM oauth_clients").await,
            1000
        );
        f.clock
            .0
            .fetch_add(24 * 60 * 60 * 1000 + 1, Ordering::SeqCst);
        oauth_error(
            oauth.resolve_client(budget(), "pending_1".into()).await,
            OAuthErrorCode::InvalidClient,
        );
        let client = oauth.register_client(budget(), request()).await.unwrap();
        assert_eq!(
            f.observer.count("SELECT COUNT(*) FROM oauth_clients").await,
            1
        );
        oauth
            .resolve_client(budget(), client.client_id.clone())
            .await
            .unwrap();
        f.clock.0.fetch_add(24 * 60 * 60 * 1000, Ordering::SeqCst);
        oauth_error(
            oauth.resolve_client(budget(), client.client_id).await,
            OAuthErrorCode::InvalidClient,
        );
        drop(oauth);
        drop(control);
        f.close().await;
    }
}

#[tokio::test]
async fn both_databases_imported_native_tokens_keep_their_verifiers_and_expiry() {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/identity/native-token-vectors.json")).unwrap();
    let digest =
        |kind: &str| serde_json::from_value::<Vec<u8>>(vectors[kind]["digest"].clone()).unwrap();
    let raw = |kind: &str| vectors[kind]["token"].as_str().unwrap().to_owned();
    let id = |kind: &str| vectors[kind]["id"].as_str().unwrap().to_owned();
    for pg in [false, true] {
        let mut f = Fixture::new(pg, "oauth_imported").await;
        let (control, oauth, owner) = service(&mut f).await;
        let grant = OAuthGrantId::from_bytes([81; 16]).to_string();
        let family = OAuthFamilyId::from_bytes([82; 16]).to_string();
        let now = 1_700_000_000_000;
        let expires = now + 123_456;
        let records = vec![
            TargetRecord::Sessions {
                session_id: AuthSessionId::from_bytes([83; 16]).to_string(),
                token_hash: digest("session"),
                user_id: owner.account.id.to_string(),
                created_at: now,
                expires_at: expires,
                last_used_at: now,
                revoked_at: None,
                auth_version: 0,
            },
            TargetRecord::OauthClients {
                client_id: "imported-client".into(),
                kind: "dcr".into(),
                redirect_uris: "[\"https://client.example/callback\"]".into(),
                client_name: "Imported client".into(),
                metadata_uri: None,
                metadata_digest: None,
                cache_expires_at: None,
                activated_at: Some(now),
                created_at: now,
                last_seen_at: Some(now),
            },
            TargetRecord::OauthGrants {
                grant_id: grant.clone(),
                user_id: owner.account.id.to_string(),
                client_id: "imported-client".into(),
                resource_uri: "https://resource.example/".into(),
                scope: "read".into(),
                selected_spaces: None,
                revoked_at: None,
                revision: 0,
                created_at: now,
            },
            TargetRecord::OauthRefreshFamilies {
                family_id: family.clone(),
                grant_id: grant.clone(),
                revoked_at: None,
                reason_code: None,
                created_at: now,
            },
            TargetRecord::OauthRefreshTokens {
                token_id: id("refresh"),
                token_hash: digest("refresh"),
                family_id: family.clone(),
                client_id: "imported-client".into(),
                issued_at: now,
                expires_at: expires,
                used_at: None,
                revoked_at: None,
                rotated_to: None,
            },
            TargetRecord::OauthAccessTokens {
                token_id: id("access"),
                token_hash: digest("access"),
                grant_id: grant,
                family_id: Some(family),
                refresh_id: Some(id("refresh")),
                resource_uri: "https://resource.example/".into(),
                scope: "read".into(),
                selected_spaces: None,
                issued_at: now,
                expires_at: expires,
                revoked_at: None,
                last_used_at: Some(now),
            },
        ];
        f.observer
            .execute("UPDATE v1_storage_epoch SET state='migrating'")
            .await;
        f.store
            .import_target_batch(
                MaintenanceContext {
                    authority: ServiceAuthority::admit(ServicePurpose::Restore),
                    budget: budget(),
                },
                &records,
            )
            .await
            .unwrap();
        f.observer
            .execute("UPDATE v1_storage_epoch SET state='ready'")
            .await;
        for (kind, evidence_kind) in [
            ("session", AuthEvidenceKind::Session),
            ("access", AuthEvidenceKind::OAuth),
        ] {
            assert_eq!(
                control
                    .resolve(evidence(evidence_kind, &raw(kind)))
                    .await
                    .unwrap()
                    .principal(),
                &owner.account.id
            );
        }
        let successor = oauth
            .refresh(budget(), refresh("imported-client", &raw("refresh")))
            .await
            .unwrap();
        assert_ne!(
            successor.refresh_token.as_ref().unwrap().expose(),
            raw("refresh")
        );
        assert_eq!(f.observer.count("SELECT COUNT(*) FROM oauth_refresh_tokens WHERE token_id='111213141516' AND expires_at=1700000123456 AND rotated_to IS NOT NULL").await, 1);
        assert_eq!(f.observer.count("SELECT COUNT(*) FROM oauth_access_tokens WHERE token_id='010203040506' AND expires_at=1700000123456").await, 1);
        assert_eq!(
            f.observer
                .count("SELECT COUNT(*) FROM sessions WHERE expires_at=1700000123456")
                .await,
            1
        );
        oauth_error(
            oauth
                .refresh(budget(), refresh("imported-client", &raw("refresh")))
                .await,
            OAuthErrorCode::InvalidGrant,
        );
        assert!(
            control
                .resolve(evidence(
                    AuthEvidenceKind::OAuth,
                    successor.access_token.expose()
                ))
                .await
                .is_err()
        );
        assert!(
            control
                .resolve(evidence(AuthEvidenceKind::OAuth, &raw("access")))
                .await
                .is_err()
        );
        drop(oauth);
        drop(control);
        f.close().await;
    }
}
