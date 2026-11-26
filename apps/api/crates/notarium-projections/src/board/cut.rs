use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    time::Duration,
};

use notarium_canonical::{
    LiveNoteStatus, LiveReadPermit,
    codec::{
        cancelled_not_committed, deadline_not_committed, evaluate_fields_with_schema,
        group_key_hex, internal_not_committed,
    },
    domain::common::MAX_FOLDER_DEPTH,
    projection_read::{ProjectedSchemaSnapshot, ProjectionDelta, ProjectionNote, ProjectionRank},
};
use notarium_core::{
    DomainError,
    auth::{ResourceFacts, Space, SpaceLifecycle},
    classes::DocClass,
    error::{Diagnostic, PortError, ValidationReason},
    ids::{AbilityId, ContentDigest, FolderId, NoteId, RevisionId, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::{Cancellation, PageLimit, PlannedNoteRestoration, SpaceContext, ViewRef},
    query::{FieldObservation, FieldSchema, FieldValue},
    value::{Timestamp, YamlValue},
};
use notarium_syntax::extract::{ExtractedDocDelta, extract};
use tokio::time::Instant;

use crate::{
    derived::{ProjectedFolder, ProjectedNote, ProjectedViewRank, decode_payload},
    index::PostingKey,
    nota::{SourceScope, ViewInput, ViewSource},
    query::{resolve_source_folder, view_source_candidates},
    runtime::{ProjectionEngine, PublishedCut, records::effective_tags},
};

use super::{RollbackBoardPlan, board_plan, board_plan_for_rollback};

const MAX_REPLAY_EVENTS: u64 = 512;
const BOARD_WAIT: Duration = Duration::from_millis(25);

static EMPTY_SCHEMA: BTreeMap<String, FieldSchema> = BTreeMap::new();

pub(super) struct BoardCut {
    pub(super) scope: HistoryScope,
    pub(super) cutoff: SpaceSeq,
    space: Space,
    root: FolderId,
    schema: Option<ProjectedSchemaSnapshot>,
    folders: BTreeMap<FolderId, BoardFolder>,
    pub(super) notes: BTreeMap<NoteId, BoardNote>,
    pub(super) ranks: BTreeMap<ViewRef, BTreeMap<NoteId, BoardRank>>,
}

pub(super) struct BoardNote {
    pub(super) revision: RevisionId,
    pub(super) parent_folder: FolderId,
    pub(super) class: DocClass,
    ability: Option<AbilityId>,
    pub(super) lifecycle: Lifecycle,
    pub(super) updated_at: Timestamp,
    digest: Option<ContentDigest>,
    pub(super) inline_tags: Vec<String>,
    pub(super) tags: BTreeSet<String>,
    pub(super) raw_fields: Option<BTreeMap<String, YamlValue>>,
    diagnostic: Option<Diagnostic>,
    pub(super) fields: BTreeMap<String, FieldObservation<FieldValue>>,
    pub(super) views: Vec<ViewInput>,
}

struct BoardFolder {
    parent: Option<FolderId>,
    slug_fold: String,
    lifecycle: Lifecycle,
    locked: bool,
    is_project: bool,
}

pub(super) struct BoardRank {
    pub(super) revision: RevisionId,
    pub(super) group_hex: String,
    pub(super) rank: String,
}

pub(super) struct Ancestry {
    pub(super) ids: Vec<FolderId>,
    pub(super) active: bool,
    locked: bool,
}

#[derive(Default)]
struct ReplayedChanges {
    notes: BTreeSet<NoteId>,
    folders_changed: bool,
    schema_changed: bool,
}

impl BoardCut {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn load<'a>(
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        requested: Option<SpaceSeq>,
        views: impl IntoIterator<Item = &'a ViewRef>,
        additional_notes: impl IntoIterator<Item = &'a NoteId>,
        restorations: &[PlannedNoteRestoration],
        deadline: &PlannerDeadline,
    ) -> Result<Self, PortError> {
        let _ = engine.current_admission(engine.active_generation())?;
        let views: BTreeSet<_> = views.into_iter().cloned().collect();
        let canonical = engine.canonical();
        let mut projection = engine.projection_context_for(ctx);
        projection.budget.remaining = deadline.remaining()?;
        let header = deadline
            .wait(canonical.read_projection_space_header(
                &projection,
                &ctx.scope().space_id,
                requested,
            ))
            .await?;
        ctx.check_current(&header.scope)?;
        if header.space.lifecycle != SpaceLifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        let mut waiting = ctx.clone();
        waiting.budget.remaining = BOARD_WAIT.min(deadline.remaining()? / 3);
        let published = match deadline
            .wait(engine.wait_for_board_cut(&waiting, Some(header.cutoff)))
            .await?
        {
            Some(cut) => cut,
            None => engine.published_cut(ctx.scope())?,
        };
        let mut cut = Self {
            scope: header.scope,
            cutoff: header.cutoff,
            space: header.space,
            root: header.root_folder_id,
            schema: header.schema,
            folders: BTreeMap::new(),
            notes: BTreeMap::new(),
            ranks: BTreeMap::new(),
        };
        let view_notes: BTreeSet<_> = views.iter().map(|view| &view.note).collect();
        let additional: BTreeSet<_> = additional_notes.into_iter().cloned().collect();
        if published.cut.projected_seq <= cut.cutoff
            && cut.cutoff.get() - published.cut.projected_seq.get() <= MAX_REPLAY_EVENTS
        {
            match cut
                .try_load_from_derived(
                    engine,
                    ctx,
                    &published,
                    &views,
                    &view_notes,
                    &additional,
                    restorations,
                    deadline,
                )
                .await
            {
                Ok(()) => return Ok(cut),
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::CursorStale =>
                {
                    if requested.is_none() {
                        return Err(stale());
                    }
                    // Explicit historical cutoffs may fall back to canonical
                    // reads at the requested sequence.
                    cut.folders.clear();
                    cut.notes.clear();
                    cut.ranks.clear();
                }
                Err(error) => return Err(error),
            }
        } else if requested.is_none() {
            if published.cut.projected_seq > cut.cutoff {
                return Err(stale());
            }
            return Err(DomainError::validation(ValidationReason::NotReady).into());
        }
        cut.load_from_canonical(engine, ctx, &views, &view_notes, deadline)
            .await?;
        Ok(cut)
    }

    #[allow(clippy::too_many_arguments)]
    async fn try_load_from_derived(
        &mut self,
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        published: &PublishedCut,
        views: &BTreeSet<ViewRef>,
        view_notes: &BTreeSet<&NoteId>,
        additional: &BTreeSet<NoteId>,
        restorations: &[PlannedNoteRestoration],
        deadline: &PlannerDeadline,
    ) -> Result<(), PortError> {
        let projected = published.cut.projected_seq;
        let limit = PageLimit::new(200)?;
        let mut after_folder = None;
        loop {
            let rows = deadline
                .wait(
                    published
                        .store
                        .folders_page(&self.scope, projected, after_folder, limit),
                )
                .await?;
            after_folder = rows.last().map(|folder| folder.dense_folder_id);
            let complete = rows.len() < usize::from(limit.get());
            for folder in rows {
                self.insert_folder(folder);
            }
            if complete {
                break;
            }
        }

        let needed: BTreeSet<_> = view_notes
            .iter()
            .copied()
            .cloned()
            .chain(additional.iter().cloned())
            .collect();
        for id in needed {
            if let Some(note) = deadline
                .wait(published.store.note_by_id(&self.scope, projected, &id))
                .await?
            {
                let read_views = view_notes.contains(&id);
                self.notes
                    .insert(id, BoardNote::from_derived(note, read_views)?);
            }
        }

        for view in views {
            let mut after_rank = None;
            let mut ranks = BTreeMap::new();
            loop {
                let rows = deadline
                    .wait(published.store.view_rank_page(
                        &self.scope,
                        projected,
                        view,
                        after_rank.as_ref(),
                        limit,
                    ))
                    .await?;
                after_rank = rows.last().map(|rank| rank.target_note_id.clone());
                let complete = rows.len() < usize::from(limit.get());
                for rank in rows {
                    let (note, rank) = BoardRank::from_derived(rank);
                    ranks.insert(note, rank);
                }
                if complete {
                    break;
                }
            }
            self.ranks.insert(view.clone(), ranks);
        }

        let replayed = if projected < self.cutoff {
            self.replay(engine, ctx, published, views, view_notes, deadline)
                .await?
        } else {
            ReplayedChanges::default()
        };
        self.hydrate_candidates(
            engine,
            ctx,
            published,
            views,
            &replayed,
            restorations,
            deadline,
        )
        .await
    }

    async fn load_from_canonical(
        &mut self,
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        views: &BTreeSet<ViewRef>,
        view_notes: &BTreeSet<&NoteId>,
        deadline: &PlannerDeadline,
    ) -> Result<(), PortError> {
        let canonical = engine.canonical();
        let mut projection = engine.projection_context_for(ctx);
        let limit = PageLimit::new(200)?;

        let mut after_folder = None;
        loop {
            projection.budget.remaining = deadline.remaining()?;
            let page = deadline
                .wait(canonical.read_projection_folders_page(
                    &projection,
                    &self.scope,
                    self.cutoff,
                    after_folder,
                    limit,
                ))
                .await?;
            for folder in page.rows {
                let folder = folder.metadata;
                self.folders.insert(
                    folder.folder_id,
                    BoardFolder {
                        parent: folder.parent_folder_id,
                        slug_fold: folder.slug_fold,
                        lifecycle: folder.lifecycle,
                        locked: folder.write_locked,
                        is_project: folder.is_project,
                    },
                );
            }
            after_folder = page.next;
            if after_folder.is_none() {
                break;
            }
        }

        let schema = self.schema.as_ref().map(|schema| &schema.fields);
        let mut after_note = None;
        loop {
            projection.budget.remaining = deadline.remaining()?;
            let page = deadline
                .wait(canonical.read_projection_notes_page(
                    &projection,
                    &self.scope,
                    self.cutoff,
                    after_note,
                    limit,
                ))
                .await?;
            for note in page.rows {
                let id = note.metadata.note_id.clone();
                let read_views = view_notes.contains(&id);
                let (inline_tags, parsed_views) =
                    if note.metadata.doc_class == DocClass::EncryptedNote {
                        (Vec::new(), Vec::new())
                    } else {
                        projection.budget.remaining = deadline.remaining()?;
                        let carrier = deadline
                            .wait(canonical.read_projection_note_carrier(
                                &projection,
                                &self.scope,
                                self.cutoff,
                                &note,
                            ))
                            .await?;
                        parse_structure(carrier.as_deref(), &note, read_views)?
                    };
                self.notes.insert(
                    id,
                    BoardNote::from_canonical(note, schema, inline_tags, parsed_views),
                );
            }
            after_note = page.next;
            if after_note.is_none() {
                break;
            }
        }

        let mut after_rank = None;
        loop {
            projection.budget.remaining = deadline.remaining()?;
            let page = deadline
                .wait(canonical.read_projection_overlays_page(
                    &projection,
                    &self.scope,
                    self.cutoff,
                    after_rank,
                    limit,
                ))
                .await?;
            for rank in page.rows {
                self.apply_rank(views, rank)?;
            }
            after_rank = page.next;
            if after_rank.is_none() {
                break;
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn hydrate_candidates(
        &mut self,
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        published: &PublishedCut,
        views: &BTreeSet<ViewRef>,
        replayed: &ReplayedChanges,
        restorations: &[notarium_core::ports::PlannedNoteRestoration],
        deadline: &PlannerDeadline,
    ) -> Result<(), PortError> {
        let index = deadline.wait(engine.open_index_async(published)).await?;
        let mut universe = index.posting(&PostingKey::Active).map_err(index_error)?;
        // Folder mutations can change membership for rows whose individual
        // note revisions did not change. Their current ancestry is checked
        // exactly after hydration.
        if !replayed.folders_changed {
            universe.andnot_inplace(
                &index
                    .posting(&PostingKey::TrashedSubtree)
                    .map_err(index_error)?,
            );
        }
        for id in &replayed.notes {
            if let Some(dense) = index.dense_id(id) {
                universe.remove(dense);
            }
        }
        let restored_by_note: BTreeMap<&NoteId, &notarium_core::ports::PlannedNoteRestoration> =
            restorations
                .iter()
                .filter(|entry| entry.planned_lifecycle == Lifecycle::Active)
                .map(|entry| (&entry.note, entry))
                .collect();
        let mut candidates = croaring::Bitmap::new();
        for view in views {
            deadline.check()?;
            let plan = if restorations.is_empty() {
                board_plan(self, ctx, view)?
            } else {
                match board_plan_for_rollback(
                    self,
                    ctx,
                    view,
                    restored_by_note.get(&view.note).copied(),
                )? {
                    RollbackBoardPlan::Board(plan) => *plan,
                    RollbackBoardPlan::Retired => continue,
                }
            };
            let folder = plan
                .source_folder
                .as_ref()
                .filter(|_| !replayed.folders_changed);
            let source =
                view_source_candidates(&index, &plan.descriptor.source, folder, universe.clone())?;
            if replayed.schema_changed {
                candidates.or_inplace(&source);
            } else {
                let matches = index
                    .filter_candidates(&plan.descriptor.filter.predicate, &source)
                    .map_err(index_error)?;
                candidates.or_inplace(&matches.into_possible());
            }
        }
        // These are semantic candidates, including rows outside the caller's
        // read grant. Every matching hydrated row still needs authorization.
        let mut dense = candidates.iter();
        loop {
            let batch: Vec<_> = dense.by_ref().take(200).collect();
            if batch.is_empty() {
                break;
            }
            let rows = deadline
                .wait(
                    published
                        .store
                        .hydrate(&self.scope, published.cut.projected_seq, &batch),
                )
                .await?;
            for note in rows {
                let note = note.ok_or_else(stale)?;
                let id = note.note_id.clone();
                if let std::collections::btree_map::Entry::Vacant(entry) = self.notes.entry(id) {
                    let mut note = BoardNote::from_derived(note, false)?;
                    if replayed.schema_changed {
                        note.evaluate_fields(self.schema.as_ref().map(|schema| &schema.fields));
                    }
                    entry.insert(note);
                }
            }
        }
        Ok(())
    }

    async fn replay(
        &mut self,
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        published: &PublishedCut,
        views: &BTreeSet<ViewRef>,
        view_notes: &BTreeSet<&NoteId>,
        deadline: &PlannerDeadline,
    ) -> Result<ReplayedChanges, PortError> {
        let projected = published.cut.projected_seq;
        let canonical = engine.canonical();
        let mut projection = engine.projection_context_for(ctx);
        let mut after = None;
        let mut changed = BTreeMap::new();
        let mut purged = BTreeSet::new();
        let mut replayed = ReplayedChanges::default();
        let limit = PageLimit::new(200)?;
        loop {
            projection.budget.remaining = deadline.remaining()?;
            let page = deadline
                .wait(canonical.read_projection_delta_batch(
                    &projection,
                    &self.scope,
                    projected,
                    self.cutoff,
                    after,
                    limit,
                ))
                .await?;
            for delta in page.rows {
                match delta {
                    ProjectionDelta::Folder(folder) => {
                        replayed.folders_changed = true;
                        let folder = folder.metadata;
                        self.folders.insert(
                            folder.folder_id,
                            BoardFolder {
                                parent: folder.parent_folder_id,
                                slug_fold: folder.slug_fold,
                                lifecycle: folder.lifecycle,
                                locked: folder.write_locked,
                                is_project: folder.is_project,
                            },
                        );
                    }
                    ProjectionDelta::Note(note) => {
                        changed.insert(note.metadata.note_id.clone(), note);
                    }
                    ProjectionDelta::Ability(ability) => {
                        if let Some(note) = ability.note {
                            changed.insert(note.metadata.note_id.clone(), note);
                        }
                    }
                    ProjectionDelta::Rank { rank, .. } => self.apply_rank(views, rank)?,
                    ProjectionDelta::Schema(_) => replayed.schema_changed = true,
                    ProjectionDelta::Purge(note) => {
                        purged.insert(note);
                    }
                    ProjectionDelta::Alias(_) | ProjectionDelta::Thread(_) => {}
                }
            }
            let Some(next) = page.next else {
                break;
            };
            after = Some(next);
        }

        for note in purged {
            replayed.notes.insert(note.clone());
            changed.remove(&note);
            self.notes.remove(&note);
            self.ranks.retain(|view, _| view.note != note);
            for ranks in self.ranks.values_mut() {
                ranks.remove(&note);
            }
        }
        let schema = self.schema.as_ref().map(|schema| &schema.fields);
        for (id, note) in changed {
            replayed.notes.insert(id.clone());
            let read_views = view_notes.contains(&id);
            let previous = match self.notes.remove(&id) {
                Some(previous) => Some(previous),
                None => deadline
                    .wait(published.store.note_by_id(&self.scope, projected, &id))
                    .await?
                    .map(|row| BoardNote::from_derived(row, read_views))
                    .transpose()?,
            };
            let (inline_tags, views) = if note.metadata.doc_class == DocClass::EncryptedNote {
                (Vec::new(), Vec::new())
            } else if let Some(previous) = previous.filter(|previous| {
                previous.class == note.metadata.doc_class
                    && previous.digest == note.metadata.content_digest
            }) {
                (previous.inline_tags, previous.views)
            } else {
                projection.budget.remaining = deadline.remaining()?;
                let carrier = deadline
                    .wait(canonical.read_projection_note_carrier(
                        &projection,
                        &self.scope,
                        self.cutoff,
                        &note,
                    ))
                    .await?;
                parse_structure(carrier.as_deref(), &note, read_views)?
            };
            self.notes.insert(
                id,
                BoardNote::from_canonical(*note, schema, inline_tags, views),
            );
        }
        if replayed.schema_changed {
            for note in self.notes.values_mut() {
                deadline.check()?;
                note.evaluate_fields(schema);
            }
        }
        Ok(replayed)
    }

    fn apply_rank(
        &mut self,
        views: &BTreeSet<ViewRef>,
        rank: ProjectionRank,
    ) -> Result<(), PortError> {
        let metadata = rank.metadata;
        let view = ViewRef {
            note: metadata.view_note_id,
            key: metadata.view_key,
        };
        if !views.contains(&view) {
            return Ok(());
        }
        let ranks = self.ranks.entry(view).or_default();
        if metadata.removed {
            ranks.remove(&metadata.target_note_id);
        } else {
            let (_, group_hex) = group_key_hex(&metadata.group_key)?;
            ranks.insert(
                metadata.target_note_id,
                BoardRank {
                    revision: rank.revision_id,
                    group_hex,
                    rank: metadata.sort_rank_lexo,
                },
            );
        }
        Ok(())
    }

    fn insert_folder(&mut self, folder: ProjectedFolder) {
        self.folders.insert(
            folder.folder_id,
            BoardFolder {
                parent: folder.parent_folder_id,
                slug_fold: folder.slug_fold,
                lifecycle: folder.lifecycle,
                locked: folder.write_locked,
                is_project: folder.is_project,
            },
        );
    }

    pub(super) fn schema_fields(&self) -> &BTreeMap<String, FieldSchema> {
        self.schema
            .as_ref()
            .map_or(&EMPTY_SCHEMA, |schema| &schema.fields)
    }

    pub(super) fn schema_revision(&self) -> Option<RevisionId> {
        self.schema
            .as_ref()
            .map(|schema| schema.schema_rev_id.clone())
    }

    pub(super) fn schema_fingerprint(&self) -> ContentDigest {
        self.schema
            .as_ref()
            .map_or(ContentDigest::from_bytes([0; 32]), |schema| {
                schema.descriptor_fingerprint
            })
    }

    pub(super) fn ancestry(&self, id: &FolderId) -> Result<Ancestry, PortError> {
        let mut current = Some(id);
        let mut ancestry = Ancestry {
            ids: Vec::new(),
            active: true,
            locked: false,
        };
        while let Some(id) = current {
            if ancestry.ids.len() > MAX_FOLDER_DEPTH || ancestry.ids.contains(id) {
                return Err(internal_not_committed(
                    "board_cut_ancestry",
                    "invalid folder hierarchy",
                ));
            }
            let folder = self.folders.get(id).ok_or(DomainError::ResourceNotFound)?;
            ancestry.ids.push(id.clone());
            ancestry.active &= folder.lifecycle == Lifecycle::Active;
            ancestry.locked |= folder.locked;
            current = folder.parent.as_ref();
        }
        if ancestry.ids.last() != Some(&self.root) {
            return Err(internal_not_committed(
                "board_cut_ancestry",
                "missing Space root",
            ));
        }
        Ok(ancestry)
    }

    pub(super) fn resolve_source(
        &self,
        source: &ViewSource,
        origin: &FolderId,
    ) -> Result<Option<FolderId>, PortError> {
        let project = if source.scope == SourceScope::Project && source.folder.is_none() {
            self.ancestry(origin)?
                .ids
                .into_iter()
                .find(|id| self.folders.get(id).is_some_and(|folder| folder.is_project))
        } else {
            None
        };
        Ok(resolve_source_folder(
            source,
            &self.root,
            project.as_ref(),
            |path| self.folder_by_path(path),
        )?)
    }

    fn folder_by_path(&self, path: &str) -> Option<FolderId> {
        let mut folder = self.root.clone();
        if path.is_empty() {
            return Some(folder);
        }
        for key in path.split('/') {
            folder = self
                .folders
                .iter()
                .find(|(_, candidate)| {
                    candidate.parent.as_ref() == Some(&folder)
                        && candidate.slug_fold == key
                        && candidate.lifecycle == Lifecycle::Active
                })
                .map(|(id, _)| id.clone())?;
        }
        Some(folder)
    }

    pub(super) fn authorize_entry(
        &self,
        ctx: &SpaceContext,
        explicit: Option<&FolderId>,
    ) -> Result<(), PortError> {
        let entry = explicit
            .or_else(|| {
                ctx.auth()
                    .spaces()
                    .get(&self.scope.space_id)?
                    .project_root
                    .as_ref()
            })
            .unwrap_or(&self.root);
        let ancestry = self.ancestry(entry)?;
        if !ancestry.active {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(ctx
            .auth()
            .authorize_folder_read(&self.space, entry, &ancestry.ids)?)
    }

    pub(super) fn authorize_board_source(
        &self,
        ctx: &SpaceContext,
        source: &ViewSource,
        source_folder: Option<&FolderId>,
    ) -> Result<(), PortError> {
        let grant = ctx
            .auth()
            .spaces()
            .get(&self.scope.space_id)
            .ok_or(DomainError::ResourceNotFound)?;
        if !source
            .classes
            .iter()
            .all(|class| grant.read_classes.contains(class))
            || (matches!(
                ctx.auth().kind(),
                notarium_core::auth::PrincipalKind::Keeper(_)
            ) && source.classes.contains(&DocClass::Skill))
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        if let Some(project_root) = grant.project_root.as_ref() {
            let Some(folder) = source_folder else {
                return Err(DomainError::ResourceNotFound.into());
            };
            let ancestry = self.ancestry(folder)?;
            if !ancestry.active || !ancestry.ids.contains(project_root) {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
        Ok(())
    }

    pub(super) fn authorize_placement(
        &self,
        ctx: &SpaceContext,
        parent: &FolderId,
        class: DocClass,
        ability: Option<AbilityId>,
    ) -> Result<(), PortError> {
        let ancestry = self.ancestry(parent)?;
        if !ancestry.active {
            return Err(DomainError::ResourceNotFound.into());
        }
        ctx.auth()
            .authorize_read(&ResourceFacts {
                space: self.space.clone(),
                class,
                project: ancestry
                    .ids
                    .iter()
                    .find(|id| {
                        self.folders
                            .get(*id)
                            .is_some_and(|folder| folder.is_project)
                    })
                    .cloned(),
                ancestor_folders: ancestry.ids,
                folder_write_locked: ancestry.locked,
                ability_package: ability,
            })
            .map_err(|_| DomainError::ResourceNotFound.into())
    }

    pub(super) fn authorize_note(
        &self,
        ctx: &SpaceContext,
        note: &BoardNote,
    ) -> Result<(), PortError> {
        self.authorize_placement(ctx, &note.parent_folder, note.class, note.ability.clone())
    }

    pub(super) fn active_note(
        &self,
        ctx: &SpaceContext,
        id: &NoteId,
    ) -> Result<&BoardNote, PortError> {
        let note = self
            .notes
            .get(id)
            .filter(|note| {
                note.lifecycle == Lifecycle::Active && note.class != DocClass::EncryptedNote
            })
            .ok_or(DomainError::ResourceNotFound)?;
        self.authorize_note(ctx, note)?;
        Ok(note)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn check_live<'a>(
        &self,
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        requested: Option<SpaceSeq>,
        views: impl IntoIterator<Item = (&'a ViewRef, &'a [notarium_core::ports::EvaluatedBoardGroup])>,
        additional: impl IntoIterator<Item = &'a NoteId>,
        auth_folders: impl IntoIterator<Item = &'a FolderId>,
        restorations: impl IntoIterator<Item = &'a notarium_core::ports::PlannedNoteRestoration>,
        deadline: &PlannerDeadline,
    ) -> Result<LiveReadPermit, PortError> {
        deadline.check()?;
        let _admission = engine.current_admission(engine.active_generation())?;
        let permit = engine.live_handle(&self.scope)?.try_read()?;
        if permit.space().lifecycle != SpaceLifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        if permit.head() == self.cutoff {
            // The projection has already checked every row against these same
            // canonical resource facts. Keeping the permit through attestation
            // makes this verification independent of the next write.
            return Ok(permit);
        }
        if requested.is_none() || permit.head() < self.cutoff {
            return Err(stale());
        }

        // Explicit exact past cuts may use historical facts, but never past access.
        let check_note = |id: &NoteId| -> Result<(), PortError> {
            deadline.check()?;
            let LiveNoteStatus::ActiveVisible(facts) = permit.classify(ctx, id, true)? else {
                return Err(DomainError::ResourceNotFound.into());
            };
            Ok(ctx.auth().authorize_read(&facts)?)
        };
        let check_folder = |folder: &FolderId| -> Result<(), PortError> {
            deadline.check()?;
            let facts = permit
                .active_folder_facts(folder, true)
                .ok_or(DomainError::ResourceNotFound)?;
            Ok(ctx
                .auth()
                .authorize_folder_read(&facts.space, folder, &facts.ancestor_folders)?)
        };
        let restorations: Vec<_> = restorations.into_iter().collect();
        let restored_active_views: BTreeSet<&NoteId> = restorations
            .iter()
            .filter(|entry| entry.planned_lifecycle == Lifecycle::Active)
            .map(|entry| &entry.note)
            .collect();
        for folder in auth_folders {
            check_folder(folder)?;
        }
        for (view, groups) in views {
            if !restored_active_views.contains(&view.note) {
                check_note(&view.note)?;
            }
            for row in groups.iter().flat_map(|group| &group.rows) {
                check_note(&row.note)?;
            }
        }
        for id in additional {
            check_note(id)?;
        }
        for restoration in restorations {
            deadline.check()?;
            if restoration.planned_lifecycle == Lifecycle::Active {
                check_folder(&restoration.planned_parent_folder)?;
            }
            match permit.classify(ctx, &restoration.note, false)? {
                LiveNoteStatus::ActiveVisible(facts)
                | LiveNoteStatus::TrashedVisible(facts)
                | LiveNoteStatus::EncryptedVisible { facts, .. } => {
                    ctx.auth().authorize_read(&facts)?;
                }
                LiveNoteStatus::HiddenByAuth { .. } | LiveNoteStatus::PurgedOrAbsent => {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
        }
        Ok(permit)
    }
}

impl BoardNote {
    fn evaluate_fields(&mut self, schema: Option<&BTreeMap<String, FieldSchema>>) {
        if self.class != DocClass::EncryptedNote {
            self.fields = evaluate_fields_with_schema(
                self.raw_fields.as_ref(),
                self.diagnostic.as_ref(),
                schema,
            );
        }
    }

    fn from_derived(row: ProjectedNote, read_views: bool) -> Result<Self, PortError> {
        let updated_at = row.updated_at()?;
        let fields = row.evaluated_fields()?;
        let inline_tags: Vec<String> = decode_payload(&row.tags_msgpack)?;
        let raw_fields: Option<BTreeMap<String, YamlValue>> =
            decode_payload(&row.raw_fields_msgpack)?;
        let tags = effective_tags(&inline_tags, raw_fields.as_ref())
            .into_iter()
            .collect();
        let diagnostic = decode_payload(&row.header_diagnostic_msgpack)?;
        let views = if read_views {
            decode_payload(&row.view_blocks_msgpack)?
        } else {
            Vec::new()
        };
        Ok(Self {
            revision: row.rev_id,
            parent_folder: row.parent_folder_id,
            class: row.doc_class,
            ability: row.ability_id,
            lifecycle: row.lifecycle,
            updated_at,
            digest: row.content_digest,
            inline_tags,
            tags,
            raw_fields,
            diagnostic,
            fields,
            views,
        })
    }

    fn from_canonical(
        note: ProjectionNote,
        schema: Option<&BTreeMap<String, FieldSchema>>,
        inline_tags: Vec<String>,
        views: Vec<ViewInput>,
    ) -> Self {
        let meta = note.metadata;
        let (raw_fields, diagnostic, fields) = if meta.doc_class == DocClass::EncryptedNote {
            (None, None, BTreeMap::new())
        } else {
            let fields = evaluate_fields_with_schema(
                meta.raw_fields.as_ref(),
                note.header_diagnostic.as_ref(),
                schema,
            );
            (meta.raw_fields, note.header_diagnostic, fields)
        };
        let tags = effective_tags(&inline_tags, raw_fields.as_ref())
            .into_iter()
            .collect();
        Self {
            revision: note.revision_id,
            parent_folder: meta.parent_folder_id,
            class: meta.doc_class,
            ability: meta.ability_id,
            lifecycle: meta.lifecycle,
            updated_at: note.updated_at,
            digest: meta.content_digest,
            inline_tags,
            tags,
            raw_fields,
            diagnostic,
            fields,
            views,
        }
    }
}

impl BoardRank {
    fn from_derived(row: ProjectedViewRank) -> (NoteId, Self) {
        (
            row.target_note_id,
            Self {
                revision: row.rank_rev_id,
                group_hex: row.group_key_hex,
                rank: row.sort_rank_lexo,
            },
        )
    }
}

fn parse_structure(
    carrier: Option<&str>,
    note: &ProjectionNote,
    read_views: bool,
) -> Result<(Vec<String>, Vec<ViewInput>), PortError> {
    let Some(carrier) = carrier else {
        return Ok((Vec::new(), Vec::new()));
    };
    match extract(
        carrier,
        note.metadata.doc_class,
        &note.metadata.note_id,
        &note.metadata.title,
        None,
    )? {
        ExtractedDocDelta::Plain(doc) => Ok((
            doc.tags.into_iter().map(|tag| tag.key).collect(),
            if read_views {
                doc.views.into_iter().map(ViewInput::from).collect()
            } else {
                Vec::new()
            },
        )),
        ExtractedDocDelta::Encrypted(_) => Err(stale()),
    }
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

fn index_error(error: impl std::fmt::Display) -> PortError {
    internal_not_committed("board_cut_index", error.to_string())
}

pub(super) struct PlannerDeadline {
    start: Instant,
    limit: Duration,
    cancellation: Cancellation,
}

impl PlannerDeadline {
    pub(super) fn start(ctx: &SpaceContext) -> Self {
        Self {
            start: Instant::now(),
            limit: ctx.budget.remaining,
            cancellation: ctx.budget.cancellation.clone(),
        }
    }

    fn remaining(&self) -> Result<Duration, PortError> {
        if self.cancellation.is_cancelled() {
            return Err(cancelled_not_committed("board_planner", "caller cancelled"));
        }
        let remaining = self.limit.saturating_sub(self.start.elapsed());
        if remaining.is_zero() {
            return Err(deadline_not_committed(
                "board_planner",
                "board plan exceeded request budget",
            ));
        }
        Ok(remaining)
    }

    pub(super) fn check(&self) -> Result<(), PortError> {
        self.remaining().map(|_| ())
    }

    async fn wait<T>(
        &self,
        operation: impl Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        let remaining = self.remaining()?;
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => {
                Err(cancelled_not_committed("board_planner", "caller cancelled"))
            }
            _ = tokio::time::sleep(remaining) => {
                Err(deadline_not_committed("board_planner", "board plan exceeded request budget"))
            }
            result = operation => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{evaluate_move, evaluate_rollback};
    use notarium_core::{
        auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
        ids::{GrantId, HistoryIncarnation, PrincipalId, RequestId, SpaceId, ViewKey},
        ports::{
            BoardGroupFieldKind, CallBudget, GroupKey, MoveBoardCard, PlannedNoteRestoration,
            RankExpectation, RollbackBoardFactsRequest, SemanticPlacement,
        },
        value::ScalarValue,
    };

    fn group(label: &str) -> GroupKey {
        GroupKey::Value(ScalarValue::String(label.to_owned()))
    }

    fn note(
        id: u8,
        parent: &FolderId,
        class: DocClass,
        status: Option<&str>,
        extra: &str,
    ) -> (NoteId, BoardNote) {
        let id = NoteId::from_bytes([id; 16]);
        let carrier = format!("---\nstatus: {}\n---\n{extra}", status.unwrap_or("none"));
        let ExtractedDocDelta::Plain(doc) = extract(&carrier, class, &id, "", None).unwrap() else {
            panic!("fixture is a plaintext note");
        };
        let inline_tags: Vec<String> = doc.tags.into_iter().map(|tag| tag.key).collect();
        let raw_fields = doc.fields;
        let diagnostic = doc.diagnostics.first().cloned();
        let fields = evaluate_fields_with_schema(raw_fields.as_ref(), diagnostic.as_ref(), None);
        let tags = effective_tags(&inline_tags, raw_fields.as_ref())
            .into_iter()
            .collect();
        (
            id,
            BoardNote {
                revision: RevisionId::from_bytes([8; 16]),
                parent_folder: parent.clone(),
                class,
                ability: None,
                lifecycle: Lifecycle::Active,
                updated_at: Timestamp::from_unix_parts(1, 0).unwrap(),
                digest: None,
                inline_tags,
                tags,
                raw_fields,
                diagnostic,
                fields,
                views: doc.views.into_iter().map(ViewInput::from).collect(),
            },
        )
    }

    fn fixture(source: &str) -> (BoardCut, SpaceContext, ViewRef) {
        let space_id = SpaceId::from_bytes([1; 16]);
        let root = FolderId::from_bytes([2; 16]);
        let scope = HistoryScope {
            space_id: space_id.clone(),
            incarnation: HistoryIncarnation::from_bytes([3; 16]),
        };
        let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes([4; 16]),
            GrantId::from_bytes([5; 16]),
            BTreeMap::from([(
                space_id.clone(),
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: BTreeSet::from([DocClass::UserDoc]),
                    write_classes: BTreeSet::from([DocClass::UserDoc]),
                    project_root: None,
                },
            )]),
            false,
        ));
        let ctx = SpaceContext::new(
            auth,
            scope.clone(),
            CallBudget {
                request: RequestId::from_bytes([6; 16]),
                cancellation: Cancellation::default(),
                remaining: Duration::from_secs(10),
            },
        )
        .unwrap();
        let key = ViewKey::from_bytes([7; 16]);
        let carrier = format!(
            "```nota\nid: {}\ntype: board\ngroup_by: status\n{source}```\n",
            key.as_str()
        );
        let (view_note, definition) = note(7, &root, DocClass::UserDoc, Some("none"), &carrier);
        let view = ViewRef {
            note: view_note.clone(),
            key,
        };
        let cut = BoardCut {
            scope,
            cutoff: SpaceSeq::new(9).unwrap(),
            space: Space {
                id: space_id,
                lifecycle: SpaceLifecycle::Active,
                kind: SpaceKind::Shared,
            },
            root: root.clone(),
            schema: None,
            folders: BTreeMap::from([(
                root,
                BoardFolder {
                    parent: None,
                    slug_fold: String::new(),
                    lifecycle: Lifecycle::Active,
                    locked: false,
                    is_project: false,
                },
            )]),
            notes: BTreeMap::from([(view_note, definition)]),
            ranks: BTreeMap::new(),
        };
        (cut, ctx, view)
    }

    fn intent(view: ViewRef, target: NoteId) -> MoveBoardCard {
        MoveBoardCard {
            view,
            note: target,
            group: group("doing"),
            before: None,
            after: None,
            fields: BTreeMap::from([(
                "status".to_owned(),
                Some(YamlValue::String("doing".to_owned())),
            )]),
            expected_note: RevisionId::from_bytes([8; 16]),
            expected_view: RevisionId::from_bytes([8; 16]),
            expected_rank: RankExpectation::Absent,
        }
    }

    #[test]
    fn denied_row_in_third_group_rejects_entire_plan() {
        let (mut cut, ctx, view) = fixture("source: {classes: [user-doc, profile]}\n");
        let (target, card) = note(10, &cut.root, DocClass::UserDoc, Some("todo"), "");
        cut.notes.insert(target.clone(), card);
        let (hidden, profile) = note(11, &cut.root, DocClass::Profile, Some("done"), "");
        cut.notes.insert(hidden, profile);
        assert!(matches!(
            evaluate_move(
                &cut,
                &ctx,
                &intent(view, target),
                &PlannerDeadline::start(&ctx)
            ),
            Err(PortError::Domain(DomainError::ResourceNotFound)),
        ));
    }

    #[test]
    fn expected_rank_is_preserved_when_card_is_in_a_different_group() {
        let (mut cut, ctx, view) = fixture("");
        let (target, target_note) = note(10, &cut.root, DocClass::UserDoc, Some("todo"), "");
        let (peer, peer_note) = note(11, &cut.root, DocClass::UserDoc, Some("todo"), "");
        cut.notes
            .extend([(target.clone(), target_note), (peer.clone(), peer_note)]);
        let target_revision = RevisionId::from_bytes([12; 16]);
        cut.ranks.insert(
            view.clone(),
            BTreeMap::from([
                (
                    target.clone(),
                    BoardRank {
                        revision: target_revision.clone(),
                        group_hex: group_key_hex(&group("done")).unwrap().1,
                        rank: "A".into(),
                    },
                ),
                (
                    peer.clone(),
                    BoardRank {
                        revision: RevisionId::from_bytes([13; 16]),
                        group_hex: group_key_hex(&group("todo")).unwrap().1,
                        rank: "B".into(),
                    },
                ),
            ]),
        );
        let (facts, _) = evaluate_move(
            &cut,
            &ctx,
            &intent(view, target.clone()),
            &PlannerDeadline::start(&ctx),
        )
        .unwrap();
        let todo = facts
            .groups
            .iter()
            .find(|column| column.group == group("todo"))
            .unwrap();
        assert_eq!(&todo.rows[0].note, &peer);
        assert_eq!(&todo.rows[1].note, &target);
        assert_eq!(
            todo.rows[1].expected_rank,
            RankExpectation::Existing(target_revision)
        );
        assert_eq!(facts.group_field_kind, BoardGroupFieldKind::Scalar);
        assert!(facts.after_eligible_in_group);
        assert!(
            facts
                .groups
                .iter()
                .any(|column| column.group == group("doing") && column.rows.is_empty())
        );
        assert_eq!(
            facts.before_placement,
            SemanticPlacement::InGroup {
                group: group("todo"),
                predecessor: Some(peer),
                successor: None
            }
        );
    }

    #[test]
    fn proposed_frontmatter_tags_participate_in_board_eligibility() {
        let (mut cut, ctx, view) = fixture("source: {tags: [work]}\n");
        let (target, note) = note(10, &cut.root, DocClass::UserDoc, Some("todo"), "");
        cut.notes.insert(target.clone(), note);
        let mut move_card = intent(view, target.clone());
        let deadline = PlannerDeadline::start(&ctx);
        assert!(
            !evaluate_move(&cut, &ctx, &move_card, &deadline)
                .unwrap()
                .0
                .after_eligible_in_group
        );
        move_card.fields.insert(
            "tags".into(),
            Some(YamlValue::Sequence(vec![YamlValue::String("work".into())])),
        );
        assert!(
            evaluate_move(&cut, &ctx, &move_card, &deadline)
                .unwrap()
                .0
                .after_eligible_in_group
        );
    }

    #[test]
    fn rollback_uses_the_restored_parent_and_respects_trashed_ancestors() {
        let (mut cut, ctx, view) = fixture("source: {scope: folder, folder: recovered}\n");
        let restored_parent = FolderId::from_bytes([9; 16]);
        cut.folders.insert(
            restored_parent.clone(),
            BoardFolder {
                parent: Some(cut.root.clone()),
                slug_fold: "recovered".to_owned(),
                lifecycle: Lifecycle::Active,
                locked: false,
                is_project: false,
            },
        );
        let (target, note) = note(10, &cut.root, DocClass::UserDoc, Some("done"), "");
        let request = RollbackBoardFactsRequest {
            cutoff: None,
            views: vec![view.clone()],
            eligible_notes: vec![PlannedNoteRestoration {
                note: target.clone(),
                current_revision: note.revision.clone(),
                restored_from_revision: Some(RevisionId::from_bytes([4; 16])),
                planned_lifecycle: Lifecycle::Active,
                planned_parent_folder: restored_parent.clone(),
                planned_class: DocClass::UserDoc,
                planned_ability: None,
                planned_header_diagnostic: None,
                planned_carrier: None,
                planned_fields: BTreeMap::from([(
                    "status".to_owned(),
                    Some(YamlValue::String("todo".to_owned())),
                )]),
            }],
        };
        cut.notes.insert(target.clone(), note);
        let deadline = PlannerDeadline::start(&ctx);
        let (facts, _) = evaluate_rollback(&cut, &ctx, &request, &deadline).unwrap();
        assert_eq!(
            facts[&view].post_restore_membership[&target],
            Some(group("todo"))
        );
        assert!(
            facts[&view]
                .groups
                .iter()
                .all(|column| column.rows.is_empty())
        );

        // The board's folder itself must stay active. Trash a descendant that
        // was the earlier placement of the restored card.
        let child = FolderId::from_bytes([11; 16]);
        cut.folders.insert(
            child.clone(),
            BoardFolder {
                parent: Some(restored_parent.clone()),
                slug_fold: "child".to_owned(),
                lifecycle: Lifecycle::Trashed,
                locked: false,
                is_project: false,
            },
        );
        let mut request = request;
        request.eligible_notes[0].planned_parent_folder = child;
        let (facts, auth_folders) = evaluate_rollback(&cut, &ctx, &request, &deadline).unwrap();
        assert_eq!(facts[&view].post_restore_membership[&target], None);
        assert!(auth_folders.contains(&restored_parent));
    }

    #[test]
    fn static_source_auth_rejects_oracle_even_when_filter_matches_no_notes() {
        // Class oracle: source includes profile, caller only has UserDoc, and
        // filter matches ZERO notes — must still reject statically before filter evaluation.
        let (mut cut, ctx, view) = fixture(
            "source: {classes: [user-doc, profile]}\nfilter: {eq: {key: secret, value: miss}}\n",
        );
        let (target, card) = note(20, &cut.root, DocClass::UserDoc, Some("todo"), "");
        cut.notes.insert(target.clone(), card);
        assert!(matches!(
            evaluate_move(
                &cut,
                &ctx,
                &intent(view, target),
                &PlannerDeadline::start(&ctx)
            ),
            Err(PortError::Domain(DomainError::ResourceNotFound)),
        ));

        // Project-root oracle: caller pinned to a project cannot evaluate a
        // space-wide board even when no out-of-project notes match the filter.
        let (mut cut, mut ctx, view) =
            fixture("source: {scope: space}\nfilter: {eq: {key: secret, value: miss}}\n");
        let project = FolderId::from_bytes([21; 16]);
        cut.folders.insert(
            project.clone(),
            BoardFolder {
                parent: Some(cut.root.clone()),
                slug_fold: "proj".to_owned(),
                lifecycle: Lifecycle::Active,
                locked: false,
                is_project: true,
            },
        );
        // Move the view carrier inside the caller's project so only the board source escapes.
        cut.notes.get_mut(&view.note).unwrap().parent_folder = project.clone();
        let (target, card) = note(22, &project, DocClass::UserDoc, Some("todo"), "");
        cut.notes.insert(target.clone(), card);
        let scoped_auth = EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes([4; 16]),
            GrantId::from_bytes([5; 16]),
            BTreeMap::from([(
                cut.scope.space_id.clone(),
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: BTreeSet::from([DocClass::UserDoc]),
                    write_classes: BTreeSet::from([DocClass::UserDoc]),
                    project_root: Some(project),
                },
            )]),
            false,
        ));
        ctx = SpaceContext::new(scoped_auth, cut.scope.clone(), ctx.budget.clone()).unwrap();
        assert!(matches!(
            evaluate_move(
                &cut,
                &ctx,
                &intent(view, target),
                &PlannerDeadline::start(&ctx)
            ),
            Err(PortError::Domain(DomainError::ResourceNotFound)),
        ));
    }

    #[tokio::test]
    async fn check_live_rejects_hidden_or_purged_restorations_and_closed_admission() {
        use crate::{ProjectionConfig, ProjectorRuntime};
        use notarium_canonical::{
            CanonicalConfig, CanonicalRuntime, CreateFolderSpec, CreateSpaceSpec,
        };
        use notarium_core::{
            epoch::DataRoot,
            ids::{CommandKey, InstallationId, LeaseEpoch, ProjectionGeneration},
            ports::{
                CreateNote, DeleteDisposition, DeleteNote, MaintenanceContext, MoveNote, Mutation,
                NoteWritePort, Preconditions, ServiceAuthority, ServicePurpose,
            },
            receipt::CommandIdentity,
        };

        let dir = std::env::temp_dir().join(format!(
            "notarium-board-cut-{}",
            hex::encode(notarium_canonical::codec::csprng_16().unwrap())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = DataRoot::new(dir.clone());
        let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
            InstallationId::from_bytes([1; 16]),
            root.clone(),
        ))
        .await
        .unwrap();
        let actor = PrincipalId::from_bytes([2; 16]);
        let space = store
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([3; 16]),
                incarnation: HistoryIncarnation::from_bytes([4; 16]),
                root_folder_id: FolderId::from_bytes([5; 16]),
                slug: "board-cut-live".into(),
                kind: SpaceKind::Shared,
                owner: actor.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let scope = space.scope.clone();
        let project_a = FolderId::from_bytes([6; 16]);
        let project_b = FolderId::from_bytes([7; 16]);
        for (folder_id, slug) in [(&project_a, "proj-a"), (&project_b, "proj-b")] {
            store
                .create_folder(CreateFolderSpec {
                    scope: scope.clone(),
                    active_epoch: space.active_epoch,
                    folder_id: folder_id.clone(),
                    parent: None,
                    slug: slug.into(),
                    display_name: slug.into(),
                    is_project: true,
                    project_slug: Some(slug.into()),
                    actor: actor.clone(),
                    timestamp: None,
                })
                .await
                .unwrap();
        }
        let budget = CallBudget {
            request: RequestId::from_bytes([8; 16]),
            cancellation: Default::default(),
            remaining: Duration::from_secs(5),
        };
        let owner = SpaceContext::new(
            EngineAuthContext::for_human(VerifiedHuman::attest(
                actor.clone(),
                GrantId::from_bytes([9; 16]),
                BTreeMap::from([(
                    scope.space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Owner,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: None,
                    },
                )]),
                true,
            )),
            scope.clone(),
            budget.clone(),
        )
        .unwrap();
        let scoped = SpaceContext::new(
            EngineAuthContext::for_human(VerifiedHuman::attest(
                PrincipalId::from_bytes([10; 16]),
                GrantId::from_bytes([11; 16]),
                BTreeMap::from([(
                    scope.space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Editor,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: Some(project_a.clone()),
                    },
                )]),
                false,
            )),
            scope.clone(),
            budget.clone(),
        )
        .unwrap();
        let proj_ctx = MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Projection),
            budget: budget.clone(),
        };
        let runtime = ProjectorRuntime::start_sqlite(
            store.clone(),
            proj_ctx,
            root,
            ProjectionGeneration::new(1).unwrap(),
            ProjectionConfig::default(),
        )
        .await
        .unwrap();
        let engine = runtime.engine();

        let view_key = ViewKey::from_bytes([12; 16]);
        let board_id = NoteId::from_bytes([13; 16]);
        let moved_id = NoteId::from_bytes([14; 16]);
        let purged_id = NoteId::from_bytes([15; 16]);
        let make_cmd = |seed: u8| CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([seed; 16]),
            hash: ContentDigest::from_bytes([seed; 32]),
        };
        store
            .create_note(
                owner.clone(),
                Mutation {
                    identity: make_cmd(20),
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        folder_page: false,
                        note: board_id.clone(),
                        parent: Some(project_a.clone()),
                        slug: "board".into(),
                        class: DocClass::UserDoc,
                        carrier: format!(
                            "```nota\nid: {view_key}\ntype: board\nsource: {{scope: folder, folder: {project_a}}}\ngroup_by: status\n```\n"
                        ),
                    },
                },
            )
            .await
            .unwrap();
        let moved_created = store
            .create_note(
                owner.clone(),
                Mutation {
                    identity: make_cmd(21),
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        folder_page: false,
                        note: moved_id.clone(),
                        parent: Some(project_a.clone()),
                        slug: "moved".into(),
                        class: DocClass::UserDoc,
                        carrier: "---\nstatus: todo\n---\n".into(),
                    },
                },
            )
            .await
            .unwrap();
        let purged_created = store
            .create_note(
                owner.clone(),
                Mutation {
                    identity: make_cmd(22),
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        folder_page: false,
                        note: purged_id.clone(),
                        parent: Some(project_a.clone()),
                        slug: "purged".into(),
                        class: DocClass::UserDoc,
                        carrier: "---\nstatus: todo\n---\n".into(),
                    },
                },
            )
            .await
            .unwrap();
        let past_cutoff = purged_created.receipt.seq();
        engine
            .wait_for_projected(&scope, past_cutoff, &budget)
            .await
            .unwrap();

        // 1. Move moved_id out of project_a -> project_b (no purge fence yet), load BoardCut
        //    at past_cutoff, and prove check_live rejects the HiddenByAuth restoration.
        let moved_receipt = store
            .move_note(
                owner.clone(),
                Mutation {
                    identity: make_cmd(23),
                    preconditions: Preconditions::default(),
                    input: MoveNote {
                        note: moved_id.clone(),
                        parent: Some(project_b.clone()),
                        slug: "moved".into(),
                    },
                },
            )
            .await
            .unwrap();
        engine
            .wait_for_projected(&scope, moved_receipt.receipt.seq(), &budget)
            .await
            .unwrap();

        let view_ref = ViewRef {
            note: board_id.clone(),
            key: view_key,
        };
        let deadline = PlannerDeadline::start(&scoped);
        let cut = BoardCut::load(
            &engine,
            &scoped,
            Some(past_cutoff),
            [&view_ref],
            [&moved_id, &purged_id],
            &[],
            &deadline,
        )
        .await
        .unwrap();
        let hidden_restoration = PlannedNoteRestoration {
            note: moved_id,
            current_revision: moved_created.value.revision,
            restored_from_revision: None,
            planned_lifecycle: Lifecycle::Active,
            planned_parent_folder: project_a.clone(),
            planned_class: DocClass::UserDoc,
            planned_ability: None,
            planned_fields: BTreeMap::new(),
            planned_header_diagnostic: None,
            planned_carrier: None,
        };
        assert!(matches!(
            cut.check_live(
                &engine,
                &scoped,
                Some(past_cutoff),
                std::iter::empty(),
                std::iter::empty(),
                std::iter::empty(),
                std::iter::once(&hidden_restoration),
                &deadline,
            ),
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));

        // 2. Now purge purged_id concurrently after BoardCut::load and prove check_live
        //    rejects the PurgedOrAbsent restoration instead of silently skipping it.
        let purged_receipt = store
            .delete_note(
                owner.clone(),
                Mutation {
                    identity: make_cmd(24),
                    preconditions: Preconditions::default(),
                    input: DeleteNote {
                        note: purged_id.clone(),
                        disposition: DeleteDisposition::Purge,
                    },
                },
            )
            .await
            .unwrap();
        engine
            .wait_for_projected(&scope, purged_receipt.receipt.seq(), &budget)
            .await
            .unwrap();
        let purged_restoration = PlannedNoteRestoration {
            note: purged_id,
            current_revision: purged_created.value.revision,
            restored_from_revision: None,
            planned_lifecycle: Lifecycle::Active,
            planned_parent_folder: project_a,
            planned_class: DocClass::UserDoc,
            planned_ability: None,
            planned_fields: BTreeMap::new(),
            planned_header_diagnostic: None,
            planned_carrier: None,
        };
        assert!(matches!(
            cut.check_live(
                &engine,
                &scoped,
                Some(past_cutoff),
                std::iter::empty(),
                std::iter::empty(),
                std::iter::empty(),
                std::iter::once(&purged_restoration),
                &deadline,
            ),
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));

        // After shutdown (`publication_closed == true`), both BoardCut::check_live and BoardCut::load
        // must fail closed with NotReady.
        runtime.shutdown().await.unwrap();
        assert!(matches!(
            cut.check_live(
                &engine,
                &owner,
                Some(past_cutoff),
                std::iter::empty(),
                std::iter::empty(),
                std::iter::empty(),
                std::iter::empty(),
                &deadline,
            ),
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::NotReady
        ));
        assert!(matches!(
            BoardCut::load(
                &engine,
                &owner,
                Some(past_cutoff),
                [&view_ref],
                std::iter::empty(),
                &[],
                &deadline,
            )
            .await,
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::NotReady
        ));

        canonical.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
