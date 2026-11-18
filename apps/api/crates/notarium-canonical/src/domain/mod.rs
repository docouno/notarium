use std::sync::Arc;

use notarium_core::{
    DomainError,
    classes::ClassifiedAbilityResource,
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId},
    model::{FolderRef, NoteRef, SnapshotCut},
    ports::{
        AbilityPackageRevision, AcceptBatch, AppendMemory, BatchResult, BoardMoveResult,
        BoardMutationFactsProvider, BoardPlannerAuthority, ChangeRead, ChangeReadResult, Committed,
        CreateNote, DeleteDisposition, DeleteNote, EditNote, ExternalObservation,
        ExternalObservationResult, GetNote, Link, LinkBatch, LiveCollabInterceptor, MintAndPurge,
        MintAndPurgeResult, MoveBoardCard, MoveFolder, MoveNote, Mutation, NoteCard, NoteRevision,
        NoteSnapshot, NoteWritePort, PortFuture, PublishAbilityPackage, ReadAbilityResource,
        RenameFolder, RenameNote, RenameProject, RollbackAgentRun, RollbackResult, SpaceContext,
    },
};

use crate::{
    CanonicalStore, changes::ChangeCaller, codec::internal_not_committed, sql_exec::BackendConn,
};

pub mod board;
pub(crate) mod change_visibility;
pub mod common;
pub mod folders;
pub mod notes;
pub mod packages;
pub mod purge;
pub mod rollback;

pub use common::{RoomFenceTable, SpaceSchemaRevision, UpdateSpaceSchema};

impl NoteWritePort for CanonicalStore {
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
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        let store = self.clone();
        Box::pin(async move { notes::append_memory_impl(&store, ctx, request).await })
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

    fn rollback_agent_run(
        &self,
        ctx: SpaceContext,
        request: Mutation<RollbackAgentRun>,
    ) -> PortFuture<'_, Committed<RollbackResult>> {
        let store = self.clone();
        Box::pin(async move { rollback::rollback_agent_run_impl(&store, ctx, request).await })
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
    pub fn room_fences(&self) -> &Arc<RoomFenceTable> {
        &self.inner.room_fences
    }

    pub fn register_board_facts_provider(
        &self,
        provider: Arc<dyn BoardMutationFactsProvider>,
    ) -> Result<BoardPlannerAuthority, PortError> {
        let authority = BoardPlannerAuthority::admit();
        self.inner
            .board_provider
            .set((authority.clone(), provider))
            .map_err(|_| DomainError::validation(ValidationReason::DuplicateKey))?;
        Ok(authority)
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
        if self.is_postgres() {
            return Self::run_pg_read_request(
                ctx.budget.clone(),
                notes::get_note_impl(self, ctx, request),
            )
            .await;
        }
        notes::get_note_impl(self, ctx, request).await
    }

    pub async fn read_ability_resource(
        &self,
        ctx: SpaceContext,
        request: ReadAbilityResource,
    ) -> Result<ClassifiedAbilityResource, PortError> {
        packages::read_ability_resource_impl(self, ctx, request).await
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
        self.read_changes(ctx, request).await
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
        notes::hydrate_cards_impl(self, ctx, cut, notes).await
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
        board::move_board_card_impl(self, ctx, request).await
    }
}

pub(crate) async fn lookup_thread_visibility_tx(
    tx: &mut BackendConn<'_>,
    space_id: &notarium_core::ids::SpaceId,
    thread_id: &str,
) -> Result<Option<(Option<FolderId>, bool)>, PortError> {
    let row: Option<(Option<String>, i64)> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(
            "SELECT project_folder_id, ext_space_tainted_mask FROM chat_threads WHERE space_id = ? AND thread_id = ?",
        )
        .bind(space_id.as_str())
        .bind(thread_id)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_lookup_thread_taint", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_as(
            "SELECT project_folder_id, ext_space_tainted_mask::BIGINT FROM chat_threads WHERE space_id = $1 AND thread_id = $2",
        )
        .bind(space_id.as_str())
        .bind(thread_id)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_lookup_thread_taint", err.to_string()))?,
    };
    row.map(|(project, mask)| {
        let project = project
            .as_deref()
            .map(FolderId::parse)
            .transpose()
            .map_err(|_| internal_not_committed("corrupt_thread_proj", "invalid FolderId"))?;
        Ok((project, mask != 0))
    })
    .transpose()
}
