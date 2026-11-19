//! Read and model-selection contracts for the search engine.

use crate::layout::{RemoteVectorModel, VectorModel};
pub use notarium_canonical::changes::search::{
    SearchDocumentTarget, SearchIndexedNote, SearchNotesSeedPage, SearchOverlayNote,
};
use notarium_canonical::{CanonicalStore, chats::search::HydratedChatHit};
use notarium_core::{
    classes::{ClassifiedDocument, ProviderPolicy},
    ids::{
        ChatThreadId, FolderId, ModelProfileId, NoteId, PrincipalId, ProviderResourceId,
        RevisionId, SpaceSeq, ThreadEntrySeq,
    },
    model::{FolderRef, HistoryScope},
    ports::{CallBudget, PageLimit, PortFuture, ServiceAuthority, SpaceContext},
};
use serde::{Deserialize, Serialize};
use std::{num::NonZeroU64, sync::Arc};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResolvedEmbeddingTarget {
    pub model: ModelProfileId,
    pub dimension: u32,
    pub max_input_tokens: u32,
    pub backend: EmbeddingBackendTarget,
}

impl ResolvedEmbeddingTarget {
    pub(crate) fn vector_model(&self) -> VectorModel {
        VectorModel {
            profile: self.model.clone(),
            remote: match &self.backend {
                EmbeddingBackendTarget::LocalOnnx => None,
                EmbeddingBackendTarget::Remote {
                    provider,
                    runtime_epoch,
                    project,
                } => Some(RemoteVectorModel {
                    provider: provider.clone(),
                    runtime_epoch: *runtime_epoch,
                    project: project.clone(),
                }),
            },
            dimension: self.dimension,
            max_input_tokens: self.max_input_tokens,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum EmbeddingBackendTarget {
    LocalOnnx,
    Remote {
        provider: ProviderResourceId,
        runtime_epoch: NonZeroU64,
        project: Option<FolderRef>,
    },
}

#[derive(Clone)]
pub struct RemoteIndexingGrant {
    pub ctx: SpaceContext,
    pub policy: ProviderPolicy,
}

pub trait SearchModelResolverPort: Send + Sync {
    fn resolve_model<'a>(
        &'a self,
        scope: &'a HistoryScope,
        project: Option<&'a FolderId>,
        explicit: Option<&'a ModelProfileId>,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>>;

    /// Admit the owner of a Personal Space or the revision author in a
    /// Shared Space under current individual and Space/project disclosure.
    fn acquire_remote_indexing_grant<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        revision_actor: &'a PrincipalId,
        provider: &'a ProviderResourceId,
        project: Option<&'a FolderRef>,
        budget: CallBudget,
    ) -> PortFuture<'a, Option<RemoteIndexingGrant>>;
}

pub trait SearchCarrierReadPort: Send + Sync {
    fn read_searchable_notes_seed_page(
        &self,
        authority: ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        cutoff: Option<SpaceSeq>,
        after_note: Option<NoteId>,
        limit: PageLimit,
    ) -> PortFuture<'_, SearchNotesSeedPage>;

    fn read_note_documents_at_cutoff(
        &self,
        authority: ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        cutoff: SpaceSeq,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<(NoteId, Option<SearchIndexedNote>)>>;

    fn read_note_revisions_for_overlay(
        &self,
        authority: ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        targets: Vec<(NoteId, RevisionId)>,
    ) -> PortFuture<'_, Vec<(NoteId, Option<SearchOverlayNote>)>>;

    fn read_authorized_documents_for_search(
        &self,
        ctx: SpaceContext,
        targets: Vec<SearchDocumentTarget>,
    ) -> PortFuture<'_, Vec<Option<Arc<ClassifiedDocument>>>>;

    fn hydrate_live_visible_chat_hits<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        candidates: &'a [(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> PortFuture<'a, (Vec<HydratedChatHit>, bool)>;
}

impl SearchCarrierReadPort for CanonicalStore {
    fn read_searchable_notes_seed_page(
        &self,
        authority: ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        cutoff: Option<SpaceSeq>,
        after_note: Option<NoteId>,
        limit: PageLimit,
    ) -> PortFuture<'_, SearchNotesSeedPage> {
        Box::pin(async move {
            self.read_searchable_notes_seed_page(
                &authority, budget, scope, cutoff, after_note, limit,
            )
            .await
        })
    }

    fn read_note_documents_at_cutoff(
        &self,
        authority: ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        cutoff: SpaceSeq,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<(NoteId, Option<SearchIndexedNote>)>> {
        Box::pin(async move {
            self.read_note_documents_at_cutoff(&authority, budget, scope, cutoff, notes)
                .await
        })
    }

    fn read_note_revisions_for_overlay(
        &self,
        authority: ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        targets: Vec<(NoteId, RevisionId)>,
    ) -> PortFuture<'_, Vec<(NoteId, Option<SearchOverlayNote>)>> {
        Box::pin(async move {
            self.read_note_revisions_for_overlay(&authority, budget, scope, targets)
                .await
        })
    }

    fn read_authorized_documents_for_search(
        &self,
        ctx: SpaceContext,
        targets: Vec<SearchDocumentTarget>,
    ) -> PortFuture<'_, Vec<Option<Arc<ClassifiedDocument>>>> {
        Box::pin(CanonicalStore::read_authorized_documents_for_search(
            self, ctx, targets,
        ))
    }

    fn hydrate_live_visible_chat_hits<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        candidates: &'a [(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> PortFuture<'a, (Vec<HydratedChatHit>, bool)> {
        Box::pin(CanonicalStore::hydrate_live_visible_chat_hits(
            self, ctx, candidates, limit,
        ))
    }
}
