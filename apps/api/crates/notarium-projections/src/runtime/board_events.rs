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
    project: Option<FolderId>,
    write_locked: bool,
}

impl BoardNoteFacts {
    fn new(note: &ProjectedNote, location: FolderLocation) -> Self {
        Self {
            class: note.doc_class,
            ability: note.ability_id.clone(),
            ancestors: location.ids,
            project: location.project,
            write_locked: location.write_locked,
        }
    }

    fn visible(&self, ctx: &SpaceContext, permit: &LiveReadPermit) -> bool {
        ctx.auth()
            .can_view_resource(&ResourceFacts {
                space: permit.space().clone(),
                class: self.class,
                project: self.project.clone(),
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
                        .can_view_folder(space, folder, &current.ancestor_folders)
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

    pub(super) fn clear(&self) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub(super) fn clone_payload(&self) -> Option<BoardDelta> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[derive(Clone)]
pub(super) enum BoardNoticePayload {
    /// Externally published payload (scrubbed immediately in RAM on erasure).
    Published(ScrubbableBoardDelta),
    /// Computed lazily on subscriber delivery only when `Full && permit.head() == seq`,
    /// keeping heavy board window/rank scans off the Space worker hot path.
    Lazy {
        descriptor: Arc<NotaDescriptor>,
        budget: usize,
    },
    /// Fanout/overflow or already consumed: delivers `ResyncRequired`.
    ResyncOnly,
}

#[derive(Clone)]
pub(super) struct BoardNotice {
    pub(super) scope: HistoryScope,
    pub(super) seq: SpaceSeq,
    pub(super) generation: ProjectionGeneration,
    pub(super) view: ViewRef,
    pub(super) source: Arc<BoardSourceFacts>,
    pub(super) affected: Arc<[AffectedCardAtCut]>,
    pub(super) payload: BoardNoticePayload,
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
        let Some(location) = cut
            .try_location_at(seq, &carrier.parent_folder_id)
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
            let Some(location) = cut
                .try_location_at(seq, &folder)
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

    /// Captures lightweight board source and affected-card authority facts at
    /// the command cut without running heavy window/rank queries on the Space
    /// worker. Full-audience subscribers compute `BoardDelta` lazily at
    /// delivery if the cut is still current.
    pub(super) async fn board_notices(
        &self,
        cut: &PublishedCut,
        boards: &AffectedBoards,
    ) -> BoardAssembly {
        let mut proof_incomplete = boards.incomplete;
        let deadline = Instant::now() + BOARD_EVENT_BUDGET;
        let seq = cut.cut.projected_seq;
        let fanout = boards.fanout();
        let mut notices = Vec::with_capacity(boards.views.len());
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
            let payload = if fanout {
                BoardNoticePayload::ResyncOnly
            } else {
                BoardNoticePayload::Lazy {
                    descriptor: Arc::new(definition.descriptor),
                    budget: MAX_BOARD_EVENT_ITEMS - 1,
                }
            };
            notices.push(BoardNotice {
                scope: cut.cut.scope.clone(),
                seq,
                generation: cut.cut.generation,
                view: view.clone(),
                source: Arc::new(definition.source),
                affected: affected.into(),
                payload,
            });
        }
        BoardAssembly {
            notices,
            proof_incomplete,
        }
    }

    /// Lazily materializes a `BoardDelta` on the subscriber task when the
    /// advertised cut is still current.
    pub(super) async fn compute_board_delta(
        &self,
        notice: &BoardNotice,
        descriptor: &NotaDescriptor,
        budget: usize,
    ) -> Result<Option<BoardDelta>, PortError> {
        let Ok(cut) = self.published_cut(&notice.scope) else {
            return Ok(None);
        };
        if cut.cut.generation != notice.generation || cut.cut.projected_seq != notice.seq {
            return Ok(None);
        }
        let deadline = Instant::now() + BOARD_EVENT_BUDGET;
        let Ok(Ok(index)) = timeout_at(deadline, self.open_index_async(&cut)).await else {
            return Ok(None);
        };
        let mut active = index.posting(&PostingKey::Active).map_err(index_error)?;
        active.andnot_inplace(
            &index
                .posting(&PostingKey::TrashedSubtree)
                .map_err(index_error)?,
        );
        match timeout_at(
            deadline,
            board_delta(
                &cut,
                &index,
                &active,
                &notice.view,
                notice.source.folder(),
                descriptor,
                budget,
            ),
        )
        .await
        {
            Ok(Ok(delta)) => Ok(delta),
            Ok(Err(error)) => {
                tracing::debug!(?error, "could not build lazy board event payload");
                Ok(None)
            }
            Err(_) => Ok(None),
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
        let Some(location) = cut
            .try_location_at(seq, &row.parent_folder_id)
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
    folder: Option<&FolderId>,
    descriptor: &NotaDescriptor,
    budget: usize,
) -> Result<Option<BoardDelta>, PortError> {
    board_delta_at(
        &cut.store,
        &cut.cut.scope,
        cut.cut.projected_seq,
        index,
        active,
        view,
        folder,
        descriptor,
        budget,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn board_delta_at(
    store: &crate::derived::DerivedStore,
    scope: &HistoryScope,
    seq: SpaceSeq,
    index: &IndexView,
    active: &Bitmap,
    view: &ViewRef,
    folder: Option<&FolderId>,
    descriptor: &NotaDescriptor,
    budget: usize,
) -> Result<Option<BoardDelta>, PortError> {
    let group_field = descriptor
        .group_by
        .as_deref()
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidView))?;
    let candidates =
        query::view_source_candidates(index, &descriptor.source, folder, active.clone())?;
    let verify_tags = index.tags_bucketed().then_some(&descriptor.source.tags);
    let groups = query::select_view_window(
        WindowInput {
            index,
            store,
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
        },
        None,
        verify_tags,
    )
    .await?
    .groups;
    if groups.len() > budget {
        return Ok(None);
    }
    let Some(ranks) = board_ranks(
        store,
        scope,
        seq,
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

#[allow(clippy::too_many_arguments)]
async fn board_ranks(
    store: &crate::derived::DerivedStore,
    scope: &HistoryScope,
    seq: SpaceSeq,
    index: &IndexView,
    candidates: &Bitmap,
    view: &ViewRef,
    descriptor: &NotaDescriptor,
    group_field: &str,
    budget: usize,
) -> Result<Option<Vec<(NoteId, String)>>, PortError> {
    let possible = index
        .filter_candidates(&descriptor.filter.predicate, candidates)
        .map_err(index_error)?
        .into_possible();
    if possible.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let limit = PageLimit::new(200)?;
    let mut ranks = Vec::new();
    let mut after = None;
    loop {
        let rows = store
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
            let notes = store.hydrate(scope, seq, &dense).await?;
            for ((rank, _), note) in matching.into_iter().zip(notes) {
                let note = note.ok_or_else(stale)?;
                if index.tags_bucketed() && !descriptor.source.tags.is_empty() {
                    let inline: Vec<String> = crate::derived::decode_payload(&note.tags_msgpack)?;
                    let raw: Option<BTreeMap<String, notarium_core::value::YamlValue>> =
                        crate::derived::decode_payload(&note.raw_fields_msgpack)?;
                    let effective: BTreeSet<String> =
                        super::records::effective_tags(&inline, raw.as_ref())
                            .into_iter()
                            .collect();
                    if !descriptor.source.tags.is_subset(&effective) {
                        continue;
                    }
                }
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

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use notarium_core::{
        epoch::DataRoot,
        ids::{ContentDigest, HistoryIncarnation, RevisionId, SpaceId, ViewKey},
        ports::GroupKey,
        query::{FieldFilterAstV1, FieldObservation, FieldValue, Predicate, SortSpec},
        value::{ScalarValue, Timestamp},
    };

    use super::*;
    use crate::{
        derived::{
            DerivedMutation, DerivedStore, ProjectedNote, ProjectedViewRank, ProjectionWatermark,
            SpaceApply,
        },
        index::{FastIndexBuilder, IndexIdentity, IndexNote, L0Delta, NoteSortHeader},
        mmap::MmapPool,
        nota::{SourceScope, ViewSource},
    };

    #[tokio::test]
    async fn board_delta_and_ranks_verify_bucketed_tags() {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let dir = std::env::temp_dir().join(format!("notarium-board-tags-{}", hex::encode(nonce)));
        std::fs::create_dir_all(&dir).unwrap();
        let root = DataRoot::new(dir.clone());
        let gen1 = ProjectionGeneration::new(1).unwrap();
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([0x41; 16]),
            incarnation: HistoryIncarnation::from_bytes([0x42; 16]),
        };
        let folder = FolderId::from_bytes([0x43; 16]);
        let seq = SpaceSeq::new(10).unwrap();
        let ts = Timestamp::from_unix_parts(1_700_000_000, 0).unwrap();

        let status_fields: BTreeMap<String, FieldObservation<FieldValue>> = BTreeMap::from([(
            "status".into(),
            FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String("todo".into()))),
        )]);
        let empty_fields: BTreeMap<String, FieldObservation<FieldValue>> = BTreeMap::new();

        let mut filler_builder = FastIndexBuilder::default();
        filler_builder
            .add_folder(0, &folder, Lifecycle::Active)
            .unwrap();
        for dense in 0..66u32 {
            let id = NoteId::from_bytes(u128::from(dense + 100).to_be_bytes());
            let tags: Vec<String> = (0..1_000usize)
                .map(|slot| format!("fill-{dense:02}-{slot:04}"))
                .collect();
            filler_builder
                .add_note(IndexNote {
                    dense,
                    id: &id,
                    header: NoteSortHeader::new(ts, ts, 0, DocClass::UserDoc, Lifecycle::Active),
                    ancestors: &[0],
                    trashed_ancestor: false,
                    fields: &empty_fields,
                    tags: &tags,
                    ability: None,
                })
                .unwrap();
        }
        let matching_dense = 66u32;
        let matching_id = NoteId::from_bytes(u128::from(matching_dense + 100).to_be_bytes());
        let alpha_tags = vec!["alpha".to_owned()];
        filler_builder
            .add_note(IndexNote {
                dense: matching_dense,
                id: &matching_id,
                header: NoteSortHeader::new(ts, ts, 0, DocClass::UserDoc, Lifecycle::Active),
                ancestors: &[0],
                trashed_ancestor: false,
                fields: &status_fields,
                tags: &alpha_tags,
                ability: None,
            })
            .unwrap();

        let bucket_of = |tag: &str| -> u16 {
            let digest = blake3::hash(tag.as_bytes());
            u16::from_be_bytes([digest.as_bytes()[0], digest.as_bytes()[1]]) & 0x0FFF
        };
        let target_bucket = bucket_of("alpha");
        let colliding_tag = (0..200_000u32)
            .map(|n| format!("other-{n}"))
            .find(|cand| bucket_of(cand) == target_bucket)
            .expect("colliding 12-bit tag");
        let colliding_dense = 67u32;
        let colliding_id = NoteId::from_bytes(u128::from(colliding_dense + 100).to_be_bytes());
        let colliding_tags = vec![colliding_tag.clone()];
        filler_builder
            .add_note(IndexNote {
                dense: colliding_dense,
                id: &colliding_id,
                header: NoteSortHeader::new(ts, ts, 0, DocClass::UserDoc, Lifecycle::Active),
                ancestors: &[0],
                trashed_ancestor: false,
                fields: &status_fields,
                tags: &colliding_tags,
                ability: None,
            })
            .unwrap();

        let path = root.space_fast_index_with_nonce(
            gen1,
            &scope.space_id,
            seq,
            "00000000000000000000000000000001",
        );
        let (handle, _) = filler_builder
            .publish(
                &path,
                IndexIdentity {
                    generation: gen1,
                    scope: scope.clone(),
                    seq,
                },
            )
            .unwrap();
        let pool = MmapPool::new(NonZeroUsize::MIN);
        let index = IndexView::new(handle.open(&pool).unwrap(), Arc::new(L0Delta::default()));
        assert!(index.tags_bucketed());
        let bucket_hits = index.posting(&PostingKey::Tag("alpha".into())).unwrap();
        assert!(bucket_hits.contains(matching_dense));
        assert!(
            bucket_hits.contains(colliding_dense),
            "colliding tag must land in the same bucket"
        );

        let store = DerivedStore::open_sqlite(&root, gen1).await.unwrap();
        let view = ViewRef {
            note: NoteId::from_bytes([0x55; 16]),
            key: ViewKey::from_bytes([0x56; 16]),
        };
        let todo_group = GroupKey::Value(ScalarValue::String("todo".into()));
        let (todo_msgpack, todo_hex) = group_key_hex(&todo_group).unwrap();
        let rev = RevisionId::from_bytes([0x57; 16]);
        fn encode<T: serde::Serialize>(v: &T) -> Vec<u8> {
            rmp_serde::to_vec_named(v).unwrap()
        }
        let make_row = |dense: u32, id: &NoteId, tags: &[String]| ProjectedNote {
            space_id: scope.space_id.clone(),
            dense_id: dense,
            note_id: id.clone(),
            rev_id: rev.clone(),
            parent_folder_id: folder.clone(),
            dense_folder_id: 0,
            ability_id: None,
            slug: format!("card-{dense}"),
            slug_fold: format!("card-{dense}"),
            title: format!("Card {dense}"),
            title_fold: format!("card {dense}"),
            preview: "body".into(),
            doc_class: DocClass::UserDoc,
            lifecycle: Lifecycle::Active,
            byte_size: 16,
            content_digest: Some(ContentDigest::from_bytes([0x58; 32])),
            tags_msgpack: encode(&tags),
            view_blocks_msgpack: encode(&Vec::<u8>::new()),
            created_at_sec: ts.unix_seconds(),
            created_at_nsec: 0,
            updated_at_sec: ts.unix_seconds(),
            updated_at_nsec: 0,
            raw_fields_msgpack: encode(
                &Option::<BTreeMap<String, notarium_core::value::YamlValue>>::None,
            ),
            header_diagnostic_msgpack: encode(&Option::<notarium_core::error::Diagnostic>::None),
            evaluated_fields_msgpack: encode(&status_fields),
            diagnostics_msgpack: encode(&Vec::<notarium_core::error::Diagnostic>::new()),
            rank_version: ContentDigest::from_bytes([0x59; 32]),
            has_pending_nota: false,
            has_invalid_nota: false,
        };
        let mut mutations: Vec<DerivedMutation> = (0..66u32)
            .map(|dense| {
                let id = NoteId::from_bytes(u128::from(dense + 100).to_be_bytes());
                DerivedMutation::UpsertNote(Box::new(make_row(dense, &id, &[])))
            })
            .collect();
        mutations.extend([
            DerivedMutation::UpsertNote(Box::new(make_row(
                matching_dense,
                &matching_id,
                &alpha_tags,
            ))),
            DerivedMutation::UpsertNote(Box::new(make_row(
                colliding_dense,
                &colliding_id,
                &colliding_tags,
            ))),
            DerivedMutation::UpsertViewRank(ProjectedViewRank {
                space_id: scope.space_id.clone(),
                view_note_id: view.note.clone(),
                view_key: view.key.clone(),
                target_note_id: matching_id.clone(),
                group_key_hex: todo_hex.clone(),
                group_key_msgpack: todo_msgpack.clone(),
                sort_rank_lexo: "000001".into(),
                rank_rev_id: rev.clone(),
                placement_revision: rev.clone(),
                updated_seq: seq,
            }),
            DerivedMutation::UpsertViewRank(ProjectedViewRank {
                space_id: scope.space_id.clone(),
                view_note_id: view.note.clone(),
                view_key: view.key.clone(),
                target_note_id: colliding_id.clone(),
                group_key_hex: todo_hex,
                group_key_msgpack: todo_msgpack,
                sort_rank_lexo: "000002".into(),
                rank_rev_id: rev.clone(),
                placement_revision: rev,
                updated_seq: seq,
            }),
        ]);
        store
            .apply(&SpaceApply {
                expected: None,
                watermark: ProjectionWatermark {
                    scope: scope.clone(),
                    root_folder_id: folder.clone(),
                    next_dense_id: 68,
                    next_dense_folder_id: 1,
                    projected_seq: seq,
                    snapshot_seq: seq,
                    graph_settled_seq: seq,
                    schema: None,
                    seed_in_progress: false,
                    updated_at_ms: 0,
                },
                mutations,
            })
            .await
            .unwrap();

        let descriptor = NotaDescriptor {
            kind: ViewKind::Board,
            source: ViewSource {
                scope: SourceScope::Space,
                folder: None,
                recursive: true,
                classes: BTreeSet::from([DocClass::UserDoc]),
                tags: BTreeSet::from(["alpha".to_owned()]),
            },
            filter: FieldFilterAstV1 {
                version: 1,
                predicate: Predicate::All(Vec::new()),
            },
            sort: SortSpec::default(),
            group_by: Some("status".into()),
            date_field: None,
            columns: Vec::new(),
            presentation: BTreeMap::new(),
        };
        let active = Bitmap::from_range(0..68);
        let delta = board_delta_at(
            &store,
            &scope,
            seq,
            &index,
            &active,
            &view,
            Some(&folder),
            &descriptor,
            64,
        )
        .await
        .unwrap()
        .expect("board delta");

        let todo_count = delta
            .groups
            .iter()
            .find(|g| g.group == GroupKey::Value(ScalarValue::String("todo".into())))
            .map_or(0, |g| g.count);
        assert_eq!(
            todo_count, 1,
            "colliding bucket tag must not inflate BoardDelta group count"
        );
        assert_eq!(
            delta.ranks,
            vec![(matching_id, "000001".to_owned())],
            "colliding bucket tag must not leak into BoardDelta ranks"
        );

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
