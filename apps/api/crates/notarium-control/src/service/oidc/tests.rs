use super::*;
use crate::{
    keyring::KeyringLocation,
    outbound::test_https::{HttpsFixture, Reply},
    service::AuthenticationMode,
    store::target::*,
    test_support::*,
};
use notarium_core::{auth::SecretString, error::CommitEffect};
use openidconnect::{
    Audience, ClientId, EndUserEmail, IssuerUrl, JsonWebKeyId, Nonce, PrivateSigningKey,
    StandardClaims, SubjectIdentifier,
    core::{CoreIdToken, CoreIdTokenClaims, CoreJwsSigningAlgorithm, CoreRsaPrivateSigningKey},
};
use std::{
    path::PathBuf,
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};

const BROWSER: &str = "an-unpredictable-test-browser-binding-of-32-bytes";
const REDIRECT: &str = "https://application.example/callback";
fn secret(value: &str) -> SecretString {
    SecretString::new(value.into())
}
struct Authorized {
    nonce: String,
    challenge: String,
}
struct Idp {
    issuer: StdMutex<String>,
    codes: StdMutex<BTreeMap<String, Authorized>>,
    calls: AtomicUsize,
    discovery: AtomicUsize,
    jwks: AtomicUsize,
    mode: AtomicU8,
    key_version: AtomicU8,
    metadata_failure: AtomicU8,
    authentication: AtomicU8,
    hold: AtomicBool,
    entered: tokio::sync::Semaphore,
    clock: Arc<Clock>,
    key: CoreRsaPrivateSigningKey,
    other: CoreRsaPrivateSigningKey,
    rotated: CoreRsaPrivateSigningKey,
}
impl Idp {
    fn new(clock: Arc<Clock>) -> Arc<Self> {
        Arc::new(Self {
            issuer: StdMutex::new(String::new()),
            codes: StdMutex::new(BTreeMap::new()),
            calls: AtomicUsize::new(0),
            discovery: AtomicUsize::new(0),
            jwks: AtomicUsize::new(0),
            mode: AtomicU8::new(0),
            key_version: AtomicU8::new(0),
            metadata_failure: AtomicU8::new(0),
            authentication: AtomicU8::new(0),
            hold: AtomicBool::new(false),
            entered: tokio::sync::Semaphore::new(0),
            clock,
            key: CoreRsaPrivateSigningKey::from_pem(
                include_str!("../../../tests/fixtures/identity/rsa-signing.pem"),
                Some(JsonWebKeyId::new("fixture".into())),
            )
            .unwrap(),
            other: CoreRsaPrivateSigningKey::from_pem(
                include_str!("../../../tests/fixtures/identity/rsa-signing-rotated.pem"),
                Some(JsonWebKeyId::new("fixture".into())),
            )
            .unwrap(),
            rotated: CoreRsaPrivateSigningKey::from_pem(
                include_str!("../../../tests/fixtures/identity/rsa-signing-rotated.pem"),
                Some(JsonWebKeyId::new("rotated".into())),
            )
            .unwrap(),
        })
    }
    fn handler(&self, request: crate::outbound::test_https::Request) -> Reply {
        let issuer = self.issuer.lock().unwrap().clone();
        if request.path == "/.well-known/openid-configuration" {
            assert_eq!(request.method, "GET");
            self.discovery.fetch_add(1, Ordering::SeqCst);
            if self.metadata_failure.load(Ordering::SeqCst) == 1 {
                return Reply {
                    status: 503,
                    headers: vec![],
                    body: vec![],
                };
            }
            return Reply::json(
                serde_json::json!({"issuer":issuer,"authorization_endpoint":format!("{}/authorize", issuer.trim_end_matches('/')),"token_endpoint":format!("{}/token", issuer.trim_end_matches('/')),"jwks_uri":format!("{}/jwks", issuer.trim_end_matches('/')),"response_types_supported":["code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256","ES256"]}),
            );
        }
        if request.path == "/jwks" {
            assert_eq!(request.method, "GET");
            self.jwks.fetch_add(1, Ordering::SeqCst);
            if self.metadata_failure.load(Ordering::SeqCst) == 2 {
                return Reply {
                    status: 503,
                    headers: vec![],
                    body: vec![],
                };
            }
            let key = if self.key_version.load(Ordering::SeqCst) == 0 {
                self.key.as_verification_key()
            } else {
                self.rotated.as_verification_key()
            };
            if self.metadata_failure.load(Ordering::SeqCst) == 3 {
                return Reply::json(serde_json::json!({"keys":vec![key;257]}));
            }
            return Reply::json(serde_json::json!({"keys":[key]}));
        }
        assert_eq!(request.path, "/token");
        assert_eq!(request.method, "POST");
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.add_permits(1);
        let started = std::time::Instant::now();
        while self.hold.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let form = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(form["grant_type"], "authorization_code");
        let auth_header = request.headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.trim())
        });
        use base64::Engine;
        match self.authentication.load(Ordering::SeqCst) {
            1 => {
                assert_eq!(
                    base64::engine::general_purpose::STANDARD
                        .decode(auth_header.unwrap().strip_prefix("Basic ").unwrap())
                        .unwrap(),
                    b"client-fixture:test-client-secret"
                );
                assert!(!form.contains_key("client_secret"));
            }
            mode => {
                assert_eq!(form["client_id"], "client-fixture");
                assert!(auth_header.is_none());
                if mode == 2 {
                    assert_eq!(form["client_secret"], "test-client-secret");
                } else {
                    assert!(!form.contains_key("client_secret"));
                }
            }
        }
        assert_eq!(form["redirect_uri"], REDIRECT);
        let code = self
            .codes
            .lock()
            .unwrap()
            .remove(&form["code"])
            .expect("IdP code is one-time");
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(token::digest(form["code_verifier"].as_bytes())),
            code.challenge
        );
        let now = self.clock.0.load(Ordering::SeqCst);
        let mode = self.mode.load(Ordering::SeqCst);
        if mode == 10 {
            return Reply {
                status: 0,
                headers: vec![],
                body: vec![],
            };
        }
        let issuer = if mode == 2 {
            "https://another-issuer.example/".into()
        } else {
            issuer
        };
        let subject = if mode == 9 {
            "different-subject"
        } else {
            "external-subject"
        };
        let audiences = if mode == 3 {
            vec![Audience::new("another-client".into())]
        } else if matches!(mode, 7 | 8) {
            vec![
                Audience::new("client-fixture".into()),
                Audience::new("trusted-peer".into()),
            ]
        } else {
            vec![Audience::new("client-fixture".into())]
        };
        let claims = CoreIdTokenClaims::new(
            IssuerUrl::new(issuer).unwrap(),
            audiences,
            chrono::DateTime::from_timestamp_millis(if mode == 4 {
                now - 61_000
            } else {
                now + 3_600_000
            })
            .unwrap(),
            chrono::DateTime::from_timestamp_millis(if mode == 5 { now + 61_000 } else { now })
                .unwrap(),
            StandardClaims::new(SubjectIdentifier::new(subject.into()))
                .set_email(Some(EndUserEmail::new("owner@example.test".into()))),
            openidconnect::EmptyAdditionalClaims {},
        )
        .set_nonce(Some(Nonce::new(if mode == 1 {
            "wrong-nonce".into()
        } else {
            code.nonce
        })))
        .set_authorized_party(if mode == 6 {
            Some(ClientId::new("another-client".into()))
        } else if mode == 8 {
            Some(ClientId::new("client-fixture".into()))
        } else {
            None
        });
        let token = CoreIdToken::new(
            claims,
            if mode == 11 {
                &self.other
            } else if self.key_version.load(Ordering::SeqCst) == 0 {
                &self.key
            } else {
                &self.rotated
            },
            CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
            None,
            None,
        )
        .unwrap();
        Reply::json(
            serde_json::json!({"access_token":"discarded-external-access","refresh_token":"discarded-external-refresh","token_type":"Bearer","expires_in":3600,"id_token":token.to_string()}),
        )
    }
    fn callback(&self, authorization: OidcAuthorization) -> FinishOidcCallback {
        let parsed = url::Url::parse(authorization.authorization_url.expose()).unwrap();
        assert_eq!(parsed.path(), "/authorize");
        let values = parsed
            .query_pairs()
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(values["response_type"], "code");
        assert_eq!(values["code_challenge_method"], "S256");
        let scopes = values["scope"]
            .split(' ')
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            scopes,
            std::collections::BTreeSet::from(["openid", "profile", "email"])
        );
        assert!(
            !authorization
                .authorization_url
                .expose()
                .contains(authorization.flow.context.expose())
        );
        let code = format!("code-{}", authorization.flow.transaction);
        self.codes.lock().unwrap().insert(
            code.clone(),
            Authorized {
                nonce: values["nonce"].clone(),
                challenge: values["code_challenge"].clone(),
            },
        );
        FinishOidcCallback {
            flow: authorization.flow,
            code: secret(&code),
            state: secret(&values["state"]),
            browser_binding: secret(BROWSER),
        }
    }
}
fn copy_callback(request: &FinishOidcCallback) -> FinishOidcCallback {
    FinishOidcCallback {
        flow: ProtectedOidcFlow {
            transaction: request.flow.transaction.clone(),
            context: secret(request.flow.context.expose()),
        },
        code: secret(request.code.expose()),
        state: secret(request.state.expose()),
        browser_binding: secret(request.browser_binding.expose()),
    }
}
struct Setup {
    f: Fixture,
    control: Arc<ControlService>,
    oidc: Arc<OidcService>,
    session: IssuedSession,
    idp: Arc<Idp>,
    server: HttpsFixture,
}
impl Setup {
    async fn new(pg: bool, label: &str) -> Self {
        super::flows::reset_fixture_rate();
        let mut f = Fixture::new(pg, label).await;
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
        let control = f.service(AuthenticationMode::Password).await.unwrap();
        let session = control
            .bootstrap(
                empty(),
                budget(),
                BootstrapAccount {
                    username: "owner".into(),
                    email: Some("owner@example.test".into()),
                    display_name: "Owner".into(),
                    password: Some(secret("test native password")),
                },
            )
            .await
            .unwrap()
            .session
            .unwrap();
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
        let idp = Idp::new(f.clock.clone());
        let server = HttpsFixture::start({
            let idp = idp.clone();
            move |request| idp.handler(request)
        });
        let issuer = format!("{}/", server.origin);
        *idp.issuer.lock().unwrap() = issuer.clone();
        let oidc = Arc::new(
            OidcService::new(
                control.clone(),
                keyring,
                Arc::new(server.transport()),
                vec![OidcProviderConfig {
                    issuer,
                    client_id: "client-fixture".into(),
                    redirect_uri: REDIRECT.into(),
                    authentication: OidcClientAuthentication::Public,
                    trusted_additional_audiences: vec!["trusted-peer".into()],
                }],
            )
            .unwrap(),
        );
        Self {
            f,
            control,
            oidc,
            session,
            idp,
            server,
        }
    }
    fn begin(&self) -> BeginOidcLogin {
        BeginOidcLogin {
            issuer: self.idp.issuer.lock().unwrap().clone(),
            browser_binding: secret(BROWSER),
        }
    }
    async fn context(&self) -> AccountContext {
        self.context_for(&self.session).await
    }
    async fn context_for(&self, session: &IssuedSession) -> AccountContext {
        AccountContext::new(
            self.control
                .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
                .await
                .unwrap(),
            budget(),
        )
    }
    async fn account(&self, id: &PrincipalId) -> AccountInfo {
        self.control
            .account(self.context().await, id.clone())
            .await
            .unwrap()
    }
    async fn bind_request(
        &self,
        id: &PrincipalId,
        subject: &str,
        key: u8,
    ) -> AccountMutation<BindOidcIdentity> {
        let account = self.account(id).await;
        AccountMutation {
            identity: command(&self.session.account.id, id, key, account.revision),
            input: BindOidcIdentity {
                account: id.clone(),
                issuer: self.begin().issuer,
                subject: subject.into(),
            },
        }
    }
    async fn unlink_request(&self, subject: &str, key: u8) -> AccountMutation<UnlinkOidcIdentity> {
        let account = self.account(&self.session.account.id).await;
        AccountMutation {
            identity: command(&account.id, &account.id, key, account.revision),
            input: UnlinkOidcIdentity {
                account: account.id,
                issuer: self.begin().issuer,
                subject: subject.into(),
            },
        }
    }
    async fn login(&self) -> FinishOidcCallback {
        self.idp
            .callback(self.oidc.begin_login(budget(), self.begin()).await.unwrap())
    }
    async fn close(self) {
        drop(self.oidc);
        drop(self.control);
        drop(self.server);
        drop(self.idp);
        self.f.close().await;
    }
}

#[tokio::test]
async fn oidc_origin_issuer_preserves_exact_identity_without_a_trailing_slash() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    for pg in [false, true] {
        let mut s = Setup::new(pg, "oidc_exact_issuer").await;
        let mut config = s.oidc.provider(&s.begin().issuer).unwrap().config.clone();
        let issuer = s.server.origin.clone();
        config.issuer = issuer.clone();
        for invalid in [
            format!("{issuer}?query=1"),
            format!("{issuer}#fragment"),
            "http://identity.example.invalid".into(),
            "https://127.0.0.1".into(),
        ] {
            let mut config = config.clone();
            config.issuer = invalid;
            assert!(
                OidcService::new(
                    s.control.clone(),
                    s.oidc.keyring.clone(),
                    s.oidc.outbound.clone(),
                    vec![config],
                )
                .is_err()
            );
        }
        s.oidc = Arc::new(
            OidcService::new(
                s.control.clone(),
                s.oidc.keyring.clone(),
                s.oidc.outbound.clone(),
                vec![config],
            )
            .unwrap(),
        );
        let begin = || BeginOidcLogin {
            issuer: issuer.clone(),
            browser_binding: secret(BROWSER),
        };
        assert!(
            s.oidc.begin_login(budget(), begin()).await.is_err(),
            "discovery issuer with a slash must not match the configured origin"
        );
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions")
                .await,
            0
        );
        *s.idp.issuer.lock().unwrap() = issuer.clone();
        let linked = s
            .idp
            .callback(s.oidc.begin_link(s.context().await, begin()).await.unwrap());
        assert!(
            matches!(s.oidc.finish_callback(budget(), linked).await.unwrap(), OidcOutcome::Linked(ref identity) if identity.issuer == issuer)
        );
        let callback = s.login().await;
        *s.idp.issuer.lock().unwrap() = format!("{issuer}/");
        assert!(
            s.oidc.finish_callback(budget(), callback).await.is_err(),
            "a signed token with a slash must not match the configured origin"
        );
        assert_eq!(s.f.observer.count("SELECT COUNT(*) FROM sessions").await, 1);
        *s.idp.issuer.lock().unwrap() = issuer;
        let callback = s.login().await;
        let OidcOutcome::Authenticated(session) =
            s.oidc.finish_callback(budget(), callback).await.unwrap()
        else {
            panic!("the exact origin issuer must authenticate its linked account");
        };
        s.control
            .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
            .await
            .unwrap();
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 3);
        s.close().await;
    }
}

#[tokio::test]
async fn oidc_both_databases_explicit_linking_native_login_and_one_time_callback() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    for pg in [false, true] {
        let mut s = Setup::new(pg, "oidc_lifecycle").await;
        let callback = s.login().await;
        let mut bad = copy_callback(&callback);
        bad.state = secret(&"x".repeat(43));
        assert!(s.oidc.finish_callback(budget(), bad).await.is_err());
        let mut bad = copy_callback(&callback);
        bad.browser_binding = secret("another-long-enough-browser-binding-with-32-bytes");
        assert!(s.oidc.finish_callback(budget(), bad).await.is_err());
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 0);
        let replay = copy_callback(&callback);
        let unbound = s.oidc.finish_callback(budget(), callback).await.unwrap();
        assert!(
            matches!(unbound,OidcOutcome::IdentityUnbound(UnboundOidcIdentity {ref contact_email,..}) if contact_email.as_deref()==Some("owner@example.test"))
        );
        assert_eq!(
            s.f.observer.count("SELECT COUNT(*) FROM users").await,
            1,
            "same email never links or creates an account"
        );
        assert!(s.oidc.finish_callback(budget(), replay).await.is_err());
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 1);
        let linked = s.idp.callback(
            s.oidc
                .begin_link(s.context().await, s.begin())
                .await
                .unwrap(),
        );
        let linked = s.oidc.finish_callback(budget(), linked).await.unwrap();
        assert!(
            matches!(linked,OidcOutcome::Linked(ref identity) if identity.account==s.session.account.id)
        );
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM user_oidc_identities")
                .await,
            1
        );
        let callback = s.login().await;
        let other = copy_callback(&callback);
        let before = s.idp.calls.load(Ordering::SeqCst);
        let (a, b) = tokio::join!(
            s.oidc.finish_callback(budget(), callback),
            s.oidc.finish_callback(budget(), other)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), before + 1);
        let OidcOutcome::Authenticated(native) = a.or(b).unwrap() else {
            panic!("bound identity must yield a native session")
        };
        s.control
            .resolve(evidence(AuthEvidenceKind::Session, native.token.expose()))
            .await
            .unwrap();
        assert_eq!(s.idp.discovery.load(Ordering::SeqCst), 1);
        assert_eq!(s.idp.jwks.load(Ordering::SeqCst), 1);
        for mode in [1, 2, 3, 4, 5, 6, 7, 11] {
            s.idp.mode.store(mode, Ordering::SeqCst);
            let callback = s.login().await;
            assert!(
                s.oidc.finish_callback(budget(), callback).await.is_err(),
                "claim mode {mode}"
            );
        }
        s.idp.mode.store(8, Ordering::SeqCst);
        assert!(matches!(
            s.oidc
                .finish_callback(budget(), s.login().await)
                .await
                .unwrap(),
            OidcOutcome::Authenticated(_)
        ));
        s.idp.mode.store(9, Ordering::SeqCst);
        assert!(matches!(
            s.oidc
                .finish_callback(budget(), s.login().await)
                .await
                .unwrap(),
            OidcOutcome::IdentityUnbound(_)
        ));
        s.idp.mode.store(0, Ordering::SeqCst);
        let ctx = s.context().await;
        let account = s
            .control
            .account(ctx.clone(), s.session.account.id.clone())
            .await
            .unwrap();
        let unlink = UnlinkOidcIdentity {
            account: account.id.clone(),
            issuer: s.begin().issuer,
            subject: "external-subject".into(),
        };
        let mutation = AccountMutation {
            identity: command(&account.id, &account.id, 99, account.revision),
            input: unlink,
        };
        s.oidc.unlink(ctx, mutation).await.unwrap();
        assert!(matches!(
            s.oidc
                .finish_callback(budget(), s.login().await)
                .await
                .unwrap(),
            OidcOutcome::IdentityUnbound(_)
        ));
        let expired = s.login().await;
        let count = s.idp.calls.load(Ordering::SeqCst);
        s.f.clock.0.fetch_add(600_001, Ordering::SeqCst);
        assert!(s.oidc.finish_callback(budget(), expired).await.is_err());
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), count);
        assert!(
            s.oidc
                .begin_link(s.context().await, s.begin())
                .await
                .is_err(),
            "link requires a recent session"
        );
        s.close().await;
    }
}

#[tokio::test]
async fn oidc_claim_survives_lost_response_and_caller_cancellation() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    for pg in [false, true] {
        let mut s = Setup::new(pg, "oidc_cancel").await;
        s.idp.mode.store(10, Ordering::SeqCst);
        let callback = s.login().await;
        let retry = copy_callback(&callback);
        assert!(
            matches!(s.oidc.finish_callback(budget(),callback).await,Err(PortError::Unavailable(f)) if f.effect()==CommitEffect::Unknown)
        );
        assert!(s.oidc.finish_callback(budget(), retry).await.is_err());
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 1);
        s.idp.mode.store(0, Ordering::SeqCst);
        s.idp.hold.store(true, Ordering::SeqCst);
        s.idp.entered.acquire().await.unwrap().forget();
        let callback = s.login().await;
        let retry = copy_callback(&callback);
        let oidc = s.oidc.clone();
        let task = tokio::spawn(async move { oidc.finish_callback(budget(), callback).await });
        s.idp.entered.acquire().await.unwrap().forget();
        task.abort();
        let _ = task.await;
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions WHERE consumed_at IS NOT NULL")
                .await,
            2
        );
        s.idp.hold.store(false, Ordering::SeqCst);
        assert!(s.oidc.finish_callback(budget(), retry).await.is_err());
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 2);
        s.close().await;
    }
}

#[tokio::test]
async fn oidc_key_rotation_unknown_kid_singleflight_and_expired_metadata() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    for pg in [false, true] {
        let mut s = Setup::new(pg, "oidc_rotation").await;
        let provider = s.oidc.provider(&s.begin().issuer).unwrap();
        let call = budget();
        let operation = crate::store::lease::OperationBudget::new(call.clone());
        s.oidc
            .metadata(&provider, &operation, &call.request)
            .await
            .unwrap();
        assert_eq!(s.idp.jwks.load(Ordering::SeqCst), 1);
        let names = (0..20).map(|i| format!("unknown-{i}")).collect::<Vec<_>>();
        let results = futures_util::future::join_all(names.iter().map(|name| {
            s.oidc
                .signing_metadata(&provider, &operation, &call.request, Some(name))
        }))
        .await;
        assert!(results.iter().all(Result::is_err));
        assert_eq!(
            s.idp.jwks.load(Ordering::SeqCst),
            2,
            "one refresh for the entire unknown-kid wave"
        );

        s.idp.key_version.store(1, Ordering::SeqCst);
        assert!(
            s.oidc
                .finish_callback(budget(), s.login().await)
                .await
                .is_err()
        );
        assert_eq!(
            s.idp.jwks.load(Ordering::SeqCst),
            2,
            "rotation waits for the same cooldown"
        );
        s.f.clock.0.fetch_add(30_001, Ordering::SeqCst);
        assert!(matches!(
            s.oidc
                .finish_callback(budget(), s.login().await)
                .await
                .unwrap(),
            OidcOutcome::IdentityUnbound(_)
        ));
        assert_eq!(s.idp.jwks.load(Ordering::SeqCst), 3);

        // A failed forced refresh consumes cooldown too; ordinary cached keys
        // remain usable until their own expiry, without hammering the issuer.
        s.f.clock.0.fetch_add(30_001, Ordering::SeqCst);
        s.idp.metadata_failure.store(2, Ordering::SeqCst);
        let before = s.idp.jwks.load(Ordering::SeqCst);
        for kid in ["missing-a", "missing-b"] {
            assert!(
                s.oidc
                    .signing_metadata(&provider, &operation, &call.request, Some(kid))
                    .await
                    .is_err()
            );
        }
        assert_eq!(s.idp.jwks.load(Ordering::SeqCst), before + 1);

        // No durable login transaction is issued from expired metadata after
        // an upstream error, and oversized JWKS is rejected before admission.
        s.f.clock.0.fetch_add(900_001, Ordering::SeqCst);
        let rows =
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions")
                .await;
        assert!(s.oidc.begin_login(budget(), s.begin()).await.is_err());
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions")
                .await,
            rows
        );
        s.idp.metadata_failure.store(3, Ordering::SeqCst);
        assert!(s.oidc.begin_login(budget(), s.begin()).await.is_err());
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions")
                .await,
            rows
        );
        s.idp.metadata_failure.store(0, Ordering::SeqCst);
        s.oidc.begin_login(budget(), s.begin()).await.unwrap();
        s.f.clock.0.fetch_add(3_600_001, Ordering::SeqCst);
        let rows =
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions")
                .await;
        s.idp.metadata_failure.store(1, Ordering::SeqCst);
        assert!(s.oidc.begin_login(budget(), s.begin()).await.is_err());
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions")
                .await,
            rows
        );
        s.idp.metadata_failure.store(0, Ordering::SeqCst);
        s.oidc.begin_login(budget(), s.begin()).await.unwrap();
        s.close().await;
    }
}

#[tokio::test]
async fn oidc_identity_ownership_last_method_and_callback_authority_races() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    for pg in [false, true] {
        let mut s = Setup::new(pg, "oidc_ownership").await;
        let request = s
            .bind_request(&s.session.account.id, "last-method", 1)
            .await;
        let bound = s
            .oidc
            .admin_bind(s.context().await, request.clone())
            .await
            .unwrap();
        let replay = s.oidc.admin_bind(s.context().await, request).await.unwrap();
        assert_eq!(bound.revision, replay.revision);
        let original_password =
            s.f.observer
                .text("SELECT password_hash FROM users WHERE username='owner'")
                .await;
        s.f.observer
            .set_password_hash(&s.session.account.id, "unsupported-hash")
            .await;
        assert!(
            s.oidc
                .unlink(s.context().await, s.unlink_request("last-method", 2).await)
                .await
                .is_err()
        );
        s.oidc
            .admin_bind(
                s.context().await,
                s.bind_request(&s.session.account.id, "other-method", 3)
                    .await,
            )
            .await
            .unwrap();
        let unlink = s.unlink_request("last-method", 4).await;
        let removed = s
            .oidc
            .unlink(s.context().await, unlink.clone())
            .await
            .unwrap();
        assert_eq!(
            removed.revision,
            s.oidc
                .unlink(s.context().await, unlink)
                .await
                .unwrap()
                .revision
        );
        assert!(
            s.oidc
                .unlink(s.context().await, s.unlink_request("other-method", 5).await)
                .await
                .is_err()
        );
        s.f.observer
            .set_password_hash(&s.session.account.id, &original_password)
            .await;
        s.oidc
            .unlink(s.context().await, s.unlink_request("other-method", 6).await)
            .await
            .unwrap();

        let owner = s.account(&s.session.account.id).await;
        let bob = s
            .control
            .create_account(
                s.context().await,
                AccountMutation {
                    identity: command(&owner.id, &owner.id, 7, owner.revision),
                    input: NewAccount {
                        username: "bob".into(),
                        email: None,
                        display_name: "Bob".into(),
                    },
                },
            )
            .await
            .unwrap()
            .value;
        let invitation = s
            .control
            .issue_one_time(
                s.context().await,
                IssueOneTime {
                    account: bob.id.clone(),
                    purpose: OneTimePurpose::Invite,
                    expected: bob.revision,
                },
            )
            .await
            .unwrap();
        let bob_session = s
            .control
            .consume_one_time(
                budget(),
                ConsumeOneTime {
                    token: secret(invitation.value.token.expose()),
                    purpose: OneTimePurpose::Invite,
                    password: secret("another native password"),
                },
            )
            .await
            .unwrap();
        let mut non_admin = s.bind_request(&bob.id, "non-admin", 8).await;
        non_admin.identity.actor = bob.id.clone();
        assert!(
            s.oidc
                .admin_bind(s.context_for(&bob_session).await, non_admin)
                .await
                .is_err()
        );
        let one = s.bind_request(&owner.id, "contested", 9).await;
        let two = s.bind_request(&bob.id, "contested", 10).await;
        let ctx = s.context().await;
        let (one, two) = tokio::join!(
            s.oidc.admin_bind(ctx.clone(), one),
            s.oidc.admin_bind(ctx, two)
        );
        assert_eq!(usize::from(one.is_ok()) + usize::from(two.is_ok()), 1);
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM user_oidc_identities WHERE subject='contested'")
                .await,
            1
        );

        s.oidc
            .admin_bind(
                s.context().await,
                s.bind_request(&owner.id, "external-subject", 11).await,
            )
            .await
            .unwrap();
        let callback = s.login().await;
        let sessions = s.f.observer.count("SELECT COUNT(*) FROM sessions").await;
        s.idp.hold.store(true, Ordering::SeqCst);
        let oidc = s.oidc.clone();
        let login = tokio::spawn(async move { oidc.finish_callback(budget(), callback).await });
        s.idp.entered.acquire().await.unwrap().forget();
        s.oidc
            .unlink(
                s.context().await,
                s.unlink_request("external-subject", 12).await,
            )
            .await
            .unwrap();
        s.idp.hold.store(false, Ordering::SeqCst);
        assert!(matches!(
            login.await.unwrap().unwrap(),
            OidcOutcome::IdentityUnbound(_)
        ));
        assert_eq!(
            s.f.observer.count("SELECT COUNT(*) FROM sessions").await,
            sessions
        );

        let callback = s.idp.callback(
            s.oidc
                .begin_link(s.context().await, s.begin())
                .await
                .unwrap(),
        );
        s.idp.hold.store(true, Ordering::SeqCst);
        let oidc = s.oidc.clone();
        let link = tokio::spawn(async move { oidc.finish_callback(budget(), callback).await });
        s.idp.entered.acquire().await.unwrap().forget();
        s.control
            .logout(evidence(
                AuthEvidenceKind::Session,
                s.session.token.expose(),
            ))
            .await
            .unwrap();
        s.idp.hold.store(false, Ordering::SeqCst);
        assert!(link.await.unwrap().is_err());
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM user_oidc_identities WHERE subject='external-subject'")
                .await,
            0
        );
        s.close().await;
    }
}

#[tokio::test]
async fn oidc_confidential_clients_use_encrypted_references_and_fail_before_exchange() {
    let _serial = crate::TEST_RESOURCE_LOCK.lock().await;
    for pg in [false, true] {
        let mut s = Setup::new(pg, "oidc_confidential").await;
        let credential = CredentialId::from_bytes([9; 16]);
        let envelope = s
            .oidc
            .keyring
            .seal(
                budget(),
                crate::keyring::EnvelopeAddress::credential(&credential),
                secret("test-client-secret"),
            )
            .await
            .unwrap();
        let record = TargetRecord::Credentials(CredentialsRow {
            id: credential.to_string(),
            owner_id: s.session.account.id.to_string(),
            name: "OIDC fixture".into(),
            kind: "oidc-client-secret".into(),
            secret: envelope.encrypted,
            injection: "{}".into(),
            disabled_at: None,
            rpm: None,
            tpm: None,
            consent_epoch: 1,
            runtime_epoch: 1,
            revision: 1,
            created_at: 0,
            updated_at: 0,
        });
        record.validate().unwrap();
        let mut tx =
            s.f.store
                .write(crate::store::lease::OperationBudget::new(budget()))
                .await
                .unwrap();
        record.insert(tx.inner_mut()).await.unwrap();
        tx.commit().await.unwrap();
        let mut config = s.oidc.provider(&s.begin().issuer).unwrap().config.clone();
        config.authentication = OidcClientAuthentication::SecretBasic {
            credential: credential.clone(),
        };
        s.oidc = Arc::new(
            OidcService::new(
                s.control.clone(),
                s.oidc.keyring.clone(),
                s.oidc.outbound.clone(),
                vec![config.clone()],
            )
            .unwrap(),
        );
        s.idp.authentication.store(1, Ordering::SeqCst);
        let callback = s.login().await;
        s.f.observer
            .execute("UPDATE credentials SET kind='provider-secret'")
            .await;
        assert!(
            s.oidc
                .finish_callback(budget(), copy_callback(&callback))
                .await
                .is_err()
        );
        s.f.observer
            .execute("UPDATE credentials SET kind='oidc-client-secret',disabled_at=1")
            .await;
        assert!(
            s.oidc
                .finish_callback(budget(), copy_callback(&callback))
                .await
                .is_err()
        );
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            s.f.observer
                .count("SELECT COUNT(*) FROM oidc_transactions WHERE consumed_at IS NOT NULL")
                .await,
            0
        );
        s.f.observer
            .execute("UPDATE credentials SET disabled_at=NULL")
            .await;
        assert!(matches!(
            s.oidc.finish_callback(budget(), callback).await.unwrap(),
            OidcOutcome::IdentityUnbound(_)
        ));

        let stale_config = s.login().await;
        config.authentication = OidcClientAuthentication::SecretPost { credential };
        s.oidc = Arc::new(
            OidcService::new(
                s.control.clone(),
                s.oidc.keyring.clone(),
                s.oidc.outbound.clone(),
                vec![config],
            )
            .unwrap(),
        );
        s.idp.authentication.store(2, Ordering::SeqCst);
        assert!(
            s.oidc
                .finish_callback(budget(), stale_config)
                .await
                .is_err()
        );
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 1);
        assert!(matches!(
            s.oidc
                .finish_callback(budget(), s.login().await)
                .await
                .unwrap(),
            OidcOutcome::IdentityUnbound(_)
        ));
        assert_eq!(s.idp.calls.load(Ordering::SeqCst), 2);
        let stored = s.f.observer.text("SELECT secret FROM credentials").await;
        assert!(stored.starts_with("v1.ck_") && !stored.contains("test-client-secret"));
        s.close().await;
    }
}
