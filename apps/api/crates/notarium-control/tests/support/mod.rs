use notarium_control::{
    service::{AuthenticationMode, ControlClock, ControlConfig, ControlService},
    store::{ControlStore, PostgresConfig},
};
use notarium_core::{
    DomainError,
    auth::*,
    epoch::*,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice},
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
use sqlx::Connection;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub static AUTH_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([1; 16]),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(30),
    }
}
pub fn evidence(kind: AuthEvidenceKind, token: &str) -> PreAuthContext {
    let mut evidence = AuthEvidence::new(kind, token.into());
    if kind == AuthEvidenceKind::Session {
        evidence = evidence.with_human_management();
    }
    PreAuthContext {
        budget: budget(),
        evidence,
    }
}
#[allow(dead_code)]
pub fn unconfirmed_evidence(kind: AuthEvidenceKind, token: &str) -> PreAuthContext {
    PreAuthContext {
        budget: budget(),
        evidence: AuthEvidence::new(kind, token.into()),
    }
}
pub fn empty() -> EmptyRootAuthorization {
    EmptyRootAuthorization::from_classification(
        InstallationId::from_bytes([1; 16]),
        EpochClassification {
            state: StorageEpochState::EmptyRoot,
            reason: EpochReason::ConfirmedEmpty,
        },
    )
    .unwrap()
}
pub fn command(
    actor: &PrincipalId,
    owner: &PrincipalId,
    key: u8,
    expected: ControlRevision,
) -> AccountCommandIdentity {
    AccountCommandIdentity {
        actor: actor.clone(),
        owner: owner.clone(),
        key: CommandKey::from_bytes([key; 16]),
        hash: ContentDigest::from_bytes([key; 32]),
        expected,
    }
}
pub struct Clock(pub AtomicI64);
impl Default for Clock {
    fn default() -> Self {
        Self(AtomicI64::new(1_700_000_000_000))
    }
}
impl ControlClock for Clock {
    fn now_ms(&self) -> Result<i64, PortError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}
pub struct CallbackGate {
    pub enabled: AtomicBool,
    pub entered: tokio::sync::Semaphore,
    pub release: tokio::sync::Semaphore,
}
impl Default for CallbackGate {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            entered: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}
#[derive(Default)]
pub struct Catalog {
    pub fail_after_create: AtomicBool,
    pub fail_after_lifecycle: AtomicBool,
    pub create_gate: CallbackGate,
    pub abilities_gate: CallbackGate,
    pub ability_tip_gate: CallbackGate,
    pub abilities_calls: AtomicUsize,
    pub space_read_fault: AtomicU8,
    pub space_reads: AtomicUsize,
    lifecycle_receipts:
        Mutex<BTreeMap<CommandKey, (ContentDigest, HistoryScope, SpaceLifecycle, CatalogSpace)>>,
    pub entries: Mutex<BTreeMap<SpaceId, (PrincipalId, String, CatalogSpace)>>,
    pub project_entries: Mutex<BTreeMap<(SpaceId, FolderId), ProjectInfo>>,
    pub ability_entries: Mutex<Vec<AbilityDescriptor>>,
    pub note_entries: Mutex<BTreeMap<(SpaceId, NoteId), CatalogNote>>,
    pub folder_entries: Mutex<BTreeMap<(SpaceId, FolderId), CatalogFolder>>,
    pub memory_calls: AtomicUsize,
}
struct TestSchedulePin {
    history: HistoryScope,
    descriptors: Vec<AbilityDescriptor>,
}
impl ScheduleAbilityLease for TestSchedulePin {
    fn history(&self) -> &HistoryScope {
        &self.history
    }
    fn abilities(&self) -> &[AbilityDescriptor] {
        &self.descriptors
    }
}

impl ControlCatalogPort for Catalog {
    fn disclosure(
        &self,
        _: AccountContext,
        _: CatalogDisclosure,
    ) -> PortFuture<'_, notarium_core::classes::CanonicalMetadataContent> {
        Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
    }
    fn space(&self, _: CallBudget, id: SpaceId) -> PortFuture<'_, CatalogSpace> {
        Box::pin(async move {
            self.space_reads.fetch_add(1, Ordering::SeqCst);
            let mut result = self
                .entries
                .lock()
                .unwrap()
                .get(&id)
                .map(|v| v.2.clone())
                .ok_or(DomainError::ResourceNotFound)?;
            match self.space_read_fault.load(Ordering::SeqCst) {
                1 => {
                    return Err(PortError::Unavailable(
                        OperationalFailure::new(
                            ContentDigest::from_bytes([1; 32]),
                            CommitEffect::NotCommitted,
                            RetryAdvice::Never,
                            false,
                        )
                        .unwrap(),
                    ));
                }
                2 => return Err(DomainError::ResourceNotFound.into()),
                3 => result.history.space_id = SpaceId::from_bytes([255; 16]),
                _ => {}
            }
            Ok(result)
        })
    }
    fn ensure_space(
        &self,
        _: CallBudget,
        request: EnsureCatalogSpace,
    ) -> PortFuture<'_, CatalogSpace> {
        Box::pin(async move {
            let space = CatalogSpace {
                slug: request.space.id.to_string(),
                space: Space {
                    id: request.space.id.clone(),
                    kind: request.space.kind,
                    lifecycle: SpaceLifecycle::Active,
                },
                history: HistoryScope {
                    space_id: request.space.id.clone(),
                    incarnation: HistoryIncarnation::from_bytes([1; 16]),
                },
                last_seq: SpaceSeq::ZERO,
            };
            let result = {
                let mut entries = self.entries.lock().unwrap();
                let existing = entries.entry(request.space.id).or_insert_with(|| {
                    (
                        request.owner.clone(),
                        request.space.name.clone(),
                        space.clone(),
                    )
                });
                assert_eq!(existing.0, request.owner);
                assert_eq!(existing.1, request.space.name);
                assert_eq!(existing.2.space.kind, request.space.kind);
                existing.2.clone()
            };
            if self.create_gate.enabled.swap(false, Ordering::SeqCst) {
                self.create_gate.entered.add_permits(1);
                self.create_gate.release.acquire().await.unwrap().forget();
            }
            if self.fail_after_create.load(Ordering::SeqCst) {
                return Err(DomainError::ResourceNotFound.into());
            }
            Ok(result)
        })
    }
    fn projects(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProjectInfo>> {
        Box::pin(async move {
            let after = page.continuation().map(FolderId::parse).transpose()?;
            let entries = self.project_entries.lock().unwrap();
            let mut values: Vec<_> = entries
                .values()
                .filter(|value| {
                    value.folder.space_id == ctx.scope().space_id
                        && after
                            .as_ref()
                            .is_none_or(|after| value.folder.folder_id > *after)
                })
                .take(usize::from(page.limit()) + 1)
                .cloned()
                .collect();
            let continuation = if values.len() > usize::from(page.limit()) {
                values.pop();
                Some(values.last().unwrap().folder.folder_id.to_string())
            } else {
                None
            };
            Ok(ControlPage {
                items: values,
                continuation,
            })
        })
    }
    fn project(&self, ctx: SpaceContext, project: FolderRef) -> PortFuture<'_, ProjectInfo> {
        Box::pin(async move {
            if project.space_id != ctx.scope().space_id {
                return Err(DomainError::ResourceNotFound.into());
            }
            let space = self
                .entries
                .lock()
                .unwrap()
                .get(&project.space_id)
                .map(|entry| entry.2.clone())
                .ok_or(DomainError::ResourceNotFound)?;
            ctx.check_current(&space.history)?;
            ctx.auth().can_view_resource(&ResourceFacts {
                space: space.space,
                class: notarium_core::classes::DocClass::UserDoc,
                project: Some(project.folder_id.clone()),
                ancestor_folders: vec![project.folder_id.clone()],
                folder_write_locked: false,
                ability_package: None,
            })?;
            self.project_entries
                .lock()
                .unwrap()
                .get(&(project.space_id.clone(), project.folder_id.clone()))
                .cloned()
                .ok_or(DomainError::ResourceNotFound.into())
        })
    }
    fn project_by_slug(&self, ctx: SpaceContext, slug: String) -> PortFuture<'_, ProjectInfo> {
        Box::pin(async move {
            let project = self
                .project_entries
                .lock()
                .unwrap()
                .values()
                .find(|entry| {
                    entry.folder.space_id == ctx.scope().space_id
                        && entry.project_slug.eq_ignore_ascii_case(&slug)
                })
                .map(|entry| entry.folder.clone())
                .ok_or(DomainError::ResourceNotFound)?;
            self.project(ctx, project).await
        })
    }
    fn abilities(
        &self,
        _: AccountContext,
        query: AbilityQuery,
    ) -> PortFuture<'_, ControlPage<AbilityDescriptor>> {
        Box::pin(async move {
            self.abilities_calls.fetch_add(1, Ordering::SeqCst);
            if self.abilities_gate.enabled.load(Ordering::SeqCst) {
                self.abilities_gate.entered.add_permits(1);
                let _ = self.abilities_gate.release.acquire().await.unwrap();
            }
            let offset = query
                .page
                .continuation()
                .map(|v| v.parse::<usize>().unwrap())
                .unwrap_or(0);
            let entries = self.ability_entries.lock().unwrap();
            let mut latest_indices = std::collections::BTreeMap::new();
            for (idx, value) in entries.iter().enumerate() {
                let key = serde_json::to_string(&value.reference.identity()).unwrap();
                latest_indices.insert(key, idx);
            }
            let tip_set: std::collections::BTreeSet<usize> = latest_indices.into_values().collect();
            let values: Vec<_> = entries
                .iter()
                .enumerate()
                .filter(|(idx, value)| {
                    tip_set.contains(idx)
                        && query.kind.is_none_or(|kind| value.kind == kind)
                        && query.name.as_ref().is_none_or(|name| value.name == *name)
                })
                .map(|(_, value)| value.clone())
                .collect();
            let end = offset
                .saturating_add(usize::from(query.page.limit()))
                .min(values.len());
            Ok(ControlPage {
                items: values.get(offset..end).unwrap_or_default().to_vec(),
                continuation: (end < values.len()).then(|| end.to_string()),
            })
        })
    }
    fn ability(
        &self,
        _: AccountContext,
        reference: AbilityRef,
    ) -> PortFuture<'_, AbilityDescriptor> {
        Box::pin(async move {
            self.ability_entries
                .lock()
                .unwrap()
                .iter()
                .find(|value| value.reference == reference)
                .cloned()
                .ok_or(DomainError::ResourceNotFound.into())
        })
    }
    fn current_ability(
        &self,
        _: AccountContext,
        identity: AbilityIdentity,
    ) -> PortFuture<'_, AbilityDescriptor> {
        Box::pin(async move {
            if self.ability_tip_gate.enabled.swap(false, Ordering::SeqCst) {
                self.ability_tip_gate.entered.add_permits(1);
                self.ability_tip_gate
                    .release
                    .acquire()
                    .await
                    .unwrap()
                    .forget();
            }
            self.ability_entries
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|value| value.reference.identity() == identity)
                .cloned()
                .ok_or(DomainError::ResourceNotFound.into())
        })
    }
    fn pin_schedule_abilities(
        &self,
        ctx: AccountContext,
        refs: Vec<AbilityRef>,
    ) -> PortFuture<'_, Box<dyn ScheduleAbilityLease>> {
        Box::pin(async move {
            let (space, grant) = ctx
                .auth()
                .spaces()
                .iter()
                .next()
                .ok_or(DomainError::ResourceNotFound)?;
            let facts = self.space(ctx.budget.clone(), space.clone()).await?;
            if let Some(folder_id) = &grant.project_root {
                self.project(
                    SpaceContext::new(
                        ctx.auth().clone(),
                        facts.history.clone(),
                        ctx.budget.clone(),
                    )?,
                    FolderRef {
                        space_id: space.clone(),
                        folder_id: folder_id.clone(),
                    },
                )
                .await?;
            }
            let entries = self.ability_entries.lock().unwrap();
            let mut descriptors = Vec::with_capacity(refs.len());
            for reference in refs {
                let descriptor = entries
                    .iter()
                    .rev()
                    .find(|entry| entry.reference.identity() == reference.identity())
                    .filter(|entry| entry.reference == reference)
                    .ok_or(DomainError::ResourceNotFound)?;
                descriptors.push(descriptor.clone());
            }
            Ok(Box::new(TestSchedulePin {
                history: facts.history,
                descriptors,
            }) as Box<dyn ScheduleAbilityLease>)
        })
    }
    fn note(&self, ctx: AccountContext, note: NoteRef) -> PortFuture<'_, CatalogNote> {
        Box::pin(async move {
            let value = self
                .note_entries
                .lock()
                .unwrap()
                .get(&(note.space_id, note.note_id))
                .cloned()
                .ok_or(DomainError::ResourceNotFound)?;
            ctx.auth().can_view_resource(&value.facts)?;
            Ok(value)
        })
    }
    fn locate_note(&self, ctx: AccountContext, note: NoteId) -> PortFuture<'_, CatalogNote> {
        Box::pin(async move {
            let entries = self.note_entries.lock().unwrap();
            for space_id in ctx.auth().spaces().keys() {
                if let Some(value) = entries.get(&(space_id.clone(), note.clone()))
                    && ctx.auth().can_view_resource(&value.facts).is_ok()
                {
                    return Ok(value.clone());
                }
            }
            Err(DomainError::ResourceNotFound.into())
        })
    }
    fn folder(&self, ctx: AccountContext, folder: FolderRef) -> PortFuture<'_, CatalogFolder> {
        Box::pin(async move {
            let value = self
                .folder_entries
                .lock()
                .unwrap()
                .get(&(folder.space_id, folder.folder_id))
                .cloned()
                .ok_or(DomainError::ResourceNotFound)?;
            ctx.auth().can_view_folder(
                &value.space,
                &value.reference.folder_id,
                &value.ancestor_folders,
            )?;
            Ok(value)
        })
    }
    fn change_lifecycle(
        &self,
        _: CallBudget,
        identity: AccountCommandIdentity,
        scope: HistoryScope,
        lifecycle: SpaceLifecycle,
    ) -> PortFuture<'_, CatalogSpace> {
        Box::pin(async move {
            let mut receipts = self.lifecycle_receipts.lock().unwrap();
            let result = if let Some((hash, old_scope, old_lifecycle, result)) =
                receipts.get(&identity.key)
            {
                assert_eq!(*hash, identity.hash);
                assert_eq!(*old_scope, scope);
                assert_eq!(*old_lifecycle, lifecycle);
                result.clone()
            } else {
                let mut entries = self.entries.lock().unwrap();
                let current = entries
                    .get_mut(&scope.space_id)
                    .ok_or(DomainError::ResourceNotFound)?;
                current.2.history.check(&scope)?;
                current.2.space.lifecycle = lifecycle;
                let result = current.2.clone();
                receipts.insert(
                    identity.key,
                    (identity.hash, scope, lifecycle, result.clone()),
                );
                result
            };
            if self.fail_after_lifecycle.load(Ordering::SeqCst) {
                return Err(DomainError::ResourceNotFound.into());
            }
            Ok(result)
        })
    }
    fn inspect_memory_target(
        &self,
        _: AccountContext,
        _: MemoryTarget,
        _: String,
    ) -> PortFuture<'_, MemoryTargetSnapshot> {
        Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
    }
    fn resolve_or_ensure_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, ResolvedMemoryTarget> {
        Box::pin(async move {
            self.memory_calls.fetch_add(1, Ordering::SeqCst);
            let (space, ancestors) = match &target {
                MemoryTarget::User { owner } => {
                    let entries = self.entries.lock().unwrap();
                    let space = entries
                        .values()
                        .find(|(id, _, value)| {
                            id == owner && value.space.kind == SpaceKind::Personal
                        })
                        .ok_or(DomainError::ResourceNotFound)?
                        .2
                        .space
                        .clone();
                    (space, vec![])
                }
                MemoryTarget::Project { folder } => {
                    let space = self
                        .entries
                        .lock()
                        .unwrap()
                        .get(&folder.space_id)
                        .ok_or(DomainError::ResourceNotFound)?
                        .2
                        .space
                        .clone();
                    (space, vec![folder.folder_id.clone()])
                }
            };
            let facts = ResourceFacts {
                space: space.clone(),
                class: notarium_core::classes::DocClass::AgentMemory,
                project: None,
                ancestor_folders: ancestors,
                folder_write_locked: false,
                ability_package: None,
            };
            ctx.auth().authorize_direct_write(&facts, &facts)?;
            let digest = blake3::hash(format!("{target:?}:{category}").as_bytes());
            let reference = NoteRef {
                space_id: space.id,
                note_id: NoteId::from_bytes(digest.as_bytes()[..16].try_into().unwrap()),
            };
            self.note_entries.lock().unwrap().insert(
                (reference.space_id.clone(), reference.note_id.clone()),
                CatalogNote {
                    reference: reference.clone(),
                    lifecycle: Lifecycle::Active,
                    facts,
                },
            );
            Ok(ResolvedMemoryTarget {
                target,
                note: reference,
                category,
            })
        })
    }
}
pub struct Revoker {
    provider_registry: Arc<Mutex<ProviderRegistry>>,
    pub fail: AtomicBool,
    pub gate: AtomicBool,
    pub entered: tokio::sync::Semaphore,
    pub release: tokio::sync::Semaphore,
    pub calls: Mutex<Vec<RequestId>>,
}
impl Default for Revoker {
    fn default() -> Self {
        Self {
            provider_registry: Arc::new(Mutex::new(ProviderRegistry::default())),
            fail: AtomicBool::new(false),
            gate: AtomicBool::new(false),
            entered: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            calls: Mutex::new(vec![]),
        }
    }
}
impl SessionRevocationPort for Revoker {
    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Revocation)?;
            let keys = selector_keys(vec![RevocationSelector::ProviderCall(call)]);
            let mut registry = self.provider_registry.lock().unwrap();
            if registry
                .calls
                .values()
                .any(|(other, _)| overlaps(&keys, other))
                || registry.fences.values().any(|other| overlaps(&keys, other))
            {
                return Ok(None);
            }
            let id = registry.next;
            registry.next += 1;
            registry.fences.insert(id, keys);
            Ok(Some(Box::new(ProviderRegistryLease {
                registry: self.provider_registry.clone(),
                id,
                fence: true,
                cancellation: Cancellation::default(),
            }) as Box<dyn RevocationLease>))
        })
    }
    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Revocation)?;
            let keys = selector_keys(selectors);
            loop {
                {
                    let mut registry = self.provider_registry.lock().unwrap();
                    if !registry.fences.values().any(|other| overlaps(&keys, other)) {
                        let id = registry.next;
                        registry.next += 1;
                        registry.calls.insert(id, (keys, cancellation.clone()));
                        return Ok(Box::new(ProviderRegistryLease {
                            registry: self.provider_registry.clone(),
                            id,
                            fence: false,
                            cancellation,
                        }) as Box<dyn RevocationLease>);
                    }
                }
                if ctx.budget.cancellation.is_cancelled() || cancellation.is_cancelled() {
                    return Err(DomainError::AccessDenied.into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
    }
    fn register_canonical_effect(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Arc<dyn CanonicalEffectRegistration>> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Revocation)?;
            let keys = selector_keys(selectors);
            {
                let registry = self.provider_registry.lock().unwrap();
                if registry.fences.values().any(|other| overlaps(&keys, other)) {
                    return Err(DomainError::AccessDenied.into());
                }
            }
            Ok(Arc::new(TestCanonicalEffectRegistration {
                registry: self.provider_registry.clone(),
                keys,
                cancellation,
                deadline: Mutex::new(None),
            }) as Arc<dyn CanonicalEffectRegistration>)
        })
    }
    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Revocation)?;
            let keys = selector_keys(selectors);
            let lease = {
                let mut registry = self.provider_registry.lock().unwrap();
                let id = registry.next;
                registry.next += 1;
                registry.fences.insert(id, keys.clone());
                for (other, cancellation) in registry.calls.values() {
                    if overlaps(&keys, other) {
                        cancellation.cancel();
                    }
                }
                ProviderRegistryLease {
                    registry: self.provider_registry.clone(),
                    id,
                    fence: true,
                    cancellation: Cancellation::default(),
                }
            };
            loop {
                {
                    let registry = self.provider_registry.lock().unwrap();
                    let older = registry
                        .fences
                        .iter()
                        .any(|(id, other)| *id < lease.id && overlaps(&keys, other));
                    if !older
                        && !registry
                            .calls
                            .values()
                            .any(|(other, _)| overlaps(&keys, other))
                    {
                        return Ok(Box::new(lease) as Box<dyn RevocationLease>);
                    }
                }
                if ctx.budget.cancellation.is_cancelled() {
                    return Err(DomainError::AccessDenied.into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
    }
    fn revoke(
        &self,
        ctx: MaintenanceContext,
        _: RevocationSelector,
        _: RevocationReason,
    ) -> PortFuture<'_, ()> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Revocation)?;
            self.calls.lock().unwrap().push(ctx.budget.request);
            self.entered.add_permits(1);
            if self.fail.load(Ordering::SeqCst) {
                return Err(DomainError::AccessDenied.into());
            }
            if self.gate.load(Ordering::SeqCst) {
                self.release.acquire().await.unwrap().forget();
            }
            Ok(())
        })
    }
}
#[derive(Default)]
struct ProviderRegistry {
    next: u64,
    calls: std::collections::BTreeMap<u64, (Vec<String>, Cancellation)>,
    fences: std::collections::BTreeMap<u64, Vec<String>>,
}
fn selector_keys(selectors: Vec<RevocationSelector>) -> Vec<String> {
    selectors
        .into_iter()
        .map(|selector| serde_json::to_string(&selector).unwrap())
        .collect()
}
fn overlaps(left: &[String], right: &[String]) -> bool {
    left.iter().any(|key| right.contains(key))
}
struct ProviderRegistryLease {
    registry: Arc<Mutex<ProviderRegistry>>,
    id: u64,
    fence: bool,
    cancellation: Cancellation,
}
impl RevocationLease for ProviderRegistryLease {
    fn check(&self) -> Result<(), PortError> {
        if self.cancellation.is_cancelled() {
            Err(DomainError::AccessDenied.into())
        } else {
            Ok(())
        }
    }
}
struct TestCanonicalEffectRegistration {
    registry: Arc<Mutex<ProviderRegistry>>,
    keys: Vec<String>,
    cancellation: Cancellation,
    deadline: Mutex<Option<std::time::Instant>>,
}
impl CanonicalEffectRegistration for TestCanonicalEffectRegistration {
    fn restrict_until(&self, deadline: std::time::Instant) -> Result<(), PortError> {
        let mut slot = self.deadline.lock().unwrap();
        *slot = Some(match *slot {
            Some(existing) => existing.min(deadline),
            None => deadline,
        });
        self.check()
    }
    fn check(&self) -> Result<(), PortError> {
        if self.cancellation.is_cancelled()
            || self
                .deadline
                .lock()
                .unwrap()
                .is_some_and(|d| std::time::Instant::now() >= d)
        {
            return Err(DomainError::AccessDenied.into());
        }
        Ok(())
    }
    fn begin(self: Arc<Self>) -> PortFuture<'static, Box<dyn RevocationLease>> {
        Box::pin(async move {
            self.check()?;
            let mut registry = self.registry.lock().unwrap();
            if registry
                .fences
                .values()
                .any(|other| overlaps(&self.keys, other))
            {
                return Err(DomainError::AccessDenied.into());
            }
            let id = registry.next;
            registry.next += 1;
            registry
                .calls
                .insert(id, (self.keys.clone(), self.cancellation.clone()));
            Ok(Box::new(ProviderRegistryLease {
                registry: self.registry.clone(),
                id,
                fence: false,
                cancellation: self.cancellation.clone(),
            }) as Box<dyn RevocationLease>)
        })
    }
}
impl Drop for ProviderRegistryLease {
    fn drop(&mut self) {
        let mut registry = self.registry.lock().unwrap();
        if self.fence {
            registry.fences.remove(&self.id);
        } else {
            registry.calls.remove(&self.id);
        }
    }
}
pub enum Observer {
    Sqlite(sqlx::SqliteConnection),
    Postgres(sqlx::PgConnection),
}
impl Observer {
    pub async fn set_password_hash(&mut self, account: &PrincipalId, hash: &str) {
        match self {
            Self::Sqlite(c) => {
                sqlx::query("UPDATE users SET password_hash=$1 WHERE user_id=$2")
                    .bind(hash)
                    .bind(account.as_str())
                    .execute(c)
                    .await
                    .unwrap();
            }
            Self::Postgres(c) => {
                sqlx::query("UPDATE users SET password_hash=$1 WHERE user_id=$2")
                    .bind(hash)
                    .bind(account.as_str())
                    .execute(c)
                    .await
                    .unwrap();
            }
        }
    }
    #[allow(
        dead_code,
        reason = "Used by the integrated Canonical revocation fixture"
    )]
    pub async fn seed_session(
        &mut self,
        account: &PrincipalId,
        id: &AuthSessionId,
        token: &notarium_control::auth::token::MintedToken,
        now: i64,
    ) {
        let sql = "INSERT INTO sessions(session_id,token_hash,user_id,created_at,expires_at,last_used_at,auth_version)
            SELECT $1,$2,user_id,$3,$4,$3,auth_version FROM users WHERE user_id=$5";
        let query = sqlx::query(sql)
            .bind(id.as_str())
            .bind(token.digest.as_slice())
            .bind(now)
            .bind(now + 3_600_000)
            .bind(account.as_str());
        match self {
            Self::Sqlite(conn) => {
                query.execute(conn).await.unwrap();
            }
            Self::Postgres(conn) => {
                sqlx::query(sql)
                    .bind(id.as_str())
                    .bind(token.digest.as_slice())
                    .bind(now)
                    .bind(now + 3_600_000)
                    .bind(account.as_str())
                    .execute(conn)
                    .await
                    .unwrap();
            }
        }
    }

    pub async fn seed_oauth_access(
        &mut self,
        account: &PrincipalId,
        token: &notarium_control::auth::token::MintedToken,
    ) {
        macro_rules! execute {
            ($sql:literal; $($bind:expr),*)=>{
                match &mut *self {
                    Self::Sqlite(c)=>{sqlx::query($sql)$(.bind($bind))*.execute(c).await.unwrap();},
                    Self::Postgres(c)=>{sqlx::query($sql)$(.bind($bind))*.execute(c).await.unwrap();},
                }
            }
        }
        execute!("INSERT INTO oauth_clients(client_id,kind,redirect_uris,client_name,created_at) VALUES('test-client','dcr','[]','test client',0)";);
        let grant = OAuthGrantId::from_bytes([1; 16]).to_string();
        let family = OAuthFamilyId::from_bytes([1; 16]).to_string();
        execute!("INSERT INTO oauth_grants(grant_id,user_id,client_id,resource_uri,scope,created_at) VALUES($1,$2,'test-client','https://resource.example/','read',0)";&grant,account.as_str());
        execute!("INSERT INTO oauth_refresh_families(family_id,grant_id,created_at) VALUES($1,$2,0)";&family,&grant);
        execute!("INSERT INTO oauth_access_tokens(token_id,token_hash,grant_id,family_id,resource_uri,scope,issued_at,expires_at) VALUES($1,$2,$3,$4,'https://resource.example/','write',0,1800000000000)";token.id.as_ref().unwrap(),token.digest.as_slice(),&grant,&family);
    }
    pub async fn execute(&mut self, sql: &'static str) {
        match self {
            Self::Sqlite(c) => {
                sqlx::query(sql).execute(c).await.unwrap();
            }
            Self::Postgres(c) => {
                sqlx::query(sql).execute(c).await.unwrap();
            }
        }
    }
    pub async fn count(&mut self, sql: &'static str) -> i64 {
        match self {
            Self::Sqlite(c) => sqlx::query_scalar(sql).fetch_one(c).await.unwrap(),
            Self::Postgres(c) => sqlx::query_scalar(sql).fetch_one(c).await.unwrap(),
        }
    }
    pub async fn text(&mut self, sql: &'static str) -> String {
        match self {
            Self::Sqlite(c) => sqlx::query_scalar(sql).fetch_one(c).await.unwrap(),
            Self::Postgres(c) => sqlx::query_scalar(sql).fetch_one(c).await.unwrap(),
        }
    }
    async fn close(self) {
        match self {
            Self::Sqlite(c) => c.close().await.unwrap(),
            Self::Postgres(c) => c.close().await.unwrap(),
        }
    }
}
pub struct Fixture {
    pub store: ControlStore,
    pub observer: Observer,
    pub catalog: Arc<Catalog>,
    pub revoker: Arc<Revoker>,
    pub clock: Arc<Clock>,
    pub root: Option<PathBuf>,
    admin: Option<sqlx::PgConnection>,
    database: String,
}
impl Fixture {
    pub async fn new(pg: bool, label: &str) -> Self {
        let (store, observer, root, admin, database) = if pg {
            let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../.artifacts/control-db-fixture/active.json");
            let descriptor: serde_json::Value =
                serde_json::from_slice(&std::fs::read(file).expect("run with database fixture"))
                    .unwrap();
            let socket = PathBuf::from(descriptor["socket"].as_str().unwrap());
            let options = sqlx::postgres::PgConnectOptions::new()
                .socket(&socket)
                .username("postgres")
                .database("postgres");
            let mut admin = sqlx::PgConnection::connect_with(&options).await.unwrap();
            let database = format!("auth_{label}");
            assert!(
                database
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_')
            );
            sqlx::QueryBuilder::<sqlx::Postgres>::new("CREATE DATABASE ")
                .push(&database)
                .build()
                .execute(&mut admin)
                .await
                .unwrap();
            let store =
                ControlStore::postgres(PostgresConfig::unix_socket(socket, &database, "postgres"))
                    .await
                    .unwrap();
            let mut observer = sqlx::PgConnection::connect_with(&options.database(&database))
                .await
                .unwrap();
            sqlx::query("SET search_path TO v1_control,pg_catalog")
                .execute(&mut observer)
                .await
                .unwrap();
            (
                store,
                Observer::Postgres(observer),
                None,
                Some(admin),
                database,
            )
        } else {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root =
                PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").expect("use pinned runner"))
                    .join(format!("control-tests/auth-{label}-{unique}"));
            std::fs::create_dir_all(root.join("v1")).unwrap();
            let store = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
            let mut observer = sqlx::SqliteConnection::connect(&format!(
                "sqlite:{}",
                root.join("v1/control.sqlite").display()
            ))
            .await
            .unwrap();
            sqlx::query("PRAGMA foreign_keys=ON")
                .execute(&mut observer)
                .await
                .unwrap();
            (
                store,
                Observer::Sqlite(observer),
                Some(root),
                None,
                String::new(),
            )
        };
        let mut result = Self {
            store,
            observer,
            root,
            admin,
            database,
            catalog: Arc::default(),
            revoker: Arc::default(),
            clock: Arc::default(),
        };
        // The composition fixture owns paired-root publication. Auth never
        // infers readiness from an empty control schema.
        result.observer.execute("INSERT INTO v1_storage_epoch(singleton,epoch_version,state,installation_id) VALUES(1,1,'ready','install_01010101010101010101010101010101')").await;
        result
    }
    pub async fn service(
        &self,
        mode: AuthenticationMode,
    ) -> Result<Arc<ControlService>, PortError> {
        Ok(Arc::new(
            ControlService::open(
                self.store.clone(),
                self.catalog.clone(),
                self.revoker.clone(),
                self.clock.clone(),
                ControlConfig {
                    authentication: mode,
                    resource_uri: "https://resource.example/".into(),
                    max_auth_spaces: 100,
                    schedule_limits: notarium_core::ports::control::RunLimits::HARD_CEILING,
                },
                budget(),
            )
            .await?,
        ))
    }
    pub async fn close(mut self) {
        self.store.close().await;
        self.observer.close().await;
        if let Some(root) = self.root {
            std::fs::remove_dir_all(root).unwrap();
        }
        if let Some(admin) = &mut self.admin {
            sqlx::QueryBuilder::<sqlx::Postgres>::new("DROP DATABASE ")
                .push(&self.database)
                .build()
                .execute(admin)
                .await
                .unwrap();
        }
    }
}
