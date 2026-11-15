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
pub struct EnsureCatalogSpace {
    pub identity: AccountCommandIdentity,
    pub owner: PrincipalId,
    pub space: CreateSpace,
}

/// Implementations check exact identity/placement and return only admitted metadata.
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
    fn note_facts(&self, ctx: AccountContext, note: NoteRef) -> PortFuture<'_, ResourceFacts>;
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
