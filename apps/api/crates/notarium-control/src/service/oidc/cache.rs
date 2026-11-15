use super::{OidcService, Provider, denied, http::IdentityHttp};
use crate::{
    outbound::{NetworkPolicy, OutboundScope, metadata::freshness_ms},
    store::lease::OperationBudget,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{
    error::{CommitEffect, PortError},
    ids::RequestId,
};
use openidconnect::{
    HttpResponse, JsonWebKey,
    core::{CoreJsonWebKeySet, CoreProviderMetadata},
};

#[derive(Default)]
pub(super) struct Cache {
    metadata: Option<CoreProviderMetadata>,
    discovery_until: i64,
    keys_until: i64,
    next_forced_refresh: i64,
}
fn body(response: &HttpResponse, jwks: bool) -> Result<&[u8], PortError> {
    let content = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim);
    if response.status().as_u16() != 200
        || !content.is_some_and(|v| {
            v.eq_ignore_ascii_case("application/json")
                || (jwks && v.eq_ignore_ascii_case("application/jwk-set+json"))
        })
    {
        return Err(denied());
    }
    Ok(response.body())
}
fn endpoint(issuer: &str, url: &str) -> Result<(), PortError> {
    NetworkPolicy::default().endpoint(
        OutboundScope::Oidc {
            issuer: issuer.into(),
        },
        url,
    )?;
    Ok(())
}
fn keys(bytes: &[u8]) -> Result<CoreJsonWebKeySet, PortError> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| denied())?;
    let keys = value
        .get("keys")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(denied)?;
    if keys.is_empty() || keys.len() > 256 {
        return Err(denied());
    }
    for key in keys {
        if key
            .get("kid")
            .is_some_and(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 256))
        {
            return Err(denied());
        }
        match key.get("kty").and_then(serde_json::Value::as_str) {
            Some("RSA") => {
                let n = key
                    .get("n")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(denied)?;
                let e = key
                    .get("e")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(denied)?;
                if n.len() > 683 || e.len() > 8 {
                    return Err(denied());
                }
                let modulus = URL_SAFE_NO_PAD.decode(n).map_err(|_| denied())?;
                let exponent = URL_SAFE_NO_PAD.decode(e).map_err(|_| denied())?;
                if !(256..=512).contains(&modulus.len())
                    || modulus.first() == Some(&0)
                    || exponent.is_empty()
                    || exponent.len() > 4
                {
                    return Err(denied());
                }
            }
            Some("EC") if key.get("crv").and_then(serde_json::Value::as_str) == Some("P-256") => {
                for axis in ["x", "y"] {
                    let value = key
                        .get(axis)
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(denied)?;
                    if value.len() != 43
                        || URL_SAFE_NO_PAD.decode(value).map_err(|_| denied())?.len() != 32
                    {
                        return Err(denied());
                    }
                }
            }
            _ => {}
        }
    }
    let result: CoreJsonWebKeySet = serde_json::from_slice(bytes).map_err(|_| denied())?;
    if result.keys().is_empty() {
        return Err(denied());
    }
    Ok(result)
}
fn has_key(metadata: &CoreProviderMetadata, kid: Option<&str>) -> bool {
    match kid {
        Some(kid) => metadata
            .jwks()
            .keys()
            .iter()
            .any(|key| key.key_id().is_some_and(|id| id.as_str() == kid)),
        None => metadata.jwks().keys().len() == 1,
    }
}
impl OidcService {
    fn identity_http(
        &self,
        provider: &Provider,
        budget: &OperationBudget,
        request: &RequestId,
    ) -> IdentityHttp {
        IdentityHttp {
            outbound: self.outbound.clone(),
            issuer: provider.config.issuer.clone(),
            budget: budget.clone(),
            request: request.clone(),
        }
    }
    pub(super) async fn metadata(
        &self,
        provider: &Provider,
        budget: &OperationBudget,
        request: &RequestId,
    ) -> Result<CoreProviderMetadata, PortError> {
        budget
            .run(
                async {
                    let mut cache = provider.cache.lock().await;
                    let now = self.control.clock.now_ms()?;
                    let http = self.identity_http(provider, budget, request);
                    let discovery_expired =
                        cache.metadata.is_none() || cache.discovery_until <= now;
                    let (mut metadata, discovery_until) =
                        if discovery_expired {
                            let url = format!(
                                "{}/.well-known/openid-configuration",
                                provider.config.issuer.trim_end_matches('/')
                            );
                            let response = http.get(&url).await?;
                            let metadata: CoreProviderMetadata =
                                serde_json::from_slice(body(&response, false)?)
                                    .map_err(|_| denied())?;
                            if metadata.issuer().as_str() != provider.config.issuer {
                                return Err(denied());
                            }
                            endpoint(
                                &provider.config.issuer,
                                metadata.authorization_endpoint().as_str(),
                            )?;
                            endpoint(
                                &provider.config.issuer,
                                metadata.token_endpoint().ok_or_else(denied)?.as_str(),
                            )?;
                            endpoint(&provider.config.issuer, metadata.jwks_uri().as_str())?;
                            // Never accept discovery-supplied duplicates of protocol-owned
                            // authorization parameters in an existing endpoint query.
                            if metadata.authorization_endpoint().url().query_pairs().any(
                                |(key, _)| {
                                    matches!(
                                        key.as_ref(),
                                        "client_id"
                                            | "redirect_uri"
                                            | "response_type"
                                            | "scope"
                                            | "state"
                                            | "nonce"
                                            | "code_challenge"
                                            | "code_challenge_method"
                                    )
                                },
                            ) {
                                return Err(denied());
                            }
                            (
                                metadata,
                                now.saturating_add(freshness_ms(response.headers(), 3600, 3600)),
                            )
                        } else {
                            (
                                cache.metadata.clone().ok_or_else(denied)?,
                                cache.discovery_until,
                            )
                        };
                    let keys_until = if discovery_expired || cache.keys_until <= now {
                        let response = http.get(metadata.jwks_uri().as_str()).await?;
                        metadata = metadata.set_jwks(keys(body(&response, true)?)?);
                        now.saturating_add(freshness_ms(response.headers(), 15 * 60, 15 * 60))
                    } else {
                        cache.keys_until
                    };
                    cache.metadata = Some(metadata.clone());
                    cache.discovery_until = discovery_until;
                    cache.keys_until = keys_until;
                    Ok(metadata)
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
    pub(super) async fn signing_metadata(
        &self,
        provider: &Provider,
        budget: &OperationBudget,
        request: &RequestId,
        kid: Option<&str>,
    ) -> Result<CoreProviderMetadata, PortError> {
        let metadata = self.metadata(provider, budget, request).await?;
        if has_key(&metadata, kid) {
            return Ok(metadata);
        }
        budget
            .run(
                async {
                    let mut cache = provider.cache.lock().await;
                    let now = self.control.clock.now_ms()?;
                    let current = cache.metadata.as_ref().ok_or_else(denied)?;
                    if has_key(current, kid) {
                        return Ok(current.clone());
                    }
                    if now < cache.next_forced_refresh {
                        return Err(denied());
                    }
                    // Set before awaiting I/O so even failed refreshes consume cooldown.
                    cache.next_forced_refresh = now.saturating_add(30_000);
                    let mut metadata = cache.metadata.clone().ok_or_else(denied)?;
                    let response = self
                        .identity_http(provider, budget, request)
                        .get(metadata.jwks_uri().as_str())
                        .await?;
                    metadata = metadata.set_jwks(keys(body(&response, true)?)?);
                    cache.keys_until =
                        now.saturating_add(freshness_ms(response.headers(), 15 * 60, 15 * 60));
                    cache.metadata = Some(metadata.clone());
                    if !has_key(&metadata, kid) {
                        return Err(denied());
                    }
                    Ok(metadata)
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
}
