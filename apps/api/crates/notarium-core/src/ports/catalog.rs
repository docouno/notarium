//! Metadata-only canonical ownership consumed by control. No document bodies or SQL.
use super::{PortFuture, context::*, control::*, types::*};
use crate::classes::CanonicalMetadataContent;
use crate::{auth::*, ids::*, model::*, receipt::AccountCommandIdentity};

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
    fn space(&self, budget: CallBudget, space: SpaceId) -> PortFuture<'_, CatalogSpace>;
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
