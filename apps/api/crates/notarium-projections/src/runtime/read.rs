mod retention;

use std::{
    collections::{BTreeMap, BTreeSet},
    num::NonZeroUsize,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use croaring::Bitmap;
use notarium_canonical::{
    LiveNoteStatus, LiveReadPermit, LiveSpaceHandle,
    codec::{cancelled_not_committed, csprng_16, deadline_not_committed, encode_msgpack},
    domain::common::MAX_FOLDER_DEPTH,
    projection_read::ProjectionOverlaySelection,
};
use notarium_core::{
    DomainError, DomainResult,
    auth::{AuthenticatedCredential, PrincipalKind, ResourceFacts, SpaceLifecycle},
    classes::{ClassEgressFence, ClassifiedMetadata, DocClass},
    error::{Diagnostic, PortError, ValidationReason},
    ids::*,
    model::{
        DenseNodeId, DenseNodeIter, FolderRef, HistoryScope, Lifecycle, LifecycleMask, NoteRef,
        SnapshotCut,
    },
    ports::*,
    query::{
        CursorPage, EffectiveRead, FieldFilterAstV1, FieldSchema, KeysetCursor, Predicate,
        ReadRequest,
    },
    receipt::{CausalBasis, MutationEffect, OverlayDecision, ReceiptSet, plan_overlay},
};

use crate::{
    derived::{ListCardRow, ProjectedNote, ProjectedViewRank},
    index::{IndexView, PostingKey},
    nota::{NotaDescriptor, SourceFolder, ViewKind, ViewSource, compile_projected_views},
    query::{self, BoardRank, WindowInput},
};

use super::{ProjectionEngine, PublishedCut, records};

pub(super) struct RetainedReads {
    by_id: Mutex<BTreeMap<EffectiveReadId, Arc<ReadState>>>,
    inserted: tokio::sync::Notify,
    limit: usize,
    lifetime: Duration,
}

impl RetainedReads {
    pub(super) fn new(limit: NonZeroUsize, lifetime: Duration) -> Self {
        Self {
            by_id: Mutex::default(),
            inserted: tokio::sync::Notify::new(),
            limit: limit.get(),
            lifetime,
        }
    }

    fn insert(&self, state: Arc<ReadState>) {
        const TOTAL_BYTE_BUDGET: usize = 64 * 1024 * 1024;
        const PER_SPACE_BYTE_BUDGET: usize = 16 * 1024 * 1024;
        let per_space_limit = (self.limit / 4).max(16).min(self.limit);
        let inserted_id = state.read.id.clone();
        let inserted_space = state.read.cut.scope.space_id.clone();
        let mut entries = self.by_id.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|_, entry| entry.expires > Instant::now());
        entries.insert(inserted_id.clone(), state);
        // Enforce a per-Space quota first so one hot tenant cannot evict all
        // retained cursors belonging to other Spaces. Never evict the freshly
        // inserted cursor itself.
        loop {
            let space_count = entries
                .values()
                .filter(|entry| entry.read.cut.scope.space_id == inserted_space)
                .count();
            let space_bytes = retained_bytes(
                entries
                    .values()
                    .filter(|entry| entry.read.cut.scope.space_id == inserted_space)
                    .map(|entry| (&entry.cut, entry.owned_bytes)),
            );
            if space_count <= per_space_limit && space_bytes <= PER_SPACE_BYTE_BUDGET {
                break;
            }
            let Some(victim) = entries
                .values()
                .filter(|entry| {
                    entry.read.cut.scope.space_id == inserted_space && entry.read.id != inserted_id
                })
                .min_by_key(|entry| entry.expires)
                .map(|entry| entry.read.id.clone())
            else {
                break;
            };
            entries.remove(&victim);
        }
        while entries.len() > self.limit
            || retained_bytes(
                entries
                    .values()
                    .map(|entry| (&entry.cut, entry.owned_bytes)),
            ) > TOTAL_BYTE_BUDGET
        {
            let Some(victim) = entries
                .values()
                .filter(|entry| entry.read.id != inserted_id)
                .min_by_key(|entry| entry.expires)
                .map(|entry| entry.read.id.clone())
            else {
                break;
            };
            entries.remove(&victim);
        }
        self.inserted.notify_one();
    }

    fn get(&self, cursor: &KeysetCursor, ctx: &SpaceContext) -> Result<Arc<ReadState>, PortError> {
        ctx.scope().check(&cursor.scope)?;
        let mut entries = self.by_id.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, entry| entry.expires > Instant::now());
        let state = entries
            .get(&cursor.effective_read)
            .cloned()
            .ok_or_else(stale)?;
        cursor.check(&state.read)?;
        if state.authority != authority_fingerprint(ctx)?
            || state.principal_kind != *ctx.auth().kind()
            || state.credential.as_ref() != ctx.auth().credential()
        {
            return Err(DomainError::validation(ValidationReason::CursorScopeMismatch).into());
        }
        Ok(state)
    }

    pub(super) fn invalidate_history(&self, scope: &HistoryScope) {
        self.by_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, read| &read.read.cut.scope != scope);
    }

    pub(super) async fn expire_on_deadline(&self) {
        loop {
            let deadline = {
                let mut reads = self.by_id.lock().unwrap_or_else(|error| error.into_inner());
                let now = Instant::now();
                let previous = reads.len();
                reads.retain(|_, read| read.expires > now);
                if reads.len() < previous {
                    return;
                }
                reads.values().map(|read| read.expires).min()
            };
            if let Some(deadline) = deadline {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline.into()) => {},
                    _ = self.inserted.notified() => {},
                }
            } else {
                self.inserted.notified().await;
            }
        }
    }

    pub(super) fn clear(&self) {
        self.by_id
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
}

pub(super) fn retained_bytes<'a>(
    reads: impl IntoIterator<Item = (&'a Arc<PublishedCut>, usize)>,
) -> usize {
    let mut cuts = BTreeSet::new();
    let mut fields = BTreeSet::new();
    let mut deltas = BTreeSet::new();
    reads.into_iter().fold(0usize, |bytes, (cut, owned)| {
        let mut bytes = bytes.saturating_add(owned);
        // Cursors on the same publication share its entire cut, including
        // its serialized watermark, parsed schema and in-memory delta.
        if !cuts.insert(Arc::as_ptr(cut)) {
            return bytes;
        }
        bytes = bytes
            .saturating_add(std::mem::size_of::<PublishedCut>())
            .saturating_add(
                cut.watermark
                    .schema
                    .as_ref()
                    .map_or(0, |schema| schema.fields_msgpack.capacity()),
            );
        if fields.insert(Arc::as_ptr(&cut.fields)) {
            bytes = bytes.saturating_add(cut.fields.retained_bytes);
        }
        if deltas.insert(Arc::as_ptr(&cut.delta)) {
            bytes = bytes.saturating_add(cut.delta.approx_bytes());
        }
        bytes
    })
}

#[derive(Clone)]
enum RetainedQuery {
    Notes(NoteQuery),
    View(ViewQuery),
}

struct ReadState {
    read: EffectiveRead,
    cut: Arc<PublishedCut>,
    query: RetainedQuery,
    overlay: BTreeMap<u32, ExactRow>,
    authority: ContentDigest,
    principal_kind: PrincipalKind,
    credential: Option<AuthenticatedCredential>,
    incomplete: bool,
    expires: Instant,
    prepared_view: Option<PreparedView>,
    owned_bytes: usize,
}

struct PreparedView {
    source: ViewSource,
    columns: Vec<GroupKey>,
    board: bool,
    plan: query::ViewPlan,
    folder: Option<FolderId>,
}

pub(super) struct ExactRow {
    pub(super) note: ProjectedNote,
    pub(super) location: records::FolderLocation,
    ranks: Vec<ProjectedViewRank>,
}

fn authority_fingerprint(ctx: &SpaceContext) -> Result<ContentDigest, PortError> {
    let auth = ctx.auth();
    let grant = auth
        .spaces()
        .get(&ctx.scope().space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    let audience: u8 = match auth.chat_audience() {
        None => 0,
        Some(notarium_core::auth::ChatAudience::Personal) => 1,
        Some(notarium_core::auth::ChatAudience::Shared) => 2,
    };
    let payload = encode_msgpack(&(
        auth.principal(),
        auth.grant(),
        grant.role,
        &grant.read_classes,
        &grant.project_root,
        auth.readonly_abilities(),
        auth.keeper_log(),
        audience,
    ))?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-projection-read-authority-v2");
    hasher.update(&payload);
    Ok(ContentDigest::from_bytes(*hasher.finalize().as_bytes()))
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

pub(super) fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}

async fn within_budget<T>(
    ctx: &SpaceContext,
    task: impl std::future::Future<Output = Result<T, PortError>>,
) -> Result<T, PortError> {
    tokio::select! {
        biased;
        _ = ctx.budget.cancellation.cancelled() => Err(cancelled_not_committed("projection_read", "caller cancelled")),
        result = tokio::time::timeout(ctx.budget.remaining, task) => {
            result.map_err(|_| deadline_not_committed("projection_read", "caller deadline exhausted"))?
        }
    }
}

struct ChosenRead {
    cut: Arc<PublishedCut>,
    incomplete: bool,
    selections: Vec<ProjectionOverlaySelection>,
    overlay: BTreeMap<u32, ExactRow>,
}

fn registration_gap(error: &PortError) -> bool {
    matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
        if matches!(diagnostic.reason, ValidationReason::CursorStale
            | ValidationReason::NotReady | ValidationReason::GenerationMismatch))
}

impl ProjectionEngine {
    async fn choose_read(
        &self,
        ctx: &SpaceContext,
        causal: &CausalBasis,
        query: Option<&RetainedQuery>,
    ) -> Result<ChosenRead, PortError> {
        let scope = ctx.scope();
        // Fail closed on unauthorized callers before waiting on projector lag
        // so `wait_for_cut` cannot act as a timing/existence oracle.
        if !ctx.auth().spaces().contains_key(&scope.space_id) {
            return Err(DomainError::ResourceNotFound.into());
        }
        if let Ok(live) = self.canonical.live_visibility_fence().space(scope)
            && let Ok(permit) = live.try_read()
        {
            match query {
                Some(RetainedQuery::Notes(notes)) => {
                    authorize_notes(&permit, ctx, permit.root_folder_id(), notes)?;
                }
                Some(RetainedQuery::View(view)) => ensure_active(&permit, ctx, &view.view.note)?,
                None => {
                    authorize_query(&permit, ctx, permit.root_folder_id(), None, true)?;
                }
            }
        }
        let mut apply_overlay = query.is_some();
        loop {
            let base = match self.published_cut(scope) {
                Ok(cut) => cut,
                Err(error) if registration_gap(&error) => {
                    self.wait_for_cut(scope, SpaceSeq::ZERO, &ctx.budget, ctx.budget.remaining)
                        .await?
                }
                Err(error) => return Err(error),
            };
            let mut incomplete = false;
            let mut pending = None;
            let cut = match causal {
                CausalBasis::Await(watermarks) => {
                    let target = watermarks.required(scope)?;
                    if target <= base.cut.projected_seq {
                        base
                    } else if query.is_none() {
                        // A structural snapshot has no partial-page flag.
                        self.wait_for_cut(scope, target, &ctx.budget, ctx.budget.remaining)
                            .await?
                    } else {
                        let wait = (ctx.budget.remaining / 2).min(Duration::from_millis(50));
                        match self.wait_for_cut(scope, target, &ctx.budget, wait).await {
                            Ok(cut) => cut,
                            Err(PortError::DeadlineExceeded(_)) => {
                                let cut = self
                                    .wait_for_cut(
                                        scope,
                                        SpaceSeq::ZERO,
                                        &ctx.budget,
                                        ctx.budget.remaining,
                                    )
                                    .await?;
                                incomplete = cut.cut.projected_seq < target;
                                cut
                            }
                            Err(error) => return Err(error),
                        }
                    }
                }
                CausalBasis::Exact(receipts) => {
                    let required = receipts
                        .for_scope(scope)?
                        .into_iter()
                        .map(|receipt| receipt.seq())
                        .max()
                        .unwrap_or(SpaceSeq::ZERO);
                    if required <= base.cut.projected_seq {
                        base
                    } else if apply_overlay {
                        let wait = (ctx.budget.remaining / 4).min(Duration::from_millis(15));
                        match self.wait_for_cut(scope, required, &ctx.budget, wait).await {
                            Ok(cut) => cut,
                            Err(PortError::DeadlineExceeded(_)) => {
                                let cut = self
                                    .wait_for_cut(
                                        scope,
                                        SpaceSeq::ZERO,
                                        &ctx.budget,
                                        ctx.budget.remaining,
                                    )
                                    .await?;
                                if cut.cut.projected_seq < required {
                                    pending = Some(receipts);
                                }
                                cut
                            }
                            Err(error) => return Err(error),
                        }
                    } else {
                        self.wait_for_cut(scope, required, &ctx.budget, ctx.budget.remaining)
                            .await?
                    }
                }
            };
            let (selections, overlay) = if let Some(receipts) = pending {
                if let Some(query) = query {
                    let permit = cut.live.try_read()?;
                    match query {
                        RetainedQuery::Notes(notes) => {
                            authorize_notes(&permit, ctx, &cut.root_folder_id, notes)?;
                        }
                        RetainedQuery::View(view) => ensure_active(&permit, ctx, &view.view.note)?,
                    }
                }
                match self.try_exact(ctx, &cut, receipts).await {
                    Ok(Some(overlay)) => overlay,
                    Ok(None) => {
                        apply_overlay = false;
                        continue;
                    }
                    Err(error) if registration_gap(&error) => {
                        apply_overlay = false;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            } else {
                (Vec::new(), BTreeMap::new())
            };
            return Ok(ChosenRead {
                cut,
                incomplete,
                selections,
                overlay,
            });
        }
    }

    async fn try_exact(
        &self,
        ctx: &SpaceContext,
        base: &PublishedCut,
        receipts: &ReceiptSet,
    ) -> Result<Option<(Vec<ProjectionOverlaySelection>, BTreeMap<u32, ExactRow>)>, PortError> {
        let scope = &base.cut.scope;
        let projection = self.projection_context_for(ctx);
        let mut pending = receipts.clone();
        pending.discard_caught_up(scope, base.cut.projected_seq);
        let effects = self
            .canonical
            .resolve_projection_receipt_effects(&projection, scope, &pending)
            .await?;
        let OverlayDecision::Bounded { versions } =
            plan_overlay(scope, base.cut.projected_seq, &pending, &effects, 64 * 1024)?
        else {
            return Ok(None);
        };
        let selections = versions.into_iter().map(|version| {
            let receipt = effects.iter()
                .filter(|fact| matches!(&fact.effect, MutationEffect::Notes { versions, .. } if versions.contains(&version)))
                .max_by_key(|fact| fact.receipt.seq())
                .ok_or_else(not_ready)?.receipt.clone();
            Ok(ProjectionOverlaySelection { version, receipt })
        }).collect::<Result<Vec<_>, PortError>>()?;
        let Some(notes) = self
            .canonical
            .read_projection_overlay_notes(&projection, scope, base.cut.projected_seq, &selections)
            .await?
        else {
            return Ok(None);
        };
        let index = self.open_index_async(base).await?;
        let mut overlays = BTreeMap::new();
        for (ordinal, note) in notes.into_iter().enumerate() {
            let cutoff = note.receipt.seq();
            let folder = &note.note.metadata.parent_folder_id;
            let Some(location) = self.try_location(base, folder).await? else {
                return Ok(None);
            };
            let dense = index
                .dense_id(&note.note.metadata.note_id)
                .unwrap_or_else(|| u32::MAX - ordinal as u32);
            if dense < index.node_count()
                && index.note_id_str(dense) != Some(note.note.metadata.note_id.as_str())
            {
                return Ok(None);
            }
            let source = self
                .canonical
                .read_projection_note_carrier(&projection, scope, cutoff, &note.note)
                .await?;
            let projected = records::project_note(
                scope,
                note.note,
                dense,
                &location,
                source.as_deref(),
                &base.fields,
            )?;
            let ranks = note
                .ranks
                .into_iter()
                .map(|rank| records::rank_row(scope, rank))
                .collect::<Result<Vec<_>, _>>()?;
            overlays.insert(
                dense,
                ExactRow {
                    note: projected.row,
                    location,
                    ranks,
                },
            );
        }
        Ok(Some((selections, overlays)))
    }

    async fn try_location(
        &self,
        cut: &PublishedCut,
        folder: &FolderId,
    ) -> Result<Option<records::FolderLocation>, PortError> {
        cut.try_location_at(cut.cut.projected_seq, folder).await
    }

    async fn open_read(
        &self,
        ctx: &SpaceContext,
        query: RetainedQuery,
        causal: &CausalBasis,
    ) -> Result<Arc<ReadState>, PortError> {
        let ChosenRead {
            cut,
            incomplete,
            selections,
            overlay,
        } = self.choose_read(ctx, causal, Some(&query)).await?;
        let schema_revision = cut.watermark.schema.as_ref().map(|schema| &schema.revision);
        let (fingerprint, prepared_view) = match &query {
            RetainedQuery::Notes(query) => {
                let permit = cut.live.try_read()?;
                authorize_notes(&permit, ctx, &cut.root_folder_id, query)?;
                (
                    query::plan_notes(query, schema_revision, &cut.fields)?,
                    None,
                )
            }
            RetainedQuery::View(query) => {
                let (row, descriptor) = self.load_view(ctx, &cut, &query.view, &overlay).await?;
                let plan = query::plan_view(
                    &descriptor,
                    query,
                    &row.rev_id,
                    schema_revision,
                    &cut.fields,
                )?;
                let folder = self
                    .resolve_view_folder(&cut, &row, &descriptor.source)
                    .await?;
                (
                    plan.fingerprint,
                    Some(PreparedView {
                        source: descriptor.source,
                        board: descriptor.kind == ViewKind::Board,
                        columns: if descriptor.kind == ViewKind::Board
                            && plan.group_by == descriptor.group_by
                        {
                            descriptor.columns
                        } else {
                            Vec::new()
                        },
                        plan,
                        folder,
                    }),
                )
            }
        };
        let owned_bytes = retention::page_bytes(&query, prepared_view.as_ref(), &overlay);
        let mut snapshot = cut.cut.clone();
        snapshot.canonical_seq = cut.live.try_read()?.head();
        Ok(Arc::new(ReadState {
            read: EffectiveRead {
                id: EffectiveReadId::from_bytes(csprng_16()?),
                cut: snapshot,
                fingerprint,
                exact_receipts: match causal {
                    CausalBasis::Await(_) => ReceiptSet::default(),
                    CausalBasis::Exact(receipts) => receipts.clone(),
                },
                overlay: selections
                    .into_iter()
                    .map(|selection| selection.version)
                    .collect(),
            },
            cut,
            query,
            overlay,
            authority: authority_fingerprint(ctx)?,
            principal_kind: ctx.auth().kind().clone(),
            incomplete,
            credential: ctx.auth().credential().cloned(),
            prepared_view,
            owned_bytes,
            expires: Instant::now()
                .checked_add(self.reads.lifetime)
                .ok_or_else(not_ready)?,
        }))
    }

    pub(super) async fn load_view(
        &self,
        ctx: &SpaceContext,
        cut: &PublishedCut,
        view: &ViewRef,
        overlay: &BTreeMap<u32, ExactRow>,
    ) -> Result<(ProjectedNote, NotaDescriptor), PortError> {
        ensure_active(&cut.live.try_read()?, ctx, &view.note)?;
        if let Some(row) = overlay.values().find(|row| row.note.note_id == view.note) {
            self.authorize_recorded_view(ctx, cut, &row.note).await?;
            let blocks = records::decode::<Vec<_>>(&row.note.view_blocks_msgpack)?;
            let compiled = compile_projected_views(&blocks, &cut.fields);
            return Ok((row.note.clone(), compiled.get(&view.key)?.clone()));
        }
        let row = cut
            .store
            .note_by_id(ctx.scope(), cut.cut.projected_seq, &view.note)
            .await?
            .filter(|row| {
                row.doc_class != DocClass::EncryptedNote && row.lifecycle == Lifecycle::Active
            })
            .ok_or(DomainError::ResourceNotFound)?;
        self.authorize_recorded_view(ctx, cut, &row).await?;
        if let Some(descriptor) = cut
            .store
            .view_descriptor(ctx.scope(), cut.cut.projected_seq, view)
            .await?
        {
            if descriptor.view_note_rev_id != row.rev_id {
                return Err(stale());
            }
            if let Some(compiled) = descriptor.compiled_msgpack {
                return Ok((row, records::decode(&compiled)?));
            }
            let diagnostics: Vec<Diagnostic> = records::decode(&descriptor.diagnostics_msgpack)?;
            return Err(DomainError::validation(
                diagnostics
                    .first()
                    .map_or(ValidationReason::InvalidView, |diagnostic| {
                        diagnostic.reason
                    }),
            )
            .into());
        }
        if row.has_pending_nota {
            return Err(DomainError::validation(ValidationReason::PendingView).into());
        }
        if row.has_invalid_nota {
            return Err(DomainError::validation(ValidationReason::InvalidView).into());
        }
        Err(DomainError::ResourceNotFound.into())
    }

    async fn authorize_recorded_view(
        &self,
        ctx: &SpaceContext,
        cut: &PublishedCut,
        row: &ProjectedNote,
    ) -> Result<(), PortError> {
        if row.lifecycle != Lifecycle::Active || row.doc_class == DocClass::EncryptedNote {
            return Err(DomainError::ResourceNotFound.into());
        }
        let location = self
            .try_location(cut, &row.parent_folder_id)
            .await?
            .ok_or(DomainError::ResourceNotFound)?;
        if location.trashed || !recorded_visible(&cut.live.try_read()?, ctx, row, &location) {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(())
    }

    pub(super) async fn resolve_view_folder(
        &self,
        cut: &PublishedCut,
        view: &ProjectedNote,
        source: &ViewSource,
    ) -> Result<Option<FolderId>, PortError> {
        self.resolve_view_folder_at(cut, cut.cut.projected_seq, view, source)
            .await
    }

    pub(super) async fn resolve_view_folder_at(
        &self,
        cut: &PublishedCut,
        seq: SpaceSeq,
        view: &ProjectedNote,
        source: &ViewSource,
    ) -> Result<Option<FolderId>, PortError> {
        let mut requested = None;
        if let Some(SourceFolder::Path(path)) = &source.folder {
            let path = query::normalized_source_path(path);
            requested = cut
                .store
                .folder_by_path(&cut.cut.scope, seq, &path)
                .await?
                .map(|row| row.folder_id);
        }
        let project = if matches!(source.scope, crate::nota::SourceScope::Project) {
            cut.try_location_at(seq, &view.parent_folder_id)
                .await?
                .and_then(|location| location.project)
        } else {
            None
        };
        Ok(query::resolve_source_folder(
            source,
            &cut.root_folder_id,
            project.as_ref(),
            |_| requested,
        )?)
    }

    async fn view_page(
        &self,
        ctx: &SpaceContext,
        state: &ReadState,
        request: &ViewQuery,
        after: Option<&KeysetCursor>,
    ) -> Result<ViewResult, PortError> {
        let cut = &state.cut;
        let PreparedView {
            source,
            columns,
            board,
            plan,
            folder,
        } = state.prepared_view.as_ref().ok_or_else(stale)?;
        let index = self
            .open_index_async(cut)
            .await
            .map_err(|error| if after.is_some() { stale() } else { error })?;
        let (mut candidates, head) = {
            let permit = cut.live.try_read()?;
            let entry = query::view_authorization_folder(source, folder.as_ref());
            authorize_query(&permit, ctx, &cut.root_folder_id, entry, true)?;
            let universe = query::structural_universe(&index, permit.space(), ctx.auth())?;
            let candidates =
                query::view_source_candidates(&index, source, folder.as_ref(), universe)?;
            let (candidates, permit) = current_bitmap(
                &index,
                cut,
                ctx,
                permit,
                candidates,
                LifecycleMask::Active,
                true,
            )
            .await?;
            (candidates, permit.head())
        };
        let mut exact = BTreeMap::new();
        for (id, row) in &state.overlay {
            let location = &row.location;
            let inline = records::decode::<Vec<String>>(&row.note.tags_msgpack)?;
            let raw = records::note_raw_fields(&row.note)?;
            let tags = records::effective_tags(&inline, raw.as_ref())
                .into_iter()
                .collect();
            let source = query::source_matches(
                source,
                folder.as_ref(),
                &row.note.parent_folder_id,
                &location.ids,
                row.note.doc_class,
                &tags,
            );
            let permit = cut.live.try_read()?;
            let live = matches!(
                permit.classify(ctx, &row.note.note_id, true)?,
                LiveNoteStatus::ActiveVisible(_)
            );
            candidates.remove(*id);
            if source
                && live
                && row.note.lifecycle == Lifecycle::Active
                && !location.trashed
                && recorded_visible(&permit, ctx, &row.note, location)
            {
                candidates.add(*id);
            }
            exact.insert(*id, row.note.clone());
        }
        let mut ranks = BTreeMap::new();
        if *board && !candidates.is_empty() {
            for (id, row) in &state.overlay {
                if let Some(rank) = row.ranks.iter().find(|rank| {
                    rank.view_note_id == request.view.note && rank.view_key == request.view.key
                }) {
                    ranks.insert(
                        *id,
                        BoardRank {
                            group: rank.group_key()?,
                            rank: rank.sort_rank_lexo.clone(),
                        },
                    );
                }
            }
        }
        let selection = query::select_view_window(
            WindowInput {
                index: &index,
                store: &cut.store,
                scope: ctx.scope(),
                cut: cut.cut.projected_seq,
                candidates: &candidates,
                filter: &plan.filter,
                sort: &plan.sort,
                group_by: plan.group_by.as_deref(),
                columns,
                board: *board,
                ranks: &ranks,
                overlay: &exact,
                after: after.map(|cursor| &cursor.last),
                limit: request.limit,
            },
            (*board).then_some(&request.view),
            index.tags_bucketed().then_some(&source.tags),
        )
        .await?;
        let ids = selection
            .rows
            .iter()
            .map(|row| row.dense_id)
            .collect::<Vec<_>>();
        let cards = self
            .hydrate_cards_at(ctx, cut, &ids, &exact, Some(head))
            .await?;
        let next = next_cursor(state, selection.has_more, &selection.rows);
        let permit = cut.live.try_read()?;
        ensure_active_head(&permit, head)?;
        ensure_active(&permit, ctx, &request.view.note)?;
        let rows = cards
            .into_iter()
            .zip(selection.rows)
            .filter_map(|(card, row)| {
                card.map(|card| ViewRow {
                    card,
                    group: row.group,
                    rank: row.rank,
                })
            })
            .collect();
        Ok(ViewResult {
            rows: cursor_page(state, head, rows, next),
            groups: selection.groups,
            effective_read: state.read.id.clone(),
        })
    }

    async fn project_counts(
        &self,
        ctx: SpaceContext,
        project: FolderRef,
        causal: CausalBasis,
    ) -> Result<ProjectNoteCounts, PortError> {
        const PROJECT_COUNTS_WAIT_CAP: Duration = Duration::from_millis(250);
        const MAX_FALLBACK_TAG_SCAN_NOTES: usize = 1_000;
        if project.space_id != ctx.scope().space_id {
            return Err(DomainError::ResourceNotFound.into());
        }
        within_budget(&ctx, async {
            if !ctx.auth().spaces().contains_key(&ctx.scope().space_id) {
                return Err(DomainError::ResourceNotFound.into());
            }
            let required = match &causal {
                CausalBasis::Await(watermarks) => watermarks.required(ctx.scope())?,
                CausalBasis::Exact(receipts) => receipts
                    .for_scope(ctx.scope())?
                    .into_iter()
                    .map(|receipt| receipt.seq())
                    .max()
                    .unwrap_or(SpaceSeq::ZERO),
            };
            let grace_wait = (ctx.budget.remaining / 4).min(PROJECT_COUNTS_WAIT_CAP);
            for attempt in 0..3 {
                let attempt_result: Result<ProjectNoteCounts, PortError> = async {
                    let initial = match self.published_cut(ctx.scope()) {
                        Ok(cut) => cut,
                        Err(error) if registration_gap(&error) => match self
                            .wait_for_cut(ctx.scope(), SpaceSeq::ZERO, &ctx.budget, grace_wait)
                            .await
                        {
                            Ok(cut) => cut,
                            Err(PortError::DeadlineExceeded(_)) => return Err(not_ready()),
                            Err(error) => return Err(error),
                        },
                        Err(error) => return Err(error),
                    };
                    let head = {
                        let permit = initial.live.read(&ctx.budget).await?;
                        authorize_entry(&permit, &ctx, &project.folder_id)?;
                        permit.head()
                    };
                    let target = head.max(required);
                    // Moving a subtree can change thousands of memberships at once. Wait
                    // within a bounded grace window for the current cut, then degrade
                    // promptly to `NotReady` when the projector is lagging.
                    let cut = if initial.cut.projected_seq >= target {
                        initial
                    } else {
                        match self
                            .wait_for_cut(ctx.scope(), target, &ctx.budget, grace_wait)
                            .await
                        {
                            Ok(cut) => cut,
                            Err(PortError::DeadlineExceeded(_)) => return Err(not_ready()),
                            Err(error) => return Err(error),
                        }
                    };
                    let seq = cut.cut.projected_seq;
                    let folder = cut
                        .store
                        .folder_by_id(ctx.scope(), seq, &project.folder_id)
                        .await?
                        .filter(|row| row.is_project)
                        .ok_or(DomainError::ResourceNotFound)?;
                    let path = folder
                        .norm_path_prefix
                        .ok_or(DomainError::ResourceNotFound)?;
                    let index = self.open_index_async(&cut).await?;
                    let mut members = query::folder_notes(&index, &project.folder_id, true)?;
                    for nested in cut
                        .store
                        .active_descendants_of_kind(
                            ctx.scope(),
                            seq,
                            &project.folder_id,
                            &path,
                            true,
                        )
                        .await?
                    {
                        members.andnot_inplace(&query::folder_notes(&index, &nested, true)?);
                    }
                    {
                        let permit = cut.live.read(&ctx.budget).await?;
                        ensure_active_head(&permit, seq)?;
                        authorize_entry(&permit, &ctx, &project.folder_id)?;
                        members.and_inplace(&query::note_universe(
                            &index,
                            permit.space(),
                            ctx.auth(),
                            LifecycleMask::Active,
                        )?);
                    }
                    let mut counts = BTreeMap::new();
                    for class in DocClass::all() {
                        let rows = index
                            .posting(&PostingKey::DocClass(class))
                            .map_err(super::checkpoint_error)?;
                        let n = members.and_cardinality(&rows);
                        if n > 0 {
                            counts.insert(class, n);
                        }
                    }
                    let memory = index
                        .posting(&PostingKey::DocClass(DocClass::AgentMemory))
                        .map_err(super::checkpoint_error)?;
                    let encrypted = index
                        .posting(&PostingKey::Encrypted)
                        .map_err(super::checkpoint_error)?;
                    members.andnot_inplace(&encrypted);
                    let indexed_tags = index
                        .visible_tags(&members, MAX_PROJECT_BOOTSTRAP_VALUES)
                        .map_err(super::checkpoint_error)?;
                    let mut tags = BTreeSet::new();
                    let mut categories = BTreeSet::new();
                    let memory_members = &members & &memory;
                    let mut scanned_memory = 0usize;
                    for page in query::dense_pages(&memory_members) {
                        if scanned_memory >= MAX_FALLBACK_TAG_SCAN_NOTES {
                            break;
                        }
                        scanned_memory += page.len();
                        for row in cut
                            .store
                            .hydrate_list_rows(ctx.scope(), seq, &page)
                            .await?
                            .into_iter()
                            .flatten()
                        {
                            if indexed_tags.is_none() {
                                for tag in row.tags {
                                    remember_value(&mut tags, tag);
                                }
                            }
                            if let Some(category) = row.slug.strip_prefix("memory-") {
                                remember_value(&mut categories, category.to_owned());
                            }
                        }
                    }
                    if indexed_tags.is_none() {
                        members.andnot_inplace(&memory_members);
                        let mut scanned = 0usize;
                        for page in query::dense_pages(&members) {
                            if scanned >= MAX_FALLBACK_TAG_SCAN_NOTES {
                                break;
                            }
                            scanned += page.len();
                            for row in cut
                                .store
                                .hydrate_list_rows(ctx.scope(), seq, &page)
                                .await?
                                .into_iter()
                                .flatten()
                            {
                                for tag in row.tags {
                                    remember_value(&mut tags, tag);
                                }
                            }
                        }
                    }
                    let permit = cut.live.read(&ctx.budget).await?;
                    ensure_active_head(&permit, seq)?;
                    authorize_entry(&permit, &ctx, &project.folder_id)?;
                    let _generation = self.current_admission(cut.cut.generation)?;
                    Ok(ProjectNoteCounts {
                        project: project.clone(),
                        cut: SnapshotCut {
                            canonical_seq: seq,
                            ..cut.cut.clone()
                        },
                        counts,
                        known_tags: indexed_tags.unwrap_or_else(|| tags.into_iter().collect()),
                        known_categories: categories.into_iter().collect(),
                    })
                }
                .await;
                match attempt_result {
                    Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                        if attempt < 2
                            && matches!(
                                diagnostic.reason,
                                ValidationReason::CursorStale
                                    | ValidationReason::GenerationMismatch
                            ) =>
                    {
                        continue;
                    }
                    result => return result,
                }
            }
            Err(stale())
        })
        .await
    }

    async fn notes_page(
        &self,
        ctx: &SpaceContext,
        state: &ReadState,
        query: &NoteQuery,
        after: Option<&KeysetCursor>,
    ) -> Result<FolderPage, PortError> {
        let cut = &state.cut;
        let index = self
            .open_index_async(cut)
            .await
            .map_err(|error| if after.is_some() { stale() } else { error })?;
        let (mut candidates, head, entry) = {
            let permit = cut.live.try_read()?;
            let entry = authorize_notes(&permit, ctx, &cut.root_folder_id, query)?;
            let universe =
                query::note_universe(&index, permit.space(), ctx.auth(), query.lifecycle)?;
            let candidates = query::note_source_candidates(&index, query, &entry, universe)?;
            let (candidates, permit) =
                current_bitmap(&index, cut, ctx, permit, candidates, query.lifecycle, false)
                    .await?;
            (candidates, permit.head(), entry)
        };
        let cover_note = cut
            .store
            .folder_by_id(ctx.scope(), cut.cut.projected_seq, &entry)
            .await?
            .and_then(|folder| folder.cover_note_id);
        if let Some(id) = cover_note.as_ref().and_then(|note| index.dense_id(note)) {
            candidates.remove(id);
        }
        let tags: BTreeSet<_> = query.tag.iter().cloned().collect();
        let mut exact = BTreeMap::new();
        for (id, row) in &state.overlay {
            let location = &row.location;
            let permit = cut.live.try_read()?;
            let live =
                current_facts(&permit, ctx, &row.note.note_id, query.lifecycle, false)?.is_some();
            let effective = if location.trashed {
                Lifecycle::Trashed
            } else {
                row.note.lifecycle
            };
            candidates.remove(*id);
            let folder_match = match &query.folder {
                Some(folder) => {
                    folder == &row.note.parent_folder_id
                        || (query.recursive && location.ids.contains(folder))
                }
                None => query.recursive || entry == row.note.parent_folder_id,
            };
            if live
                && recorded_visible(&permit, ctx, &row.note, location)
                && query.lifecycle.includes(effective)
                && query.classes.contains(&row.note.doc_class)
                && folder_match
                && Some(&row.note.note_id) != cover_note.as_ref()
                && (tags.is_empty() || tags.is_subset(&row_tags(&row.note)?.into_iter().collect()))
            {
                candidates.add(*id);
            }
            exact.insert(*id, row.note.clone());
        }
        let selection = query::select_view_window(
            WindowInput {
                index: &index,
                store: &cut.store,
                scope: ctx.scope(),
                cut: cut.cut.projected_seq,
                candidates: &candidates,
                filter: &query.filter.predicate,
                sort: &query.sort,
                group_by: None,
                columns: &[],
                board: false,
                ranks: &BTreeMap::new(),
                overlay: &exact,
                after: after.map(|cursor| &cursor.last),
                limit: query.limit,
            },
            None,
            index.tags_bucketed().then_some(&tags),
        )
        .await?;
        let ids = selection
            .rows
            .iter()
            .map(|row| row.dense_id)
            .collect::<Vec<_>>();
        let planned = self.hydration_list_plan(ctx, cut, &ids, &exact).await?;
        let page = if let Some(cover_id) = cover_note {
            let cover_row = exact.values().find(|row| row.note_id == cover_id).cloned();
            let cover_row = match cover_row {
                Some(row) => Some(row),
                None => {
                    cut.store
                        .note_by_id(ctx.scope(), cut.cut.projected_seq, &cover_id)
                        .await?
                }
            };
            let cover_live_active = {
                let permit = cut.live.try_read()?;
                current_facts(&permit, ctx, &cover_id, LifecycleMask::Active, false)?.is_some()
            };
            if cover_live_active
                && let Some(row) = cover_row.filter(|row| row.lifecycle == Lifecycle::Active)
            {
                match self
                    .canonical
                    .get_note(
                        ctx.clone(),
                        GetNote {
                            note: cover_id,
                            revision: Some(row.rev_id),
                            causal: CausalBasis::Await(Default::default()),
                        },
                    )
                    .await
                {
                    Ok(snapshot) => Some(snapshot),
                    Err(PortError::Domain(
                        DomainError::ResourceNotFound
                        | DomainError::AccessDenied
                        | DomainError::CrossSpaceTainted,
                    )) => None,
                    Err(error) => return Err(error),
                }
            } else {
                None
            }
        } else {
            None
        };
        let next = next_cursor(state, selection.has_more, &selection.rows);
        #[cfg(any(test, feature = "test-support"))]
        if page.is_some() {
            pause_after_read_payload(cut, ctx).await;
        }
        let permit = cut.live.try_read()?;
        ensure_active_head(&permit, head)?;
        let mut rows = Vec::new();
        for planned in planned.into_iter().flatten() {
            if let Some((metadata, path, row)) =
                planned.admit(&permit, ctx, query.lifecycle, false)?
                && let Ok(document) = metadata.listing(ctx.auth())
            {
                rows.push(NoteListCard {
                    document,
                    title: row.title,
                    tags: row.tags,
                    view_type: row.view_type,
                    path,
                });
            }
        }
        Ok(FolderPage {
            folder: FolderRef {
                space_id: ctx.scope().space_id.clone(),
                folder_id: entry,
            },
            page,
            children: cursor_page(state, head, rows, next),
            total: selection.total,
        })
    }

    async fn load_folder_catalog(
        &self,
        scope: &HistoryScope,
        cut: &PublishedCut,
        mut pending: BTreeSet<FolderId>,
    ) -> Result<records::FolderCatalog, PortError> {
        let mut folders = records::FolderCatalog::default();
        for _ in 0..=MAX_FOLDER_DEPTH {
            if pending.is_empty() {
                break;
            }
            let ids = std::mem::take(&mut pending).into_iter().collect::<Vec<_>>();
            for batch in ids.chunks(200) {
                let loaded = cut
                    .store
                    .hydrate_folders(scope, cut.cut.projected_seq, batch)
                    .await?;
                if loaded.len() != batch.len() {
                    return Err(stale());
                }
                for (id, folder) in loaded {
                    if let Some(parent) = folder
                        .parent_folder_id
                        .as_ref()
                        .filter(|parent| !folders.rows.contains_key(*parent))
                    {
                        pending.insert(parent.clone());
                    }
                    folders.rows.insert(id, folder);
                }
            }
            pending.retain(|id| !folders.rows.contains_key(id));
        }
        Ok(folders)
    }

    async fn hydration_list_plan(
        &self,
        ctx: &SpaceContext,
        cut: &PublishedCut,
        ids: &[u32],
        overlay: &BTreeMap<u32, ProjectedNote>,
    ) -> Result<Vec<Option<ListCardPlan>>, PortError> {
        let scope = ctx.scope();
        let mut rows = cut
            .store
            .hydrate_list_rows(scope, cut.cut.projected_seq, ids)
            .await?;
        for (slot, dense) in rows.iter_mut().zip(ids) {
            if let Some(row) = overlay.get(dense) {
                *slot = Some(ListCardRow {
                    space_id: row.space_id.clone(),
                    note_id: row.note_id.clone(),
                    rev_id: row.rev_id.clone(),
                    parent_folder_id: row.parent_folder_id.clone(),
                    ability_id: row.ability_id.clone(),
                    doc_class: row.doc_class,
                    lifecycle: row.lifecycle,
                    content_digest: row.content_digest,
                    title: row.title.clone(),
                    slug: row.slug.clone(),
                    tags: row_tags(row)?,
                    view_type: crate::nota::first_view_type(&row.view_blocks_msgpack)?,
                });
            }
        }
        let pending = rows
            .iter()
            .flatten()
            .map(|row| row.parent_folder_id.clone())
            .collect::<BTreeSet<_>>();
        let folders = self.load_folder_catalog(scope, cut, pending).await?;
        rows.into_iter()
            .map(|row| {
                row.map(|row| {
                    let location = folders.location(&row.parent_folder_id)?;
                    Ok(ListCardPlan { row, location })
                })
                .transpose()
            })
            .collect()
    }

    async fn hydration_plan(
        &self,
        ctx: &SpaceContext,
        cut: &PublishedCut,
        ids: &[u32],
        overlay: &BTreeMap<u32, ProjectedNote>,
    ) -> Result<Vec<Option<CardPlan>>, PortError> {
        let scope = ctx.scope();
        let mut rows = cut.store.hydrate(scope, cut.cut.projected_seq, ids).await?;
        for (slot, dense) in rows.iter_mut().zip(ids) {
            if let Some(row) = overlay.get(dense) {
                *slot = Some(row.clone());
            }
        }
        let pending = rows
            .iter()
            .flatten()
            .map(|row| row.parent_folder_id.clone())
            .collect::<BTreeSet<_>>();
        let folders = self.load_folder_catalog(scope, cut, pending).await?;
        rows.into_iter()
            .map(|row| {
                row.map(|row| {
                    let location = folders.location(&row.parent_folder_id)?;
                    Ok(CardPlan { row, location })
                })
                .transpose()
            })
            .collect()
    }

    pub(super) async fn hydrate_cards_at(
        &self,
        ctx: &SpaceContext,
        cut: &PublishedCut,
        ids: &[u32],
        overlay: &BTreeMap<u32, ProjectedNote>,
        require_head: Option<SpaceSeq>,
    ) -> Result<Vec<Option<NoteCard>>, PortError> {
        let fast_head_match = overlay.is_empty()
            && match require_head {
                Some(head) => head == cut.cut.projected_seq,
                None => cut
                    .live
                    .try_read()
                    .ok()
                    .is_some_and(|permit| permit.head() == cut.cut.projected_seq),
            };
        if fast_head_match
            && let Some(cards) = cut
                .store
                .hydrate_current_cards(ctx.scope(), cut.cut.projected_seq, ids)
                .await?
        {
            let permit = cut.live.read(&ctx.budget).await?;
            if let Some(expected_head) = require_head {
                ensure_active_head(&permit, expected_head)?;
            } else if permit.space().lifecycle != SpaceLifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }
            // Only substitute live facts as `recorded` when the live head still
            // equals `cut.cut.projected_seq`; otherwise fall through to the
            // historical `hydration_plan` path so `recorded` facts are verified.
            if permit.head() == cut.cut.projected_seq {
                return cards
                    .into_iter()
                    .map(|card| {
                        let Some(card) = card else {
                            return Ok(None);
                        };
                        let LiveNoteStatus::ActiveVisible(facts) =
                            permit.classify(ctx, &card.note, true)?
                        else {
                            return Ok(None);
                        };
                        if card.class != facts.class || card.lifecycle != Lifecycle::Active {
                            return Err(stale());
                        }
                        let metadata = ClassifiedMetadata::from_canonical(
                            NoteRef {
                                space_id: ctx.scope().space_id.clone(),
                                note_id: card.note,
                            },
                            card.revision,
                            facts,
                            Lifecycle::Active,
                            card.digest,
                        )?;
                        Ok(ClassEgressFence::search_metadata(metadata, ctx.auth())
                            .ok()
                            .map(|document| NoteCard {
                                document,
                                title: card.title,
                                path: card.path,
                                preview: card.preview,
                            }))
                    })
                    .collect();
            }
        }
        let planned = self.hydration_plan(ctx, cut, ids, overlay).await?;
        let permit = cut.live.read(&ctx.budget).await?;
        if let Some(expected_head) = require_head {
            ensure_active_head(&permit, expected_head)?;
        } else if permit.space().lifecycle != SpaceLifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        planned
            .into_iter()
            .map(|plan| {
                let Some(plan) = plan else {
                    return Ok(None);
                };
                let Some((metadata, path, row)) =
                    plan.admit(&permit, ctx, LifecycleMask::Active, true)?
                else {
                    return Ok(None);
                };
                Ok(ClassEgressFence::search_metadata(metadata, ctx.auth())
                    .ok()
                    .map(|document| NoteCard {
                        document,
                        title: row.title,
                        path,
                        preview: row.preview,
                    }))
            })
            .collect()
    }
}

struct ListCardPlan {
    row: ListCardRow,
    location: records::FolderLocation,
}

impl ListCardPlan {
    fn admit(
        self,
        permit: &LiveReadPermit,
        ctx: &SpaceContext,
        mask: LifecycleMask,
        plain: bool,
    ) -> Result<Option<(ClassifiedMetadata, String, ListCardRow)>, PortError> {
        let Some((current, live_cycle)) =
            current_facts(permit, ctx, &self.row.note_id, mask, plain)?
        else {
            return Ok(None);
        };
        let Some(digest) = self.row.content_digest else {
            return Ok(None);
        };
        let recorded = ResourceFacts {
            space: permit.space().clone(),
            class: self.row.doc_class,
            project: self.location.project,
            ancestor_folders: self.location.ids,
            folder_write_locked: self.location.write_locked,
            ability_package: self.row.ability_id.clone(),
        };
        let lifecycle = if self.location.trashed {
            Lifecycle::Trashed
        } else {
            self.row.lifecycle
        };
        if !mask.includes(lifecycle) || (plain && recorded.class == DocClass::EncryptedNote) {
            return Ok(None);
        }
        let mut metadata = ClassifiedMetadata::from_canonical(
            NoteRef {
                space_id: self.row.space_id.clone(),
                note_id: self.row.note_id.clone(),
            },
            self.row.rev_id.clone(),
            recorded,
            lifecycle,
            digest,
        )?;
        if metadata.bind_current(current, live_cycle).is_err() {
            return Ok(None);
        }
        let path = if self.location.display_path.is_empty() {
            format!("{}.md", self.row.slug)
        } else {
            format!("{}/{}.md", self.location.display_path, self.row.slug)
        };
        Ok(Some((metadata, path, self.row)))
    }
}

struct CardPlan {
    row: ProjectedNote,
    location: records::FolderLocation,
}

#[cfg(any(test, feature = "test-support"))]
async fn pause_after_read_payload(cut: &PublishedCut, ctx: &SpaceContext) {
    if let Some(slot) = cut.slot.upgrade() {
        slot.benchmark_pause
            .pause_at(
                super::benchmark::PausePoint::AfterReadPayload,
                None,
                &ctx.budget.cancellation,
            )
            .await;
    }
}

impl CardPlan {
    fn admit(
        self,
        permit: &LiveReadPermit,
        ctx: &SpaceContext,
        mask: LifecycleMask,
        plain: bool,
    ) -> Result<Option<(ClassifiedMetadata, String, ProjectedNote)>, PortError> {
        let Some((current, live_cycle)) =
            current_facts(permit, ctx, &self.row.note_id, mask, plain)?
        else {
            return Ok(None);
        };
        let Some(digest) = self.row.content_digest else {
            return Ok(None);
        };
        let recorded = ResourceFacts {
            space: permit.space().clone(),
            class: self.row.doc_class,
            project: self.location.project,
            ancestor_folders: self.location.ids,
            folder_write_locked: self.location.write_locked,
            ability_package: self.row.ability_id.clone(),
        };
        let lifecycle = if self.location.trashed {
            Lifecycle::Trashed
        } else {
            self.row.lifecycle
        };
        if !mask.includes(lifecycle) || (plain && recorded.class == DocClass::EncryptedNote) {
            return Ok(None);
        }
        let mut metadata = ClassifiedMetadata::from_canonical(
            NoteRef {
                space_id: self.row.space_id.clone(),
                note_id: self.row.note_id.clone(),
            },
            self.row.rev_id.clone(),
            recorded,
            lifecycle,
            digest,
        )?;
        if metadata.bind_current(current, live_cycle).is_err() {
            return Ok(None);
        }
        let path = if self.location.display_path.is_empty() {
            format!("{}.md", self.row.slug)
        } else {
            format!("{}/{}.md", self.location.display_path, self.row.slug)
        };
        Ok(Some((metadata, path, self.row)))
    }
}

fn current_facts(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    note: &NoteId,
    mask: LifecycleMask,
    plain: bool,
) -> Result<Option<(ResourceFacts, Lifecycle)>, PortError> {
    let result = match permit.classify(ctx, note, matches!(mask, LifecycleMask::Active))? {
        LiveNoteStatus::ActiveVisible(facts) => Some((facts, Lifecycle::Active)),
        LiveNoteStatus::TrashedVisible(facts) => Some((facts, Lifecycle::Trashed)),
        LiveNoteStatus::EncryptedVisible {
            facts,
            effective_lifecycle,
        } if !plain => Some((facts, effective_lifecycle)),
        _ => None,
    };
    Ok(result.filter(|(_, lifecycle)| mask.includes(*lifecycle)))
}

fn remember_value(values: &mut BTreeSet<String>, value: String) {
    values.insert(value);
    if values.len() > MAX_PROJECT_BOOTSTRAP_VALUES {
        values.pop_last();
    }
}

fn row_tags(row: &ProjectedNote) -> Result<Vec<String>, PortError> {
    let inline: Vec<String> = records::decode(&row.tags_msgpack)?;
    let raw = records::note_raw_fields(row)?;
    Ok(records::effective_tags(&inline, raw.as_ref()))
}

fn recorded_visible(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    note: &ProjectedNote,
    location: &records::FolderLocation,
) -> bool {
    ctx.auth()
        .can_view_resource(&ResourceFacts {
            space: permit.space().clone(),
            class: note.doc_class,
            project: location.project.clone(),
            ancestor_folders: location.ids.clone(),
            folder_write_locked: location.write_locked,
            ability_package: note.ability_id.clone(),
        })
        .is_ok()
}

pub(super) fn authorize_entry(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    folder: &FolderId,
) -> Result<(), PortError> {
    ctx.check_current(permit.scope())?;
    let facts = permit
        .folder_facts(folder)
        .ok_or(DomainError::ResourceNotFound)?;
    ctx.auth()
        .authorize_folder_read(permit.space(), folder, &facts.ancestor_folders)?;
    Ok(())
}

fn authorize_query(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    root: &FolderId,
    requested: Option<&FolderId>,
    active_only: bool,
) -> Result<FolderId, PortError> {
    let grant = ctx
        .auth()
        .spaces()
        .get(&ctx.scope().space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    let entry = query::entry_folder(grant, root, requested).clone();
    ctx.check_current(permit.scope())?;
    let facts = permit
        .active_folder_facts(&entry, active_only)
        .ok_or(DomainError::ResourceNotFound)?;
    ctx.auth()
        .authorize_folder_read(permit.space(), &entry, &facts.ancestor_folders)?;
    Ok(entry)
}

/// Untainted entry-folder visibility check for probes (`is_live_visible`,
/// `filter_live_visible`) that must not taint cross-space callers before a
/// live note is confirmed visible.
fn can_view_query_entry(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    root: &FolderId,
    requested: Option<&FolderId>,
    active_only: bool,
) -> Result<FolderId, PortError> {
    let grant = ctx
        .auth()
        .spaces()
        .get(&ctx.scope().space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    let entry = query::entry_folder(grant, root, requested).clone();
    ctx.check_current(permit.scope())?;
    let facts = permit
        .active_folder_facts(&entry, active_only)
        .ok_or(DomainError::ResourceNotFound)?;
    ctx.auth()
        .can_view_folder(permit.space(), &entry, &facts.ancestor_folders)?;
    Ok(entry)
}

pub(super) fn ensure_active(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<(), PortError> {
    let LiveNoteStatus::ActiveVisible(facts) = permit.classify(ctx, note, true)? else {
        return Err(DomainError::ResourceNotFound.into());
    };
    ctx.auth().authorize_read(&facts)?;
    Ok(())
}

fn authorize_notes(
    permit: &LiveReadPermit,
    ctx: &SpaceContext,
    root: &FolderId,
    query: &NoteQuery,
) -> Result<FolderId, PortError> {
    authorize_query(
        permit,
        ctx,
        root,
        query.folder.as_ref(),
        matches!(query.lifecycle, LifecycleMask::Active),
    )
}

fn ensure_active_head(permit: &LiveReadPermit, head: SpaceSeq) -> Result<(), PortError> {
    // Catalog lifecycle transitions preserve the command sequence.
    if permit.space().lifecycle != SpaceLifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    if permit.head() != head {
        return Err(stale());
    }
    Ok(())
}

const VISIBILITY_BATCH: usize = 32;

pub(super) async fn current_bitmap(
    index: &IndexView,
    cut: &PublishedCut,
    ctx: &SpaceContext,
    mut permit: LiveReadPermit,
    mut bitmap: Bitmap,
    lifecycle: LifecycleMask,
    plain_only: bool,
) -> Result<(Bitmap, LiveReadPermit), PortError> {
    let head = permit.head();
    if head == cut.cut.projected_seq {
        return Ok((bitmap, permit));
    }
    // Re-seek the bounded journal on each permit. Its range iterator skips
    // the already checked prefix without cloning identities or visiting it.
    let mut offset = 0;
    loop {
        let remaining = {
            let Some(changes) = permit.note_changes_since(cut.cut.projected_seq) else {
                break;
            };
            let remaining = changes.len().saturating_sub(offset);
            for note in changes.skip(offset).take(VISIBILITY_BATCH) {
                if let Some(dense) = index.dense_id(note).filter(|id| bitmap.contains(*id))
                    && current_facts(&permit, ctx, note, lifecycle, plain_only)?.is_none()
                {
                    bitmap.remove(dense);
                }
            }
            remaining
        };
        if remaining <= VISIBILITY_BATCH {
            return Ok((bitmap, permit));
        }
        offset += VISIBILITY_BATCH;
        drop(permit);
        permit = next_visibility_batch(cut, ctx, head).await?;
    }
    let mut allowed = Bitmap::new();
    let mut ids = bitmap_ids(bitmap).peekable();
    loop {
        for dense in ids.by_ref().take(VISIBILITY_BATCH) {
            let note = index.note_id(index.dense(dense))?;
            if current_facts(&permit, ctx, &note, lifecycle, plain_only)?.is_some() {
                allowed.add(dense);
            }
        }
        if ids.peek().is_none() {
            return Ok((allowed, permit));
        }
        drop(permit);
        permit = next_visibility_batch(cut, ctx, head).await?;
    }
}

// Materializing live ancestry is bounded by folder depth per note. No permit
// or borrowed journal iterator remains held while a reader yields to a writer.
async fn next_visibility_batch(
    cut: &PublishedCut,
    ctx: &SpaceContext,
    head: SpaceSeq,
) -> Result<LiveReadPermit, PortError> {
    tokio::task::yield_now().await;
    // The same handle validates its history and lease epoch on each acquisition.
    let permit = cut.live.read(&ctx.budget).await?;
    ctx.check_current(permit.scope())?;
    if permit.space().lifecycle != SpaceLifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    if permit.head() != head {
        return Err(stale());
    }
    Ok(permit)
}

fn cursor_page<T>(
    state: &ReadState,
    canonical_seq: SpaceSeq,
    rows: Vec<T>,
    next: Option<KeysetCursor>,
) -> CursorPage<T> {
    CursorPage {
        items: rows,
        next,
        scope: state.read.cut.scope.clone(),
        canonical_seq,
        projected_seq: state.read.cut.projected_seq,
        incomplete: state.incomplete,
        diagnostics: Vec::new(),
    }
}

fn next_cursor(state: &ReadState, more: bool, rows: &[query::SelectedRow]) -> Option<KeysetCursor> {
    rows.last().filter(|_| more).map(|last| KeysetCursor {
        version: 1,
        scope: state.read.cut.scope.clone(),
        fingerprint: state.read.fingerprint,
        effective_read: state.read.id.clone(),
        generation: state.read.cut.generation,
        base_cut: state.read.cut.projected_seq,
        last: last.tuple.clone(),
    })
}

impl ViewGraphPort for ProjectionEngine {
    fn query_view(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<ViewQuery>,
    ) -> PortFuture<'_, ViewResult> {
        Box::pin(async move {
            within_budget(&ctx, async {
                match request {
                    ReadRequest::Open { query, causal } => {
                        for attempt in 0..3 {
                            let attempt_result: Result<ViewResult, PortError> = async {
                                let state = self
                                    .open_read(&ctx, RetainedQuery::View(query.clone()), &causal)
                                    .await?;
                                let result = self.view_page(&ctx, &state, &query, None).await?;
                                let _admission =
                                    self.current_admission(state.read.cut.generation)?;
                                let _live = state.cut.live.try_read()?;
                                ensure_active_head(&_live, result.rows.canonical_seq)?;
                                if result.rows.next.is_some() {
                                    self.reads.insert(state);
                                }
                                Ok(result)
                            }
                            .await;
                            match attempt_result {
                                Err(error) if attempt < 2 && registration_gap(&error) => continue,
                                result => return result,
                            }
                        }
                        Err(stale())
                    }
                    ReadRequest::Continue { cursor } => {
                        let state = self.reads.get(&cursor, &ctx)?;
                        let RetainedQuery::View(query) = &state.query else {
                            return Err(stale());
                        };
                        let result = self.view_page(&ctx, &state, query, Some(&cursor)).await?;
                        let _live = state.cut.live.try_read()?;
                        ensure_active_head(&_live, result.rows.canonical_seq)?;
                        Ok(result)
                    }
                }
            })
            .await
        })
    }

    fn move_board_card(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveBoardCard>,
    ) -> PortFuture<'_, Committed<BoardMoveResult>> {
        Box::pin(self.canonical.move_board_card(ctx, request))
    }

    fn query_graph(&self, ctx: SpaceContext, request: GraphQuery) -> PortFuture<'_, GraphResult> {
        Box::pin(async move { within_budget(&ctx, self.run_graph(&ctx, request)).await })
    }
}

impl ProjectionEngine {
    pub fn list_notes(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<NoteQuery>,
    ) -> PortFuture<'_, FolderPage> {
        Box::pin(async move {
            within_budget(&ctx, async {
                match request {
                    ReadRequest::Open { query, causal } => {
                        for attempt in 0..3 {
                            let attempt_result: Result<FolderPage, PortError> = async {
                                let state = self
                                    .open_read(&ctx, RetainedQuery::Notes(query.clone()), &causal)
                                    .await?;
                                let result = self.notes_page(&ctx, &state, &query, None).await?;
                                let _admission =
                                    self.current_admission(state.read.cut.generation)?;
                                let _live = state.cut.live.try_read()?;
                                ensure_active_head(&_live, result.children.canonical_seq)?;
                                if result.children.next.is_some() {
                                    self.reads.insert(state);
                                }
                                Ok(result)
                            }
                            .await;
                            match attempt_result {
                                Err(error) if attempt < 2 && registration_gap(&error) => continue,
                                result => return result,
                            }
                        }
                        Err(stale())
                    }
                    ReadRequest::Continue { cursor } => {
                        let state = self.reads.get(&cursor, &ctx)?;
                        let RetainedQuery::Notes(query) = &state.query else {
                            return Err(stale());
                        };
                        let result = self.notes_page(&ctx, &state, query, Some(&cursor)).await?;
                        let _live = state.cut.live.try_read()?;
                        ensure_active_head(&_live, result.children.canonical_seq)?;
                        Ok(result)
                    }
                }
            })
            .await
        })
    }
}

#[derive(Clone)]
pub struct ProjectedNoteReadPort(Arc<ProjectionEngine>);

impl ProjectedNoteReadPort {
    pub fn new(engine: Arc<ProjectionEngine>) -> Self {
        Self(engine)
    }
}

impl NoteReadPort for ProjectedNoteReadPort {
    fn resolve_folder_path(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        path: String,
    ) -> PortFuture<'_, Option<FolderSnapshot>> {
        Box::pin(self.0.canonical.resolve_folder_path(ctx, base, path))
    }

    fn list_child_folders(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        after: Option<FolderId>,
        limit: PageLimit,
    ) -> PortFuture<'_, ChildFolders> {
        Box::pin(self.0.canonical.list_child_folders(ctx, base, after, limit))
    }

    fn resolve_note_target(
        &self,
        ctx: SpaceContext,
        parent: Option<FolderId>,
        target: String,
    ) -> PortFuture<'_, Option<NoteRef>> {
        Box::pin(self.0.canonical.resolve_note_target(ctx, parent, target))
    }

    fn space_schema(&self, ctx: SpaceContext) -> PortFuture<'_, BTreeMap<String, FieldSchema>> {
        Box::pin(self.0.canonical.space_schema(ctx))
    }

    fn project_note_counts(
        &self,
        ctx: SpaceContext,
        project: FolderRef,
        causal: CausalBasis,
    ) -> PortFuture<'_, ProjectNoteCounts> {
        Box::pin(self.0.project_counts(ctx, project, causal))
    }

    fn read_ability_resource(
        &self,
        ctx: SpaceContext,
        request: ReadAbilityResource,
    ) -> PortFuture<'_, notarium_core::classes::ClassifiedAbilityResource> {
        Box::pin(self.0.canonical.read_ability_resource(ctx, request))
    }
    fn get_note(&self, ctx: SpaceContext, request: GetNote) -> PortFuture<'_, NoteSnapshot> {
        Box::pin(self.0.canonical.get_note(ctx, request))
    }
    fn get_note_metadata(
        &self,
        ctx: SpaceContext,
        request: GetNote,
    ) -> PortFuture<'_, NoteMetadataSnapshot> {
        Box::pin(self.0.canonical.get_note_metadata(ctx, request))
    }
    fn list_notes(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<NoteQuery>,
    ) -> PortFuture<'_, FolderPage> {
        self.0.list_notes(ctx, request)
    }
    fn recent_activity(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        Box::pin(self.0.canonical.recent_activity(ctx, request))
    }
    fn read_changes(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        Box::pin(self.0.canonical.read_changes(ctx, request))
    }
}

impl PublishedCut {
    pub(super) async fn try_location_at(
        &self,
        seq: SpaceSeq,
        folder: &FolderId,
    ) -> Result<Option<records::FolderLocation>, PortError> {
        let mut folders = records::FolderCatalog::default();
        let mut next = Some(folder.clone());
        while let Some(id) = next {
            if folders.rows.len() > MAX_FOLDER_DEPTH || folders.rows.contains_key(&id) {
                return Ok(None);
            }
            let Some(row) = self.store.folder_by_id(&self.cut.scope, seq, &id).await? else {
                return Ok(None);
            };
            next = row.parent_folder_id.clone();
            folders.rows.insert(id, row);
        }
        folders.location(folder).map(Some)
    }
}

struct FolderScope {
    ancestors: Vec<FolderId>,
    project: Option<FolderId>,
    descendants: Vec<FolderId>,
}

struct Snapshot {
    cut: SnapshotCut,
    published: Arc<PublishedCut>,
    canonical: notarium_canonical::CanonicalStore,
    authority: ServiceAuthority,
    request_deadline: Instant,
    index: IndexView,
    visible: Bitmap,
    ctx: SpaceContext,
    live: LiveSpaceHandle,
    expires: Instant,
}

impl Snapshot {
    fn remaining(&self) -> Result<Duration, PortError> {
        let now = Instant::now();
        if self.expires <= now {
            return Err(stale());
        }
        let remaining = self
            .request_deadline
            .min(self.expires)
            .saturating_duration_since(now);
        if self.ctx.budget.cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "structural_snapshot",
                "caller cancelled",
            ));
        }
        if remaining.is_zero() {
            return Err(deadline_not_committed(
                "structural_snapshot",
                "caller deadline exhausted",
            ));
        }
        Ok(remaining)
    }

    async fn within_request<T>(
        &self,
        task: impl std::future::Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        let mut ctx = self.ctx.clone();
        ctx.budget.remaining = self.remaining()?;
        let result = within_budget(&ctx, task).await?;
        self.remaining()?;
        Ok(result)
    }

    fn budget(&self) -> Result<CallBudget, PortError> {
        let mut budget = self.ctx.budget.clone();
        budget.remaining = self.remaining()?;
        Ok(budget)
    }

    async fn read_live(&self) -> Result<LiveReadPermit, PortError> {
        self.live.read(&self.budget()?).await
    }

    fn maintenance(&self) -> Result<MaintenanceContext, PortError> {
        Ok(MaintenanceContext {
            authority: self.authority.clone(),
            budget: self.budget()?,
        })
    }

    async fn historical_descendants(&self, folder: &FolderId) -> Result<Vec<FolderId>, PortError> {
        let mut frontier = vec![folder.clone()];
        let mut descendants = BTreeSet::new();
        while !frontier.is_empty() {
            let mut children = Vec::new();
            for parents in frontier.chunks(200) {
                let rows = self
                    .canonical
                    .read_projection_folder_children_at_cut(
                        &self.maintenance()?,
                        &self.cut.scope,
                        self.cut.projected_seq,
                        parents,
                    )
                    .await?;
                for child in rows {
                    if &child == folder || !descendants.insert(child.clone()) {
                        return Err(DomainError::validation(ValidationReason::InvalidState).into());
                    }
                    children.push(child);
                }
            }
            frontier = children;
        }
        Ok(descendants.into_iter().collect())
    }

    async fn folder_scope(
        &self,
        folder: &FolderId,
        include_children: bool,
    ) -> Result<FolderScope, PortError> {
        authorize_entry(&self.read_live().await?, &self.ctx, folder)?;
        if self.index.dense_folder_id(folder).is_none() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let scope = {
            let derived = async {
                let location = self
                    .published
                    .try_location_at(self.cut.projected_seq, folder)
                    .await?
                    .filter(|location| !location.trashed)
                    .ok_or(DomainError::ResourceNotFound)?;
                let descendants = if include_children {
                    self.published
                        .store
                        .active_descendants(
                            &self.cut.scope,
                            self.cut.projected_seq,
                            folder,
                            &location.norm_path,
                        )
                        .await?
                } else {
                    Vec::new()
                };
                Ok(FolderScope {
                    ancestors: location.ids,
                    project: location.project,
                    descendants,
                })
            }
            .await;
            match derived {
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::CursorStale =>
                {
                    let (ancestors, project) = self
                        .canonical
                        .read_projection_folder_ancestry_at_cut(
                            &self.maintenance()?,
                            &self.cut.scope,
                            self.cut.projected_seq,
                            folder,
                        )
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    let descendants = if include_children {
                        self.historical_descendants(folder).await?
                    } else {
                        Vec::new()
                    };
                    FolderScope {
                        ancestors,
                        project,
                        descendants,
                    }
                }
                result => result?,
            }
        };
        let permit = self.read_live().await?;
        authorize_entry(&permit, &self.ctx, folder)?;
        self.ctx
            .auth()
            .can_view_folder(permit.space(), folder, &scope.ancestors)?;
        Ok(scope)
    }

    async fn verify_filter_page(
        &self,
        page: Vec<u32>,
        predicate: &Predicate,
    ) -> Result<Bitmap, PortError> {
        let derived = self
            .published
            .store
            .hydrate_query_rows(&self.cut.scope, self.cut.projected_seq, &page)
            .await;
        match derived {
            Ok(rows) if rows.len() == page.len() => {
                let mut matches = Bitmap::new();
                let mut complete = true;
                for (row, expected) in rows.into_iter().zip(&page) {
                    let Some(row) = row.filter(|row| row.dense_id == *expected) else {
                        complete = false;
                        break;
                    };
                    if predicate.matches(&row.evaluated_fields()?) {
                        matches.add(row.dense_id);
                    }
                }
                if complete {
                    return Ok(matches);
                }
            }
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale => {}
            Err(error) => return Err(error),
            Ok(_) => {}
        }
        let notes = page
            .iter()
            .copied()
            .map(|dense| self.index.note_id(self.index.dense(dense)))
            .collect::<DomainResult<Vec<_>>>()?;
        let rows = self
            .canonical
            .read_projection_note_metadata_batch(
                &self.maintenance()?,
                &self.cut.scope,
                self.cut.projected_seq,
                notes,
            )
            .await?;
        let mut matches = Bitmap::new();
        for (note, row) in rows {
            if predicate.matches(&records::field_observations(&row, &self.published.fields)) {
                matches.add(self.index.dense_id(&note).ok_or_else(stale)?);
            }
        }
        Ok(matches)
    }

    fn live_permit(&self) -> DomainResult<LiveReadPermit> {
        self.live.try_read().map_err(|error| match error {
            PortError::Domain(domain) => domain,
            _ => DomainError::validation(ValidationReason::NotReady),
        })
    }

    fn live_node(&self, id: u32) -> DomainResult<bool> {
        let permit = self.live_permit()?;
        Ok(self.visible_under(&permit, id))
    }

    fn visible_under(&self, permit: &LiveReadPermit, id: u32) -> bool {
        if self.expires <= Instant::now()
            || permit.space().lifecycle != SpaceLifecycle::Active
            || !self.visible.contains(id)
        {
            return false;
        }
        // `self.visible` was verified against `self.cut.canonical_seq`; while
        // the Space head has not moved, membership is already authoritative.
        if permit.head() == self.cut.canonical_seq {
            return true;
        }
        self.index
            .note_id(self.index.dense(id))
            .ok()
            .is_some_and(|note| ensure_active(permit, &self.ctx, &note).is_ok())
    }

    fn live_edges<'a>(
        &'a self,
        id: u32,
        edges: impl Iterator<Item = u32> + Send + 'a,
    ) -> DomainResult<DenseNodeIter<'a>> {
        let permit = self.live_permit()?;
        if !self.visible_under(&permit, id) {
            return Err(DomainError::ResourceNotFound);
        }
        let verified_head = permit.head();
        if verified_head == self.cut.canonical_seq {
            drop(permit);
            return Ok(DenseNodeIter::from_iter(
                self.cut.generation,
                edges.filter(move |neighbor| {
                    self.visible.contains(*neighbor)
                        && self.live_edge_after_commit(id, *neighbor, verified_head)
                }),
            ));
        }
        let neighbors: Vec<u32> = edges
            .filter(|&neighbor| self.visible_under(&permit, neighbor))
            .collect();
        drop(permit);
        // Neighbors are verified eagerly under `live_permit()?` so write-lock
        // contention propagates `NotReady` instead of silently dropping edges.
        // Keep a fail-closed check on iteration so an iterator retained across
        // a subsequent trash mutation stops yielding edges.
        Ok(DenseNodeIter::from_iter(
            self.cut.generation,
            neighbors
                .into_iter()
                .filter(move |&neighbor| self.live_edge_after_commit(id, neighbor, verified_head)),
        ))
    }

    fn live_edge_after_commit(&self, focal: u32, adjacent: u32, verified_head: SpaceSeq) -> bool {
        if self.expires <= Instant::now() {
            return false;
        }
        self.live.try_read().is_ok_and(|permit| {
            permit.space().lifecycle == SpaceLifecycle::Active
                && (permit.head() == verified_head
                    || (self.visible_under(&permit, focal)
                        && self.visible_under(&permit, adjacent)))
        })
    }

    /// Filter a dense bitmap against the current live fence in bounded batches,
    /// waiting for brief writer holds instead of dropping hits under `try_read()`.
    async fn filter_bitmap_live(
        &self,
        rows: Bitmap,
        entry_folder: Option<&FolderId>,
    ) -> Result<Bitmap, PortError> {
        const LIVE_BITMAP_BATCH: usize = 64;
        'verify: loop {
            self.remaining()?;
            let mut permit = self.read_live().await?;
            if let Some(folder) = entry_folder {
                authorize_entry(&permit, &self.ctx, folder)?;
            } else if permit.space().lifecycle != SpaceLifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }
            let head = permit.head();
            if head == self.cut.canonical_seq {
                let mut verified = rows;
                verified.and_inplace(&self.visible);
                return Ok(verified);
            }
            let mut verified = Bitmap::new();
            let mut next = Some(0u32);
            let mut batch_index = 0usize;
            while let Some(start) = next.take() {
                if batch_index > 0 {
                    drop(permit);
                    tokio::task::yield_now().await;
                    permit = self.read_live().await?;
                    if let Some(folder) = entry_folder {
                        authorize_entry(&permit, &self.ctx, folder)?;
                    } else if permit.space().lifecycle != SpaceLifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    if permit.head() != head {
                        continue 'verify;
                    }
                }
                batch_index += 1;
                let mut raw = [0u32; LIVE_BITMAP_BATCH];
                let mut iter = rows.iter();
                iter.reset_at_or_after(start);
                let count = iter.next_many(&mut raw);
                if count == 0 {
                    break;
                }
                next = raw[count - 1].checked_add(1);
                for &id in &raw[..count] {
                    if self.visible_under(&permit, id) {
                        verified.add(id);
                    }
                }
            }
            return Ok(verified);
        }
    }
}

/// Stop at the visible limit or exhaustion. Otherwise release the live permit
/// before examining another batch of potentially hidden neighbors.
fn collect_neighbor_batch(
    edges: &mut impl Iterator<Item = u32>,
    found: &mut Vec<DenseNodeId>,
    end: usize,
    mut visible: impl FnMut(u32) -> Option<DenseNodeId>,
) -> bool {
    for _ in 0..VISIBILITY_BATCH {
        let Some(id) = edges.next() else { return true };
        if let Some(node) = visible(id) {
            found.push(node);
            if found.len() == end {
                return true;
            }
        }
    }
    false
}

#[test]
fn bounded_neighbor_pages_do_not_expand_the_rest_of_a_hub() {
    let generation = ProjectionGeneration::new(1).unwrap();
    let mut edges = 0..100_000;
    let mut found = Vec::new();
    while !collect_neighbor_batch(&mut edges, &mut found, 64, |id| {
        (id % 2 == 0).then(|| DenseNodeId::new(generation, id))
    }) {}
    assert_eq!(found.len(), 64);
    assert_eq!(edges.next(), Some(127));
}

/// Own the compressed posting while the consumer is suspended. Re-seek once
/// per small batch so that abandoning an iterator never expands its tail.
fn bitmap_ids(rows: Bitmap) -> impl Iterator<Item = u32> + Send {
    let mut next = Some(0);
    let mut buffer = [0; 64];
    let mut offset = 0;
    let mut count = 0;
    std::iter::from_fn(move || {
        if offset == count {
            let start = next.take()?;
            let mut iter = rows.iter();
            iter.reset_at_or_after(start);
            offset = 0;
            count = iter.next_many(&mut buffer);
            if count == 0 {
                return None;
            }
            next = buffer[count - 1].checked_add(1);
        }
        let id = buffer[offset];
        offset += 1;
        Some(id)
    })
}

impl StructuralSnapshot for Snapshot {
    fn cut(&self) -> &SnapshotCut {
        &self.cut
    }

    fn lookup(&self, note: &NoteId) -> DomainResult<Option<DenseNodeId>> {
        let Some(id) = self.index.dense_id(note) else {
            return Ok(None);
        };
        Ok(self.live_node(id)?.then(|| self.index.dense(id)))
    }

    fn note_id(&self, node: DenseNodeId) -> DomainResult<NoteId> {
        if !self.live_node(node.index(self.cut.generation)?)? {
            return Err(DomainError::ResourceNotFound);
        }
        self.index.note_id(node)
    }

    fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
        let index = node.index(self.cut.generation)?;
        if !self.live_node(index)? {
            return Err(DomainError::ResourceNotFound);
        }
        self.index
            .note_header(index)
            .map(|header| header.doc_class)
            .ok_or(DomainError::ResourceNotFound)
    }

    fn folder_descendants<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, Vec<FolderId>> {
        Box::pin(async move {
            self.within_request(async {
                let descendants = self.folder_scope(folder, true).await?.descendants;
                // Yield the live fence between batches. If a writer changes it,
                // revalidate the prefix under the new head before returning IDs.
                'verify: loop {
                    self.remaining()?;
                    let mut permit = self.read_live().await?;
                    authorize_entry(&permit, &self.ctx, folder)?;
                    let head = permit.head();
                    let mut result = Vec::with_capacity(1 + descendants.len());
                    result.push(folder.clone());
                    if head == self.cut.projected_seq {
                        result.extend(descendants);
                        return Ok(result);
                    }
                    for (i, batch) in descendants.chunks(VISIBILITY_BATCH).enumerate() {
                        if i > 0 {
                            drop(permit);
                            tokio::task::yield_now().await;
                            permit = self.read_live().await?;
                            authorize_entry(&permit, &self.ctx, folder)?;
                            if permit.head() != head {
                                continue 'verify;
                            }
                        }
                        for child in batch {
                            if let Some(facts) = permit.folder_facts(child)
                                && self
                                    .ctx
                                    .auth()
                                    .can_view_folder(permit.space(), child, &facts.ancestor_folders)
                                    .is_ok()
                            {
                                result.push(child.clone());
                            }
                        }
                    }
                    return Ok(result);
                }
            })
            .await
        })
    }

    fn enclosing_project<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, Option<FolderId>> {
        Box::pin(async move {
            self.within_request(async {
                let location = self.folder_scope(folder, false).await?;
                if let Some(project) = &location.project {
                    authorize_entry(&self.read_live().await?, &self.ctx, project)?;
                }
                Ok(location.project)
            })
            .await
        })
    }

    fn filter_notes<'a>(
        &'a self,
        filter: &'a FieldFilterAstV1,
    ) -> PortFuture<'a, Option<DenseNodeIter<'a>>> {
        Box::pin(async move {
            self.within_request(async {
                filter.validate_declared(&self.published.fields)?;
                if matches!(&filter.predicate, Predicate::All(terms) if terms.is_empty()) {
                    return Ok(None);
                }
                let matches = query::exact_filter_pages(
                    &self.index,
                    &self.visible,
                    &filter.predicate,
                    |page| self.verify_filter_page(page, &filter.predicate),
                )
                .await?;
                let verified = self.filter_bitmap_live(matches, None).await?;
                Ok(Some(DenseNodeIter::from_iter(
                    self.cut.generation,
                    bitmap_ids(verified),
                )))
            })
            .await
        })
    }

    fn folder_subtree<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, DenseNodeIter<'a>> {
        Box::pin(async move {
            self.within_request(async {
                let permit = self.read_live().await?;
                authorize_entry(&permit, &self.ctx, folder)?;
                let id = self
                    .index
                    .dense_folder_id(folder)
                    .ok_or(DomainError::ResourceNotFound)?;
                let mut rows = self
                    .index
                    .posting(&PostingKey::FolderSubtree(id))
                    .map_err(|_| DomainError::ResourceNotFound)?;
                rows.and_inplace(&self.visible);
                drop(permit);
                let verified = self.filter_bitmap_live(rows, Some(folder)).await?;
                Ok(DenseNodeIter::from_iter(
                    self.cut.generation,
                    bitmap_ids(verified),
                ))
            })
            .await
        })
    }

    fn neighbor_page(
        &self,
        node: DenseNodeId,
        per_direction: PageLimit,
    ) -> PortFuture<'_, Vec<DenseNodeId>> {
        Box::pin(async move {
            self.within_request(async {
                let focal = node.index(self.cut.generation)?;
                let limit = usize::from(per_direction.get());
                'verify: loop {
                    let mut permit = self.read_live().await?;
                    if !self.visible_under(&permit, focal) {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let head = permit.head();
                    let mut found = Vec::with_capacity(limit * 2);
                    for incoming in [false, true] {
                        let end = found.len() + limit;
                        let mut neighbors = self.index.neighbors(focal, incoming);
                        while !collect_neighbor_batch(&mut neighbors, &mut found, end, |id| {
                            self.visible_under(&permit, id)
                                .then(|| self.index.dense(id))
                        }) {
                            drop(permit);
                            tokio::task::yield_now().await;
                            permit = self.read_live().await?;
                            if permit.head() != head {
                                continue 'verify;
                            }
                            if !self.visible_under(&permit, focal) {
                                return Err(DomainError::ResourceNotFound.into());
                            }
                        }
                    }
                    return Ok(found);
                }
            })
            .await
        })
    }

    fn wait_ready(&self) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.within_request(async {
                let _permit = self.read_live().await?;
                Ok(())
            })
            .await
        })
    }

    fn outgoing(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        let id = node.index(self.cut.generation)?;
        self.live_edges(id, self.index.outgoing(id))
    }

    fn incoming(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        let id = node.index(self.cut.generation)?;
        self.live_edges(id, self.index.incoming(id))
    }
}

impl StructuralReadPort for ProjectionEngine {
    fn acquire_snapshot(
        &self,
        ctx: SpaceContext,
        causal: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        Box::pin(async move {
            within_budget(&ctx, async {
                let request_deadline = Instant::now()
                    .checked_add(ctx.budget.remaining)
                    .ok_or_else(not_ready)?;
                let cut = self.choose_read(&ctx, &causal, None).await?.cut;
                let index = self.open_index_async(&cut).await?;
                let permit = cut.live.read(&ctx.budget).await?;
                authorize_query(&permit, &ctx, &cut.root_folder_id, None, true)?;
                let universe = query::structural_universe(&index, permit.space(), ctx.auth())?;
                let (visible, permit) = current_bitmap(
                    &index,
                    &cut,
                    &ctx,
                    permit,
                    universe,
                    LifecycleMask::Active,
                    true,
                )
                .await?;
                let _admission = self.current_admission(cut.cut.generation)?;
                let mut snapshot_cut = cut.cut.clone();
                snapshot_cut.canonical_seq = permit.head();
                let live = cut.live.clone();
                let snapshot: Box<dyn StructuralSnapshot> = Box::new(Snapshot {
                    cut: snapshot_cut,
                    published: cut,
                    canonical: self.canonical.clone(),
                    authority: self.projection_context.authority.clone(),
                    request_deadline,
                    index,
                    visible,
                    ctx: ctx.clone(),
                    live,
                    expires: Instant::now()
                        .checked_add(self.reads.lifetime)
                        .ok_or_else(not_ready)?,
                });
                Ok(snapshot)
            })
            .await
        })
    }

    fn is_live_visible<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        note: &'a NoteId,
    ) -> PortFuture<'a, bool> {
        Box::pin(async move {
            within_budget(ctx, async {
                drop(self.current_admission(self.active_generation())?);
                let handle = self.live_handle_async(ctx.scope(), &ctx.budget).await?;
                let permit = handle.read(&ctx.budget).await?;
                let _admission = self.current_admission(self.active_generation())?;
                can_view_query_entry(&permit, ctx, permit.root_folder_id(), None, true)?;
                match permit.classify(ctx, note, true)? {
                    LiveNoteStatus::ActiveVisible(facts) => {
                        ctx.auth().authorize_read(&facts)?;
                        Ok(true)
                    }
                    _ => Ok(false),
                }
            })
            .await
        })
    }

    fn filter_live_visible<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        notes: &'a [NoteId],
    ) -> PortFuture<'a, Vec<bool>> {
        Box::pin(async move {
            within_budget(ctx, async {
                drop(self.current_admission(self.active_generation())?);
                let handle = self.live_handle_async(ctx.scope(), &ctx.budget).await?;
                let mut results = Vec::with_capacity(notes.len());
                let mut checked_head = None;
                loop {
                    {
                        let permit = handle.read(&ctx.budget).await?;
                        let _admission = self.current_admission(self.active_generation())?;
                        can_view_query_entry(&permit, ctx, permit.root_folder_id(), None, true)?;
                        if checked_head != Some(permit.head()) {
                            results.clear();
                            checked_head = Some(permit.head());
                        }
                        for note in notes[results.len()..].iter().take(VISIBILITY_BATCH) {
                            match permit.classify(ctx, note, true)? {
                                LiveNoteStatus::ActiveVisible(facts) => {
                                    ctx.auth().authorize_read(&facts)?;
                                    results.push(true);
                                }
                                _ => results.push(false),
                            }
                        }
                        if results.len() == notes.len() {
                            return Ok(results);
                        }
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
        })
    }

    fn hydrate(
        &self,
        ctx: SpaceContext,
        snapshot: SnapshotCut,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
        Box::pin(async move {
            within_budget(&ctx, async {
                ctx.check_current(&snapshot.scope)?;
                drop(self.current_admission(self.active_generation())?);
                // A retained cut can use canonical hydration while this
                // Space is still binding the newly selected generation.
                let live = self
                    .canonical
                    .live_visibility_fence()
                    .read_space(ctx.scope(), &ctx.budget)
                    .await?;
                let head = {
                    let permit = live.read(&ctx.budget).await?;
                    authorize_query(&permit, &ctx, permit.root_folder_id(), None, true)?;
                    permit.head()
                };
                if let Ok(current) = self.published_cut(ctx.scope())
                    && current.cut.generation == snapshot.generation
                    && current.cut.projected_seq == snapshot.projected_seq
                {
                    let hydrated = async {
                        let index = self.open_index_async(&current).await?;
                        let slots = notes
                            .iter()
                            .map(|note| index.dense_id(note))
                            .collect::<Vec<_>>();
                        let keys = slots.iter().filter_map(|slot| *slot).collect::<Vec<_>>();
                        let mut cards = Vec::with_capacity(keys.len());
                        for batch in keys.chunks(200) {
                            cards.extend(
                                self.hydrate_cards_at(
                                    &ctx,
                                    &current,
                                    batch,
                                    &BTreeMap::new(),
                                    None,
                                )
                                .await?,
                            );
                            #[cfg(any(test, feature = "test-support"))]
                            if cards.len() < keys.len() {
                                pause_after_read_payload(&current, &ctx).await;
                            }
                        }
                        let mut cards = cards.into_iter();
                        let mut result: Vec<Option<NoteCard>> = slots
                            .into_iter()
                            .map(|slot| slot.and_then(|_| cards.next().flatten()))
                            .collect();
                        let _admission = self.current_admission(current.cut.generation)?;
                        let permit = live.read(&ctx.budget).await?;
                        if permit.space().lifecycle != SpaceLifecycle::Active {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        if permit.head() != head {
                            authorize_query(&permit, &ctx, permit.root_folder_id(), None, true)?;
                            for (card, id) in result.iter_mut().zip(&notes) {
                                if card.is_some() && ensure_active(&permit, &ctx, id).is_err() {
                                    *card = None;
                                }
                            }
                        }
                        Ok::<_, PortError>(result)
                    }
                    .await;
                    match hydrated {
                        Ok(cards) => return Ok(cards),
                        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                            if diagnostic.reason == ValidationReason::CursorStale => {}
                        Err(error) => return Err(error),
                    }
                }
                // The fallback reads the projected command cut. The current
                // admission is rechecked after the canonical call returns.
                let mut historical = snapshot;
                historical.canonical_seq = historical.projected_seq;
                let mut cards = Vec::with_capacity(notes.len());
                for batch in notes.chunks(200) {
                    cards.extend(
                        self.canonical
                            .hydrate_cards(ctx.clone(), historical.clone(), batch.to_vec())
                            .await?,
                    );
                }
                let _admission = self.current_admission(self.active_generation())?;
                let permit = live.read(&ctx.budget).await?;
                if permit.space().lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if permit.head() != head {
                    authorize_query(&permit, &ctx, permit.root_folder_id(), None, true)?;
                }
                for (card, id) in cards.iter_mut().zip(notes) {
                    if card.is_some() && ensure_active(&permit, &ctx, &id).is_err() {
                        *card = None;
                    }
                }
                Ok(cards)
            })
            .await
        })
    }
}

#[cfg(test)]
mod subtree_tests {
    use super::*;

    #[test]
    fn owned_bitmap_iterator_stays_exhausted_after_any_final_batch() {
        for len in [0, 1, 40, 64, 65, 128] {
            for last_is_max in [false, true] {
                let mut rows = Bitmap::new();
                rows.add_range(0..len);
                if last_is_max {
                    rows.add(u32::MAX);
                }
                let expected = rows.to_vec();
                let mut ids = bitmap_ids(rows);
                assert_eq!(ids.by_ref().collect::<Vec<_>>(), expected);
                assert_eq!(ids.next(), None);
                assert_eq!(ids.next(), None);
            }
        }
    }

    #[test]
    fn owned_subtree_iterator_starts_with_a_bounded_batch_and_crosses_batch_boundaries() {
        let mut bitmap = Bitmap::new();
        bitmap.add_range(0..1_000_000);
        bitmap.add(u32::MAX);
        let mut early = bitmap_ids(bitmap.clone());
        assert_eq!(early.next(), Some(0));
        drop(early);
        let mut sparse = Bitmap::new();
        sparse.add_range(5..69);
        sparse.add_range(10_000..10_069);
        sparse.add(u32::MAX);
        assert_eq!(
            bitmap_ids(sparse.clone()).collect::<Vec<_>>(),
            sparse.to_vec()
        );
    }
}
