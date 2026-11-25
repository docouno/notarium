//! Metadata-only canonical ownership consumed by control. No document bodies or SQL.
use super::{PortFuture, context::*, control::*, types::*};
use crate::classes::CanonicalMetadataContent;
use crate::{
    DomainError, auth::*, error::PortError, ids::*, model::*, receipt::AccountCommandIdentity,
};

#[derive(Clone, Debug)]
pub struct CatalogSpace {
    pub space: Space,
    pub slug: String,
    pub history: HistoryScope,
    pub last_seq: SpaceSeq,
}

#[derive(Clone, Debug)]
pub struct CatalogNote {
    pub reference: NoteRef,
    pub lifecycle: Lifecycle,
    pub facts: ResourceFacts,
}
#[derive(Clone, Debug)]
pub struct CatalogFolder {
    pub reference: FolderRef,
    pub space: Space,
    pub lifecycle: Lifecycle,
    pub ancestor_folders: Vec<FolderId>,
    pub write_locked: bool,
}

#[derive(Clone, Debug)]
pub enum CatalogDisclosure {
    Folder(FolderRef),
    Space(HistoryScope),
}

#[derive(Clone, Debug)]
pub struct EnsureCatalogSpace {
    pub identity: AccountCommandIdentity,
    pub owner: PrincipalId,
    pub space: CreateSpace,
}

/// The owner holds these current package tips stable for the lifetime of the
/// lease. Control uses it through the commit that binds scheduling authority.
pub trait ScheduleAbilityLease: Send {
    fn history(&self) -> &HistoryScope;
    fn abilities(&self) -> &[AbilityDescriptor];
    /// Explicitly roll back and recycle any pinned storage snapshot connection.
    fn close(&mut self) -> PortFuture<'_, ()>;
}

/// Implementations check exact identity/placement and return only admitted metadata.
/// Pages contain current candidates, including disabled candidates so control can
/// enforce precedence. Continuations are bounded to 2048 UTF-8 bytes and detect
/// catalog changes. Cursor positions must not disclose candidate entity IDs:
/// control can filter additional candidates and forwards the bounded continuation.
/// Control binds the outer cursor to its own current authority.
/// Cross-owner writes are idempotent on the supplied identity and exact payload.
pub trait ControlCatalogPort: Send + Sync {
    fn disclosure(
        &self,
        ctx: AccountContext,
        source: CatalogDisclosure,
    ) -> PortFuture<'_, CanonicalMetadataContent>;
    /// Load folder disclosure proofs for a batch of folders across admitted
    /// Spaces in a single read transaction, skipping hidden/inaccessible entries.
    fn folder_disclosures(
        &self,
        ctx: AccountContext,
        folders: Vec<FolderRef>,
    ) -> PortFuture<'_, Vec<CanonicalMetadataContent>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(folders.len());
            for folder in folders {
                match self
                    .disclosure(ctx.clone(), CatalogDisclosure::Folder(folder))
                    .await
                {
                    Ok(proof) => out.push(proof),
                    Err(PortError::Domain(
                        DomainError::ResourceNotFound | DomainError::AccessDenied,
                    )) => {}
                    Err(error) => return Err(error),
                }
            }
            Ok(out)
        })
    }
    /// Verify a batch of candidate project references across admitted Spaces in
    /// a single read transaction, returning only active visible projects.
    fn existing_projects(
        &self,
        ctx: AccountContext,
        projects: Vec<FolderRef>,
    ) -> PortFuture<'_, Vec<FolderRef>> {
        Box::pin(async move {
            let mut spaces = std::collections::BTreeMap::new();
            let mut out = Vec::with_capacity(projects.len());
            for reference in projects {
                if !ctx.auth().spaces().contains_key(&reference.space_id) {
                    continue;
                }
                let space = if let Some(cached) = spaces.get(&reference.space_id) {
                    let Some(space) = cached else {
                        continue;
                    };
                    space
                } else {
                    match self
                        .space(ctx.budget.clone(), reference.space_id.clone())
                        .await
                    {
                        Ok(space) => {
                            spaces.insert(reference.space_id.clone(), Some(space));
                            spaces
                                .get(&reference.space_id)
                                .and_then(Option::as_ref)
                                .expect("cached space")
                        }
                        Err(PortError::Domain(
                            DomainError::ResourceNotFound | DomainError::AccessDenied,
                        )) => {
                            spaces.insert(reference.space_id.clone(), None);
                            continue;
                        }
                        Err(error) => return Err(error),
                    }
                };
                if space.space.lifecycle != SpaceLifecycle::Active {
                    continue;
                }
                let scope_ctx = SpaceContext::new(
                    ctx.auth().clone(),
                    space.history.clone(),
                    ctx.budget.clone(),
                )?;
                match self.project(scope_ctx, reference.clone()).await {
                    Ok(_) => out.push(reference),
                    Err(PortError::Domain(
                        DomainError::ResourceNotFound | DomainError::AccessDenied,
                    )) => {}
                    Err(error) => return Err(error),
                }
            }
            Ok(out)
        })
    }
    fn space(&self, budget: CallBudget, space: SpaceId) -> PortFuture<'_, CatalogSpace>;
    /// Whether `run` has recorded any canonical document heads in `space`.
    /// Used to decide whether a non-owner Space Editor may observe a Keeper
    /// run's liveness during rollback fencing without leaking zero-edit private runs.
    fn agent_run_has_head(
        &self,
        budget: CallBudget,
        space: SpaceId,
        run: AgentRunId,
    ) -> PortFuture<'_, bool>;
    fn projects(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProjectInfo>>;
    fn project(&self, ctx: SpaceContext, project: FolderRef) -> PortFuture<'_, ProjectInfo>;
    /// Look up the active project handle in one admitted Space. A current
    /// exact slug takes precedence over an authorized historical alias.
    fn project_by_slug(&self, ctx: SpaceContext, slug: String) -> PortFuture<'_, ProjectInfo>;
    fn abilities(
        &self,
        ctx: AccountContext,
        query: AbilityQuery,
    ) -> PortFuture<'_, ControlPage<AbilityDescriptor>>;
    fn ability(
        &self,
        ctx: AccountContext,
        reference: AbilityRef,
    ) -> PortFuture<'_, AbilityDescriptor>;
    /// Current tip of an identity, distinct from an immutable revision lookup.
    fn current_ability(
        &self,
        ctx: AccountContext,
        identity: AbilityIdentity,
    ) -> PortFuture<'_, AbilityDescriptor>;
    /// Locate active ability packages matching `id` across the caller's
    /// authorized Spaces in a single bounded read (up to 200 entries, used for
    /// raw-ID lookup and ambiguity detection after control/provider filtering).
    fn locate_ability(
        &self,
        ctx: AccountContext,
        id: AbilityId,
    ) -> PortFuture<'_, Vec<AbilityDescriptor>>;
    /// Pin current exact package tips together with the context's single Space
    /// and its optional project. A missing project or changed or unreadable
    /// package makes the entire acquisition fail. Empty references still pin
    /// the scope for a schedule composed entirely of built-in abilities.
    fn pin_schedule_abilities(
        &self,
        ctx: AccountContext,
        refs: Vec<AbilityRef>,
    ) -> PortFuture<'_, Box<dyn ScheduleAbilityLease>>;
    fn note(&self, ctx: AccountContext, note: NoteRef) -> PortFuture<'_, CatalogNote>;
    /// Locate a single note across the caller's authorized Spaces in one read.
    fn locate_note(&self, ctx: AccountContext, note: NoteId) -> PortFuture<'_, CatalogNote>;
    fn folder(&self, ctx: AccountContext, folder: FolderRef) -> PortFuture<'_, CatalogFolder>;
    fn ensure_space(
        &self,
        budget: CallBudget,
        request: EnsureCatalogSpace,
    ) -> PortFuture<'_, CatalogSpace>;
    fn change_lifecycle(
        &self,
        budget: CallBudget,
        identity: AccountCommandIdentity,
        scope: HistoryScope,
        lifecycle: SpaceLifecycle,
    ) -> PortFuture<'_, CatalogSpace>;
    fn resolve_or_ensure_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, ResolvedMemoryTarget>;
    fn inspect_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, MemoryTargetSnapshot>;
}
