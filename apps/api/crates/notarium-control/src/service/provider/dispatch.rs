//! Owned dispatch: SQL authority -> live registration -> wire -> shutdown -> audit.
use super::{
    ProviderService, accounting,
    admission::DispatchAuthority,
    execution::{CancelOnDrop, Job, Request, Runtime},
    records::*,
    selection, wire,
};
use crate::{
    error::{invalid, unavailable},
    outbound::{OutboundRequest, OutboundResponse},
    store::{lease::OperationBudget, target::ProviderCallLogRow},
};
use http::{
    Method,
    header::{ACCEPT, CONTENT_TYPE, HeaderValue},
};
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, PrincipalKind},
    classes::{DocClass, ProviderOrigin},
    error::{BudgetKind, CommitEffect, PortError, ValidationReason},
    ids::*,
    model::{FolderRef, Lifecycle},
    ports::{control::*, *},
};
use std::{
    collections::BTreeSet,
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
fn is_unknown_effect(error: &PortError) -> bool {
    match error {
        PortError::Cancelled(failure)
        | PortError::DeadlineExceeded(failure)
        | PortError::Unavailable(failure)
        | PortError::Internal(failure) => failure.effect() == CommitEffect::Unknown,
        PortError::Domain(_) => false,
    }
}

fn unknown_failure(label: &str) -> notarium_core::error::OperationalFailure {
    notarium_core::error::OperationalFailure::new(
        ContentDigest::from_bytes(*blake3::hash(label.as_bytes()).as_bytes()),
        CommitEffect::Unknown,
        notarium_core::error::RetryAdvice::Never,
        false,
    )
    .expect("non-retryable failure")
}

fn unknown_lease_error(error: PortError) -> PortError {
    match error {
        PortError::Cancelled(_) => {
            PortError::Cancelled(unknown_failure("provider lease cancelled"))
        }
        PortError::DeadlineExceeded(_) => {
            PortError::DeadlineExceeded(unknown_failure("provider lease expired"))
        }
        PortError::Unavailable(_) => unavailable("provider lease revoked", CommitEffect::Unknown),
        _ => PortError::Cancelled(unknown_failure("provider lease revoked")),
    }
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
        if let Err(error) = self.check() {
            return Err(unknown_lease_error(error));
        }
        let result = runtime.run(operation, CommitEffect::Unknown).await;
        if let Err(error) = self.check() {
            return Err(match result {
                Err(existing) if is_unknown_effect(&existing) => existing,
                _ => unknown_lease_error(error),
            });
        }
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
            if let Some(error) = self
                .error
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
            {
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
                *terminal
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
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
        if request
            .inputs
            .iter()
            .any(|input| matches!(input, EmbeddingInput::Query(_)))
        {
            ctx.auth()
                .authorize_remote_embedding_query(&ctx.scope().space_id)?;
        }
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
        // Cancellation/drop only signals the transport. Keep any un-released
        // source snapshot and live credential/consent registration active until
        // actual network shutdown completes.
        if let Some(response) = progress.response.take()
            && let Err(error) = response.close().await
        {
            result = Err(error);
        }
        if let Some(lease) = &mut progress.leases.canonical {
            let _ = lease.close().await;
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
            if let Err(finalize_err) = self
                .finalize(
                    &progress.call,
                    Some(&self.dispatcher),
                    progress.usage,
                    outcome,
                    diagnostic,
                )
                .await
                && result.is_ok()
            {
                result = Err(if progress.submitted {
                    match finalize_err {
                        PortError::Unavailable(failure) | PortError::Internal(failure)
                            if failure.effect() == CommitEffect::NotCommitted =>
                        {
                            unavailable("provider settlement", CommitEffect::Unknown)
                        }
                        PortError::DeadlineExceeded(failure)
                            if failure.effect() == CommitEffect::NotCommitted =>
                        {
                            PortError::DeadlineExceeded(unknown_failure("provider settlement"))
                        }
                        PortError::Cancelled(failure)
                            if failure.effect() == CommitEffect::NotCommitted =>
                        {
                            PortError::Cancelled(unknown_failure("provider settlement"))
                        }
                        other => other,
                    }
                } else {
                    finalize_err
                });
            }
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
        let allow_search_indexing = match (job.ctx.auth().kind(), job.ctx.auth().credential()) {
            (
                PrincipalKind::SearchIndexing,
                Some(AuthenticatedCredential::SearchIndexing { space, provider }),
            ) => {
                let binding_ok = provider == job.resource()
                    && job
                        .scope
                        .as_ref()
                        .is_some_and(|scope| &scope.space_id == space)
                    && matches!(job.request, Request::Embedding(_))
                    && !job.embedding_inputs().is_empty()
                    && job
                        .embedding_inputs()
                        .iter()
                        .all(|input| matches!(input, EmbeddingInput::Part(_)));
                if !binding_ok {
                    return Err(DomainError::AccessDenied.into());
                }
                true
            }
            (PrincipalKind::SearchIndexing, _)
            | (_, Some(AuthenticatedCredential::SearchIndexing { .. })) => {
                return Err(DomainError::AccessDenied.into());
            }
            _ => false,
        };
        let hash = job.fingerprint()?;
        let scope_key = job.scope_key()?;
        let (mut tx, auth) = runtime
            .run(
                async {
                    if allow_search_indexing {
                        self.control
                            .open_revalidated_read_for_search_indexing(
                                &runtime.budget,
                                &job.ctx.budget.request,
                                job.ctx.auth(),
                            )
                            .await
                    } else {
                        self.control
                            .open_revalidated_read(
                                &runtime.budget,
                                &job.ctx.budget.request,
                                job.ctx.auth(),
                            )
                            .await
                    }
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        runtime
            .run(
                async {
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
        if let Request::Embedding(request) = &job.request
            && let Some(expected) = request.runtime_epochs()
            && runtime_epochs(&snapshot.resource, snapshot.credential.as_ref())? != expected
        {
            return Err(selection::unavailable());
        }
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
        // Run Keeper catalog prechecks before acquiring the pinned canonical
        // egress lease so a single-connection canonical pool cannot deadlock
        // trying to borrow a second connection while holding the lease.
        let keeper = runtime
            .run(
                self.control.precheck_keeper_catalog(
                    job.ctx.auth(),
                    &runtime.budget,
                    &job.ctx.budget.request,
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        let parts = job.parts();
        let mut secondary_projects = Vec::new();
        let current = if primary.is_some() {
            if parts.len() > MAX_PROVIDER_ORIGINS {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
            let chat_origins = parts
                .iter()
                .filter_map(|part| {
                    let origin = part.origin();
                    matches!(origin, ProviderOrigin::Chat { .. }).then_some(origin)
                })
                .collect::<Vec<_>>();
            let dependencies = if chat_origins.is_empty() {
                ProviderEgressDependencies::default()
            } else {
                runtime
                    .run(
                        self.egress.chat_dependencies(
                            AccountContext::new(job.ctx.auth().clone(), runtime.context()),
                            chat_origins,
                        ),
                        CommitEffect::NotCommitted,
                    )
                    .await?
            };
            let egress = job.egress(&parts, dependencies)?;
            secondary_projects.clone_from(&egress.secondary_projects);
            let project_folders = egress.project_folders.clone();
            let lease = runtime
                .run(
                    self.egress.acquire_egress(
                        AccountContext::new(job.ctx.auth().clone(), runtime.context()),
                        egress,
                        runtime.cancelled.clone(),
                    ),
                    CommitEffect::NotCommitted,
                )
                .await?;
            progress.leases.canonical = Some(lease);
            let lease = progress
                .leases
                .canonical
                .as_ref()
                .expect("stored canonical lease");
            lease.check()?;
            if lease.project() != job.project()
                || lease.project_folders() != &project_folders
                || lease.secondary_projects() != secondary_projects
                || lease.current().len() > MAX_PROVIDER_ORIGINS
            {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            lease.current().to_vec()
        } else {
            Vec::new()
        };
        let authority = || DispatchAuthority {
            snapshot: &snapshot,
            ctx: &job.ctx,
            primary: primary.as_ref(),
            project: job.project(),
            secondary_projects: &secondary_projects,
            parts: &parts,
            embedding_inputs: job.embedding_inputs(),
            selection: match &job.request {
                Request::Embedding(request) => Some(&request.selection),
                _ => None,
            },
            current: &current,
            keeper: keeper.as_ref(),
            allow_search_indexing,
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
                        run_id: match validated.auth.kind() {
                            PrincipalKind::AgentRun(run) | PrincipalKind::Keeper(run) => {
                                Some(run.to_string())
                            }
                            _ => None,
                        },
                        scope_id: scope_key,
                        intent_key: job.intent().to_string(),
                        request_hash: hash.to_vec(),
                        resource_id: snapshot.resource.id.clone(),
                        credential_id: snapshot.resource.credential_id.clone(),
                        policy_epochs: snapshot.epochs(
                            &validated.disclosed_classes,
                            validated.disclosed_project_only.as_ref(),
                        )?,
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
        let query_taint = job
            .embedding_inputs()
            .iter()
            .any(|input| matches!(input, EmbeddingInput::Query(_)))
            .then(|| job.ctx.auth().taint().clone());
        let check_query_taint = move || {
            if query_taint.as_ref().is_some_and(|taint| taint.is_tainted()) {
                return Err(DomainError::CrossSpaceTainted.into());
            }
            Ok(())
        };
        check_query_taint()?;
        progress.response = Some(self.outbound.start_checked(
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
            check_query_taint,
        )?);
        progress.submitted = true;
        // Keep the pinned canonical snapshot across DNS/TCP/TLS, preflight(),
        // and request-body upload so concurrent purge/redaction cannot race
        // before bytes hit the socket, then release cleanly before waiting on
        // upstream TTFB so same-Space chat writes stay unblocked.
        let response = progress.response.as_mut().expect("started transport");
        let uploaded = progress
            .leases
            .run(runtime, response.wait_uploaded())
            .await?;
        if uploaded && let Some(lease) = &mut progress.leases.canonical {
            let _ = lease.mark_dispatched().await;
        }
        if let Err(error) = progress.leases.run(runtime, response.receive_head()).await {
            if matches!(&error,PortError::Unavailable(failure) if failure.effect()==CommitEffect::NotCommitted)
                || matches!(&error, PortError::Domain(DomainError::CrossSpaceTainted))
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
    fn query_disclosure(
        &self,
        mut ctx: SpaceContext,
        provider: ProviderResourceId,
        model: ModelProfileId,
        project: Option<FolderRef>,
        folder: Option<FolderId>,
    ) -> PortFuture<'_, BTreeSet<DocClass>> {
        Box::pin(async move {
            ctx.auth()
                .authorize_remote_embedding_query(&ctx.scope().space_id)?;
            if let (Some(project), Some(folder_id)) = (&project, folder) {
                let budget = OperationBudget::new(ctx.budget.clone());
                let reference = FolderRef {
                    space_id: ctx.scope().space_id.clone(),
                    folder_id,
                };
                let folder = self
                    .control
                    .catalog
                    .folder(
                        AccountContext::new(ctx.auth().clone(), ctx.budget.clone()),
                        reference.clone(),
                    )
                    .await?;
                ctx.budget = budget.context(ctx.budget.request.clone());
                if folder.reference != reference
                    || folder.lifecycle != Lifecycle::Active
                    || !folder.ancestor_folders.contains(&project.folder_id)
                {
                    return Err(DomainError::AccessDenied.into());
                }
            }
            let caller_classes = ctx
                .auth()
                .spaces()
                .get(&ctx.scope().space_id)
                .map(|grant| grant.read_classes.clone())
                .unwrap_or_default();
            let selected = self
                .select_provider(
                    ctx.clone(),
                    SelectProvider {
                        kind: PreferenceModelKind::Embedding,
                        resource: Some(provider),
                        model: Some(model),
                        project: project.clone(),
                    },
                )
                .await?;
            if matches!(
                ctx.auth().kind(),
                PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
            ) {
                let budget = OperationBudget::new(ctx.budget.clone());
                let space = self.selection_catalog(&ctx, project.as_ref()).await?;
                let (mut tx, auth) = self
                    .control
                    .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
                    .await?;
                let required = budget
                    .run(
                        async {
                            let grant = auth
                                .spaces()
                                .get(&space.space.id)
                                .ok_or_else(selection::unavailable)?;
                            super::admission::required_query_source_disclosure(
                                tx.inner_mut(),
                                &auth,
                                grant,
                            )
                            .await
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await;
                budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
                let required = required?;
                if !required.allows_embedder(
                    &selected.policy.allowed_classes,
                    selected.project_only.as_ref(),
                ) {
                    return Ok(BTreeSet::new());
                }
            }
            Ok(selected
                .policy
                .allowed_classes
                .intersection(&caller_classes)
                .copied()
                .collect())
        })
    }

    fn embed(
        &self,
        ctx: SpaceContext,
        request: EmbeddingRequest,
    ) -> PortFuture<'_, EmbeddingResult> {
        Box::pin(self.embed(ctx, request))
    }
}
