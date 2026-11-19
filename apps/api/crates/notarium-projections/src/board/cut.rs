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
    ports::{Cancellation, PageLimit, SpaceContext, ViewRef},
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

use super::board_plan;

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
    pub(super) async fn load<'a>(
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        requested: Option<SpaceSeq>,
        views: impl IntoIterator<Item = &'a ViewRef>,
        additional_notes: impl IntoIterator<Item = &'a NoteId>,
        deadline: &PlannerDeadline,
    ) -> Result<Self, PortError> {
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
        let projected = published.cut.projected_seq.min(header.cutoff);
        if header.cutoff.get() - projected.get() > MAX_REPLAY_EVENTS {
            return Err(stale());
        }

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
        let limit = PageLimit::new(200)?;
        let mut after_folder = None;
        loop {
            let rows = deadline
                .wait(
                    published
                        .store
                        .folders_page(&cut.scope, projected, after_folder, limit),
                )
                .await?;
            after_folder = rows.last().map(|folder| folder.dense_folder_id);
            let complete = rows.len() < usize::from(limit.get());
            for folder in rows {
                cut.insert_folder(folder);
            }
            if complete {
                break;
            }
        }

        let view_notes: BTreeSet<_> = views.iter().map(|view| &view.note).collect();
        let use_index = published.cut.projected_seq <= cut.cutoff;
        if use_index {
            let needed: BTreeSet<_> = view_notes
                .iter()
                .copied()
                .cloned()
                .chain(additional_notes.into_iter().cloned())
                .collect();
            for id in needed {
                if let Some(note) = deadline
                    .wait(published.store.note_by_id(&cut.scope, projected, &id))
                    .await?
                {
                    let read_views = view_notes.contains(&id);
                    cut.notes
                        .insert(id, BoardNote::from_derived(note, read_views)?);
                }
            }
        } else {
            cut.hydrate_temporal_notes(&published, projected, &view_notes, limit, deadline)
                .await?;
        }

        for view in &views {
            let mut after_rank = None;
            let mut ranks = BTreeMap::new();
            loop {
                let rows = deadline
                    .wait(published.store.view_rank_page(
                        &cut.scope,
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
            cut.ranks.insert(view.clone(), ranks);
        }

        let replayed = if projected < cut.cutoff {
            cut.replay(engine, ctx, &published, &views, &view_notes, deadline)
                .await?
        } else {
            ReplayedChanges::default()
        };
        if use_index {
            cut.hydrate_candidates(engine, ctx, &published, &views, &replayed, deadline)
                .await?;
        }
        Ok(cut)
    }

    async fn hydrate_candidates(
        &mut self,
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        published: &PublishedCut,
        views: &BTreeSet<ViewRef>,
        replayed: &ReplayedChanges,
        deadline: &PlannerDeadline,
    ) -> Result<(), PortError> {
        let index = engine.open_index(published)?;
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
        let mut candidates = croaring::Bitmap::new();
        for view in views {
            deadline.check()?;
            let plan = board_plan(self, ctx, view)?;
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
                candidates.or_inplace(&matches.possible);
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

    async fn hydrate_temporal_notes(
        &mut self,
        published: &PublishedCut,
        projected: SpaceSeq,
        view_notes: &BTreeSet<&NoteId>,
        limit: PageLimit,
        deadline: &PlannerDeadline,
    ) -> Result<(), PortError> {
        let mut after = None;
        loop {
            let rows = deadline
                .wait(
                    published
                        .store
                        .notes_page(&self.scope, projected, after, limit),
                )
                .await?;
            after = rows.last().map(|note| note.dense_id);
            let complete = rows.len() < usize::from(limit.get());
            for note in rows {
                let id = note.note_id.clone();
                let read_views = view_notes.contains(&id);
                self.notes
                    .insert(id, BoardNote::from_derived(note, read_views)?);
            }
            if complete {
                return Ok(());
            }
        }
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

    pub(super) fn check_live<'a>(
        &self,
        engine: &ProjectionEngine,
        ctx: &SpaceContext,
        requested: Option<SpaceSeq>,
        views: impl IntoIterator<Item = (&'a ViewRef, &'a [notarium_core::ports::EvaluatedBoardGroup])>,
        additional: impl IntoIterator<Item = &'a NoteId>,
        deadline: &PlannerDeadline,
    ) -> Result<LiveReadPermit, PortError> {
        deadline.check()?;
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

        // Explicit exact past cuts may use retained rows, but never past access.
        let check = |id: &NoteId| -> Result<(), PortError> {
            deadline.check()?;
            let LiveNoteStatus::ActiveVisible(facts) = permit.classify(ctx, id, true)? else {
                return Err(DomainError::ResourceNotFound.into());
            };
            Ok(ctx.auth().authorize_read(&facts)?)
        };
        for (view, groups) in views {
            check(&view.note)?;
            for row in groups.iter().flat_map(|group| &group.rows) {
                check(&row.note)?;
            }
        }
        for id in additional {
            check(id)?;
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
        let facts = evaluate_move(
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
                .after_eligible_in_group
        );
        move_card.fields.insert(
            "tags".into(),
            Some(YamlValue::Sequence(vec![YamlValue::String("work".into())])),
        );
        assert!(
            evaluate_move(&cut, &ctx, &move_card, &deadline)
                .unwrap()
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
        let facts = evaluate_rollback(&cut, &ctx, &request, &deadline).unwrap();
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
                parent: Some(restored_parent),
                slug_fold: "child".to_owned(),
                lifecycle: Lifecycle::Trashed,
                locked: false,
                is_project: false,
            },
        );
        let mut request = request;
        request.eligible_notes[0].planned_parent_folder = child;
        let facts = evaluate_rollback(&cut, &ctx, &request, &deadline).unwrap();
        assert_eq!(facts[&view].post_restore_membership[&target], None);
    }
}
