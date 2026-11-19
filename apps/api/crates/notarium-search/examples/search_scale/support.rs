use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
};
use notarium_core::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, Space, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::{DataRoot, SearchIndexKind},
    error::ValidationReason,
    ids::{
        CommandKey, ContentDigest, FolderId, GrantId, HistoryIncarnation, InstallationId,
        LeaseEpoch, ModelProfileId, NoteId, PrincipalId, ProjectionGeneration, RequestId, SpaceId,
        SpaceSeq,
    },
    model::{DenseNodeId, DenseNodeIter, SnapshotCut},
    ports::{
        CallBudget, Cancellation, MoveFolder, Mutation, NoteCard, NoteWritePort, PortFuture,
        SpaceContext, StructuralReadPort, StructuralSnapshot,
    },
    query::FieldFilterAstV1,
    receipt::{CausalBasis, CommandIdentity},
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::SearchLayout,
};
use std::{
    collections::BTreeMap,
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

pub struct Scratch(DataRoot);

impl Scratch {
    pub fn new() -> io::Result<Self> {
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
        let root = target.join(format!("search-scale-{}", std::process::id()));
        fs::create_dir(&root)?;
        Ok(Self(DataRoot::new(root)))
    }

    pub fn root(&self) -> &DataRoot {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0.root());
    }
}

pub struct Fixture {
    pub root: DataRoot,
    pub projection: Arc<Projection>,
    pub root_folder: FolderId,
    pub selective: FolderId,
    pub broad: FolderId,
    pub space: Space,
    pub model: ModelProfileId,
    store: Arc<CanonicalStore>,
    runtime: CanonicalRuntime,
    corpus: FolderId,
    destination: FolderId,
    owner: PrincipalId,
}

impl Fixture {
    pub async fn open(root: &DataRoot, count: u32) -> Result<Self, Box<dyn Error>> {
        let owner = PrincipalId::from_bytes([1; 16]);
        let root_folder = FolderId::from_bytes([2; 16]);
        let corpus = FolderId::from_bytes([3; 16]);
        let destination = FolderId::from_bytes([4; 16]);
        let selective = FolderId::from_bytes([5; 16]);
        let broad = FolderId::from_bytes([6; 16]);
        let lease = LeaseEpoch::new(1)?;
        let config =
            CanonicalConfig::local_default(InstallationId::from_bytes([1; 16]), root.clone());
        let (store, runtime) = CanonicalRuntime::open(config).await?;
        let store = Arc::new(store);
        let space = store
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([1; 16]),
                incarnation: HistoryIncarnation::from_bytes([1; 16]),
                root_folder_id: root_folder.clone(),
                slug: "search-scale".to_owned(),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: lease,
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await?;
        for (folder, parent, slug) in [
            (&corpus, None, "corpus"),
            (&destination, None, "destination"),
            (&selective, Some(corpus.clone()), "selective"),
            (&broad, Some(corpus.clone()), "broad"),
        ] {
            store
                .create_folder(CreateFolderSpec {
                    scope: space.scope.clone(),
                    active_epoch: lease,
                    folder_id: folder.clone(),
                    parent,
                    slug: slug.to_owned(),
                    display_name: slug.to_owned(),
                    is_project: false,
                    project_slug: None,
                    actor: owner.clone(),
                    timestamp: None,
                })
                .await?;
        }
        let current = store.read_space(&space.scope.space_id).await?;
        let projection = Arc::new(Projection {
            cut: SnapshotCut {
                scope: space.scope,
                generation: ProjectionGeneration::new(1)?,
                canonical_seq: current.last_seq,
                projected_seq: current.last_seq,
            },
            notes: (1..=count)
                .map(|index| NoteId::from_bytes(u128::from(index).to_be_bytes()))
                .collect(),
        });
        let model = ModelProfileId::from_bytes(*b"deterministic-v1");
        Ok(Self {
            root: root.clone(),
            projection,
            root_folder,
            selective,
            broad,
            space: space.space,
            model,
            store,
            runtime,
            corpus,
            destination,
            owner,
        })
    }

    pub async fn move_folder(&self) -> Result<(usize, usize), Box<dyn Error>> {
        let scope = &self.projection.cut.scope;
        let layout = SearchLayout::open(&self.root, scope.clone())?;
        let initial = layout.search_manifest()?.ok_or("missing search manifest")?;
        let vectors = self.root.search(&scope.space_id, SearchIndexKind::Vector);
        let before = contents(&vectors)?;
        let engine = SearchEngine::start(
            SearchConfig::new(
                self.root.clone(),
                VectorMode::DeterministicTest { dimension: 384 },
            ),
            SearchDependencies::new(self.store.clone(), self.projection.clone()),
        );
        engine.start_space(scope.clone())?;
        let grant = SpaceGrant {
            role: SpaceRole::Owner,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        };
        let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
            self.owner.clone(),
            GrantId::from_bytes([1; 16]),
            BTreeMap::from([(scope.space_id.clone(), grant)]),
            false,
        ));
        let budget = CallBudget {
            request: RequestId::from_bytes([1; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        };
        let context = SpaceContext::new(auth, scope.clone(), budget)?;
        let changed = self
            .store
            .move_folder(
                context,
                Mutation {
                    identity: CommandIdentity {
                        scope: scope.clone(),
                        actor: self.owner.clone(),
                        key: CommandKey::from_bytes([1; 16]),
                        hash: ContentDigest::from_bytes([2; 32]),
                    },
                    preconditions: Default::default(),
                    input: MoveFolder {
                        folder: self.corpus.clone(),
                        new_parent: Some(self.destination.clone()),
                    },
                },
            )
            .await?;
        let end = changed.receipt.seq();
        let after = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if self
                    .store
                    .min_consumer_watermark(&scope.space_id, &scope.incarnation)
                    .is_some_and(|seq| seq >= end)
                    && let Some(manifest) = layout.search_manifest()?
                    && manifest.tantivy_seq == end
                {
                    return Ok::<_, notarium_search::layout::LayoutError>(manifest);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await??;
        engine.shutdown().await;
        if initial.tantivy_commit != after.tantivy_commit
            || initial.active_index_dir != after.active_index_dir
            || before != contents(&vectors)?
        {
            return Err("folder movement rewrote search data".into());
        }
        Ok((0, 0))
    }

    pub async fn shutdown(self) -> Result<(), Box<dyn Error>> {
        self.runtime.shutdown().await?;
        Ok(())
    }
}

pub struct Projection {
    pub cut: SnapshotCut,
    pub notes: Vec<NoteId>,
}

impl StructuralSnapshot for Projection {
    fn cut(&self) -> &SnapshotCut {
        &self.cut
    }

    fn lookup(&self, note: &NoteId) -> Option<DenseNodeId> {
        let slot = u32::from_str_radix(note.as_str().strip_prefix(NoteId::PREFIX)?, 16)
            .ok()?
            .checked_sub(1)?;
        self.notes
            .get(slot as usize)
            .filter(|expected| *expected == note)
            .map(|_| DenseNodeId::new(self.cut.generation, slot))
    }

    fn note_id(&self, node: DenseNodeId) -> DomainResult<&NoteId> {
        self.notes
            .get(node.index(self.cut.generation)? as usize)
            .ok_or(DomainError::ResourceNotFound)
    }

    fn doc_class(&self, node: DenseNodeId) -> DomainResult<DocClass> {
        self.note_id(node)?;
        Ok(DocClass::UserDoc)
    }

    fn folder_subtree(&self, _: &FolderId) -> DomainResult<DenseNodeIter<'_>> {
        Err(unavailable())
    }
    fn folder_descendants(&self, _: &FolderId) -> DomainResult<Vec<FolderId>> {
        Err(unavailable())
    }
    fn enclosing_project(&self, _: &FolderId) -> DomainResult<Option<FolderId>> {
        Err(unavailable())
    }
    fn filter_notes(&self, _: &FieldFilterAstV1) -> DomainResult<Option<DenseNodeIter<'_>>> {
        Err(unavailable())
    }
    fn outgoing(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        Err(unavailable())
    }
    fn incoming(&self, _: DenseNodeId) -> DomainResult<DenseNodeIter<'_>> {
        Err(unavailable())
    }
}

impl StructuralReadPort for Projection {
    fn acquire_snapshot(
        &self,
        _: SpaceContext,
        _: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        Box::pin(async { Err(unavailable().into()) })
    }
    fn is_live_visible(&self, _: &SpaceContext, _: &NoteId) -> DomainResult<bool> {
        Err(unavailable())
    }
    fn hydrate(
        &self,
        _: SpaceContext,
        _: SnapshotCut,
        _: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
        Box::pin(async { Err(unavailable().into()) })
    }
}

fn unavailable() -> DomainError {
    DomainError::validation(ValidationReason::NotReady)
}

fn contents(root: &Path) -> io::Result<BTreeMap<PathBuf, blake3::Hash>> {
    let mut hashes = BTreeMap::new();
    for folder in fs::read_dir(root)? {
        for entry in fs::read_dir(folder?.path())? {
            let path = entry?.path();
            let mut input = fs::File::open(&path)?;
            let mut hash = blake3::Hasher::new();
            io::copy(&mut input, &mut hash)?;
            hashes.insert(path, hash.finalize());
        }
    }
    Ok(hashes)
}

pub struct PeakDisk {
    root: PathBuf,
    peak: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    sampler: Option<JoinHandle<()>>,
}

impl PeakDisk {
    pub fn start(root: &Path) -> Self {
        let root = root.join("v1/search");
        let peak = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let sampler = std::thread::spawn({
            let (root, peak, stop) = (root.clone(), peak.clone(), stop.clone());
            move || {
                while !stop.load(Ordering::Acquire) {
                    peak.fetch_max(size(&root, &mut Default::default()), Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });
        Self {
            root,
            peak,
            stop,
            sampler: Some(sampler),
        }
    }

    pub fn finish(mut self) -> u64 {
        self.close();
        self.peak
            .load(Ordering::Relaxed)
            .max(size(&self.root, &mut Default::default()))
    }

    fn close(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(sampler) = self.sampler.take() {
            let _ = sampler.join();
        }
    }
}

impl Drop for PeakDisk {
    fn drop(&mut self) {
        self.close();
    }
}

fn size(path: &Path, seen: &mut std::collections::HashSet<(u64, u64)>) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_dir() {
        return fs::read_dir(path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| size(&entry.path(), seen))
            .sum();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if seen.insert((meta.dev(), meta.ino())) {
            meta.blocks() * 512
        } else {
            0
        }
    }
    #[cfg(not(unix))]
    {
        meta.len()
    }
}
