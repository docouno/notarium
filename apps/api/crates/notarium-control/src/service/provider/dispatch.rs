//! Owned dispatch: SQL authority -> live registration -> wire -> shutdown -> audit.
use super::{
    ProviderService, accounting,
    admission::DispatchAuthority,
    execution::{CancelOnDrop, Job, Request, Runtime},
    records::*,
    wire,
};
use crate::{
    error::{invalid, unavailable},
    outbound::{OutboundRequest, OutboundResponse},
    store::target::ProviderCallLogRow,
};
use notarium_core::{
    DomainError,
    error::{BudgetKind, CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::{control::*, *},
};
use reqwest::{
    Method,
    header::{ACCEPT, CONTENT_TYPE, HeaderValue},
};
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, mpsc, oneshot};
#[path = "responses.rs"]
mod responses;
#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;

fn failed() -> PortError {
    unavailable("provider worker", CommitEffect::Unknown)
}
fn protocol() -> PortError {
    provider_error(ProviderErrorCode::Protocol)
}
fn provider_error(error: ProviderErrorCode) -> PortError {
    DomainError::Provider { error }.into()
}

#[derive(Default)]
struct Leases {
    canonical: Option<Box<dyn ProviderEgressLease>>,
    registration: Option<Box<dyn RevocationLease>>,
}
impl Leases {
    fn check(&mut self) -> Result<(), PortError> {
        if let Some(lease) = &self.canonical {
            lease.check()?;
        }
        if let Some(lease) = &self.registration {
            lease.check()?;
        }
        Ok(())
    }
    async fn run<T>(
        &mut self,
        runtime: &Runtime,
        operation: impl Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        self.check()?;
        let result = runtime.run(operation, CommitEffect::Unknown).await;
        self.check()?;
        result
    }
}
struct Progress {
    call: RequestId,
    reserved: bool,
    submitted: bool,
    mismatch: bool,
    usage: ProviderUsage,
    leases: Leases,
    response: Option<OutboundResponse>,
}
enum Output {
    Completion(Vec<CompletionEvent>),
    Embedding(EmbeddingResult),
    Connection(ProviderConnectionStatus),
}

struct CompletionStream {
    receiver: mpsc::Receiver<CompletionEvent>,
    error: Arc<Mutex<Option<PortError>>>,
    _guard: CancelOnDrop,
}
impl PortStream<CompletionEvent> for CompletionStream {
    fn next(&mut self) -> PortFuture<'_, Option<CompletionEvent>> {
        Box::pin(async {
            if let Some(event) = self.receiver.recv().await {
                return Ok(Some(event));
            }
            if let Some(error) = self.error.lock().expect("provider stream result").take() {
                return Err(error);
            }
            Ok(None)
        })
    }
}
impl ProviderService {
    fn acquire_call_permit(&self) -> Result<OwnedSemaphorePermit, PortError> {
        self.active_calls.clone().try_acquire_owned().map_err(|_| {
            DomainError::RateLimited {
                retry_after_ms: 100,
                budget: BudgetKind::Concurrency,
            }
            .into()
        })
    }
    pub async fn complete(
        &self,
        ctx: SpaceContext,
        request: CompletionRequest,
    ) -> Result<Box<dyn PortStream<CompletionEvent>>, PortError> {
        let permit = self.acquire_call_permit()?;
        let job = Job::completion(ctx, request);
        let runtime = Runtime::new(job.ctx.budget.clone());
        runtime.check(CommitEffect::NotCommitted)?;
        let guard = CancelOnDrop(runtime.cancelled.clone());
        let (sender, receiver) = mpsc::channel(8);
        let error = Arc::new(Mutex::new(None));
        let terminal = error.clone();
        let service = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let result = async {
                let Output::Completion(events) =
                    service.execute(&runtime, &job, Some(&sender)).await?
                else {
                    return Err(protocol());
                };
                for event in events {
                    runtime
                        .run(
                            async { sender.send(event).await.map_err(|_| failed()) },
                            CommitEffect::Unknown,
                        )
                        .await?;
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                *terminal.lock().expect("provider stream result") = Some(error);
            }
        });
        Ok(Box::new(CompletionStream {
            receiver,
            error,
            _guard: guard,
        }))
    }
    async fn unary(&self, job: Job) -> Result<Output, PortError> {
        let permit = self.acquire_call_permit()?;
        let runtime = Runtime::new(job.ctx.budget.clone());
        runtime.check(CommitEffect::NotCommitted)?;
        let _guard = CancelOnDrop(runtime.cancelled.clone());
        let (sender, receiver) = oneshot::channel();
        let service = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let result = service.execute(&runtime, &job, None).await;
            let _ = sender.send(result);
        });
        receiver.await.map_err(|_| failed())?
    }
    pub async fn embed(
        &self,
        ctx: SpaceContext,
        request: EmbeddingRequest,
    ) -> Result<EmbeddingResult, PortError> {
        match self.unary(Job::embedding(ctx, request)).await? {
            Output::Embedding(result) => Ok(result),
            _ => Err(protocol()),
        }
    }
    pub async fn check_connection(
        &self,
        ctx: AccountContext,
        request: CheckProviderConnection,
    ) -> Result<ProviderConnectionStatus, PortError> {
        match self.unary(Job::connection(ctx, request)).await? {
            Output::Connection(result) => Ok(result),
            _ => Err(protocol()),
        }
    }
    async fn execute(
        &self,
        runtime: &Runtime,
        job: &Job,
        sender: Option<&mpsc::Sender<CompletionEvent>>,
    ) -> Result<Output, PortError> {
        let mut progress = Progress {
            call: RequestId::from_bytes(crate::auth::token::random()?),
            reserved: false,
            submitted: false,
            mismatch: false,
            usage: ProviderUsage::Unknown,
            leases: Leases::default(),
            response: None,
        };
        let mut result = self.perform(runtime, job, sender, &mut progress).await;
        // Cancellation/drop only signals the transport. Keep every authority
        // lease until its owned producer acknowledges actual network shutdown.
        if let Some(response) = progress.response.take()
            && let Err(error) = response.close().await
        {
            result = Err(error);
        }
        drop(progress.leases);
        if progress.reserved {
            let outcome = match &result {
                Ok(_) => ProviderOutcome::Completed,
                Err(_) if !progress.submitted => ProviderOutcome::NotSent,
                Err(_)
                    if runtime.cancelled.is_cancelled()
                        || runtime.context().cancellation.is_cancelled() =>
                {
                    ProviderOutcome::Cancelled
                }
                Err(PortError::Cancelled(_)) => ProviderOutcome::Cancelled,
                Err(_) => ProviderOutcome::Unknown,
            };
            let diagnostic = match &result {
                Err(PortError::Domain(DomainError::Provider { error })) => Some(*error),
                Ok(_) if progress.mismatch => Some(ProviderErrorCode::BudgetMismatch),
                _ => None,
            };
            self.finalize(
                &progress.call,
                Some(&self.dispatcher),
                progress.usage,
                outcome,
                diagnostic,
            )
            .await?;
        }
        result
    }
    async fn perform(
        &self,
        runtime: &Runtime,
        job: &Job,
        sender: Option<&mpsc::Sender<CompletionEvent>>,
        progress: &mut Progress,
    ) -> Result<Output, PortError> {
        let hash = job.fingerprint()?;
        let scope_key = job.scope_key()?;
        let mut tx = runtime
            .run(
                self.control.store.read(runtime.budget.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        runtime
            .run(
                async {
                    let auth = self
                        .control
                        .revalidate_read(tx.inner_mut(), job.ctx.auth())
                        .await?;
                    accounting::existing_read(
                        tx.inner_mut(),
                        auth.principal().as_str(),
                        &scope_key,
                        job.intent(),
                        &hash,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        runtime
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let snapshot = runtime
            .run(
                self.snapshot(&runtime.budget, job.resource(), job.model()),
                CommitEffect::NotCommitted,
            )
            .await?;
        let primary = if let Some(scope) = &job.scope {
            let ctx = SpaceContext::new(job.ctx.auth().clone(), scope.clone(), runtime.context())?;
            Some(
                runtime
                    .run(
                        self.selection_catalog(&ctx, job.project()),
                        CommitEffect::NotCommitted,
                    )
                    .await?,
            )
        } else {
            None
        };
        let parts = job.parts();
        let current = if primary.is_some() {
            let lease = runtime
                .run(
                    self.egress.acquire_egress(
                        AccountContext::new(job.ctx.auth().clone(), runtime.context()),
                        job.egress(&parts)?,
                        runtime.cancelled.clone(),
                    ),
                    CommitEffect::NotCommitted,
                )
                .await?;
            lease.check()?;
            if lease.project() != job.project() || lease.current().len() > 4096 {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            let current = lease.current().to_vec();
            progress.leases.canonical = Some(lease);
            current
        } else {
            Vec::new()
        };
        let keeper = self
            .control
            .precheck_keeper_catalog(job.ctx.auth(), &runtime.budget, &job.ctx.budget.request)
            .await?;
        let authority = || DispatchAuthority {
            snapshot: &snapshot,
            ctx: &job.ctx,
            primary: primary.as_ref(),
            project: job.project(),
            parts: &parts,
            current: &current,
            keeper: keeper.as_ref(),
        };
        let body = job.encode(&snapshot)?;
        let mut tx = runtime
            .run(
                self.control.store.write(runtime.budget.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        runtime
            .run(
                async {
                    progress.leases.check()?;
                    let validated = self.validate_dispatch(tx.inner_mut(), authority()).await?;
                    let row = ProviderCallLogRow {
                        call_id: progress.call.to_string(),
                        owner_id: snapshot.resource.owner_id.clone(),
                        principal: validated.auth.principal().to_string(),
                        run_id: None,
                        scope_id: scope_key,
                        intent_key: job.intent().to_string(),
                        request_hash: hash.to_vec(),
                        resource_id: snapshot.resource.id.clone(),
                        credential_id: snapshot.resource.credential_id.clone(),
                        policy_epochs: snapshot.epochs()?,
                        participating_spaces: json(&validated.spaces)?,
                        model_id: job.model().map(ToString::to_string),
                        reserved_tokens: job.reservation(&snapshot)?,
                        bucket_keys: "[]".into(),
                        delivery_state: "intent".into(),
                        outcome: None,
                        usage_source: "unknown".into(),
                        input_tokens: None,
                        output_tokens: None,
                        diagnostic: None,
                        dispatch_owner: None,
                        created_at: 0,
                        settled_at: None,
                    };
                    accounting::reserve(
                        tx.inner_mut(),
                        row,
                        snapshot.budgets(&self.config, &validated.spaces)?,
                        self.control.clock.now_ms()?,
                    )
                    .await?;
                    progress.reserved = true;
                    Ok(())
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        runtime.run(tx.commit(), CommitEffect::Unknown).await?;
        let mut material = runtime
            .run(
                self.headers(&runtime.budget, &progress.call, &snapshot),
                CommitEffect::NotCommitted,
            )
            .await?;
        let mut tx = runtime
            .run(
                self.control.store.write(runtime.budget.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        let expires = runtime
            .run(
                async {
                    progress.leases.check()?;
                    let mut validated = self.validate_dispatch(tx.inner_mut(), authority()).await?;
                    for witness in &material.witnesses {
                        witness.verify(tx.inner_mut()).await?;
                    }
                    accounting::sending(tx.inner_mut(), &progress.call, &self.dispatcher).await?;
                    validated
                        .selectors
                        .push(RevocationSelector::ProviderCall(progress.call.clone()));
                    progress.leases.registration = Some(
                        self.control
                            .revoker
                            .register_provider(
                                MaintenanceContext {
                                    authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                                    budget: runtime.context(),
                                },
                                validated.selectors,
                                runtime.cancelled.clone(),
                            )
                            .await?,
                    );
                    progress.leases.check()?;
                    Ok(validated.expires_at_ms)
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        runtime.run(tx.commit(), CommitEffect::Unknown).await?;
        progress.leases.check()?;
        let kind = wire(&snapshot.resource.wire)?;
        material
            .headers
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        material.headers.insert(
            ACCEPT,
            HeaderValue::from_static(
                if matches!(job.request, Request::Completion(_))
                    && kind == ProviderWireKind::OpenaiCompatible
                {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            ),
        );
        let network_budget = runtime.network_budget(
            progress.call.clone(),
            timeout(&snapshot.resource)?,
            expires,
            self.control.clock.now_ms()?,
        )?;
        progress.response = Some(self.outbound.start(
            network_budget,
            OutboundRequest {
                scope: scope(
                    job.resource().clone(),
                    kind,
                    snapshot.resource.runtime_epoch as u64,
                    snapshot.credential.as_ref().map(|c| c.runtime_epoch as u64),
                ),
                url: wire::endpoint(&snapshot.resource.base_url, kind, job.operation())?,
                method: if matches!(job.request, Request::Check(_)) {
                    Method::GET
                } else {
                    Method::POST
                },
                headers: material.headers,
                body,
                response_limit: if matches!(job.request, Request::Check(_)) {
                    1024 * 1024
                } else {
                    32 * 1024 * 1024
                },
            },
        )?);
        progress.submitted = true;
        let response = progress.response.as_mut().expect("started transport");
        if let Err(error) = progress.leases.run(runtime, response.receive_head()).await {
            if matches!(&error,PortError::Unavailable(failure) if failure.effect()==CommitEffect::NotCommitted)
            {
                progress.submitted = false;
            }
            return Err(error);
        }
        match response.status() {
            200 => {}
            401 | 403 => return Err(provider_error(ProviderErrorCode::UpstreamAuthentication)),
            429 => return Err(provider_error(ProviderErrorCode::UpstreamRateLimit)),
            _ => return Err(provider_error(ProviderErrorCode::Unavailable)),
        }
        responses::receive(runtime, job, &snapshot, progress, sender).await
    }
}

impl EmbeddingProviderPort for ProviderService {
    fn embed(
        &self,
        ctx: SpaceContext,
        request: EmbeddingRequest,
    ) -> PortFuture<'_, EmbeddingResult> {
        Box::pin(self.embed(ctx, request))
    }
}
