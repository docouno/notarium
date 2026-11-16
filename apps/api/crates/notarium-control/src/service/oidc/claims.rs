use super::{OidcProviderConfig, OidcService, Provider, denied};
use crate::store::lease::OperationBudget;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{error::PortError, ids::RequestId};
use openidconnect::{
    ClientId, IssuerUrl, Nonce,
    core::{CoreIdToken, CoreIdTokenVerifier, CoreJwsSigningAlgorithm, CoreProviderMetadata},
};
use zeroize::Zeroizing;

struct Header {
    kid: Option<String>,
}
fn header(raw: &str) -> Result<Header, PortError> {
    if raw.len() > 64 * 1024 {
        return Err(denied());
    }
    let first = raw.split('.').next().ok_or_else(denied)?;
    if first.len() > 8192 {
        return Err(denied());
    }
    let decoded = URL_SAFE_NO_PAD.decode(first).map_err(|_| denied())?;
    if URL_SAFE_NO_PAD.encode(&decoded) != first {
        return Err(denied());
    }
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&decoded).map_err(|_| denied())?;
    if map.len() > 16
        || map.keys().any(|key| {
            matches!(
                key.as_str(),
                "jku" | "x5u" | "jwk" | "x5c" | "crit" | "enc" | "zip"
            )
        })
    {
        return Err(denied());
    }
    let alg = map
        .get("alg")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(denied)?;
    if !matches!(alg, "RS256" | "ES256") {
        return Err(denied());
    }
    if let Some(typ) = map.get("typ") {
        let Some(typ) = typ.as_str() else {
            return Err(denied());
        };
        if !typ.eq_ignore_ascii_case("JWT") {
            return Err(denied());
        }
    }
    let kid = match map.get("kid") {
        Some(value) => {
            let kid = value.as_str().ok_or_else(denied)?;
            if kid.is_empty() || kid.len() > 256 {
                return Err(denied());
            }
            Some(kid.to_owned())
        }
        None => None,
    };
    Ok(Header { kid })
}
pub(super) struct VerifiedIdentity {
    pub issuer: String,
    pub subject: String,
    pub contact_email: Option<String>,
}
impl OidcService {
    pub(super) async fn verify_identity(
        &self,
        provider: &Provider,
        budget: &OperationBudget,
        request: &RequestId,
        id_token: &CoreIdToken,
        nonce: &str,
        started: i64,
    ) -> Result<VerifiedIdentity, PortError> {
        // Display preserves the original JWS signing input. Inspect only its
        // bounded header; signatures and claims remain the library's job.
        let raw = Zeroizing::new(id_token.to_string());
        let header = header(&raw)?;
        let metadata = self
            .signing_metadata(provider, budget, request, header.kid.as_deref())
            .await?;
        verify_snapshot(
            &provider.config,
            &metadata,
            id_token,
            nonce,
            started,
            self.control.clock.now_ms()?,
        )
    }
}
fn verify_snapshot(
    config: &OidcProviderConfig,
    metadata: &CoreProviderMetadata,
    id_token: &CoreIdToken,
    nonce: &str,
    started: i64,
    now: i64,
) -> Result<VerifiedIdentity, PortError> {
    header(&Zeroizing::new(id_token.to_string()))?;
    let verify_time =
        chrono::DateTime::from_timestamp_millis(now.saturating_sub(60_000)).ok_or_else(denied)?;
    let trusted = &config.trusted_additional_audiences;
    let verifier = CoreIdTokenVerifier::new_public_client(
        ClientId::new(config.client_id.clone()),
        IssuerUrl::new(config.issuer.clone()).map_err(|_| denied())?,
        metadata.jwks().clone(),
    )
    .set_allowed_algs([
        CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
        CoreJwsSigningAlgorithm::EcdsaP256Sha256,
    ])
    .set_time_fn(move || verify_time)
    .set_issue_time_verifier_fn(move |iat| {
        if iat.timestamp_millis() < started.saturating_sub(60_000)
            || iat.timestamp_millis() > now.saturating_add(60_000)
        {
            Err("ID token issue time outside flow".into())
        } else {
            Ok(())
        }
    })
    .set_other_audience_verifier_fn(move |audience| {
        trusted.iter().any(|value| value == audience.as_str())
    });
    let nonce = Nonce::new(nonce.into());
    let claims = id_token.claims(&verifier, &nonce).map_err(|_| denied())?;
    // openidconnect intentionally leaves azp policy to its caller.
    if claims.issuer().as_str() != config.issuer
        || claims.expiration() <= claims.issue_time()
        || claims
            .authorized_party()
            .is_some_and(|azp| azp.as_str() != config.client_id)
        || (claims.audiences().len() > 1 && claims.authorized_party().is_none())
    {
        return Err(denied());
    }
    let subject = claims.subject().as_str();
    if subject.is_empty() || subject.len() > 1024 || subject.chars().any(char::is_control) {
        return Err(denied());
    }
    let contact_email = claims
        .email()
        .map(|email| email.as_str())
        .filter(|email| email.len() <= 320 && !email.chars().any(char::is_control))
        .map(str::to_owned);
    Ok(VerifiedIdentity {
        issuer: config.issuer.clone(),
        subject: subject.into(),
        contact_email,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_es256_vectors_exercise_signatures_azp_and_header_rejections() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/identity/es256-vector.json"
        ))
        .unwrap();
        let issuer = vectors["claims"]["iss"].as_str().unwrap();
        let metadata:CoreProviderMetadata=serde_json::from_value(serde_json::json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}authorize"),"token_endpoint":format!("{issuer}token"),"jwks_uri":format!("{issuer}jwks"),"response_types_supported":["code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["ES256"]})).unwrap();
        let metadata = metadata.set_jwks(serde_json::from_value(vectors["jwks"].clone()).unwrap());
        let mut config = OidcProviderConfig {
            issuer: issuer.into(),
            client_id: "client-fixture".into(),
            redirect_uri: "https://application.example/callback".into(),
            authentication: super::super::OidcClientAuthentication::Public,
            trusted_additional_audiences: vec!["trusted-peer".into()],
        };
        let nonce = vectors["claims"]["nonce"].as_str().unwrap();
        let now = 1_700_000_000_000;
        let verify = |raw: &str, config: &OidcProviderConfig, nonce: &str, now| {
            let token: CoreIdToken = raw.parse().unwrap();
            verify_snapshot(config, &metadata, &token, nonce, 1_700_000_000_000, now)
        };
        let raw = vectors["token"].as_str().unwrap();
        assert_eq!(
            verify(raw, &config, nonce, now).unwrap().subject,
            "external-p256-user"
        );
        assert!(verify(raw, &config, "wrong-nonce", now).is_err());
        assert!(verify(raw, &config, nonce, now + 3_660_000).is_err());
        for name in [
            "wrong_azp",
            "multi_no_azp",
            "wrong_issuer",
            "future_iat",
            "jku",
            "x5u",
            "jwk",
            "x5c",
            "crit",
            "hmac",
            "unsigned",
        ] {
            assert!(
                verify(
                    vectors["variants"][name].as_str().unwrap(),
                    &config,
                    nonce,
                    now
                )
                .is_err(),
                "{name}"
            );
        }
        for name in ["multi_valid", "no_kid"] {
            assert!(
                verify(
                    vectors["variants"][name].as_str().unwrap(),
                    &config,
                    nonce,
                    now
                )
                .is_ok(),
                "{name}"
            );
        }
        config.trusted_additional_audiences.clear();
        assert!(
            verify(
                vectors["variants"]["multi_valid"].as_str().unwrap(),
                &config,
                nonce,
                now
            )
            .is_err()
        );
        let mut parts = raw.split('.').map(str::to_owned).collect::<Vec<_>>();
        let mut signature = URL_SAFE_NO_PAD.decode(&parts[2]).unwrap();
        signature[0] ^= 1;
        parts[2] = URL_SAFE_NO_PAD.encode(signature);
        assert!(
            verify(&parts.join("."), &config, nonce, now).is_err(),
            "cryptographic verification must run"
        );
        assert!(
            header(&format!(
                "{}.e30.sig",
                URL_SAFE_NO_PAD.encode(format!(
                    "{{\"alg\":\"ES256\",\"kid\":\"{}\"}}",
                    "x".repeat(257)
                ))
            ))
            .is_err()
        );
        assert!(
            header(&format!(
                "{}.e30.sig",
                URL_SAFE_NO_PAD.encode(
                    r#"{"alg":"ES256","typ":"jwt","cty":"JWT","vendor_claim":"allowed","kid":"k1"}"#
                )
            ))
            .is_ok()
        );
    }
}
