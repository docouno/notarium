use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use croaring::Bitmap;
use notarium_canonical::{
    LiveNoteStatus, LiveReadPermit,
    codec::{group_key_hex, internal_not_committed},
    projection_read::ProjectionRank,
};
use notarium_core::{
    DomainError,
    auth::ResourceFacts,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{AbilityId, FolderId, NoteId, ProjectionGeneration, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::{BoardDelta, PageLimit, SpaceContext, ViewRef},
};
use tokio::time::{Instant, timeout_at};

use crate::{
    derived::ProjectedNote,
    index::{IndexView, PostingKey},
    nota::{NotaDescriptor, ViewKind},
    query::{self, WindowInput},
};

use super::{
    ProjectionEngine, PublishedCut,
    records::{FolderLocation, decode, effective_tags, note_raw_fields},
};

pub(super) const MAX_BOARD_EVENT_ITEMS: usize = 200;
const BOARD_EVENT_BUDGET: Duration = Duration::from_millis(240);

#[derive(Default)]
pub(super) struct AffectedBoards {
    views: BTreeMap<ViewRef, BTreeSet<NoteId>>,
    targets: usize,
    incomplete: bool,
}

impl AffectedBoards {
    pub(super) fn record(&mut self, rank: &ProjectionRank, changes_placement: bool) {
        let metadata = &rank.metadata;
        let view = ViewRef {
            note: metadata.view_note_id.clone(),
            key: metadata.view_key.clone(),
        };
        // Keep one extra view to detect command-wide fanout.
        if self.views.len() > MAX_BOARD_EVENT_ITEMS && !self.views.contains_key(&view) {
            return;
        }
        let targets = self.views.entry(view).or_default();
        if changes_placement && !targets.contains(&metadata.target_note_id) {
            if self.targets < MAX_BOARD_EVENT_ITEMS {
                targets.insert(metadata.target_note_id.clone());
                self.targets += 1;
            } else {
                self.incomplete = true;
            }
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.views.is_empty()
    }

    pub(super) fn fanout(&self) -> bool {
        self.views.len() > MAX_BOARD_EVENT_ITEMS
    }
}

struct BoardNoteFacts {
    class: DocClass,
    ability: Option<AbilityId>,
    ancestors: Vec<FolderId>,
    write_locked: bool,
}

impl BoardNoteFacts {
    fn new(note: &ProjectedNote, location: FolderLocation) -> Self {
        Self {
            class: note.doc_class,
            ability: note.ability_id.clone(),
            ancestors: location.ids,
            write_locked: location.write_locked,
        }
    }

    fn visible(&self, ctx: &SpaceContext, permit: &LiveReadPermit) -> bool {
        ctx.auth()
            .can_view_resource(&ResourceFacts {
                space: permit.space().clone(),
                class: self.class,
                ancestor_folders: self.ancestors.clone(),
                folder_write_locked: self.write_locked,
                ability_package: self.ability.clone(),
            })
            .is_ok()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum BoardAudience {
    Full,
    Scoped,
}

/// Source facts observed at the command cutoff and independent of SQL retention.
pub(super) struct BoardSourceFacts {
    carrier: BoardNoteFacts,
    source_folder: Option<(FolderId, Vec<FolderId>)>,
    source_classes: BTreeSet<DocClass>,
    recursive: bool,
    requires_folder_grant: bool,
}

impl BoardSourceFacts {
    pub(super) fn audience(
        &self,
        ctx: &SpaceContext,
        permit: &LiveReadPermit,
    ) -> Option<BoardAudience> {
        let space = permit.space();
        let auth = ctx.auth();
        let grant = auth.spaces().get(&space.id)?;
        if self.source_classes.is_disjoint(&grant.read_classes)
            || !self.carrier.visible(ctx, permit)
        {
            return None;
        }
        let full_folder = match &self.source_folder {
            Some((folder, ancestors)) => {
                let current = permit.folder_facts(folder)?;
                auth.can_view_folder(space, folder, ancestors).is_ok()
                    && auth
                        .authorize_folder_read(space, folder, &current.ancestor_folders)
                        .is_ok()
            }
            None => grant.project_root.is_none(),
        };
        if self.requires_folder_grant && !full_folder {
            return None;
        }
        Some(
            if full_folder && self.source_classes.is_subset(&grant.read_classes) {
                BoardAudience::Full
            } else {
                BoardAudience::Scoped
            },
        )
    }

    fn folder(&self) -> Option<&FolderId> {
        self.source_folder.as_ref().map(|(id, _)| id)
    }

    fn contains(&self, facts: &ResourceFacts) -> bool {
        self.source_classes.contains(&facts.class)
            && self.folder().is_none_or(|folder| {
                facts.ancestor_folders.first() == Some(folder)
                    || (self.recursive && facts.ancestor_folders.contains(folder))
            })
    }
}

pub(super) struct AffectedCardAtCut {
    note: NoteId,
    facts: BoardNoteFacts,
}

#[derive(Clone)]
pub(super) struct ScrubbableBoardDelta(Arc<Mutex<Option<BoardDelta>>>);

impl ScrubbableBoardDelta {
    pub(super) fn new(delta: BoardDelta) -> Self {
        Self(Arc::new(Mutex::new(Some(delta))))
    }

    pub(super) fn downgrade(&self) -> Weak<Mutex<Option<BoardDelta>>> {
        Arc::downgrade(&self.0)
    }

    pub(super) fn clone_payload(&self) -> Option<BoardDelta> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[derive(Clone)]
pub(super) struct BoardNotice {
    pub(super) scope: HistoryScope,
    pub(super) seq: SpaceSeq,
    pub(super) generation: ProjectionGeneration,
    pub(super) view: ViewRef,
    pub(super) source: Arc<BoardSourceFacts>,
    pub(super) affected: Arc<[AffectedCardAtCut]>,
    pub(super) delta: Option<ScrubbableBoardDelta>,
}

impl BoardNotice {
    pub(super) fn affected_visible(
        &self,
        ctx: &SpaceContext,
        permit: &LiveReadPermit,
        current_source: &BoardSourceFacts,
    ) -> Result<bool, PortError> {
        for card in self.affected.iter() {
            if !card.facts.visible(ctx, permit) {
                continue;
            }
            if let LiveNoteStatus::ActiveVisible(current) =
                permit.classify(ctx, &card.note, true)?
                && current_source.contains(&current)
                && ctx.auth().can_view_resource(&current).is_ok()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(super) struct BoardAssembly {
    pub(super) notices: Vec<BoardNotice>,
    pub(super) proof_incomplete: bool,
}

pub(super) struct BoardDefinition {
    pub(super) source: BoardSourceFacts,
    descriptor: NotaDescriptor,
}

impl ProjectionEngine {
    pub(super) async fn board_definition(
        &self,
        cut: &PublishedCut,
        seq: SpaceSeq,
        view: &ViewRef,
    ) -> Result<Option<BoardDefinition>, PortError> {
        let scope = &cut.cut.scope;
        let Some(carrier) = cut
            .store
            .note_by_id(scope, seq, &view.note)
            .await?
            .filter(|row| {
                row.lifecycle == Lifecycle::Active && row.doc_class != DocClass::EncryptedNote
            })
        else {
            return Ok(None);
        };
        let Some(row) = cut.store.view_descriptor(scope, seq, view).await? else {
            return Ok(None);
        };
        let Some(bytes) = row.compiled_msgpack else {
            return Ok(None);
        };
        if row.view_note_rev_id != carrier.rev_id
            || (seq == cut.cut.projected_seq
                && row.schema_rev_id.as_ref()
                    != cut.watermark.schema.as_ref().map(|schema| &schema.revision))
        {
            return Ok(None);
        }
        let descriptor: NotaDescriptor = decode(&bytes)?;
        if descriptor.kind != ViewKind::Board {
            return Ok(None);
        }
        let Some(location) = self
            .try_location_at(cut, seq, &carrier.parent_folder_id)
            .await?
            .filter(|location| !location.trashed)
        else {
            return Ok(None);
        };
        let folder = match self
            .resolve_view_folder_at(cut, seq, &carrier, &descriptor.source)
            .await
        {
            Ok(folder) => folder,
            Err(PortError::Domain(DomainError::ResourceNotFound)) => return Ok(None),
            Err(error) => return Err(error),
        };
        let requires_folder_grant =
            query::view_authorization_folder(&descriptor.source, folder.as_ref()).is_some();
        let source_folder = if let Some(folder) = folder {
            let Some(location) = self
                .try_location_at(cut, seq, &folder)
                .await?
                .filter(|location| !location.trashed)
            else {
                return Ok(None);
            };
            Some((folder, location.ids))
        } else {
            None
        };
        let source = BoardSourceFacts {
            carrier: BoardNoteFacts::new(&carrier, location),
            source_folder,
            source_classes: descriptor.source.classes.clone(),
            recursive: descriptor.source.recursive,
            requires_folder_grant,
        };
        Ok(Some(BoardDefinition { source, descriptor }))
    }

    pub(super) async fn board_events(
        &self,
        cut: &PublishedCut,
        boards: &AffectedBoards,
    ) -> BoardAssembly {
        let mut proof_incomplete = boards.incomplete;
        let deadline = Instant::now() + BOARD_EVENT_BUDGET;
        let seq = cut.cut.projected_seq;
        let mut prepared = Vec::with_capacity(boards.views.len());
        // Capture source authority before spending the remaining shared budget
        // on aggregates. A per-view invalidation can still fit without them.
        for (view, targets) in &boards.views {
            if Instant::now() >= deadline {
                proof_incomplete = true;
                break;
            }
            let definition = match timeout_at(deadline, self.board_definition(cut, seq, view)).await
            {
                Ok(Ok(Some(definition))) => definition,
                Ok(Ok(None)) => continue,
                Ok(Err(error)) => {
                    proof_incomplete = true;
                    tracing::debug!(?error, "could not verify source for board notification");
                    continue;
                }
                Err(_) => {
                    proof_incomplete = true;
                    break;
                }
            };
            let mut affected = Vec::with_capacity(targets.len());
            for note in targets {
                if Instant::now() >= deadline {
                    proof_incomplete = true;
                    break;
                }
                match timeout_at(deadline, self.affected_card(cut, &definition, note)).await {
                    Ok(Ok(Some(card))) => affected.push(card),
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => {
                        proof_incomplete = true;
                        tracing::debug!(?error, "could not verify affected board card");
                    }
                    Err(_) => {
                        proof_incomplete = true;
                        break;
                    }
                }
            }
            prepared.push((view, definition, affected));
        }

        let index = if !prepared.is_empty() && !boards.fanout() && Instant::now() < deadline {
            Some(match self.open_index_async(cut).await {
                Ok(index) => (|| -> Result<_, PortError> {
                    let mut active = index.posting(&PostingKey::Active).map_err(index_error)?;
                    active.andnot_inplace(
                        &index
                            .posting(&PostingKey::TrashedSubtree)
                            .map_err(index_error)?,
                    );
                    Ok((index, active))
                })(),
                Err(error) => Err(error),
            })
        } else {
            None
        };
        let mut items = MAX_BOARD_EVENT_ITEMS;
        let mut notices = Vec::with_capacity(prepared.len());
        for (view, definition, affected) in prepared {
            let delta = if let Some(Ok((index, active))) = &index
                && items > 0
                && Instant::now() < deadline
            {
                match timeout_at(
                    deadline,
                    board_delta(cut, index, active, view, &definition, items - 1),
                )
                .await
                {
                    Ok(Ok(delta)) => delta,
                    Ok(Err(error)) => {
                        tracing::debug!(?error, "could not build board event payload");
                        None
                    }
                    Err(_) => None,
                }
            } else {
                None
            };
            if let Some(delta) = &delta {
                items -= delta.groups.len() + delta.ranks.len() + 1;
            }
            notices.push(BoardNotice {
                scope: cut.cut.scope.clone(),
                seq,
                generation: cut.cut.generation,
                view: view.clone(),
                source: Arc::new(definition.source),
                affected: affected.into(),
                delta: delta.map(ScrubbableBoardDelta::new),
            });
        }
        BoardAssembly {
            notices,
            proof_incomplete,
        }
    }

    async fn affected_card(
        &self,
        cut: &PublishedCut,
        definition: &BoardDefinition,
        note: &NoteId,
    ) -> Result<Option<AffectedCardAtCut>, PortError> {
        let seq = cut.cut.projected_seq;
        let Some(row) = cut
            .store
            .note_by_id(&cut.cut.scope, seq, note)
            .await?
            .filter(|row| row.lifecycle == Lifecycle::Active)
        else {
            return Ok(None);
        };
        let Some(location) = self
            .try_location_at(cut, seq, &row.parent_folder_id)
            .await?
            .filter(|location| !location.trashed)
        else {
            return Ok(None);
        };
        let descriptor = &definition.descriptor;
        let tags = if descriptor.source.tags.is_empty() {
            BTreeSet::new()
        } else {
            let inline: Vec<String> = decode(&row.tags_msgpack)?;
            let raw = note_raw_fields(&row)?;
            effective_tags(&inline, raw.as_ref()).into_iter().collect()
        };
        if !query::source_matches(
            &descriptor.source,
            definition.source.folder(),
            &row.parent_folder_id,
            &location.ids,
            row.doc_class,
            &tags,
        ) || !descriptor
            .filter
            .predicate
            .matches(&row.evaluated_fields()?)
        {
            return Ok(None);
        }
        Ok(Some(AffectedCardAtCut {
            note: note.clone(),
            facts: BoardNoteFacts::new(&row, location),
        }))
    }
}

async fn board_delta(
    cut: &PublishedCut,
    index: &IndexView,
    active: &Bitmap,
    view: &ViewRef,
    definition: &BoardDefinition,
    budget: usize,
) -> Result<Option<BoardDelta>, PortError> {
    let descriptor = &definition.descriptor;
    let group_field = descriptor
        .group_by
        .as_deref()
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidView))?;
    let folder = definition.source.folder();
    let candidates =
        query::view_source_candidates(index, &descriptor.source, folder, active.clone())?;
    let scope = &cut.cut.scope;
    let seq = cut.cut.projected_seq;
    let groups = query::select_window(WindowInput {
        index,
        store: &cut.store,
        scope,
        cut: seq,
        candidates: &candidates,
        filter: &descriptor.filter.predicate,
        sort: &descriptor.sort,
        group_by: Some(group_field),
        columns: &descriptor.columns,
        board: true,
        ranks: &BTreeMap::new(),
        overlay: &BTreeMap::new(),
        after: None,
        limit: PageLimit::new(1)?,
    })
    .await?
    .groups;
    if groups.len() > budget {
        return Ok(None);
    }
    let Some(ranks) = board_ranks(
        cut,
        index,
        &candidates,
        view,
        descriptor,
        group_field,
        budget - groups.len(),
    )
    .await?
    else {
        return Ok(None);
    };
    Ok(Some(BoardDelta {
        scope: scope.clone(),
        seq,
        view: view.clone(),
        groups,
        ranks,
    }))
}

async fn board_ranks(
    cut: &PublishedCut,
    index: &IndexView,
    candidates: &Bitmap,
    view: &ViewRef,
    descriptor: &NotaDescriptor,
    group_field: &str,
    budget: usize,
) -> Result<Option<Vec<(NoteId, String)>>, PortError> {
    let scope = &cut.cut.scope;
    let seq = cut.cut.projected_seq;
    let possible = index
        .filter_candidates(&descriptor.filter.predicate, candidates)
        .map_err(index_error)?
        .possible;
    let limit = PageLimit::new(200)?;
    let mut ranks = Vec::new();
    let mut after = None;
    loop {
        let rows = cut
            .store
            .view_rank_page(scope, seq, view, after.as_ref(), limit)
            .await?;
        after = rows.last().map(|row| row.target_note_id.clone());
        let complete = rows.len() < usize::from(limit.get());
        let matching: Vec<_> = rows
            .into_iter()
            .filter_map(|rank| {
                let dense = index.dense_id(&rank.target_note_id)?;
                possible.contains(dense).then_some((rank, dense))
            })
            .collect();
        if !matching.is_empty() {
            let dense: Vec<_> = matching.iter().map(|(_, dense)| *dense).collect();
            let notes = cut.store.hydrate(scope, seq, &dense).await?;
            for ((rank, _), note) in matching.into_iter().zip(notes) {
                let note = note.ok_or_else(stale)?;
                let fields = note.evaluated_fields()?;
                if !descriptor.filter.predicate.matches(&fields) {
                    continue;
                }
                let group = query::group_key(fields.get(group_field));
                if group_key_hex(&group)?.1 == rank.group_key_hex {
                    if ranks.len() == budget {
                        return Ok(None);
                    }
                    ranks.push((rank.target_note_id, rank.sort_rank_lexo));
                }
            }
        }
        if complete {
            return Ok(Some(ranks));
        }
    }
}

fn index_error(error: impl std::fmt::Display) -> PortError {
    internal_not_committed("board_event_index", error.to_string())
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}
