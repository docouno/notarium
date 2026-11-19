use notarium_canonical::CanonicalStore;
use notarium_core::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman},
    classes::{ClassEgressFence, DocClass},
    error::{PortError, ValidationReason},
    ids::{
        CommandKey, ContentDigest, FolderId, GrantId, NoteId, PrincipalId, ProjectionGeneration,
        RequestId, SpaceSeq,
    },
    model::{DenseNodeId, DenseNodeIter, HistoryScope, SnapshotCut},
    ports::{
        CallBudget, Cancellation, ChangeBroadcast, ChangeRead, ChangeReadResult,
        ChangeSubscription, MaintenanceContext, Mutation, NoteCard, PortFuture, ServiceAuthority,
        ServicePurpose, SpaceContext, StructuralReadPort, StructuralSnapshot,
    },
    query::{FieldFilterAstV1, Predicate},
    receipt::{CausalBasis, ChangeCursor, CommandIdentity},
};
use notarium_search::ports::SearchCarrierReadPort;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
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
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner.clone(),
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
    edges: BTreeMap<u32, Vec<u32>>,
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
            edges: BTreeMap::new(),
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

    pub fn link(&mut self, from: u32, to: u32) {
        self.edges.entry(from).or_default().push(to);
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

    fn lookup(&self, note: &NoteId) -> Option<DenseNodeId> {
        self.rows
            .iter()
            .position(|(id, _)| id == note)
            .map(|offset| DenseNodeId::new(self.cut.generation, offset as u32))
    }

    fn note_id(&self, node: DenseNodeId) -> DomainResult<&NoteId> {
        self.rows
            .get(node.index(self.cut.generation)? as usize)
            .map(|(note, _)| note)
            .ok_or(DomainError::ResourceNotFound)
    }

    fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
        self.note_id(node)?;
        Ok(DocClass::UserDoc)
    }

    fn folder_subtree(&self, folder: &FolderId) -> DomainResult<DenseNodeIter<'_>> {
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
    }

    fn folder_descendants(&self, folder: &FolderId) -> DomainResult<Vec<FolderId>> {
        Ok(self
            .parents
            .keys()
            .filter(|candidate| self.in_folder(candidate, folder))
            .cloned()
            .collect())
    }

    fn enclosing_project(&self, _: &FolderId) -> DomainResult<Option<FolderId>> {
        Ok(None)
    }

    fn filter_notes(&self, filter: &FieldFilterAstV1) -> DomainResult<Option<DenseNodeIter<'_>>> {
        filter.validate(&BTreeMap::new())?;
        if matches!(&filter.predicate, Predicate::All(items) if items.is_empty()) {
            return Ok(None);
        }
        Ok(Some(DenseNodeIter::from_slice(self.cut.generation, &[])))
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

impl StructuralReadPort for Projection {
    fn acquire_snapshot(
        &self,
        ctx: SpaceContext,
        causal: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        Box::pin(async move {
            loop {
                let view = self.snapshot.read().unwrap().clone();
                ctx.check_current(&view.cut.scope)?;
                if let CausalBasis::Await(watermarks) = &causal
                    && watermarks.required(ctx.scope())? > view.cut.projected_seq
                {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    continue;
                }
                return Ok(Box::new(view) as Box<dyn StructuralSnapshot>);
            }
        })
    }

    fn is_live_visible(&self, _: &SpaceContext, note: &NoteId) -> DomainResult<bool> {
        Ok(self.live.read().unwrap().contains(note))
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

pub struct HeldPages {
    canonical: Arc<CanonicalStore>,
    from: AtomicU64,
    pub reached: Notify,
    released: Notify,
}

impl HeldPages {
    pub fn new(canonical: Arc<CanonicalStore>) -> Self {
        Self {
            canonical,
            from: AtomicU64::new(u64::MAX),
            reached: Notify::new(),
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
        self.canonical.subscribe(ctx, after)
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
