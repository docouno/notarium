use super::*;
use crate::{
    keyring::{Keyring, KeyringLocation},
    outbound::test_https::{HttpsFixture, Reply},
    service::{AuthenticationMode, ControlConfig, ControlService},
    test_support::*,
};
use notarium_core::{auth::SecretString, ids::*};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
};

#[tokio::test]
async fn cimd_https_cache_changes_and_failures_never_fall_back_to_stale_consent() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    for pg in [false, true] {
        let mut f = Fixture::new(pg, "cimd_tls").await;
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/keyring/vectors.json"))
                .unwrap();
        f.observer.execute("DELETE FROM v1_storage_epoch").await;
        f.store
            .import_target_batch(
                MaintenanceContext {
                    authority: ServiceAuthority::admit(ServicePurpose::Restore),
                    budget: budget(),
                },
                &[
                    TargetRecord::V1StorageEpoch(V1StorageEpochRow {
                        singleton: 1,
                        epoch_version: 1,
                        state: "migrating".into(),
                        installation_id: InstallationId::from_bytes([1; 16]).to_string(),
                        receipt_sha256: None,
                        receipt_json: None,
                    }),
                    TargetRecord::SecretKeyring(SecretKeyringRow {
                        key_id: v["keyId"].as_str().unwrap().into(),
                        key_hash: v["keyHash"].as_str().unwrap().into(),
                        generation: 1,
                        state: "active".into(),
                        canary: v["canaryEnvelope"].as_str().unwrap().into(),
                        created_at: 0,
                        retired_at: None,
                    }),
                ],
            )
            .await
            .unwrap();
        f.observer
            .execute("UPDATE v1_storage_epoch SET state='ready'")
            .await;
        let control = Arc::new(
            ControlService::open(
                f.store.clone(),
                f.catalog.clone(),
                f.revoker.clone(),
                f.clock.clone(),
                ControlConfig {
                    authentication: AuthenticationMode::Password,
                    resource_uri: "https://resource.example/".into(),
                    max_auth_spaces: 100,
                },
                budget(),
            )
            .await
            .unwrap(),
        );
        let account = control
            .bootstrap(
                empty(),
                budget(),
                BootstrapAccount {
                    username: "owner".into(),
                    email: None,
                    display_name: "Owner".into(),
                    password: Some(SecretString::new("test login password".into())),
                },
            )
            .await
            .unwrap();
        let session = account.session.unwrap();
        let ctx = AccountContext::new(
            control
                .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
                .await
                .unwrap(),
            budget(),
        );
        let keyring = Arc::new(
            Keyring::open(
                f.store.clone(),
                KeyringLocation::External(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native"),
                ),
                budget(),
            )
            .await
            .unwrap(),
        );
        let client = Arc::new(Mutex::new(String::new()));
        let mode = Arc::new(AtomicU8::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let server = HttpsFixture::start({
            let client = client.clone();
            let mode = mode.clone();
            let calls = calls.clone();
            move |request| {
                assert_eq!(request.method, "GET");
                assert_eq!(request.path.split('?').next(), Some("/client.json"));
                assert!(request.body.is_empty());
                assert!(
                    request
                        .headers
                        .to_lowercase()
                        .contains("accept: application/json")
                );
                calls.fetch_add(1, Ordering::SeqCst);
                let mode = mode.load(Ordering::SeqCst);
                let mut reply = Reply::json(
                    serde_json::json!({"client_id":if mode==2 {"https://wrong.example/client.json".into()} else {client.lock().unwrap().clone()},"client_name":"TLS app","redirect_uris":[if mode==1 {"https://client.example/changed"} else {"https://client.example/cb"}],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}),
                );
                reply
                    .headers
                    .push(("Cache-Control".into(), "max-age=1".into()));
                if mode == 3 {
                    reply.status = 302;
                    reply
                        .headers
                        .push(("Location".into(), "https://127.0.0.1/forbidden".into()));
                }
                if mode == 4 {
                    reply.headers[0].1 = "text/html".into();
                }
                if mode == 5 {
                    reply.body = vec![b' '; 64 * 1024 + 1];
                }
                if mode == 6 {
                    reply.headers.retain(|(name, _)| name != "Cache-Control");
                    reply
                        .headers
                        .push(("Cache-Control".into(), "no-store, max-age=0".into()));
                }
                reply
            }
        });
        let id = format!("{}/client.json", server.origin);
        *client.lock().unwrap() = id.clone();
        let oauth = OAuthService::new(
            control.clone(),
            keyring,
            Arc::new(server.transport()),
            super::super::OAuthConfig {
                issuer: "https://auth.example/".into(),
                authorization_endpoint: "https://auth.example/authorize".into(),
                token_endpoint: "https://auth.example/token".into(),
                registration_endpoint: "https://auth.example/register".into(),
                revocation_endpoint: "https://auth.example/revoke".into(),
            },
        )
        .unwrap();
        let first = oauth.resolve_client(budget(), id.clone()).await.unwrap();
        assert_eq!(first.redirect_uris, ["https://client.example/cb"]);
        oauth.resolve_client(budget(), id.clone()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let prepared = oauth
            .prepare_authorization(
                ctx.clone(),
                PrepareOAuthAuthorization {
                    client_id: id.clone(),
                    redirect_uri: "https://client.example/cb".into(),
                    resource: "https://resource.example/".into(),
                    scope: "read".into(),
                    selected_spaces: None,
                    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".into(),
                    code_challenge_method: "S256".into(),
                    browser_binding: SecretString::new(
                        "a-long-test-browser-binding-for-the-consent".into(),
                    ),
                },
            )
            .await
            .unwrap();
        mode.store(1, Ordering::SeqCst);
        f.clock.0.fetch_add(1001, Ordering::SeqCst);
        assert!(matches!(
            oauth
                .approve_authorization(
                    ctx.clone(),
                    OAuthConsent::attest_checked(
                        prepared.intent,
                        SecretString::new("a-long-test-browser-binding-for-the-consent".into())
                    )
                )
                .await,
            Err(PortError::Domain(DomainError::OAuth {
                error: OAuthErrorCode::InvalidClient
            }))
        ));
        assert_eq!(
            f.observer.count("SELECT COUNT(*) FROM oauth_grants").await,
            0
        );
        assert_eq!(
            oauth
                .resolve_client(budget(), id.clone())
                .await
                .unwrap()
                .redirect_uris,
            ["https://client.example/changed"]
        );
        for failure in [2, 3, 4, 5] {
            mode.store(failure, Ordering::SeqCst);
            f.clock.0.fetch_add(1001, Ordering::SeqCst);
            assert!(
                oauth.resolve_client(budget(), id.clone()).await.is_err(),
                "failure mode {failure}"
            );
            assert_eq!(
                f.observer.count("SELECT COUNT(*) FROM oauth_clients").await,
                1
            );
        }
        mode.store(0, Ordering::SeqCst);
        oauth.resolve_client(budget(), id.clone()).await.unwrap();
        mode.store(6, Ordering::SeqCst);
        f.clock.0.fetch_add(1001, Ordering::SeqCst);
        let uncached = calls.load(Ordering::SeqCst);
        for _ in 0..2 {
            oauth.resolve_client(budget(), id.clone()).await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), uncached + 2);
        let prepared = oauth
            .prepare_authorization(
                ctx.clone(),
                PrepareOAuthAuthorization {
                    client_id: id.clone(),
                    redirect_uri: "https://client.example/cb".into(),
                    resource: "https://resource.example/".into(),
                    scope: "read".into(),
                    selected_spaces: None,
                    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".into(),
                    code_challenge_method: "S256".into(),
                    browser_binding: SecretString::new(
                        "a-long-test-browser-binding-for-the-consent".into(),
                    ),
                },
            )
            .await
            .unwrap();
        oauth
            .approve_authorization(
                ctx.clone(),
                OAuthConsent::attest_checked(
                    prepared.intent,
                    SecretString::new("a-long-test-browser-binding-for-the-consent".into()),
                ),
            )
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), uncached + 4);
        let before = calls.load(Ordering::SeqCst);
        for denied in [
            "https://127.0.0.1/client.json",
            "http://identity.example.invalid/client.json",
            "https://168.63.129.16/client.json",
        ] {
            assert!(oauth.resolve_client(budget(), denied.into()).await.is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), before);
        mode.store(0, Ordering::SeqCst);
        let maximum = 2048 - ctx.auth().principal().as_str().len();
        let prefix = format!("{id}?padding=");
        for length in [maximum, maximum + 1] {
            let long_id = format!("{prefix}{}", "x".repeat(length - prefix.len()));
            *client.lock().unwrap() = long_id.clone();
            oauth
                .resolve_client(budget(), long_id.clone())
                .await
                .unwrap();
            let before = calls.load(Ordering::SeqCst);
            let prepared = oauth
                .prepare_authorization(
                    ctx.clone(),
                    PrepareOAuthAuthorization {
                        client_id: long_id,
                        redirect_uri: "https://client.example/cb".into(),
                        resource: "https://resource.example/".into(),
                        scope: "read".into(),
                        selected_spaces: None,
                        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".into(),
                        code_challenge_method: "S256".into(),
                        browser_binding: SecretString::new(
                            "a-long-test-browser-binding-for-the-consent".into(),
                        ),
                    },
                )
                .await;
            if length == maximum {
                oauth
                    .approve_authorization(
                        ctx.clone(),
                        OAuthConsent::attest_checked(
                            prepared.unwrap().intent,
                            SecretString::new("a-long-test-browser-binding-for-the-consent".into()),
                        ),
                    )
                    .await
                    .unwrap();
            } else {
                assert!(matches!(
                    prepared,
                    Err(PortError::Domain(DomainError::OAuth {
                        error: OAuthErrorCode::InvalidClient
                    }))
                ));
            }
            assert_eq!(calls.load(Ordering::SeqCst), before);
            assert_eq!(
                f.observer.count("SELECT COUNT(*) FROM oauth_grants").await,
                2
            );
        }
        drop(oauth);
        drop(control);
        drop(server);
        f.close().await;
    }
}
