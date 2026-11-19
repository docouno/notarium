//! Metadata-only canonical ownership consumed by control. No document bodies or SQL.
use super::{PortFuture, context::*, control::*, types::*};
use crate::{auth::*, ids::*, model::*, receipt::AccountCommandIdentity};

#[derive(Clone, Debug)]
pub struct CatalogSpace {
    pub space: Space,
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
pub struct EnsureCatalogSpace {
    pub identity: AccountCommandIdentity,
    pub owner: PrincipalId,
    pub space: CreateSpace,
}

/// Implementations check exact identity/placement and return only admitted metadata.
/// Pages contain current candidates, including disabled candidates so control can
/// enforce precedence. Continuations are bounded to 2048 UTF-8 bytes and detect
/// catalog changes. Cursor positions must not disclose candidate entity IDs:
/// control can filter additional candidates and forwards the bounded continuation.
/// Control binds the outer cursor to its own current authority.
/// Cross-owner writes are idempotent on the supplied identity and exact payload.
pub trait ControlCatalogPort: Send + Sync {
    fn space(&self, budget: CallBudget, space: SpaceId) -> PortFuture<'_, CatalogSpace>;
    fn projects(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProjectInfo>>;
    fn project(&self, ctx: SpaceContext, project: FolderRef) -> PortFuture<'_, ProjectInfo>;
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
    fn note(&self, ctx: AccountContext, note: NoteRef) -> PortFuture<'_, CatalogNote>;
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
}
