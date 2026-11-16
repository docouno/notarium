use super::rejected;
use crate::auth::token;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{error::PortError, ids::PrincipalId, ports::*};
use url::{Host, Url};

pub(super) fn grant_client(principal: &PrincipalId, client: &str) -> Result<(), PortError> {
    crate::store::target::validate_index(principal.as_str().len().saturating_add(client.len()))
        .map_err(|_| rejected(OAuthErrorCode::InvalidClient))
}

pub(super) fn scope(raw: &str) -> Result<OAuthScope, PortError> {
    if raw.len() > 128 {
        return Err(rejected(OAuthErrorCode::InvalidScope));
    }
    let (mut read, mut write, mut offline) = (false, false, false);
    for part in raw.split(' ') {
        match part {
            "read" => read = true,
            "write" => write = true,
            "offline_access" => offline = true,
            _ => return Err(rejected(OAuthErrorCode::InvalidScope)),
        }
    }
    if !read && !write {
        return Err(rejected(OAuthErrorCode::InvalidScope));
    }
    Ok(OAuthScope {
        access: if write {
            BearerScope::Write
        } else {
            BearerScope::Read
        },
        offline_access: offline,
    })
}
pub(super) fn scope_name(scope: BearerScope) -> &'static str {
    match scope {
        BearerScope::Read => "read",
        BearerScope::Write => "write",
    }
}
pub(super) fn stored_scope(raw: &str) -> Result<BearerScope, PortError> {
    match raw {
        "read" => Ok(BearerScope::Read),
        "write" => Ok(BearerScope::Write),
        _ => Err(super::invalid_grant()),
    }
}
pub(super) fn challenge(value: &str) -> Result<(), PortError> {
    if value.len() != 43
        || URL_SAFE_NO_PAD
            .decode(value)
            .ok()
            .filter(|v| v.len() == 32 && URL_SAFE_NO_PAD.encode(v) == value)
            .is_none()
    {
        return Err(rejected(OAuthErrorCode::InvalidRequest));
    }
    Ok(())
}
pub(super) fn verify_pkce(verifier: &str, expected: &str) -> Result<(), PortError> {
    if !(43..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._~".contains(&c))
    {
        return Err(super::invalid_grant());
    }
    let actual = URL_SAFE_NO_PAD.encode(token::digest(verifier.as_bytes()));
    if !token::verify(
        &token::digest(expected.as_bytes()),
        &token::digest(actual.as_bytes()),
    ) {
        return Err(super::invalid_grant());
    }
    Ok(())
}
fn url(raw: &str) -> Result<Url, PortError> {
    let bad = || rejected(OAuthErrorCode::InvalidRedirectUri);
    if raw.len() > 2048
        || raw
            .bytes()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control() || c == b'\\')
    {
        return Err(bad());
    }
    let authority = authority(raw).ok_or_else(bad)?;
    let url = Url::parse(raw).map_err(|_| bad())?;
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
        || authority.contains('@')
        || authority.ends_with(':')
    {
        return Err(bad());
    }
    Ok(url)
}
fn authority(raw: &str) -> Option<&str> {
    raw.split_once("://")?.1.split(['/', '?', '#']).next()
}
fn raw_host(authority: &str) -> Option<&str> {
    if authority.starts_with('[') {
        Some(&authority[..=authority.find(']')?])
    } else {
        authority.split(':').next()
    }
}
fn native(url: &Url) -> bool {
    url.scheme() == "http"
        && match url.host() {
            Some(Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
            _ => false,
        }
}
pub(crate) fn redirect(raw: &str) -> Result<Url, PortError> {
    let parsed = url(raw)?;
    if parsed.scheme() != "https" && !native(&parsed) {
        return Err(rejected(OAuthErrorCode::InvalidRedirectUri));
    }
    if native(&parsed)
        && !matches!(
            authority(raw).and_then(raw_host),
            Some("127.0.0.1" | "[::1]")
        )
    {
        return Err(rejected(OAuthErrorCode::InvalidRedirectUri));
    }
    Ok(parsed)
}
fn without_loopback_port(raw: &str) -> Option<String> {
    let (scheme, rest) = raw.split_once("://")?;
    let authority = authority(raw)?;
    Some(format!(
        "{scheme}://{}{}",
        raw_host(authority)?,
        &rest[authority.len()..]
    ))
}
pub(super) fn matches_redirect(registered: &[String], actual: &str) -> Result<(), PortError> {
    let candidate = redirect(actual)?;
    for entry in registered {
        let expected = redirect(entry)?;
        if entry == actual {
            return Ok(());
        }
        // RFC 8252 permits a dynamically chosen loopback port only. Preserve
        // every other byte, including path escapes and dot segments.
        if native(&candidate)
            && native(&expected)
            && without_loopback_port(entry) == without_loopback_port(actual)
        {
            return Ok(());
        }
    }
    Err(rejected(OAuthErrorCode::InvalidRedirectUri))
}
pub(super) fn server_url(raw: &str) -> Result<(), PortError> {
    let parsed = redirect(raw)?;
    if parsed.query().is_some() || parsed.as_str() != raw {
        return Err(rejected(OAuthErrorCode::InvalidRequest));
    }
    Ok(())
}
pub(super) fn registration(request: &RegisterOAuthClient) -> Result<(), PortError> {
    if request.client_name.is_empty()
        || request.client_name.len() > 256
        || request.client_name.chars().any(char::is_control)
        || !(1..=10).contains(&request.redirect_uris.len())
        || request.redirect_uris.iter().map(String::len).sum::<usize>() + request.client_name.len()
            > 8000
    {
        return Err(rejected(OAuthErrorCode::InvalidRequest));
    }
    for uri in &request.redirect_uris {
        redirect(uri)?;
    }
    if serde_json::to_vec(request)
        .map_err(|_| rejected(OAuthErrorCode::InvalidRequest))?
        .len()
        > 8192
    {
        return Err(rejected(OAuthErrorCode::InvalidRequest));
    }
    Ok(())
}
pub(crate) fn browser(value: &str) -> Result<[u8; 32], PortError> {
    if !(32..=256).contains(&value.len()) {
        return Err(rejected(OAuthErrorCode::InvalidRequest));
    }
    Ok(token::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc7636_vector_and_redirect_boundaries() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        super::challenge(challenge).unwrap();
        verify_pkce(verifier, challenge).unwrap();
        assert!(verify_pkce(&format!("{verifier}x"), challenge).is_err());
        assert!(super::challenge(&format!("{challenge}=")).is_err());
        for denied in [
            "http://localhost/cb",
            "http://127.1/cb",
            "http://2130706433/cb",
            "http://127.0.0.2/cb",
            "https://user@example.test/cb",
            "https://@example.test/cb",
            "https://example.test/cb#x",
            "https://example.test:0/cb",
            "https://example.test:/cb",
            "https://example.test/\\evil",
        ] {
            assert!(redirect(denied).is_err(), "{denied}");
        }
        let registered = vec!["http://127.0.0.1:1234/cb?app=one".into()];
        matches_redirect(&registered, "http://127.0.0.1:54321/cb?app=one").unwrap();
        for denied in [
            "http://[::1]:54321/cb?app=one",
            "http://127.0.0.1:54321/cb?app=two",
            "http://127.0.0.1:54321/cb/extra?app=one",
        ] {
            assert!(matches_redirect(&registered, denied).is_err());
        }
        let exact = vec!["https://client.example/callback".into()];
        assert!(matches_redirect(&exact, "https://client.example/callback/extra").is_err());
        assert!(matches_redirect(&exact, "https://client.example:8443/callback").is_err());
        let spelling = vec!["https://Client.Example:443/a/../callback".into()];
        matches_redirect(&spelling, &spelling[0]).unwrap();
        assert!(matches_redirect(&spelling, "https://client.example/callback").is_err());
        assert!(matches_redirect(&registered, "http://127.0.0.1:54321/a/../cb?app=one").is_err());
        assert_eq!(
            scope("read write offline_access").unwrap(),
            OAuthScope {
                access: BearerScope::Write,
                offline_access: true
            }
        );
        for denied in ["", "offline_access", "admin", "read\twrite"] {
            assert!(scope(denied).is_err());
        }
    }
}
