use super::{OAuthService, expiry, rejected, validation};
use crate::{
    auth::token,
    outbound::{OutboundRequest, OutboundScope},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    error::{BudgetKind, CommitEffect, PortError},
    ports::*,
};
use reqwest::{
    Method,
    header::{ACCEPT, CONTENT_TYPE, HeaderMap},
};
use serde::Deserialize;
use std::{
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

#[cfg(test)]
#[path = "client_tests.rs"]
mod live_tests;

const DAY: i64 = 24 * 60 * 60 * 1000;
pub(super) struct ClientSnapshot {
    row: OauthClientsRow,
    fetched: bool,
}
impl std::ops::Deref for ClientSnapshot {
    type Target = OauthClientsRow;
    fn deref(&self) -> &Self::Target {
        &self.row
    }
}
impl ClientSnapshot {
    pub fn matches(&self, current: &OauthClientsRow, now: i64) -> bool {
        current.client_id == self.row.client_id
            && digest(current) == digest(&self.row)
            && (fresh(current, now)
                || (self.fetched
                    && current.kind == "cimd"
                    && current.last_seen_at == self.row.last_seen_at
                    && current.cache_expires_at == self.row.cache_expires_at))
    }
}
struct Window {
    started: Instant,
    used: u16,
}
static NEW_RATE: LazyLock<Mutex<Window>> = LazyLock::new(|| {
    Mutex::new(Window {
        started: Instant::now(),
        used: 0,
    })
});
static ACTIVE_RATE: LazyLock<Mutex<Window>> = LazyLock::new(|| {
    Mutex::new(Window {
        started: Instant::now(),
        used: 0,
    })
});
static NEW_FETCH: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
static ACTIVE_FETCH: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
fn limited() -> PortError {
    DomainError::RateLimited {
        retry_after_ms: 60_000,
        budget: BudgetKind::Requests,
    }
    .into()
}
fn admit(active: bool) -> Result<(), PortError> {
    let mut window = if active { &ACTIVE_RATE } else { &NEW_RATE }
        .lock()
        .map_err(|_| limited())?;
    if window.started.elapsed() >= Duration::from_secs(60) {
        window.started = Instant::now();
        window.used = 0;
    }
    if window.used >= if active { 120 } else { 60 } {
        return Err(limited());
    }
    window.used += 1;
    Ok(())
}
pub(super) fn info(row: &OauthClientsRow) -> Result<OAuthClientInfo, PortError> {
    Ok(OAuthClientInfo {
        client_id: row.client_id.clone(),
        client_name: row.client_name.clone(),
        redirect_uris: serde_json::from_str(&row.redirect_uris)
            .map_err(|_| rejected(OAuthErrorCode::InvalidClient))?,
        expires_at_ms: if row.kind == "dcr" && row.activated_at.is_none() {
            Some(expiry(row.created_at, DAY)?)
        } else {
            None
        },
    })
}
pub(super) fn digest(row: &OauthClientsRow) -> [u8; 32] {
    // Metadata changes invalidate an earlier consent view, even when the
    // redirect list happens to remain equal. DCR metadata is immutable.
    row.metadata_digest
        .as_deref()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| token::digest(row.redirect_uris.as_bytes()))
}
pub(super) fn fresh(row: &OauthClientsRow, now: i64) -> bool {
    match row.kind.as_str() {
        "dcr" => row.activated_at.is_some() || row.created_at > now.saturating_sub(DAY),
        "cimd" => row.cache_expires_at.is_some_and(|t| t > now),
        _ => false,
    }
}
pub(super) async fn locked(tx: &mut Transaction, id: &str) -> Result<OauthClientsRow, PortError> {
    rows!(tx,OauthClientsRow,fetch_optional,"SELECT * FROM oauth_clients WHERE client_id=$1","SELECT * FROM v1_control.oauth_clients WHERE client_id=$1 FOR UPDATE";id)?.ok_or_else(||rejected(OAuthErrorCode::InvalidClient))
}
async fn growth_lock(tx: &mut Transaction) -> Result<(), PortError> {
    rows!(tx,(i64,),fetch_one,"SELECT singleton FROM v1_storage_epoch WHERE singleton=1","SELECT singleton FROM v1_control.v1_storage_epoch WHERE singleton=1 FOR UPDATE";)?;
    Ok(())
}
#[derive(Deserialize)]
struct Cimd {
    client_id: String,
    client_name: String,
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}
fn cache_millis(headers: &HeaderMap) -> i64 {
    crate::outbound::metadata::freshness_ms(headers, 300, 3600)
}

impl OAuthService {
    pub(super) async fn register(
        &self,
        call: CallBudget,
        request: RegisterOAuthClient,
    ) -> Result<OAuthClientInfo, PortError> {
        validation::registration(&request)?;
        admit(false)?;
        let budget = OperationBudget::new(call);
        let mut tx = self.control.store.write(budget.clone()).await?;
        let now = self.control.clock.now_ms()?;
        let result=budget.run(async {
            growth_lock(tx.inner_mut()).await?;
            let cutoff=now.saturating_sub(DAY);
            execute!(tx.inner_mut(),"DELETE FROM oauth_clients WHERE kind='dcr' AND activated_at IS NULL AND created_at<=$1","DELETE FROM v1_control.oauth_clients WHERE kind='dcr' AND activated_at IS NULL AND created_at<=$1";cutoff)?;
            let (count,)=rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT COUNT(*) FROM oauth_clients WHERE activated_at IS NULL","SELECT COUNT(*) FROM v1_control.oauth_clients WHERE activated_at IS NULL";)?;
            if count>=1000 {return Err(limited());}
            let row=OauthClientsRow {
                client_id: format!("client_{}",token::random::<16>()?.iter().map(|b|format!("{b:02x}")).collect::<String>()),
                kind:"dcr".into(),redirect_uris:serde_json::to_string(&request.redirect_uris).map_err(|_|rejected(OAuthErrorCode::InvalidRequest))?,client_name:request.client_name,
                metadata_uri:None,metadata_digest:None,cache_expires_at:None,activated_at:None,created_at:now,last_seen_at:None,
            };
            let record=TargetRecord::OauthClients(row.clone()); record.validate()?; record.insert(tx.inner_mut()).await?;
            info(&row)
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(result)
    }
    pub(super) async fn client(
        &self,
        call: CallBudget,
        id: &str,
    ) -> Result<ClientSnapshot, PortError> {
        if id.is_empty() || id.len() > 2048 {
            return Err(rejected(OAuthErrorCode::InvalidClient));
        }
        let budget = OperationBudget::new(call.clone());
        let row=budget.run(async {read_rows!(&self.control.store.backend,OauthClientsRow,fetch_optional,"SELECT * FROM oauth_clients WHERE client_id=$1","SELECT * FROM v1_control.oauth_clients WHERE client_id=$1";id)},CommitEffect::NotCommitted).await?;
        let now = self.control.clock.now_ms()?;
        if let Some(row) = &row {
            if fresh(row, now) {
                return Ok(ClientSnapshot {
                    row: row.clone(),
                    fetched: false,
                });
            }
            if row.kind != "cimd" {
                return Err(rejected(OAuthErrorCode::InvalidClient));
            }
        }
        // CheckedEndpoint and the transport enforce public HTTPS for CIMD.
        let parsed = url::Url::parse(id).map_err(|_| rejected(OAuthErrorCode::InvalidClient))?;
        if parsed.scheme() != "https" {
            return Err(rejected(OAuthErrorCode::InvalidClient));
        }
        let active = row.as_ref().is_some_and(|r| r.activated_at.is_some());
        admit(active)?;
        let _permit = Arc::clone(if active { &ACTIVE_FETCH } else { &NEW_FETCH })
            .try_acquire_owned()
            .map_err(|_| limited())?;
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        let mut response = self
            .outbound
            .send(
                budget.context(call.request.clone()),
                OutboundRequest {
                    scope: OutboundScope::Cimd,
                    url: id.into(),
                    method: Method::GET,
                    headers,
                    body: vec![],
                    response_limit: 64 * 1024,
                },
            )
            .await?;
        if response.status() != 200
            || !response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| {
                    v.split(';')
                        .next()
                        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
                })
        {
            return Err(rejected(OAuthErrorCode::InvalidClient));
        }
        let ttl = cache_millis(response.headers());
        let mut body = Vec::new();
        while let Some(chunk) = response.next_chunk().await? {
            body.extend_from_slice(&chunk);
        }
        let metadata: Cimd =
            serde_json::from_slice(&body).map_err(|_| rejected(OAuthErrorCode::InvalidClient))?;
        if metadata.client_id != id
            || metadata
                .token_endpoint_auth_method
                .as_deref()
                .is_some_and(|v| v != "none")
            || metadata.grant_types.as_ref().is_some_and(|v| {
                v.is_empty()
                    || v.len() > 2
                    || !v.iter().any(|v| v == "authorization_code")
                    || v.iter()
                        .any(|v| !matches!(v.as_str(), "authorization_code" | "refresh_token"))
            })
            || metadata
                .response_types
                .as_ref()
                .is_some_and(|v| v != &["code"])
        {
            return Err(rejected(OAuthErrorCode::InvalidClient));
        }
        let request = RegisterOAuthClient {
            client_name: metadata.client_name,
            redirect_uris: metadata.redirect_uris,
        };
        validation::registration(&request)?;
        let mut tx = self.control.store.write(budget.clone()).await?;
        let now = self.control.clock.now_ms()?;
        let result=budget.run(async {
            growth_lock(tx.inner_mut()).await?;
            let current=rows!(tx.inner_mut(),OauthClientsRow,fetch_optional,"SELECT * FROM oauth_clients WHERE client_id=$1","SELECT * FROM v1_control.oauth_clients WHERE client_id=$1 FOR UPDATE";id)?;
            if let Some(current)=&current && fresh(current,now) {return Ok(ClientSnapshot {row:current.clone(),fetched:false});}
            if current.is_none() {
                execute!(tx.inner_mut(),"DELETE FROM oauth_clients WHERE kind='cimd' AND activated_at IS NULL AND cache_expires_at<=$1","DELETE FROM v1_control.oauth_clients WHERE kind='cimd' AND activated_at IS NULL AND cache_expires_at<=$1";now)?;
                let (count,inactive)=rows!(tx.inner_mut(),(i64,i64),fetch_one,"SELECT COUNT(*),COALESCE(SUM(CASE WHEN activated_at IS NULL THEN 1 ELSE 0 END),0) FROM oauth_clients WHERE kind='cimd'","SELECT COUNT(*),COALESCE(SUM(CASE WHEN activated_at IS NULL THEN 1 ELSE 0 END),0)::BIGINT FROM v1_control.oauth_clients WHERE kind='cimd'";)?;
                if count>=1024 || inactive>=1000 {return Err(limited());}
                let (all_inactive,)=rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT COUNT(*) FROM oauth_clients WHERE activated_at IS NULL","SELECT COUNT(*) FROM v1_control.oauth_clients WHERE activated_at IS NULL";)?;
                if all_inactive>=1000 {return Err(limited());}
            }
            let row=OauthClientsRow {client_id:id.into(),kind:"cimd".into(),redirect_uris:serde_json::to_string(&request.redirect_uris).map_err(|_|rejected(OAuthErrorCode::InvalidClient))?,client_name:request.client_name,
                metadata_uri:Some(id.into()),metadata_digest:Some(token::digest(&body).to_vec()),cache_expires_at:Some(expiry(now,ttl)?),activated_at:current.as_ref().and_then(|v|v.activated_at),created_at:current.as_ref().map_or(now,|v|v.created_at),last_seen_at:Some(now)};
            TargetRecord::OauthClients(row.clone()).validate()?;
            if current.is_some() {
                execute!(tx.inner_mut(),"UPDATE oauth_clients SET redirect_uris=$1,client_name=$2,metadata_digest=$3,cache_expires_at=$4,last_seen_at=$5 WHERE client_id=$6","UPDATE v1_control.oauth_clients SET redirect_uris=$1,client_name=$2,metadata_digest=$3,cache_expires_at=$4,last_seen_at=$5 WHERE client_id=$6";&row.redirect_uris,&row.client_name,&row.metadata_digest,row.cache_expires_at,now,id)?;
            } else {TargetRecord::OauthClients(row.clone()).insert(tx.inner_mut()).await?;}
            Ok(ClientSnapshot {row,fetched:true})
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::CACHE_CONTROL;
    #[test]
    fn cache_control_caps_age_duplicates_and_invalid_directives() {
        let mut headers = HeaderMap::new();
        assert_eq!(cache_millis(&headers), 300_000);
        for (value, expected) in [
            ("max-age=600", 600_000),
            ("max-age=9999", 3_600_000),
            ("max-age=60, max-age=120", 60_000),
            ("no-cache, max-age=600", 0),
            ("no-store", 0),
            ("max-age=broken", 0),
            ("max-age=0", 0),
        ] {
            headers.insert(CACHE_CONTROL, value.parse().unwrap());
            assert_eq!(cache_millis(&headers), expected, "{value}");
        }
        headers.insert(CACHE_CONTROL, "max-age=600".parse().unwrap());
        headers.insert(reqwest::header::AGE, "550".parse().unwrap());
        assert_eq!(cache_millis(&headers), 50_000);
    }
}
