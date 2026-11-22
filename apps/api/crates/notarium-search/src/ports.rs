//! Read and model-selection contracts for the search engine.

use crate::embed::Pooling;
use crate::layout::{RemoteVectorModel, VectorModel};
pub use notarium_canonical::changes::search::{
    SearchDocumentTarget, SearchIndexedNote, SearchNotesSeedPage, SearchOverlayNote,
};
use notarium_canonical::{CanonicalStore, chats::search::HydratedChatHit};
use notarium_core::{
    classes::{ClassifiedDocument, ProviderPolicy},
    ids::{
        ChatThreadId, ModelProfileId, NoteId, PrincipalId, ProviderResourceId, RevisionId,
        SpaceSeq, ThreadEntrySeq,
    },
    model::{FolderRef, HistoryScope},
    ports::{
        CallBudget, PageLimit, PortFuture, ProviderRuntimeEpochs, ServiceAuthority, SpaceContext,
    },
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
                EmbeddingBackendTarget::LocalOnnx | EmbeddingBackendTarget::LocalOnnxCls => None,
                EmbeddingBackendTarget::Remote {
                    provider,
                    runtime_epochs,
                    project,
                } => Some(RemoteVectorModel {
                    provider: provider.clone(),
                    runtime_epochs: *runtime_epochs,
                    project: project.clone(),
                }),
            },
            dimension: self.dimension,
            max_input_tokens: self.max_input_tokens,
            pooling: self.backend.local_pooling().unwrap_or_default(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum EmbeddingBackendTarget {
    /// Token-level output uses masked mean pooling.
    LocalOnnx,
    /// Token-level output uses its first token as the sentence embedding.
    LocalOnnxCls,
    Remote {
        provider: ProviderResourceId,
        runtime_epochs: ProviderRuntimeEpochs,
        project: Option<FolderRef>,
    },
}

impl EmbeddingBackendTarget {
    pub(crate) fn local_pooling(&self) -> Option<Pooling> {
        match self {
            Self::LocalOnnx => Some(Pooling::Mean),
            Self::LocalOnnxCls => Some(Pooling::Cls),
            Self::Remote { .. } => None,
        }
    }
}

#[derive(Clone)]
pub struct RemoteIndexingGrant {
    pub ctx: SpaceContext,
    pub policy: ProviderPolicy,
}

pub trait SearchModelResolverPort: Send + Sync {
    fn resolve_model<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        explicit: Option<&'a ModelProfileId>,
        budget: &'a CallBudget,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>>;

    /// Admit the owner of a Personal Space or the revision author in a
    /// Shared Space under current individual and Space/project disclosure.
    /// Return `Ok(None)` if that actor is absent, disabled, no longer a member,
    /// or lacks consent. Other eligible authors can still be indexed.
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
        ctx: SpaceContext,
        filter_cut: SpaceSeq,
        targets: Vec<(NoteId, RevisionId)>,
    ) -> PortFuture<'_, Vec<(NoteId, Option<SearchOverlayNote>)>>;

    fn read_authorized_documents_for_search(
        &self,
        ctx: SpaceContext,
        targets: Vec<SearchDocumentTarget>,
    ) -> PortFuture<'_, Vec<Option<Arc<ClassifiedDocument>>>>;

    fn visible_chat_hit_keys<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        candidates: &'a [(ChatThreadId, ThreadEntrySeq)],
    ) -> PortFuture<'a, Vec<(ChatThreadId, ThreadEntrySeq)>>;

    /// Prepare authorized candidate text without marking the caller's branch taint.
    fn prepare_search_chat_hits<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
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
        ctx: SpaceContext,
        filter_cut: SpaceSeq,
        targets: Vec<(NoteId, RevisionId)>,
    ) -> PortFuture<'_, Vec<(NoteId, Option<SearchOverlayNote>)>> {
        Box::pin(async move {
            self.read_note_revisions_for_overlay(&authority, ctx, filter_cut, targets)
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

    fn visible_chat_hit_keys<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        candidates: &'a [(ChatThreadId, ThreadEntrySeq)],
    ) -> PortFuture<'a, Vec<(ChatThreadId, ThreadEntrySeq)>> {
        Box::pin(CanonicalStore::visible_chat_hit_keys(self, ctx, candidates))
    }

    fn prepare_search_chat_hits<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        ctx: &'a SpaceContext,
        candidates: &'a [(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> PortFuture<'a, (Vec<HydratedChatHit>, bool)> {
        Box::pin(CanonicalStore::prepare_search_chat_hits(
            self, authority, ctx, candidates, limit,
        ))
    }
}
