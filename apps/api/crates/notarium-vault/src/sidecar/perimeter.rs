use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use axum::{
    extract::Request,
    http::{
        Extensions, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Version,
        header::{
            ACCESS_CONTROL_ALLOW_CREDENTIALS, ACCESS_CONTROL_ALLOW_HEADERS,
            ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_MAX_AGE,
            ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD, AUTHORIZATION,
            CONNECTION, HOST, ORIGIN, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL,
            SEC_WEBSOCKET_VERSION, UPGRADE, VARY,
        },
    },
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::ids::{NoteId, SpaceId};
use subtle::ConstantTimeEq;
use tower::{Layer, Service};
use zeroize::Zeroizing;

use super::{SidecarError, SidecarOrigin};

const REQUEST_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-request-private-network");
const ALLOW_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-allow-private-network");

pub const COLLAB_PROTOCOL: &str = "notarium.collab.v1";
pub const TICKET_PROTOCOL_PREFIX: &str = "notarium.ticket.";
pub const WS_TICKET_PATH: &str = "/api/v1/auth/ws-ticket";

/// The bearer is held in decoded form and has no logging or serialization surface.
pub struct LaunchToken(Zeroizing<[u8; 32]>);

impl LaunchToken {
    pub fn parse(encoded: &str) -> Result<Self, SidecarError> {
        decode(encoded).map(Self).ok_or(SidecarError::LaunchFrame)
    }

    fn matches_bearer(&self, headers: &HeaderMap) -> bool {
        let Some(candidate) = single(headers, AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .and_then(decode::<32>)
        else {
            return false;
        };
        bool::from(self.0[..].ct_eq(&candidate[..]))
    }
}

fn decode<const N: usize>(encoded: &str) -> Option<Zeroizing<[u8; N]>> {
    if encoded.len() != (N * 8).div_ceil(6) {
        return None;
    }
    let mut decoded = Zeroizing::new([0; N]);
    (URL_SAFE_NO_PAD.decode_slice(encoded, &mut *decoded).ok()? == N).then_some(decoded)
}

/// A preflight rule for an exact path and method served by the sidecar.
pub struct PreflightRule {
    path: &'static str,
    method: Method,
    headers: &'static [HeaderName],
}

impl PreflightRule {
    pub const fn new(path: &'static str, method: Method, headers: &'static [HeaderName]) -> Self {
        Self {
            path,
            method,
            headers,
        }
    }
}

/// The protocol carries only a short-lived, single-use ticket. Its consumer
/// owns verifying and atomically consuming the ticket for the session and path.
pub struct WsTicketRequest {
    pub space_id: SpaceId,
    pub note_id: NoteId,
    pub ticket: Zeroizing<[u8; 16]>,
}

pub trait WsTicketVerifier: Send + Sync {
    /// On successful validation and consumption, return the scoped authority
    /// to install as request extensions for the WebSocket handler.
    fn consume(
        &self,
        request: WsTicketRequest,
    ) -> Pin<Box<dyn Future<Output = Option<Extensions>> + Send + '_>>;
}

#[derive(Clone)]
pub struct SidecarPerimeter(Arc<Rules>);

struct Rules {
    authority: HeaderValue,
    origin: HeaderValue,
    token: LaunchToken,
    preflight: Vec<PreflightRule>,
    tickets: Option<Arc<dyn WsTicketVerifier>>,
}

impl SidecarPerimeter {
    pub fn new(
        port: u16,
        origin: SidecarOrigin,
        token: LaunchToken,
        preflight: Vec<PreflightRule>,
        tickets: Option<Arc<dyn WsTicketVerifier>>,
    ) -> Self {
        Self(Arc::new(Rules {
            authority: HeaderValue::from_str(&format!("127.0.0.1:{port}"))
                .expect("numeric authority"),
            origin: HeaderValue::from_static(origin.as_str()),
            token,
            preflight,
            tickets,
        }))
    }
}

impl<S> Layer<S> for SidecarPerimeter {
    type Service = SidecarService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        SidecarService {
            inner,
            rules: self.0.clone(),
        }
    }
}

#[derive(Clone)]
pub struct SidecarService<S> {
    inner: S,
    rules: Arc<Rules>,
}

impl<S> Service<Request> for SidecarService<S>
where
    S: Service<Request, Response = Response> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request) -> Self::Future {
        let rules = self.rules.clone();
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        Box::pin(async move {
            if !rules.check_target(&request) {
                return Ok(StatusCode::FORBIDDEN.into_response());
            }
            if request.method() == Method::OPTIONS {
                return Ok(rules.preflight(&request));
            }

            let response = if is_upgrade(&request) {
                let authority = match (&rules.tickets, ticket(&request)) {
                    (Some(verifier), Some(ticket)) => verifier.consume(ticket).await,
                    _ => None,
                };
                let Some(authority) = authority else {
                    return Ok(rules.with_origin(StatusCode::UNAUTHORIZED.into_response()));
                };
                request.extensions_mut().extend(authority);
                // Only the negotiated protocol reaches the handler, tracing and response.
                request.headers_mut().insert(
                    SEC_WEBSOCKET_PROTOCOL,
                    HeaderValue::from_static(COLLAB_PROTOCOL),
                );
                let mut response = inner.call(request).await?;
                if response.status() == StatusCode::SWITCHING_PROTOCOLS {
                    response.headers_mut().insert(
                        SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static(COLLAB_PROTOCOL),
                    );
                }
                response
            } else {
                if !rules.token.matches_bearer(request.headers()) {
                    return Ok(rules.with_origin(StatusCode::UNAUTHORIZED.into_response()));
                }
                // The local bearer is separate from the application's authority.
                request.headers_mut().remove(AUTHORIZATION);
                inner.call(request).await?
            };
            Ok(rules.with_origin(response))
        })
    }
}

impl Rules {
    fn check_target(&self, request: &Request) -> bool {
        matches!(request.version(), Version::HTTP_10 | Version::HTTP_11)
            && single(request.headers(), HOST) == Some(&self.authority)
            && single(request.headers(), ORIGIN) == Some(&self.origin)
            && request.uri().authority().is_none_or(|authority| {
                authority.as_str().as_bytes() == self.authority.as_bytes()
                    && request.uri().scheme_str() == Some("http")
            })
    }

    fn with_origin(&self, mut response: Response) -> Response {
        let headers = response.headers_mut();
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, self.origin.clone());
        headers.remove(ACCESS_CONTROL_ALLOW_CREDENTIALS);
        headers.remove(ACCESS_CONTROL_ALLOW_HEADERS);
        headers.remove(ACCESS_CONTROL_ALLOW_METHODS);
        headers.remove(ACCESS_CONTROL_MAX_AGE);
        headers.remove(ALLOW_PRIVATE_NETWORK);
        headers.append(VARY, HeaderValue::from_static("Origin"));
        response
    }

    fn preflight(&self, request: &Request) -> Response {
        let forbidden = || StatusCode::FORBIDDEN.into_response();
        let headers = request.headers();
        if headers.contains_key(AUTHORIZATION) || is_upgrade(request) {
            return forbidden();
        }
        let Some(method) = single(headers, ACCESS_CONTROL_REQUEST_METHOD) else {
            return forbidden();
        };
        let Some(rule) = self.preflight.iter().find(|rule| {
            rule.path == request.uri().path()
                && rule.method.as_str().as_bytes() == method.as_bytes()
        }) else {
            return forbidden();
        };
        let Some(requested_headers) = optional(headers, ACCESS_CONTROL_REQUEST_HEADERS) else {
            return forbidden();
        };
        if let Some(requested_headers) = requested_headers {
            let Ok(value) = requested_headers.to_str() else {
                return forbidden();
            };
            if !value.split(',').all(|name| {
                rule.headers
                    .iter()
                    .any(|allowed| allowed.as_str().eq_ignore_ascii_case(name.trim()))
            }) {
                return forbidden();
            }
        }
        let Some(private_network) = optional(headers, REQUEST_PRIVATE_NETWORK) else {
            return forbidden();
        };
        if private_network.is_some_and(|value| value.as_bytes() != b"true") {
            return forbidden();
        }

        let mut response = self.with_origin(StatusCode::NO_CONTENT.into_response());
        let headers = response.headers_mut();
        headers.insert(ACCESS_CONTROL_ALLOW_METHODS, method.clone());
        if let Some(requested_headers) = requested_headers {
            headers.insert(ACCESS_CONTROL_ALLOW_HEADERS, requested_headers.clone());
        }
        if private_network.is_some() {
            headers.insert(ALLOW_PRIVATE_NETWORK, HeaderValue::from_static("true"));
        }
        headers.append(
            VARY,
            HeaderValue::from_static(
                "Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
            ),
        );
        response
    }
}

fn single(headers: &HeaderMap, name: HeaderName) -> Option<&HeaderValue> {
    optional(headers, name).flatten()
}

// Distinguish an omitted field from a malformed duplicate.
fn optional(headers: &HeaderMap, name: HeaderName) -> Option<Option<&HeaderValue>> {
    let mut values = headers.get_all(name).into_iter();
    let first = values.next();
    values.next().is_none().then_some(first)
}

fn contains_token(header: &HeaderValue, expected: &str) -> bool {
    header.to_str().is_ok_and(|value| {
        value
            .split(',')
            .any(|token| token.trim().eq_ignore_ascii_case(expected))
    })
}

fn is_upgrade(request: &Request) -> bool {
    let headers = request.headers();
    headers.contains_key(UPGRADE)
        || headers.contains_key(SEC_WEBSOCKET_PROTOCOL)
        || headers.contains_key(SEC_WEBSOCKET_KEY)
        || headers.contains_key(SEC_WEBSOCKET_VERSION)
        || headers
            .get_all(CONNECTION)
            .iter()
            .any(|value| contains_token(value, "upgrade"))
}

fn ticket(request: &Request) -> Option<WsTicketRequest> {
    let headers = request.headers();
    if request.method() != Method::GET
        || request.uri().query().is_some()
        || headers.contains_key(AUTHORIZATION)
        || !single(headers, UPGRADE)?
            .as_bytes()
            .eq_ignore_ascii_case(b"websocket")
        || !single(headers, CONNECTION).is_some_and(|value| contains_token(value, "upgrade"))
        || single(headers, SEC_WEBSOCKET_VERSION)?.as_bytes() != b"13"
    {
        return None;
    }
    // Reject malformed upgrade requests before spending a valid ticket.
    let key = single(headers, SEC_WEBSOCKET_KEY)?.as_bytes();
    if key.len() != 24
        || base64::engine::general_purpose::STANDARD
            .decode_slice(key, &mut [0; 16])
            .ok()?
            != 16
    {
        return None;
    }
    let mut path = request
        .uri()
        .path()
        .strip_prefix("/api/v1/spaces/")?
        .split('/');
    let space_id = SpaceId::parse(path.next()?).ok()?;
    if path.next()? != "notes" {
        return None;
    }
    let note_id = NoteId::parse(path.next()?).ok()?;
    if path.next()? != "collab" || path.next().is_some() {
        return None;
    }
    let mut encoding = None;
    let mut protocol = false;
    for offered in single(headers, SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
    {
        match offered {
            COLLAB_PROTOCOL if !protocol => protocol = true,
            offered if encoding.is_none() => {
                encoding = Some(offered.strip_prefix(TICKET_PROTOCOL_PREFIX)?)
            }
            _ => return None,
        }
    }
    if !protocol {
        return None;
    }
    Some(WsTicketRequest {
        space_id,
        note_id,
        ticket: decode(encoding?)?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{Router, body::Body, routing::any};
    use tower::ServiceExt as _;

    use super::*;

    const AUTHORITY: &str = "127.0.0.1:42157";
    const TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[tokio::test]
    async fn denied_requests_and_allowed_preflights_never_reach_inner_service() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let protected = Router::new()
            .route(
                "/api/greeting",
                any(move |request: Request| {
                    let count = count.clone();
                    async move {
                        assert!(!request.headers().contains_key(AUTHORIZATION));
                        count.fetch_add(1, Ordering::Relaxed);
                        StatusCode::OK
                    }
                }),
            )
            .layer(SidecarPerimeter::new(
                42157,
                SidecarOrigin::App,
                LaunchToken::parse(TOKEN).unwrap(),
                vec![PreflightRule::new(
                    "/api/greeting",
                    Method::GET,
                    &[AUTHORIZATION],
                )],
                None,
            ));

        let call = |method: Method, uri: &'static str| {
            Request::builder()
                .method(method)
                .uri(uri)
                .header(HOST, AUTHORITY)
                .header(ORIGIN, SidecarOrigin::App.as_str())
        };
        let requests = [
            (call(Method::GET, "/api/greeting"), StatusCode::UNAUTHORIZED),
            (
                call(Method::GET, "http://example.com/api/greeting")
                    .header(AUTHORIZATION, format!("Bearer {TOKEN}")),
                StatusCode::FORBIDDEN,
            ),
            (
                call(Method::GET, "/api/greeting").header(HOST, AUTHORITY),
                StatusCode::FORBIDDEN,
            ),
            (
                call(Method::OPTIONS, "/api/greeting")
                    .header(ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header(ACCESS_CONTROL_REQUEST_HEADERS, "authorization"),
                StatusCode::NO_CONTENT,
            ),
            (
                call(Method::OPTIONS, "/api/greeting").header(ACCESS_CONTROL_REQUEST_METHOD, "PUT"),
                StatusCode::FORBIDDEN,
            ),
            (
                call(Method::OPTIONS, "/api/unrecognized")
                    .header(ACCESS_CONTROL_REQUEST_METHOD, "GET"),
                StatusCode::FORBIDDEN,
            ),
            (
                call(Method::OPTIONS, "/api/greeting")
                    .header(ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header(AUTHORIZATION, format!("Bearer {TOKEN}")),
                StatusCode::FORBIDDEN,
            ),
            (
                call(Method::GET, "/api/greeting")
                    .header(CONNECTION, "Upgrade")
                    .header(UPGRADE, "websocket")
                    .header(AUTHORIZATION, format!("Bearer {TOKEN}")),
                StatusCode::UNAUTHORIZED,
            ),
        ];
        for (request, status) in requests {
            assert_eq!(
                protected
                    .clone()
                    .oneshot(request.body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                status,
            );
        }
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let authorized = call(Method::GET, "/api/greeting")
            .header(AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            protected.oneshot(authorized).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }
}
