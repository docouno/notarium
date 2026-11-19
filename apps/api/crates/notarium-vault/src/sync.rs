//! One worker serializes filesystem admission, durable publication, and
//! acknowledgement for the selected Desktop vault.

use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use notarium_canonical::{
    CanonicalStore,
    vault::{VaultBinding, VaultHandoff, VaultObservation},
};
use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError, RetryAdvice},
    ids::{ContentDigest, NoteId, SpaceSeq},
    model::HistoryScope,
    ports::{
        AbilityIdentity, Cancellation, Committed, LiveCollabInterceptor, MintAndPurge,
        MintAndPurgeResult, Mutation, SpaceContext,
    },
};
use serde::{Deserialize, Serialize};
use tokio::{
    runtime::Handle,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};

use crate::{
    filesystem::{EntryKind, ValidatedRoots, VaultDir},
    journal::{
        ArchivedCapture, ConflictReason, DiskConflict, Intent, Journal, random_digest, read_record,
        write_record,
    },
    materials::{MaterialError, ReservedMaterials},
    paths::{GIT_LOCK, file_identity},
    watch::{Dirty, VaultWatch},
};

mod changes;
mod conversion;
mod disk;
mod publish;

pub(crate) use conversion::PendingMint;

const PAGE: u16 = 64;
const POLL: Duration = Duration::from_millis(250);
const SELECTION: &str = "vault-selection.json";

/// Readable by the host after validating the private root, before reopening
/// the selected vault. Opening it still revalidates both root capabilities.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedVault {
    pub scope: HistoryScope,
    pub root: PathBuf,
    pub root_identity: ContentDigest,
}

pub fn saved_vault(roots: &ValidatedRoots) -> Result<Option<SavedVault>, VaultError> {
    roots.verify_current()?;
    match read_record(roots.private_dir(), SELECTION, 32 * 1024) {
        Ok(selection) => Ok(Some(selection)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub struct VaultConfig {
    pub context: SpaceContext,
    pub owned_abilities: Vec<AbilityIdentity>,
    pub live_collaboration: Option<Arc<dyn LiveCollabInterceptor>>,
    /// Rebinding is an explicit host action. A root identity mismatch on
    /// normal startup requires the host to resolve the pairing.
    pub replace_binding: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("a Markdown vault root was not selected")]
    NoVault,
    #[error("selected vault no longer matches the private binding")]
    BindingChanged,
    #[error("vault file could not be verified for conversion")]
    ConversionConflict,
    #[error("vault shutdown was requested")]
    Stopped,
    #[error("local filesystem: {0}")]
    Filesystem(#[from] io::Error),
    #[error("filesystem observation: {0}")]
    Watch(#[from] notify::Error),
    #[error(transparent)]
    Canonical(#[from] PortError),
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error("reserved vault material: {0}")]
    Materials(#[from] MaterialError),
    #[error("vault worker could not be joined")]
    Join,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SyncPhase {
    Starting,
    Reconciling,
    WaitingForGit,
    Watching,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Default)]
pub struct VaultWork {
    pub enumerated_directories: u64,
    pub path_checks: u64,
    pub hashed_files: u64,
    pub parsed_carriers: u64,
}

#[derive(Clone, Debug)]
pub struct VaultStatus {
    pub phase: SyncPhase,
    pub cursor: SpaceSeq,
    pub conflicts: Vec<DiskConflict>,
    pub work: VaultWork,
    pub failure: Option<String>,
}

pub struct Conversion {
    pub committed: Committed<MintAndPurgeResult>,
    pub publication: ConversionPublication,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversionPublication {
    /// The encrypted replacement has not been confirmed at the selected path.
    Pending,
    /// The replacement is in place. The displaced inode is held for recovery.
    CleanupPending,
    /// The replacement is in place and the displaced inode was safely retired.
    Complete,
}

enum Control {
    Reconcile,
    Convert(
        Box<Mutation<MintAndPurge>>,
        oneshot::Sender<Result<Conversion, VaultError>>,
    ),
}

pub struct VaultSupervisor {
    stopping: Cancellation,
    controls: mpsc::Sender<Control>,
    status: watch::Receiver<VaultStatus>,
    worker: JoinHandle<Result<(), VaultError>>,
}

impl VaultSupervisor {
    /// Start after the canonical store and private data root have opened.
    /// The watcher is installed by the worker before it takes its first cut.
    pub fn start(
        roots: Arc<ValidatedRoots>,
        store: CanonicalStore,
        config: VaultConfig,
    ) -> Result<Self, VaultError> {
        roots.verify_current()?;
        if roots.vault().is_none() {
            return Err(VaultError::NoVault);
        }
        let stopping = Cancellation::default();
        let cancellation = stopping.clone();
        let (controls, rx) = mpsc::channel(8);
        let (status_tx, status) = watch::channel(VaultStatus {
            phase: SyncPhase::Starting,
            cursor: SpaceSeq::ZERO,
            conflicts: Vec::new(),
            work: VaultWork::default(),
            failure: None,
        });
        // A slow mounted filesystem must not block the server's async workers.
        let handle = Handle::current();
        let worker = tokio::task::spawn_blocking(move || {
            let result = handle.block_on(async {
                let mut sync =
                    Worker::open(&roots, store, config, cancellation, status_tx.clone()).await?;
                sync.run(rx).await
            });
            status_tx.send_modify(|state| {
                state.phase = if matches!(result, Ok(()) | Err(VaultError::Stopped)) {
                    SyncPhase::Stopped
                } else {
                    SyncPhase::Failed
                };
                if state.phase == SyncPhase::Failed {
                    state.failure = result.as_ref().err().map(ToString::to_string);
                }
            });
            if matches!(result, Err(VaultError::Stopped)) {
                Ok(())
            } else {
                result
            }
        });
        Ok(Self {
            stopping,
            controls,
            status,
            worker,
        })
    }

    pub fn status(&self) -> watch::Receiver<VaultStatus> {
        self.status.clone()
    }

    pub async fn reconcile(&self) -> Result<(), VaultError> {
        self.controls
            .send(Control::Reconcile)
            .await
            .map_err(|_| VaultError::Stopped)
    }

    /// Local transport can probe the exact destination volume before requesting
    /// the destructive canonical conversion. The canonical receipt and the
    /// state of the replacement and its capture are observable separately.
    pub async fn mint_and_purge(
        &self,
        request: Mutation<MintAndPurge>,
    ) -> Result<Conversion, VaultError> {
        let (send, receive) = oneshot::channel();
        self.controls
            .send(Control::Convert(Box::new(request), send))
            .await
            .map_err(|_| VaultError::Stopped)?;
        receive.await.map_err(|_| VaultError::Stopped)?
    }

    pub async fn shutdown(self) -> Result<(), VaultError> {
        self.stopping.cancel();
        self.worker.await.map_err(|_| VaultError::Join)?
    }
}

struct Worker<'a> {
    roots: &'a ValidatedRoots,
    vault: &'a VaultDir,
    watcher: VaultWatch,
    config: VaultConfig,
    store: CanonicalStore,
    binding: VaultBinding,
    journal: Journal,
    reserved: ReservedMaterials,
    stopping: Cancellation,
    status: watch::Sender<VaultStatus>,
    known: HashMap<String, VaultObservation>,
    missing_paths: HashSet<PathBuf>,
    pending: Vec<Intent>,
    captures: HashMap<ContentDigest, ArchivedCapture>,
    conflicts: HashMap<String, DiskConflict>,
    deferred: HashSet<NoteId>,
    conversion_paths: HashSet<NoteId>,
    work: VaultWork,
    inventory_incomplete: bool,
}

impl<'a> Worker<'a> {
    async fn open(
        roots: &'a ValidatedRoots,
        store: CanonicalStore,
        config: VaultConfig,
        stopping: Cancellation,
        status: watch::Sender<VaultStatus>,
    ) -> Result<Self, VaultError> {
        let vault = roots.vault().ok_or(VaultError::NoVault)?;
        let watcher = VaultWatch::open(vault.path_for_watcher())?;
        roots.verify_current()?;
        let root_identity = file_identity(&vault.root_identity());
        let existing = store.vault_binding(&config.context).await?;
        let binding = match existing {
            Some(ref binding)
                if binding.root_identity == root_identity
                    && &binding.scope == config.context.scope() =>
            {
                binding.clone()
            }
            Some(_) if !config.replace_binding => return Err(VaultError::BindingChanged),
            previous => {
                store
                    .bind_vault(
                        config.context.clone(),
                        root_identity,
                        random_digest()?,
                        previous.map(|binding| binding.generation),
                    )
                    .await?
            }
        };
        let journal = Journal::open(roots.private_dir(), &binding)?;
        let selection = SavedVault {
            scope: binding.scope.clone(),
            root: vault.path_for_watcher().to_owned(),
            root_identity,
        };
        if saved_vault(roots)?.as_ref() != Some(&selection) {
            write_record(roots.private_dir(), SELECTION, &selection)?;
        }
        let reserved = ReservedMaterials::open(roots.private_dir(), &binding)?;
        let known = HashMap::new();
        let pending = journal.intents()?;
        let captures = journal
            .captures()?
            .into_iter()
            .map(|capture| (capture.operation, capture))
            .collect();
        let conflicts = journal
            .conflicts()?
            .into_iter()
            .map(|issue| (issue.path.clone(), issue))
            .collect();
        let deferred = journal.deferred()?.into_iter().collect();
        Ok(Self {
            roots,
            vault,
            watcher,
            config,
            store,
            binding,
            journal,
            reserved,
            stopping,
            status,
            known,
            missing_paths: HashSet::new(),
            pending,
            captures,
            conflicts,
            deferred,
            conversion_paths: HashSet::new(),
            work: VaultWork::default(),
            inventory_incomplete: false,
        })
    }

    fn check_stop(&self) -> Result<(), VaultError> {
        if self.stopping.is_cancelled() {
            return Err(VaultError::Stopped);
        }
        Ok(())
    }

    fn report(&self, phase: SyncPhase) {
        let mut conflicts = self.conflicts.values().cloned().collect::<Vec<_>>();
        conflicts.extend(self.captures.values().map(|capture| DiskConflict {
            path: capture.target.to_string_lossy().into_owned(),
            reason: ConflictReason::CaptureUnverified,
            preserved_path: (!capture.unlocated).then(|| capture.retained_at.clone()),
        }));
        conflicts.extend(self.reserved.conflicts().map(|issue| DiskConflict {
            path: issue.path.to_string_lossy().into_owned(),
            reason: ConflictReason::ReservedMaterial,
            preserved_path: issue.preserved_path.clone(),
        }));
        conflicts.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        self.status.send_replace(VaultStatus {
            phase,
            cursor: self.binding.cursor,
            conflicts,
            work: self.work.clone(),
            failure: None,
        });
    }

    fn conflict(
        &mut self,
        path: &Path,
        reason: ConflictReason,
        preserved_path: Option<PathBuf>,
    ) -> Result<(), VaultError> {
        let path = path.to_string_lossy().into_owned();
        let issue = DiskConflict {
            path: path.clone(),
            reason,
            preserved_path,
        };
        if self.conflicts.get(&path) != Some(&issue) {
            self.journal.conflict(&issue)?;
            self.conflicts.insert(path, issue);
        }
        Ok(())
    }

    fn clear_conflict(&mut self, path: &Path) -> Result<(), VaultError> {
        if self
            .conflicts
            .remove(path.to_string_lossy().as_ref())
            .is_some()
        {
            self.journal
                .clear_conflict(path.to_string_lossy().as_ref())?;
        }
        Ok(())
    }

    fn git_busy(&self) -> bool {
        self.vault
            .entry_kind(Path::new(GIT_LOCK))
            .is_ok_and(|kind| kind == Some(EntryKind::File))
    }

    async fn run(&mut self, mut controls: mpsc::Receiver<Control>) -> Result<(), VaultError> {
        let mut dirty = Dirty::default();
        let mut reconcile = true;
        let mut ticker = tokio::time::interval(POLL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            self.check_stop()?;
            self.roots.verify_current()?;
            match self.sync_step(&mut dirty, reconcile).await {
                Ok(again) => reconcile = again,
                Err(
                    VaultError::Canonical(error)
                    | VaultError::Materials(MaterialError::Canonical(error)),
                ) if retry_reconciliation(&error) => {
                    // Reconcile an incomplete cut before withdrawing a file
                    // or advancing the feed after a transient store failure.
                    reconcile = true;
                    self.report(SyncPhase::Reconciling);
                }
                Err(error) => return Err(error),
            }

            tokio::select! {
                biased;
                () = self.stopping.cancelled() => return Ok(()),
                command = controls.recv() => match command {
                    Some(Control::Reconcile) => reconcile = true,
                    Some(Control::Convert(request, reply)) => {
                        let result = self.convert(*request).await;
                        let _ = reply.send(result);
                    }
                    None => return Ok(()),
                },
                event = self.watcher.next() => dirty.merge(event),
                _ = ticker.tick() => {}
            }
        }
    }

    async fn sync_step(&mut self, dirty: &mut Dirty, reconcile: bool) -> Result<bool, VaultError> {
        if self.git_busy() {
            self.report(SyncPhase::WaitingForGit);
            return Ok(reconcile);
        }
        let retry_blocked_subtree = self.inventory_incomplete
            && dirty.paths.iter().any(|path| {
                self.conflicts
                    .get(path.to_string_lossy().as_ref())
                    .is_some_and(|issue| issue.reason == ConflictReason::UnsafePath)
            });
        // An installation of the native watch needs its own inventory cut.
        let restore_coverage =
            self.inventory_incomplete && (reconcile || dirty.rescan || retry_blocked_subtree);
        let restored = self.watcher.restore_native(restore_coverage)?;
        let needs_seed = reconcile || dirty.rescan || retry_blocked_subtree || restored;
        let handoffs = self
            .store
            .vault_handoffs(&self.config.context, &self.binding)
            .await?;
        let pending_purge = handoffs.iter().any(|handoff| handoff.new_note.is_none());
        let settled = if needs_seed || (pending_purge && !self.inventory_incomplete) {
            self.report(SyncPhase::Reconciling);
            *dirty = Dirty::default();
            self.reconcile_all(handoffs).await?
        } else {
            let had_conversion = handoffs.iter().any(|handoff| handoff.new_note.is_some());
            self.apply_handoffs(&handoffs).await?;
            let handoffs = if had_conversion {
                self.store
                    .vault_handoffs(&self.config.context, &self.binding)
                    .await?
            } else {
                handoffs
            };
            self.process_dirty(std::mem::take(dirty), &handoffs).await?;
            let settled = self.read_changes().await?;
            self.resume_deferred().await?;
            settled
        };
        if settled {
            self.report(SyncPhase::Watching);
        }
        Ok(!settled)
    }

    async fn reconcile_all(&mut self, mut handoffs: Vec<VaultHandoff>) -> Result<bool, VaultError> {
        let loss = self.watcher.loss();
        // A polling backend can miss brief namespace transitions between samples.
        self.inventory_incomplete = self.watcher.is_polling();
        // Events received before the inventory are covered by the inventory.
        let _before_inventory = self.watcher.take();
        self.recover_captures(None)?;
        self.recover_preparations(&handoffs).await?;
        handoffs = self
            .store
            .vault_handoffs(&self.config.context, &self.binding)
            .await?;
        self.recover_publications(&handoffs).await?;
        self.reserved.recover(self.vault)?;
        self.apply_handoffs(&handoffs).await?;
        handoffs = self
            .store
            .vault_handoffs(&self.config.context, &self.binding)
            .await?;
        let mut paths = self.inventory(Path::new(""))?;
        self.add_previous_paths(&mut paths, None).await?;
        let unsettled = self.watcher.take();
        if unsettled.rescan || self.watcher.loss() != loss || self.git_busy() {
            return Ok(false);
        }
        paths.extend(self.expand(unsettled.paths).await?);
        self.reconcile_disk(paths, unsettled.renames, &handoffs, false)
            .await?;
        if self.watcher.loss() != loss || self.git_busy() {
            return Ok(false);
        }
        // Complete removal classification on a stable cut. Retain rename
        // pairs and process any arrivals from the inventory/import interval
        // before allowing the old paths to be classified as deletions.
        let mut tail = self.watcher.take();
        if tail.rescan {
            return Ok(false);
        }
        self.add_previous_paths(&mut tail.paths, None).await?;
        let tail_paths = self.expand(tail.paths).await?;
        self.reconcile_disk(tail_paths, tail.renames, &handoffs, true)
            .await?;
        if !self.seed().await? {
            return Ok(false);
        }
        self.resume_deferred().await?;
        let unsettled = self.watcher.take();
        if self.watcher.loss() != loss || self.git_busy() || unsettled.rescan {
            return Ok(false);
        }
        if !unsettled.is_empty() {
            self.process_dirty(unsettled, &handoffs).await?;
            if self.watcher.loss() != loss || self.git_busy() {
                return Ok(false);
            }
        }
        // Ordinary purge work is only retired after the stable full cut.
        if self.inventory_incomplete {
            return Ok(true);
        }
        for handoff in handoffs
            .into_iter()
            .filter(|handoff| handoff.new_note.is_none())
        {
            self.store
                .complete_vault_handoff(self.config.context.clone(), &self.binding, handoff, None)
                .await?;
        }
        Ok(true)
    }
}

fn retry_reconciliation(error: &PortError) -> bool {
    match error {
        PortError::DeadlineExceeded(failure) if failure.effect() == CommitEffect::NotCommitted => {
            true
        }
        PortError::DeadlineExceeded(failure) | PortError::Unavailable(failure) => {
            failure.retry() != RetryAdvice::Never
        }
        _ => false,
    }
}
