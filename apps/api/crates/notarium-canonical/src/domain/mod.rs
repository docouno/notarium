use std::sync::Arc;

use notarium_core::{
    DomainError,
    classes::ClassifiedAbilityResource,
    error::{PortError, ValidationReason},
    ids::{AgentRunId, FolderId, NoteId, SpaceSeq},
    model::{FolderRef, NoteRef, SnapshotCut},
    ports::{
        AbilityPackageRevision, AcceptBatch, AppendMemory, BatchResult, BoardMoveResult,
        BoardMutationFactsProvider, BoardPlannerAuthority, ChangeRead, ChangeReadResult,
        ChildFolders, Committed, CreateNote, DeleteDisposition, DeleteNote, EditNote,
        EnsureFolderPath, ExternalObservation, ExternalObservationResult, FolderSnapshot, GetNote,
        Link, LinkBatch, LiveCollabInterceptor, MemoryAppendResult, MintAndPurge,
        MintAndPurgeResult, MoveBoardCard, MoveFolder, MoveNote, Mutation, NoteCard, NoteRevision,
        NoteSnapshot, NoteWritePort, PageLimit, PortFuture, PublishAbilityPackage,
        ReadAbilityResource, RenameFolder, RenameNote, RenameProject, RollbackResult, SpaceContext,
        TrashAbilityPackage,
    },
};

use crate::{CanonicalStore, changes::ChangeCaller};

pub mod board;
pub(crate) mod change_visibility;
pub mod common;
pub(crate) mod folder_cover;
mod folder_paths;
pub mod folders;
mod memory;
pub mod notes;
pub mod packages;
pub mod purge;
pub mod rollback;

pub use common::{RoomFenceTable, SpaceSchemaRevision, UpdateSpaceSchema};
pub use notes::RoomCommandSettlement;

pub(crate) type BoardProviderBinding = (BoardPlannerAuthority, Arc<dyn BoardMutationFactsProvider>);

impl NoteWritePort for CanonicalStore {
    fn ensure_folder_path(
        &self,
        ctx: SpaceContext,
        request: Mutation<EnsureFolderPath>,
    ) -> PortFuture<'_, FolderRef> {
        Box::pin(folder_paths::ensure(self, ctx, request))
    }

    fn create_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<CreateNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        let store = self.clone();
        Box::pin(async move { notes::create_note_impl(&store, ctx, request).await })
    }

    fn edit_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<EditNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        let store = self.clone();
        Box::pin(async move { notes::edit_note_impl(&store, ctx, request).await })
    }

    fn delete_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<DeleteNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        let store = self.clone();
        Box::pin(async move {
            match request.input.disposition {
                DeleteDisposition::Trash | DeleteDisposition::Restore => {
                    notes::delete_note_impl(&store, ctx, request).await
                }
                DeleteDisposition::Purge => purge::purge_note_impl(&store, ctx, request).await,
            }
        })
    }

    fn trash_ability_package(
        &self,
        ctx: SpaceContext,
        request: Mutation<TrashAbilityPackage>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        Box::pin(notes::trash_ability_package_impl(self, ctx, request))
    }

    fn mint_and_purge(
        &self,
        ctx: SpaceContext,
        request: Mutation<MintAndPurge>,
    ) -> PortFuture<'_, Committed<MintAndPurgeResult>> {
        let store = self.clone();
        Box::pin(async move { purge::mint_and_purge_impl(&store, ctx, request).await })
    }

    fn move_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        let store = self.clone();
        Box::pin(async move { notes::move_note_impl(&store, ctx, request).await })
    }

    fn rename_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<RenameNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        let store = self.clone();
        Box::pin(async move { notes::rename_note_impl(&store, ctx, request).await })
    }

    fn move_folder(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveFolder>,
    ) -> PortFuture<'_, Committed<FolderRef>> {
        let store = self.clone();
        Box::pin(async move { folders::move_folder_impl(&store, ctx, request).await })
    }

    fn rename_folder(
        &self,
        ctx: SpaceContext,
        request: Mutation<RenameFolder>,
    ) -> PortFuture<'_, Committed<FolderRef>> {
        let store = self.clone();
        Box::pin(async move { folders::rename_folder_impl(&store, ctx, request).await })
    }

    fn rename_project(
        &self,
        ctx: SpaceContext,
        request: Mutation<RenameProject>,
    ) -> PortFuture<'_, Committed<FolderRef>> {
        let store = self.clone();
        Box::pin(async move { folders::rename_project_impl(&store, ctx, request).await })
    }

    fn accept_batch(
        &self,
        ctx: SpaceContext,
        request: AcceptBatch,
    ) -> PortFuture<'_, BatchResult<NoteRevision>> {
        let store = self.clone();
        Box::pin(async move { notes::accept_batch_impl(&store, ctx, request).await })
    }

    fn append_memory(
        &self,
        ctx: SpaceContext,
        request: Mutation<AppendMemory>,
    ) -> PortFuture<'_, Committed<MemoryAppendResult>> {
        let store = self.clone();
        Box::pin(async move { memory::append(&store, ctx, request).await })
    }

    fn link(&self, ctx: SpaceContext, request: Mutation<Link>) -> PortFuture<'_, Committed<Link>> {
        let store = self.clone();
        Box::pin(async move { notes::link_impl(&store, ctx, request).await })
    }

    fn link_many(
        &self,
        ctx: SpaceContext,
        request: LinkBatch,
    ) -> PortFuture<'_, BatchResult<Link>> {
        let store = self.clone();
        Box::pin(async move { notes::link_many_impl(&store, ctx, request).await })
    }

    fn publish_ability_package(
        &self,
        ctx: SpaceContext,
        request: Mutation<PublishAbilityPackage>,
    ) -> PortFuture<'_, Committed<AbilityPackageRevision>> {
        let store = self.clone();
        Box::pin(async move { packages::publish_ability_package_impl(&store, ctx, request).await })
    }

    fn rollback_agent_run_by_id(
        &self,
        ctx: SpaceContext,
        request: Mutation<AgentRunId>,
    ) -> PortFuture<'_, Committed<RollbackResult>> {
        let store = self.clone();
        Box::pin(async move { rollback::rollback_agent_run_by_id(&store, ctx, request).await })
    }

    fn accept_external_observation(
        &self,
        ctx: SpaceContext,
        request: Mutation<ExternalObservation>,
    ) -> PortFuture<'_, ExternalObservationResult> {
        let store = self.clone();
        Box::pin(async move { notes::accept_external_observation_impl(&store, ctx, request).await })
    }
}

impl CanonicalStore {
    pub async fn resolve_folder_path(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        path: String,
    ) -> Result<Option<FolderSnapshot>, PortError> {
        folder_paths::resolve(self, ctx, base, path).await
    }

    pub async fn list_child_folders(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        after: Option<FolderId>,
        at_seq: Option<SpaceSeq>,
        limit: PageLimit,
    ) -> Result<ChildFolders, PortError> {
        folder_paths::list_children(self, ctx, base, after, at_seq, limit).await
    }

    pub async fn resolve_note_target(
        &self,
        ctx: SpaceContext,
        parent: Option<FolderId>,
        target: String,
    ) -> Result<Option<NoteRef>, PortError> {
        folder_paths::resolve_note(self, ctx, parent, target).await
    }

    pub async fn space_schema(
        &self,
        ctx: SpaceContext,
    ) -> Result<std::collections::BTreeMap<String, notarium_core::query::FieldSchema>, PortError>
    {
        folder_paths::space_schema(self, ctx).await
    }

    pub async fn space_schema_snapshot(
        &self,
        ctx: SpaceContext,
        revision: Option<notarium_core::ids::RevisionId>,
    ) -> Result<notarium_core::ports::SpaceSchemaSnapshot, PortError> {
        folder_paths::space_schema_snapshot(self, ctx, revision).await
    }

    pub fn room_fences(&self) -> &Arc<RoomFenceTable> {
        &self.inner.room_fences
    }

    pub fn register_board_facts_provider(
        &self,
        provider: Arc<dyn BoardMutationFactsProvider>,
    ) -> Result<BoardPlannerAuthority, PortError> {
        let mut binding = self
            .inner
            .board_provider
            .write()
            .unwrap_or_else(|error| error.into_inner());
        if binding.is_some() {
            return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
        }
        let authority = BoardPlannerAuthority::admit();
        *binding = Some((authority.clone(), provider));
        Ok(authority)
    }

    /// Release this installation's binding when its planner runtime shuts down.
    /// The original authority is required, so a previous runtime cannot remove
    /// a replacement. Already prepared commands retain their canonical checks.
    pub fn unregister_board_facts_provider(&self, authority: &BoardPlannerAuthority) -> bool {
        let retired = {
            let mut binding = self
                .inner
                .board_provider
                .write()
                .unwrap_or_else(|error| error.into_inner());
            if binding
                .as_ref()
                .is_some_and(|(current, _)| current.matches(authority))
            {
                binding.take()
            } else {
                None
            }
        };
        retired.is_some()
    }

    pub(crate) fn board_facts_provider(&self) -> Result<BoardProviderBinding, PortError> {
        self.inner
            .board_provider
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .ok_or_else(|| DomainError::validation(ValidationReason::NotReady).into())
    }

    pub fn register_collab_interceptor(
        &self,
        interceptor: Arc<dyn LiveCollabInterceptor>,
    ) -> Result<(), PortError> {
        self.inner
            .collab_interceptor
            .set(interceptor)
            .map_err(|_| DomainError::validation(ValidationReason::DuplicateKey).into())
    }

    pub async fn get_note(
        &self,
        ctx: SpaceContext,
        request: GetNote,
    ) -> Result<NoteSnapshot, PortError> {
        if self.is_sqlite_local() && request.revision.is_none() {
            return crate::sqlite_fast::get_note_sqlite_local_fast(self, ctx, request).await;
        }
        let budget = ctx.budget.clone();
        let deadline = common::CommandDeadline::start(&budget, "get_note");
        if self.is_postgres() {
            return Self::run_pg_read_request(
                budget,
                notes::get_note_impl(self, ctx, request, &deadline),
            )
            .await;
        }
        let result = deadline
            .wait(&budget, || {
                notes::get_note_impl(self, ctx, request, &deadline)
            })
            .await?;
        deadline.remaining(&budget)?;
        result
    }

    pub async fn get_note_metadata(
        &self,
        ctx: SpaceContext,
        request: GetNote,
    ) -> Result<notarium_core::ports::NoteMetadataSnapshot, PortError> {
        let budget = ctx.budget.clone();
        let deadline = common::CommandDeadline::start(&budget, "get_note_metadata");
        if self.is_postgres() {
            return Self::run_pg_read_request(
                budget,
                notes::get_note_metadata_impl(self, ctx, request, &deadline),
            )
            .await;
        }
        let result = deadline
            .wait(&budget, || {
                notes::get_note_metadata_impl(self, ctx, request, &deadline)
            })
            .await?;
        deadline.remaining(&budget)?;
        result
    }

    pub async fn read_ability_resource(
        &self,
        ctx: SpaceContext,
        request: ReadAbilityResource,
    ) -> Result<ClassifiedAbilityResource, PortError> {
        let budget = ctx.budget.clone();
        common::CommandDeadline::start(&budget, "read_ability_resource")
            .prepare(&budget, || {
                packages::read_ability_resource_impl(self, ctx, request)
            })
            .await
    }

    pub async fn read_changes(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> Result<ChangeReadResult, PortError> {
        self.execute_change_read(ChangeCaller::Space(&ctx), request)
            .await
    }

    pub async fn recent_activity(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> Result<ChangeReadResult, PortError> {
        self.execute_change_read(ChangeCaller::Activity(&ctx), request)
            .await
    }

    pub async fn is_live_visible(
        &self,
        ctx: &SpaceContext,
        note_id: &NoteId,
    ) -> Result<bool, PortError> {
        notes::is_live_visible_impl(self, ctx, note_id).await
    }

    pub async fn hydrate_cards(
        &self,
        ctx: SpaceContext,
        cut: SnapshotCut,
        notes: Vec<NoteId>,
    ) -> Result<Vec<Option<NoteCard>>, PortError> {
        let budget = ctx.budget.clone();
        common::CommandDeadline::start(&budget, "hydrate_cards")
            .prepare(&budget, || notes::hydrate_cards_impl(self, ctx, cut, notes))
            .await
    }

    pub async fn resolve_note_alias(
        &self,
        ctx: SpaceContext,
        parent: Option<FolderId>,
        slug_or_title: &str,
    ) -> Result<Option<NoteRef>, PortError> {
        folders::resolve_note_alias_impl(self, ctx, parent, slug_or_title).await
    }

    pub async fn resolve_folder_alias(
        &self,
        ctx: SpaceContext,
        parent: Option<FolderId>,
        slug: &str,
    ) -> Result<Option<FolderRef>, PortError> {
        folders::resolve_folder_alias_impl(self, ctx, parent, slug).await
    }

    pub async fn set_folder_write_lock(
        &self,
        ctx: SpaceContext,
        folder: FolderId,
        locked: bool,
    ) -> Result<FolderRef, PortError> {
        folders::set_folder_write_lock_impl(self, ctx, folder, locked).await
    }

    pub async fn update_space_schema(
        &self,
        ctx: SpaceContext,
        request: Mutation<UpdateSpaceSchema>,
    ) -> Result<Committed<SpaceSchemaRevision>, PortError> {
        notes::update_space_schema_impl(self, ctx, request).await
    }

    pub async fn move_board_card(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveBoardCard>,
    ) -> Result<Committed<BoardMoveResult>, PortError> {
        Box::pin(board::move_board_card_impl(self, ctx, request)).await
    }
}
