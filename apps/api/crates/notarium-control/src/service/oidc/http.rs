use crate::{
    outbound::{OutboundRequest, OutboundScope, OutboundTransport},
    store::lease::OperationBudget,
};
use notarium_core::{error::PortError, ids::RequestId};
use openidconnect::{AsyncHttpClient, HttpRequest, HttpResponse};
use std::{future::Future, pin::Pin, sync::Arc};

/// The OIDC library never creates its own client, resolver or TLS stack.
pub(super) struct IdentityHttp {
    pub outbound: Arc<OutboundTransport>,
    pub issuer: String,
    pub budget: OperationBudget,
    pub request: RequestId,
}
impl<'c> AsyncHttpClient<'c> for IdentityHttp {
    type Error = PortError;
    type Future = Pin<Box<dyn Future<Output = Result<HttpResponse, PortError>> + Send + 'c>>;
    fn call(&'c self, request: HttpRequest) -> Self::Future {
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            let mut response = self
                .outbound
                .send(
                    self.budget.context(self.request.clone()),
                    OutboundRequest {
                        scope: OutboundScope::Oidc {
                            issuer: self.issuer.clone(),
                        },
                        url: parts.uri.to_string(),
                        method: parts.method,
                        headers: parts.headers,
                        body,
                        response_limit: 256 * 1024,
                    },
                )
                .await?;
            let status = response.status();
            let headers = response.headers().clone();
            let mut body = Vec::new();
            while let Some(chunk) = response.next_chunk().await? {
                body.extend_from_slice(&chunk);
            }
            let mut result = HttpResponse::new(body);
            *result.status_mut() =
                openidconnect::http::StatusCode::from_u16(status).map_err(|_| super::denied())?;
            *result.headers_mut() = headers;
            Ok(result)
        })
    }
}
impl IdentityHttp {
    pub async fn get(&self, url: &str) -> Result<HttpResponse, PortError> {
        let request = openidconnect::http::Request::builder()
            .method("GET")
            .uri(url)
            .header("Accept", "application/json")
            .body(vec![])
            .map_err(|_| super::denied())?;
        self.call(request).await
    }
}
