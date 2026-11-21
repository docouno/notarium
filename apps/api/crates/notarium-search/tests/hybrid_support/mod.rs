pub mod ort;
pub mod regressions;
pub mod remote;

use notarium_canonical::{CanonicalStore, chats::search::HydratedChatHit};
use notarium_core::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman},
    classes::{ClassEgressFence, ClassifiedDocument, DocClass},
    error::{PortError, ValidationReason},
    ids::{
        ChatThreadId, CommandKey, ContentDigest, FolderId, GrantId, NoteId, PrincipalId,
        ProjectionGeneration, RequestId, RevisionId, SpaceId, SpaceSeq, ThreadEntrySeq,
    },
    model::{DenseNodeId, DenseNodeIter, HistoryScope, SnapshotCut},
    ports::{
        CallBudget, Cancellation, ChangeBroadcast, ChangeNotice, ChangeRead, ChangeReadResult,
        ChangeSubscription, MaintenanceContext, Mutation, NoteCard, PageLimit, PortFuture,
        ServiceAuthority, ServicePurpose, SpaceContext, StructuralReadPort, StructuralSnapshot,
    },
    query::{
        FieldFilterAstV1, FieldObservation, FieldSchema, FieldType, FieldValue, Predicate,
        ScalarType,
    },
    receipt::{CausalBasis, ChangeCursor, CommandIdentity},
    value::ScalarValue,
};
use notarium_search::ports::{
    SearchCarrierReadPort, SearchDocumentTarget, SearchIndexedNote, SearchNotesSeedPage,
    SearchOverlayNote,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex as StdMutex, RwLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

pub fn random() -> [u8; 16] {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes
}

pub fn context(scope: &HistoryScope, owner: &PrincipalId) -> SpaceContext {
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    context_with_grant(scope, owner, grant)
}

pub fn context_with_grant(
    scope: &HistoryScope,
    principal: &PrincipalId,
    grant: SpaceGrant,
) -> SpaceContext {
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        principal.clone(),
        GrantId::from_bytes([1; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        true,
    ));
    SpaceContext::new(
        auth,
        scope.clone(),
        CallBudget {
            request: RequestId::from_bytes(random()),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(10),
        },
    )
    .unwrap()
}

pub fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    let entropy = random();
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes(entropy),
            hash: ContentDigest::from_bytes(*blake3::hash(&entropy).as_bytes()),
        },
        preconditions: Default::default(),
        input,
    }
}

/// A deliberately independently advanced implementation of the projection port.
pub struct Projection {
    pub store: Arc<CanonicalStore>,
    pub snapshot: RwLock<View>,
    pub live: RwLock<BTreeSet<NoteId>>,
}

#[derive(Clone)]
pub struct View {
    cut: SnapshotCut,
    rows: Vec<(NoteId, FolderId)>,
    parents: BTreeMap<FolderId, Option<FolderId>>,
    projects: BTreeSet<FolderId>,
    edges: BTreeMap<u32, Vec<u32>>,
    fields: BTreeMap<NoteId, BTreeMap<String, FieldObservation<FieldValue>>>,
}

impl View {
    pub fn new(scope: HistoryScope, root: FolderId) -> Self {
        Self {
            cut: SnapshotCut {
                scope,
                generation: ProjectionGeneration::new(1).unwrap(),
                canonical_seq: SpaceSeq::ZERO,
                projected_seq: SpaceSeq::ZERO,
            },
            rows: Vec::new(),
            parents: BTreeMap::from([(root, None)]),
            projects: BTreeSet::new(),
            edges: BTreeMap::new(),
            fields: BTreeMap::new(),
        }
    }

    pub fn advance(&mut self, seq: SpaceSeq) {
        self.cut.canonical_seq = seq;
        self.cut.projected_seq = seq;
    }

    pub fn index(&mut self, note: NoteId, parent: FolderId) {
        self.rows.push((note, parent));
    }

    pub fn folder(&mut self, folder: FolderId, parent: FolderId) {
        self.parents.insert(folder, Some(parent));
    }

    pub fn project(&mut self, folder: FolderId, parent: FolderId) {
        self.folder(folder.clone(), parent);
        self.projects.insert(folder);
    }

    pub fn link(&mut self, from: u32, to: u32) {
        self.edges.entry(from).or_default().push(to);
    }

    pub fn set_status(&mut self, note: NoteId, status: &str) {
        self.fields.insert(note, status_field(status));
    }

    fn in_folder(&self, member: &FolderId, folder: &FolderId) -> bool {
        std::iter::successors(Some(member), |id| {
            self.parents.get(*id).and_then(Option::as_ref)
        })
        .any(|ancestor| ancestor == folder)
    }
}

impl StructuralSnapshot for View {
    fn cut(&self) -> &SnapshotCut {
        &self.cut
    }

    fn lookup(&self, note: &NoteId) -> DomainResult<Option<DenseNodeId>> {
        Ok(self
            .rows
            .iter()
            .position(|(id, _)| id == note)
            .map(|offset| DenseNodeId::new(self.cut.generation, offset as u32)))
    }

    fn note_id(&self, node: DenseNodeId) -> DomainResult<NoteId> {
        self.rows
            .get(node.index(self.cut.generation)? as usize)
            .map(|(note, _)| note)
            .cloned()
            .ok_or(DomainError::ResourceNotFound)
    }

    fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
        self.note_id(node)?;
        Ok(DocClass::UserDoc)
    }

    fn folder_subtree<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, DenseNodeIter<'a>> {
        Box::pin(async move {
            let rows: Vec<_> = self
                .rows
                .iter()
                .enumerate()
                .filter(|(_, (_, parent))| self.in_folder(parent, folder))
                .map(|(index, _)| index as u32)
                .collect();
            Ok(DenseNodeIter::from_iter(
                self.cut.generation,
                rows.into_iter(),
            ))
        })
    }

    fn folder_descendants<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, Vec<FolderId>> {
        Box::pin(async move {
            Ok(self
                .parents
                .keys()
                .filter(|candidate| self.in_folder(candidate, folder))
                .cloned()
                .collect())
        })
    }

    fn enclosing_project<'a>(&'a self, folder: &'a FolderId) -> PortFuture<'a, Option<FolderId>> {
        Box::pin(async move {
            Ok(std::iter::successors(Some(folder), |id| {
                self.parents.get(*id).and_then(Option::as_ref)
            })
            .find(|ancestor| self.projects.contains(*ancestor))
            .cloned())
        })
    }

    fn filter_notes<'a>(
        &'a self,
        filter: &'a FieldFilterAstV1,
    ) -> PortFuture<'a, Option<DenseNodeIter<'a>>> {
        Box::pin(async move {
            filter.validate(&BTreeMap::from([(
                "status".to_owned(),
                FieldSchema {
                    kind: FieldType::Scalar(ScalarType::String),
                    nullable: false,
                },
            )]))?;
            if matches!(&filter.predicate, Predicate::All(items) if items.is_empty()) {
                return Ok(None);
            }
            let empty = BTreeMap::new();
            let nodes = self
                .rows
                .iter()
                .enumerate()
                .filter_map(|(index, (note, _))| {
                    filter
                        .predicate
                        .matches(self.fields.get(note).unwrap_or(&empty))
                        .then_some(index as u32)
                })
                .collect::<Vec<_>>();
            Ok(Some(DenseNodeIter::from_iter(
                self.cut.generation,
                nodes.into_iter(),
            )))
        })
    }

    fn outgoing(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        let edge = self
            .edges
            .get(&node.index(self.cut.generation)?)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        Ok(DenseNodeIter::from_slice(self.cut.generation, edge))
    }

    fn incoming(&self, node: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        let index = node.index(self.cut.generation)?;
        let sources = self
            .edges
            .iter()
            .filter(move |(_, edges)| edges.contains(&index))
            .map(|(point, _)| *point);
        Ok(DenseNodeIter::from_iter(self.cut.generation, sources))
    }
}

pub fn status_field(status: &str) -> BTreeMap<String, FieldObservation<FieldValue>> {
    BTreeMap::from([(
        "status".to_owned(),
        FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(status.to_owned()))),
    )])
}

impl StructuralReadPort for Projection {
    fn acquire_snapshot(
        &self,
        ctx: SpaceContext,
        causal: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        Box::pin(async move {
            let required = match &causal {
                CausalBasis::Await(watermarks) => watermarks.required(ctx.scope())?,
                CausalBasis::Exact(receipts) => receipts
                    .for_scope(ctx.scope())?
                    .into_iter()
                    .map(|receipt| receipt.seq())
                    .max()
                    .unwrap_or_default(),
            };
            loop {
                let view = self.snapshot.read().unwrap().clone();
                ctx.check_current(&view.cut.scope)?;
                if required > view.cut.projected_seq {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    continue;
                }
                return Ok(Box::new(view) as Box<dyn StructuralSnapshot>);
            }
        })
    }

    fn is_live_visible<'a>(
        &'a self,
        _: &'a SpaceContext,
        note: &'a NoteId,
    ) -> PortFuture<'a, bool> {
        Box::pin(async move { Ok(self.live.read().unwrap().contains(note)) })
    }

    fn hydrate(
        &self,
        ctx: SpaceContext,
        cut: SnapshotCut,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
        Box::pin(async move {
            let carriers = SearchCarrierReadPort::read_note_documents_at_cutoff(
                &*self.store,
                ServiceAuthority::admit(ServicePurpose::Search),
                ctx.budget.clone(),
                cut.scope,
                cut.projected_seq,
                notes,
            )
            .await?;
            Ok(carriers
                .into_iter()
                .map(|(_, row)| {
                    let row = row?;
                    let document =
                        ClassEgressFence::search_metadata(row.document.metadata(), ctx.auth())
                            .ok()?;
                    Some(NoteCard {
                        document,
                        title: row.title,
                        path: String::new(),
                        preview: String::new(),
                    })
                })
                .collect())
        })
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct SeedPageAttempt {
    pub after: Option<NoteId>,
    scope: HistoryScope,
    cutoff: Option<SpaceSeq>,
    limit: PageLimit,
    request: RequestId,
}

pub struct ControlledCarriers {
    canonical: Arc<CanonicalStore>,
    pub full_seed_pages: AtomicUsize,
    pub seed_deadline_attempts: StdMutex<Option<Vec<SeedPageAttempt>>>,
    pub reject_seed: AtomicBool,
    pub seed_rejected: Notify,
    pub release_seed: Notify,
    pub hold_chat: AtomicBool,
    pub chat_held: Notify,
    pub release_chat: Notify,
    pub hold_note_reads: AtomicBool,
    pub note_read_held: Notify,
    hold_seed_tail_spaces: StdMutex<BTreeSet<SpaceId>>,
    seed_tail_held_count: AtomicUsize,
    seed_tail_held: Notify,
    release_seed_tail: Notify,
}

impl ControlledCarriers {
    pub fn new(canonical: Arc<CanonicalStore>) -> Self {
        Self {
            canonical,
            full_seed_pages: AtomicUsize::new(0),
            seed_deadline_attempts: StdMutex::new(None),
            reject_seed: AtomicBool::new(false),
            seed_rejected: Notify::new(),
            release_seed: Notify::new(),
            hold_chat: AtomicBool::new(false),
            chat_held: Notify::new(),
            release_chat: Notify::new(),
            hold_note_reads: AtomicBool::new(false),
            note_read_held: Notify::new(),
            hold_seed_tail_spaces: StdMutex::new(BTreeSet::new()),
            seed_tail_held_count: AtomicUsize::new(0),
            seed_tail_held: Notify::new(),
            release_seed_tail: Notify::new(),
        }
    }

    pub fn hold_seed_tail_for(&self, space: SpaceId) {
        self.hold_seed_tail_spaces.lock().unwrap().insert(space);
    }

    pub fn seed_tail_held_count(&self) -> usize {
        self.seed_tail_held_count.load(Ordering::SeqCst)
    }

    pub async fn wait_seed_tail_held(&self, expected: usize) {
        loop {
            let notified = self.seed_tail_held.notified();
            if self.seed_tail_held_count.load(Ordering::SeqCst) >= expected {
                return;
            }
            notified.await;
        }
    }

    pub fn release_seed_tails(&self) {
        self.hold_seed_tail_spaces.lock().unwrap().clear();
        self.release_seed_tail.notify_waiters();
    }

    fn is_seed_tail_held(&self, space: &SpaceId) -> bool {
        self.hold_seed_tail_spaces.lock().unwrap().contains(space)
    }
}

impl SearchCarrierReadPort for ControlledCarriers {
    fn read_searchable_notes_seed_page(
        &self,
        authority: ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        cutoff: Option<SpaceSeq>,
        after_note: Option<NoteId>,
        limit: PageLimit,
    ) -> PortFuture<'_, SearchNotesSeedPage> {
        if limit.get() == 100 {
            self.full_seed_pages.fetch_add(1, Ordering::SeqCst);
        }
        let limit = if let Some(attempts) = self.seed_deadline_attempts.lock().unwrap().as_mut() {
            attempts.push(SeedPageAttempt {
                after: after_note.clone(),
                scope: scope.clone(),
                cutoff,
                limit,
                request: budget.request.clone(),
            });
            if attempts.len() == 2 {
                return Box::pin(async {
                    Err(notarium_canonical::codec::deadline_not_committed(
                        "seed_page_deadline",
                        "injected read deadline",
                    ))
                });
            }
            PageLimit::new(2).unwrap()
        } else {
            limit
        };
        if self.reject_seed.load(Ordering::SeqCst) {
            return Box::pin(async {
                self.seed_rejected.notify_one();
                self.release_seed.notified().await;
                Err(DomainError::ResourceNotFound.into())
            });
        }
        Box::pin(async move {
            let limit = if self.is_seed_tail_held(&scope.space_id) {
                if after_note.is_some() {
                    struct HoldGuard<'a>(&'a AtomicUsize);
                    impl Drop for HoldGuard<'_> {
                        fn drop(&mut self) {
                            self.0.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    self.seed_tail_held_count.fetch_add(1, Ordering::SeqCst);
                    let _guard = HoldGuard(&self.seed_tail_held_count);
                    self.seed_tail_held.notify_waiters();
                    loop {
                        let release = self.release_seed_tail.notified();
                        if !self.is_seed_tail_held(&scope.space_id) {
                            break;
                        }
                        tokio::select! {
                            () = budget.cancellation.cancelled() => return Err(DomainError::validation(ValidationReason::NotReady).into()),
                            () = release => {},
                        }
                    }
                }
                PageLimit::new(1).unwrap()
            } else {
                limit
            };
            SearchCarrierReadPort::read_searchable_notes_seed_page(
                &*self.canonical,
                authority,
                budget,
                scope,
                cutoff,
                after_note,
                limit,
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
        SearchCarrierReadPort::read_note_documents_at_cutoff(
            &*self.canonical,
            authority,
            budget,
            scope,
            cutoff,
            notes,
        )
    }

    fn read_note_revisions_for_overlay(
        &self,
        authority: ServiceAuthority,
        ctx: SpaceContext,
        filter_cut: SpaceSeq,
        targets: Vec<(NoteId, RevisionId)>,
    ) -> PortFuture<'_, Vec<(NoteId, Option<SearchOverlayNote>)>> {
        SearchCarrierReadPort::read_note_revisions_for_overlay(
            &*self.canonical,
            authority,
            ctx,
            filter_cut,
            targets,
        )
    }

    fn read_authorized_documents_for_search(
        &self,
        ctx: SpaceContext,
        targets: Vec<SearchDocumentTarget>,
    ) -> PortFuture<'_, Vec<Option<Arc<ClassifiedDocument>>>> {
        if self.hold_note_reads.load(Ordering::SeqCst) {
            return Box::pin(async {
                self.note_read_held.notify_one();
                std::future::pending().await
            });
        }
        SearchCarrierReadPort::read_authorized_documents_for_search(&*self.canonical, ctx, targets)
    }

    fn visible_chat_hit_keys<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        candidates: &'a [(ChatThreadId, ThreadEntrySeq)],
    ) -> PortFuture<'a, Vec<(ChatThreadId, ThreadEntrySeq)>> {
        Box::pin(self.canonical.visible_chat_hit_keys(ctx, candidates))
    }

    fn hydrate_live_visible_chat_hits<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        candidates: &'a [(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> PortFuture<'a, (Vec<HydratedChatHit>, bool)> {
        Box::pin(async move {
            if self.hold_chat.swap(false, Ordering::SeqCst) {
                self.chat_held.notify_one();
                self.release_chat.notified().await;
            }
            self.canonical
                .hydrate_live_visible_chat_hits(ctx, candidates, limit)
                .await
        })
    }
}

pub struct HeldPages {
    canonical: Arc<CanonicalStore>,
    from: AtomicU64,
    pub reached: Notify,
    pub lagged: Arc<Notify>,
    released: Notify,
}

impl HeldPages {
    pub fn new(canonical: Arc<CanonicalStore>) -> Self {
        Self {
            canonical,
            from: AtomicU64::new(u64::MAX),
            reached: Notify::new(),
            lagged: Arc::new(Notify::new()),
            released: Notify::new(),
        }
    }

    pub fn hold(&self, from: SpaceSeq) {
        self.from.store(from.get(), Ordering::SeqCst);
    }

    pub fn release(&self) {
        self.from.store(u64::MAX, Ordering::SeqCst);
        self.released.notify_waiters();
    }
}

impl ChangeBroadcast for HeldPages {
    fn subscribe(
        &self,
        ctx: MaintenanceContext,
        after: ChangeCursor,
    ) -> PortFuture<'_, Box<dyn ChangeSubscription>> {
        Box::pin(async move {
            let inner = self.canonical.subscribe(ctx, after).await?;
            Ok(Box::new(Observed {
                inner,
                lagged: self.lagged.clone(),
            }) as Box<dyn ChangeSubscription>)
        })
    }

    fn catch_up(
        &self,
        ctx: MaintenanceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        Box::pin(async move {
            if let ChangeRead::Log { after, .. } = &request {
                loop {
                    let release = self.released.notified();
                    if after.after.get() < self.from.load(Ordering::SeqCst) {
                        break;
                    }
                    self.reached.notify_one();
                    tokio::select! {
                        () = ctx.budget.cancellation.cancelled() => return Err(PortError::from(DomainError::validation(ValidationReason::NotReady))),
                        () = release => {},
                    }
                }
            }
            self.canonical.catch_up(ctx, request).await
        })
    }
}

struct Observed {
    inner: Box<dyn ChangeSubscription>,
    lagged: Arc<Notify>,
}

impl ChangeSubscription for Observed {
    fn processed(&self) -> &ChangeCursor {
        self.inner.processed()
    }

    fn next(&mut self) -> PortFuture<'_, Option<ChangeNotice>> {
        Box::pin(async move {
            let notice = self.inner.next().await?;
            if matches!(notice, Some(ChangeNotice::Lagged { .. })) {
                self.lagged.notify_one();
            }
            Ok(notice)
        })
    }

    fn acknowledge(&mut self, cursor: ChangeCursor) -> PortFuture<'_, ()> {
        self.inner.acknowledge(cursor)
    }
}
