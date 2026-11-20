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
    query::{CursorPage, EffectiveRead, KeysetCursor, ReadRequest},
    receipt::{CausalBasis, MutationEffect, OverlayDecision, ReceiptSet, plan_overlay},
};

use crate::{
    derived::{ProjectedNote, ProjectedViewRank},
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
        let mut entries = self.by_id.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|_, entry| entry.expires > Instant::now());
        entries.insert(state.read.id.clone(), state);
        while entries.len() > self.limit
            || retained_bytes(
                entries
                    .values()
                    .map(|entry| (&entry.cut, entry.owned_bytes)),
            ) > 64 * 1024 * 1024
        {
            let next = entries
                .values()
                .min_by_key(|entry| entry.expires)
                .map(|entry| entry.read.id.clone());
            if let Some(id) = next {
                entries.remove(&id);
            }
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
    ranks: Vec<ProjectedViewRank>,
}

fn authority_fingerprint(ctx: &SpaceContext) -> Result<ContentDigest, PortError> {
    let auth = ctx.auth();
    let grant = auth
        .spaces()
        .get(&ctx.scope().space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    let payload = encode_msgpack(&(
        auth.principal(),
        auth.grant(),
        grant.role,
        &grant.read_classes,
        &grant.project_root,
        auth.readonly_abilities(),
    ))?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-projection-read-authority-v1");
    hasher.update(&payload);
    Ok(ContentDigest::from_bytes(*hasher.finalize().as_bytes()))
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

fn not_ready() -> PortError {
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
        self.try_location_at(cut, cut.cut.projected_seq, folder)
            .await
    }

    pub(super) async fn try_location_at(
        &self,
        cut: &PublishedCut,
        seq: SpaceSeq,
        folder: &FolderId,
    ) -> Result<Option<records::FolderLocation>, PortError> {
        let mut folders = records::FolderCatalog::default();
        let mut next = Some(folder.clone());
        while let Some(id) = next {
            if folders.rows.len() > MAX_FOLDER_DEPTH || folders.rows.contains_key(&id) {
                return Ok(None);
            }
            let Some(row) = cut.store.folder_by_id(&cut.cut.scope, seq, &id).await? else {
                return Ok(None);
            };
            next = row.parent_folder_id.clone();
            folders.rows.insert(id, row);
        }
        folders.location(folder).map(Some)
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
                        columns: descriptor.columns,
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
            self.try_location_at(cut, seq, &view.parent_folder_id)
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
            let Some(location) = self.try_location(cut, &row.note.parent_folder_id).await? else {
                return Err(stale());
            };
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
                && recorded_visible(&permit, ctx, &row.note, &location)
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
        )
        .await?;
        let ids = selection
            .rows
            .iter()
            .map(|row| row.dense_id)
            .collect::<Vec<_>>();
        let cards = self.hydrate_cards_at(ctx, cut, &ids, &exact, head).await?;
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
            let candidates = query::note_source_candidates(&index, query, universe)?;
            let (candidates, permit) =
                current_bitmap(&index, cut, ctx, permit, candidates, query.lifecycle, false)
                    .await?;
            (candidates, permit.head(), entry)
        };
        let mut exact = BTreeMap::new();
        for (id, row) in &state.overlay {
            let Some(location) = self.try_location(cut, &row.note.parent_folder_id).await? else {
                return Err(stale());
            };
            let permit = cut.live.try_read()?;
            let live =
                current_facts(&permit, ctx, &row.note.note_id, query.lifecycle, false)?.is_some();
            let effective = if location.trashed {
                Lifecycle::Trashed
            } else {
                row.note.lifecycle
            };
            candidates.remove(*id);
            if live
                && recorded_visible(&permit, ctx, &row.note, &location)
                && query.lifecycle.includes(effective)
                && query.classes.contains(&row.note.doc_class)
                && query.folder.as_ref().is_none_or(|folder| {
                    folder == &row.note.parent_folder_id
                        || (query.recursive && location.ids.contains(folder))
                })
            {
                candidates.add(*id);
            }
            exact.insert(*id, row.note.clone());
        }
        let selection = query::select_window(WindowInput {
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
        })
        .await?;
        let ids = selection
            .rows
            .iter()
            .map(|row| row.dense_id)
            .collect::<Vec<_>>();
        let planned = self.hydration_plan(ctx, cut, &ids, &exact).await?;
        let cover_note = cut
            .store
            .folder_by_id(ctx.scope(), cut.cut.projected_seq, &entry)
            .await?
            .and_then(|folder| folder.cover_note_id);
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
        })
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
        let mut folders = records::FolderCatalog::default();
        let mut pending = rows
            .iter()
            .flatten()
            .map(|row| row.parent_folder_id.clone())
            .collect::<BTreeSet<_>>();
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
        expected_head: SpaceSeq,
    ) -> Result<Vec<Option<NoteCard>>, PortError> {
        if expected_head == cut.cut.projected_seq
            && overlay.is_empty()
            && let Some(cards) = cut
                .store
                .hydrate_current_cards(ctx.scope(), expected_head, ids)
                .await?
        {
            let permit = cut.live.try_read()?;
            ensure_active_head(&permit, expected_head)?;
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
        let planned = self.hydration_plan(ctx, cut, ids, overlay).await?;
        let permit = cut.live.try_read()?;
        ensure_active_head(&permit, expected_head)?;
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
        return Err(not_ready());
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
    let permit = cut.live.try_read()?;
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

struct Snapshot {
    cut: SnapshotCut,
    _published: Arc<PublishedCut>,
    index: IndexView,
    visible: Bitmap,
    ctx: SpaceContext,
    live: LiveSpaceHandle,
    expires: Instant,
}

impl Snapshot {
    fn live_node(&self, id: u32) -> bool {
        self.live
            .try_read()
            .is_ok_and(|permit| self.visible_under(&permit, id))
    }

    fn visible_under(&self, permit: &LiveReadPermit, id: u32) -> bool {
        self.expires > Instant::now()
            && self.visible.contains(id)
            && self
                .index
                .note_id(self.index.dense(id))
                .ok()
                .is_some_and(|note| ensure_active(permit, &self.ctx, &note).is_ok())
    }

    fn live_edge(&self, focal: u32, adjacent: u32) -> bool {
        self.live.try_read().is_ok_and(|permit| {
            self.visible_under(&permit, focal) && self.visible_under(&permit, adjacent)
        })
    }
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

    fn lookup(&self, note: &NoteId) -> Option<DenseNodeId> {
        let id = self.index.dense_id(note)?;
        self.live_node(id).then(|| self.index.dense(id))
    }

    fn note_id(&self, node: DenseNodeId) -> DomainResult<NoteId> {
        if !self.live_node(node.index(self.cut.generation)?) {
            return Err(DomainError::ResourceNotFound);
        }
        self.index.note_id(node)
    }

    fn folder_subtree(&self, folder: &FolderId) -> DomainResult<DenseNodeIter<'_>> {
        let permit = self
            .live
            .try_read()
            .map_err(|_| DomainError::ResourceNotFound)?;
        authorize_entry(&permit, &self.ctx, folder).map_err(|_| DomainError::ResourceNotFound)?;
        let initial_head = permit.head();
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
        let folder = folder.clone();
        let ids = bitmap_ids(rows).filter(move |id| {
            self.live.try_read().is_ok_and(|permit| {
                (permit.head() == initial_head
                    || authorize_entry(&permit, &self.ctx, &folder).is_ok())
                    && self.visible_under(&permit, *id)
            })
        });
        Ok(DenseNodeIter::from_iter(self.cut.generation, ids))
    }

    fn outgoing(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        let id = node.index(self.cut.generation)?;
        if !self.live_node(id) {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(DenseNodeIter::from_iter(
            self.cut.generation,
            self.index
                .outgoing(id)
                .filter(move |neighbor| self.live_edge(id, *neighbor)),
        ))
    }

    fn incoming(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        let id = node.index(self.cut.generation)?;
        if !self.live_node(id) {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(DenseNodeIter::from_iter(
            self.cut.generation,
            self.index
                .incoming(id)
                .filter(move |neighbor| self.live_edge(id, *neighbor)),
        ))
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
                let cut = self.choose_read(&ctx, &causal, None).await?.cut;
                let index = self.open_index_async(&cut).await?;
                let permit = cut.live.try_read()?;
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
                    _published: cut,
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

    fn is_live_visible(&self, ctx: &SpaceContext, note: &NoteId) -> DomainResult<bool> {
        let generation = self.generation.load().store.generation();
        let _admission = self
            .current_admission(generation)
            .map_err(|_| DomainError::validation(ValidationReason::NotReady))?;
        let permit = self
            .live_handle(ctx.scope())
            .and_then(|handle| handle.try_read())
            .map_err(|error| match error {
                PortError::Domain(error) => error,
                _ => DomainError::ResourceNotFound,
            })?;
        authorize_query(&permit, ctx, permit.root_folder_id(), None, true).map_err(|error| {
            match error {
                PortError::Domain(error) => error,
                _ => DomainError::ResourceNotFound,
            }
        })?;
        match permit
            .classify(ctx, note, true)
            .map_err(|_| DomainError::ResourceNotFound)?
        {
            LiveNoteStatus::ActiveVisible(facts) => {
                ctx.auth().authorize_read(&facts)?;
                Ok(true)
            }
            _ => Ok(false),
        }
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
                let live = self.canonical.live_visibility_fence().space(ctx.scope())?;
                let head = {
                    let permit = live.try_read()?;
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
                                    head,
                                )
                                .await?,
                            );
                            #[cfg(any(test, feature = "test-support"))]
                            if cards.len() < keys.len() {
                                pause_after_read_payload(&current, &ctx).await;
                            }
                        }
                        let mut cards = cards.into_iter();
                        let result: Vec<Option<NoteCard>> = slots
                            .into_iter()
                            .map(|slot| slot.and_then(|_| cards.next().flatten()))
                            .collect();
                        let _admission = self.current_admission(current.cut.generation)?;
                        let permit = live.try_read()?;
                        ensure_active_head(&permit, head)?;
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
                let permit = live.try_read()?;
                ensure_active_head(&permit, head)?;
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
