use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
};

use notarium_canonical::vault::{VaultHandoff, VaultImport, VaultObservation, VaultPath};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{CommandKey, ContentDigest, FolderId, NoteId, RevisionId},
    ports::{
        Committed, CreateNote, DeleteDisposition, DeleteNote, ExternalObservation,
        ExternalObservationResult, MoveNote, Mutation, NoteRevision, NoteWritePort,
        ObservedContent, Preconditions, RenameFolder,
    },
    receipt::CommandIdentity,
};

use super::{PAGE, VaultError, Worker};
use crate::{
    carrier::{self, NoteCarrier},
    filesystem::{EntryKind, FileStamp, ObservedFile},
    journal::ConflictReason,
    paths::{PathUse, digest, file_identity, file_stamp, is_note, path_use, same_file, vault_path},
    publication::MAX_NOTE_BYTES,
    watch::Dirty,
};

#[derive(Debug)]
struct Candidate {
    relative: PathBuf,
    path: VaultPath,
    stamp: FileStamp,
    carrier: NoteCarrier,
    binding: Option<VaultObservation>,
    source: Option<VaultObservation>,
}

struct Edit {
    relative: PathBuf,
    old: VaultObservation,
    stamp: FileStamp,
    request: Mutation<ExternalObservation>,
}

enum Write {
    Observe(Box<Edit>),
    Import(Box<(Candidate, Mutation<VaultImport>)>),
}

impl Write {
    fn byte_size(&self) -> u64 {
        match self {
            Self::Observe(edit) => edit.stamp.size,
            Self::Import(import) => import.0.stamp.size,
        }
    }
}

enum Outcome {
    Observe(Box<(Edit, Result<ExternalObservationResult, PortError>)>),
    Import(Box<(Candidate, Result<Committed<NoteRevision>, PortError>)>),
}

impl Worker<'_> {
    pub(super) fn inventory(&mut self, prefix: &Path) -> Result<HashSet<PathBuf>, VaultError> {
        let mut paths = HashSet::new();
        let mut dirs = vec![prefix.to_owned()];
        while let Some(directory) = dirs.pop() {
            self.check_stop()?;
            self.work.enumerated_directories += 1;
            let entries = match self.vault.list(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) if path_error(&error) && !directory.as_os_str().is_empty() => {
                    self.inventory_incomplete = true;
                    self.conflict(&directory, ConflictReason::UnsafePath, None)?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let path = directory.join(&entry.name);
                match (path_use(&path), entry.kind) {
                    (PathUse::Reserved, _) => self.reserved.observe_reserved(self.vault, &path)?,
                    (PathUse::Notes, EntryKind::Directory) => dirs.push(path),
                    (PathUse::Notes, _) if is_note(&path) => {
                        paths.insert(path);
                    }
                    _ => {}
                }
            }
        }
        Ok(paths)
    }

    pub(super) async fn add_previous_paths(
        &self,
        into: &mut HashSet<PathBuf>,
        prefix: Option<&str>,
    ) -> Result<(), VaultError> {
        let mut after = None;
        loop {
            self.check_stop()?;
            let page = self
                .store
                .vault_observations(
                    &self.config.context,
                    &self.binding,
                    prefix,
                    after.as_deref(),
                    PAGE,
                )
                .await?;
            if page.is_empty() {
                return Ok(());
            }
            after = page.last().map(|item| item.path.key.clone());
            for observation in page {
                into.insert(PathBuf::from(observation.path.relative));
            }
        }
    }

    pub(super) async fn expand(
        &mut self,
        paths: HashSet<PathBuf>,
    ) -> Result<HashSet<PathBuf>, VaultError> {
        let mut candidates = HashSet::new();
        for path in paths {
            self.check_stop()?;
            match path_use(&path) {
                PathUse::Reserved => self.reserved.observe_reserved(self.vault, &path)?,
                PathUse::Notes => {
                    // A Markdown name is still allowed to be a directory.
                    match self.vault.entry_kind(&path) {
                        Ok(Some(EntryKind::Directory)) => {
                            candidates.extend(self.inventory(&path)?);
                        }
                        Ok(None) => {
                            if let Ok(prefix) = vault_path(&path) {
                                self.add_previous_paths(&mut candidates, Some(&prefix.key))
                                    .await?;
                            }
                        }
                        Ok(_) => {}
                        Err(error) if path_error(&error) => {
                            self.inventory_incomplete = true;
                            self.conflict(&path, ConflictReason::UnsafePath, None)?;
                            continue;
                        }
                        Err(error) => return Err(error.into()),
                    }
                    if is_note(&path) {
                        candidates.insert(path);
                    }
                }
                PathUse::Ignore => {}
            }
        }
        Ok(candidates)
    }

    pub(super) async fn process_dirty(
        &mut self,
        mut dirty: Dirty,
        handoffs: &[VaultHandoff],
    ) -> Result<(), VaultError> {
        dirty.paths.extend(self.missing_paths.drain());
        let paths = self.expand(dirty.paths).await?;
        self.reconcile_disk(paths, dirty.renames, handoffs, true)
            .await
    }

    pub(super) async fn reconcile_disk(
        &mut self,
        paths: HashSet<PathBuf>,
        renames: Vec<(PathBuf, PathBuf)>,
        handoffs: &[VaultHandoff],
        allow_delete: bool,
    ) -> Result<(), VaultError> {
        let mut file_paths = paths.into_iter().collect::<Vec<_>>();
        let loss = self.watcher.loss();
        let renames: HashMap<_, _> = renames.into_iter().map(|(from, to)| (to, from)).collect();
        file_paths.sort_unstable();
        let mut claims = HashMap::<NoteId, usize>::new();
        let mut missing = Vec::new();
        let mut candidates = Vec::new();
        let mut spelling = HashMap::new();
        let mut collisions = HashSet::new();
        let mut protected = HashSet::new();
        for relative in file_paths {
            self.check_stop()?;
            let Ok(path) = vault_path(&relative) else {
                self.conflict(&relative, ConflictReason::UnsafePath, None)?;
                continue;
            };
            let binding = self.observation_at(&path).await?;
            let read = match self.read_disk(&relative) {
                Err(error)
                    if error.kind() == io::ErrorKind::AlreadyExists
                        && binding
                            .as_ref()
                            .is_some_and(|old| old.path.relative == path.relative)
                        && matches!(self.vault.entry_kind_exact(&relative), Ok(None)) =>
                {
                    // A case-insensitive lookup can see the new spelling
                    // while this inventory also includes the old SQL path.
                    Ok(None)
                }
                result => result,
            };
            let observed = match read {
                Ok(Some(observed)) => observed,
                Ok(None) => {
                    if let Some(binding) = binding
                        && binding.path.relative == path.relative
                    {
                        missing.push(binding);
                    }
                    continue;
                }
                Err(error) if path_error(&error) => {
                    self.conflict(&relative, ConflictReason::UnsafePath, None)?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if let Some(previous) = spelling.insert(path.key.clone(), relative.clone()) {
                self.conflict(&previous, ConflictReason::NameCollision, None)?;
                self.conflict(&relative, ConflictReason::NameCollision, None)?;
                collisions.insert(path.key.clone());
                continue;
            }
            let (binding, renamed_alias) = match binding {
                Some(binding) if binding.path.relative != path.relative => (None, Some(binding)),
                binding => (binding, None),
            };
            if let Some(old) = &renamed_alias {
                // Seeing an ambiguous spelling must not trash the bound note.
                protected.insert(old.note.clone());
            }
            if self.blocks_ordinary_input(&relative) {
                continue;
            }
            if let Some(binding) = &binding
                && same_file(&binding.file, &observed.stamp)
            {
                continue;
            }
            let carrier = match self.inspect_disk(&observed) {
                Ok(carrier) => carrier,
                Err(_) => {
                    self.conflict(&relative, ConflictReason::InvalidCarrier, None)?;
                    continue;
                }
            };
            if self
                .filter_handoffs(&relative, &observed.stamp, &carrier, handoffs)
                .await?
            {
                continue;
            }
            let source = if let Some(old) = renamed_alias {
                if let Some(source) = self
                    .move_source(&relative, &observed.stamp, &carrier, &renames)
                    .await?
                    && source.note == old.note
                {
                    Some(source)
                } else {
                    self.conflict(&relative, ConflictReason::NameCollision, None)?;
                    continue;
                }
            } else if binding.is_none() {
                self.move_source(&relative, &observed.stamp, &carrier, &renames)
                    .await?
            } else {
                None
            };
            if let Some(source) = &source {
                *claims.entry(source.note.clone()).or_default() += 1;
            }
            candidates.push(Candidate {
                relative,
                path,
                stamp: observed.stamp,
                carrier,
                binding,
                source,
            });
        }

        // Examine every arrival before authorizing deletions or losing the
        // source-side identity across a writer page boundary.
        let mut moved = HashSet::new();
        let mut batch = Vec::new();
        let mut batch_bytes = 0;
        for candidate in candidates {
            self.check_stop()?;
            if collisions.contains(&candidate.path.key) {
                continue;
            }
            if let Some(source) = &candidate.source {
                moved.insert(source.note.clone());
                if claims.get(&source.note).copied().unwrap_or_default() != 1 {
                    self.conflict(&candidate.relative, ConflictReason::NameCollision, None)?;
                    continue;
                }
                // Move plus edit for one note is a dependent sequence.
                self.write_batch(std::mem::take(&mut batch)).await?;
                batch_bytes = 0;
            }
            if let Some(write) = self.prepare_candidate(candidate).await? {
                let size = write.byte_size();
                if batch.len() >= usize::from(PAGE)
                    || (batch_bytes + size > MAX_NOTE_BYTES as u64 && !batch.is_empty())
                {
                    self.write_batch(std::mem::take(&mut batch)).await?;
                    batch_bytes = 0;
                }
                batch_bytes += size;
                batch.push(write);
            }
        }
        self.write_batch(batch).await?;
        for old in missing {
            self.check_stop()?;
            if moved.contains(&old.note) || protected.contains(&old.note) {
                continue;
            }
            if allow_delete && self.watcher.quiet_since(loss) && !self.git_busy() {
                self.delete_missing(old, loss).await?;
            } else {
                self.missing_paths.insert(PathBuf::from(old.path.relative));
            }
        }
        Ok(())
    }

    fn blocks_ordinary_input(&self, relative: &Path) -> bool {
        self.pending.iter().any(|intent| intent.target == relative)
            || self
                .conflicts
                .get(relative.to_string_lossy().as_ref())
                .is_some_and(|issue| {
                    matches!(
                        issue.reason,
                        ConflictReason::ClaimedPurgedIdentity
                            | ConflictReason::ChangedWhilePublishing
                            | ConflictReason::UnresolvedPublication
                    )
                })
    }

    fn inspect_disk(&mut self, observed: &ObservedFile) -> Result<NoteCarrier, VaultError> {
        self.work.parsed_carriers += 1;
        let text = markdown(observed)?;
        Ok(carrier::inspect(text)?)
    }

    pub(super) fn read_disk(&mut self, relative: &Path) -> io::Result<Option<ObservedFile>> {
        self.work.path_checks += 1;
        let result = self.vault.read(relative, MAX_NOTE_BYTES)?;
        if result.is_some() {
            self.work.hashed_files += 1;
        }
        Ok(result)
    }

    async fn observation_at(
        &mut self,
        path: &VaultPath,
    ) -> Result<Option<VaultObservation>, VaultError> {
        if let Some(known) = self.known.get(&path.key) {
            return Ok(Some(known.clone()));
        }
        let found = self
            .store
            .vault_observation_at(&self.config.context, &self.binding, &path.key)
            .await?;
        if let Some(found) = &found {
            self.known.insert(path.key.clone(), found.clone());
        }
        Ok(found)
    }

    async fn move_source(
        &mut self,
        relative: &Path,
        stamp: &FileStamp,
        carrier: &NoteCarrier,
        renames: &HashMap<PathBuf, PathBuf>,
    ) -> Result<Option<VaultObservation>, VaultError> {
        let proposed = if let Some(note) = &carrier.asserted_id {
            self.store
                .vault_observation_for(&self.config.context, &self.binding, note)
                .await?
        } else {
            let old_path = paired_source(relative, renames).and_then(|path| vault_path(&path).ok());
            match old_path {
                Some(path) => self
                    .observation_at(&path)
                    .await?
                    .filter(|old| old.file.identity == file_identity(&stamp.identity)),
                None => None,
            }
        };
        let Some(old) = proposed else {
            return Ok(None);
        };
        // Any error from a capability-relative probe fails the absence
        // predicate. Only a confirmed missing name authorizes a move.
        if !self.old_name_left(&old, relative)? {
            return Ok(None);
        }
        let current = self
            .store
            .read_vault_note(&self.config.context, &old.note)
            .await?;
        Ok(current
            .filter(|current| current.class == carrier.class)
            .map(|_| old))
    }

    async fn prepare_candidate(
        &mut self,
        candidate: Candidate,
    ) -> Result<Option<Write>, VaultError> {
        let Some(observed) = self.read_disk(&candidate.relative)? else {
            return Ok(None);
        };
        if observed.stamp != candidate.stamp {
            // The watcher will deliver the later write; never submit from
            // bytes unrelated to the path/candidate decision.
            return Ok(None);
        }
        let text = markdown(&observed)?;
        if let Some(old) = candidate.binding {
            self.prepare_edit(&candidate.relative, old, observed.stamp.clone(), text)
                .await
        } else if let Some(old) = candidate.source {
            self.move_observed(
                candidate.path,
                candidate.relative,
                old,
                observed.stamp.clone(),
                text,
            )
            .await?;
            Ok(None)
        } else {
            self.prepare_import(candidate, text).await
        }
    }

    async fn move_observed(
        &mut self,
        path: VaultPath,
        relative: PathBuf,
        old: VaultObservation,
        stamp: FileStamp,
        source: &str,
    ) -> Result<(), VaultError> {
        if !self.old_name_left(&old, &relative)? || self.git_busy() {
            return self.conflict(&relative, ConflictReason::CanonicalDiverged, None);
        }
        if path.key == old.path.key {
            match self
                .reconcile_folder_spelling(Path::new(&old.path.relative), &relative)
                .await
            {
                Ok(()) => {}
                Err(VaultError::Canonical(PortError::Domain(_)) | VaultError::Domain(_)) => {
                    return self.conflict(&relative, ConflictReason::NameCollision, None);
                }
                Err(VaultError::Filesystem(error)) if path_error(&error) => {
                    return self.conflict(&relative, ConflictReason::UnsafePath, None);
                }
                Err(error) => return Err(error),
            }
        }
        let (parent, slug) = self.destination(&relative).await?;
        if !self.old_name_left(&old, &relative)? || self.git_busy() {
            return self.conflict(&relative, ConflictReason::CanonicalDiverged, None);
        }
        let identity = self.identity("move", &path, &stamp, Some(&old.revision));
        let request = Mutation {
            identity,
            preconditions: Preconditions {
                revision: Some(old.revision.clone()),
                ..Default::default()
            },
            input: MoveNote {
                note: old.note.clone(),
                parent,
                slug,
            },
        };
        match self
            .store
            .move_vault_note(
                self.config.context.clone(),
                &self.binding,
                old.clone(),
                path.clone(),
                request,
            )
            .await
        {
            Ok(result) => {
                self.known.remove(&old.path.key);
                if path.key == old.path.key
                    && self
                        .conflicts
                        .get(old.path.relative.as_str())
                        .is_some_and(|issue| issue.reason == ConflictReason::UnsafePath)
                {
                    self.clear_conflict(Path::new(&old.path.relative))?;
                }
                let current = self
                    .store
                    .vault_observation_for(&self.config.context, &self.binding, &old.note)
                    .await?;
                let Some(attached) = current else {
                    return Ok(());
                };
                // The canonical move itself updates the revision. A
                // concurrent edit cannot borrow that revision as its base.
                if attached.revision != result.value.revision {
                    return self.conflict(&relative, ConflictReason::CanonicalDiverged, None);
                }
                if let Some(write) = self
                    .prepare_edit(&relative, attached, stamp, source)
                    .await?
                {
                    self.write_batch(vec![write]).await?;
                }
                Ok(())
            }
            Err(PortError::Domain(_)) => {
                self.conflict(&relative, ConflictReason::CanonicalDiverged, None)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn prepare_edit(
        &mut self,
        relative: &Path,
        old: VaultObservation,
        stamp: FileStamp,
        source: &str,
    ) -> Result<Option<Write>, VaultError> {
        let Some(current) = self
            .store
            .read_vault_note(&self.config.context, &old.note)
            .await?
        else {
            self.conflict(relative, ConflictReason::CanonicalDiverged, None)?;
            return Ok(None);
        };
        let normalized =
            match carrier::for_observation(source, &current.carrier, current.class, &old.note) {
                Ok(carrier) => carrier,
                Err(_) => {
                    self.conflict(relative, ConflictReason::InvalidCarrier, None)?;
                    return Ok(None);
                }
            };
        let carrier_digest = digest(normalized.as_bytes());
        if current.note.revision != old.revision && current.carrier_digest != carrier_digest {
            self.diverged(relative, &old, &stamp, source, &current)
                .await?;
            return Ok(None);
        }
        // A copy on the same path with new bytes but the old inode metadata
        // still crosses this digest comparison and the canonical interceptor.
        if current.carrier_digest == carrier_digest {
            self.stamp_edit(relative, old, &stamp, current.note.revision, carrier_digest)
                .await?;
            return Ok(None);
        }
        let identity = self.identity("observe", &old.path, &stamp, Some(&old.revision));
        let request = Mutation {
            identity,
            preconditions: Preconditions {
                revision: Some(old.revision.clone()),
                ..Default::default()
            },
            input: ExternalObservation {
                note: old.note.clone(),
                observed_digest: carrier_digest,
                base_revision: old.revision.clone(),
                disk_identity: file_identity(&stamp.identity),
                content: ObservedContent::Carrier(normalized),
            },
        };
        Ok(Some(Write::Observe(Box::new(Edit {
            relative: relative.to_owned(),
            old,
            stamp,
            request,
        }))))
    }

    async fn stamp_edit(
        &mut self,
        relative: &Path,
        old: VaultObservation,
        stamp: &FileStamp,
        revision: RevisionId,
        carrier_digest: ContentDigest,
    ) -> Result<(), VaultError> {
        let note = old.note.clone();
        let actual = VaultObservation {
            note: old.note.clone(),
            revision,
            path: old.path.clone(),
            file: file_stamp(stamp),
            carrier_digest,
        };
        match self.confirm_observation(Some(old), actual).await {
            Ok(()) => self.materialize(&note).await,
            Err(VaultError::Canonical(PortError::Domain(_))) => {
                self.conflict(relative, ConflictReason::CanonicalDiverged, None)
            }
            Err(error) => Err(error),
        }
    }

    async fn prepare_import(
        &mut self,
        candidate: Candidate,
        source: &str,
    ) -> Result<Option<Write>, VaultError> {
        let identity = self.identity("create", &candidate.path, &candidate.stamp, None);
        let note = NoteId::from_bytes(derived_id(identity.hash, "notarium v1 vault note"));
        let (parent, slug) = match self.destination(&candidate.relative).await {
            Ok(destination) => destination,
            Err(VaultError::Canonical(PortError::Domain(_))) | Err(VaultError::Domain(_)) => {
                self.conflict(&candidate.relative, ConflictReason::NameCollision, None)?;
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let prepared = carrier::for_import(source, candidate.carrier.class)?;
        let request = Mutation {
            identity,
            preconditions: Preconditions::default(),
            input: VaultImport {
                create: CreateNote {
                    note: note.clone(),
                    parent,
                    slug,
                    class: candidate.carrier.class,
                    carrier: prepared,
                },
                claimed_note: candidate.carrier.asserted_id.clone(),
                path: candidate.path.clone(),
                file: file_stamp(&candidate.stamp),
            },
        };
        Ok(Some(Write::Import(Box::new((candidate, request)))))
    }

    async fn write_batch(&mut self, batch: Vec<Write>) -> Result<(), VaultError> {
        let mut operations = tokio::task::JoinSet::new();
        for write in batch {
            let store = self.store.clone();
            let ctx = self.config.context.clone();
            let binding = self.binding.clone();
            operations.spawn(async move {
                match write {
                    Write::Observe(edit) => {
                        let result = store
                            .accept_vault_observation(
                                ctx,
                                &binding,
                                edit.old.clone(),
                                edit.request.clone(),
                            )
                            .await;
                        Outcome::Observe(Box::new((*edit, result)))
                    }
                    Write::Import(import) => {
                        let (candidate, request) = *import;
                        let result = store.import_vault_note(ctx, &binding, request).await;
                        Outcome::Import(Box::new((candidate, result)))
                    }
                }
            });
        }
        let mut error = None;
        // Drain all submitted operations even if one WriteBatchActor item
        // fails. A sibling receipt still owns its corresponding stamp work.
        while let Some(outcome) = operations.join_next().await {
            let result = match outcome {
                Ok(outcome) => self.finish_write(outcome).await,
                Err(_) => Err(VaultError::Join),
            };
            if let Err(issue) = result {
                error.get_or_insert(issue);
            }
        }
        error.map_or(Ok(()), Err)
    }

    async fn finish_write(&mut self, outcome: Outcome) -> Result<(), VaultError> {
        match outcome {
            Outcome::Observe(outcome) => self.finish_edit(*outcome).await,
            Outcome::Import(outcome) => self.finish_import(*outcome).await,
        }
    }

    async fn finish_edit(
        &mut self,
        (edit, result): (Edit, Result<ExternalObservationResult, PortError>),
    ) -> Result<(), VaultError> {
        let revision = match result {
            Ok(ExternalObservationResult::Committed(result)) => result.value.revision,
            Ok(ExternalObservationResult::NoChange { revision }) => revision,
            Ok(ExternalObservationResult::Conflict { .. }) | Err(PortError::Domain(_)) => {
                let current = self
                    .store
                    .read_vault_note(&self.config.context, &edit.old.note)
                    .await?;
                if let (Some(current), Some(file)) = (current, self.read_disk(&edit.relative)?)
                    && file.stamp == edit.stamp
                {
                    let source = markdown(&file)?;
                    return self
                        .diverged(&edit.relative, &edit.old, &edit.stamp, source, &current)
                        .await;
                }
                return self.conflict(&edit.relative, ConflictReason::CanonicalDiverged, None);
            }
            Err(error) => return Err(error.into()),
        };
        self.stamp_edit(
            &edit.relative,
            edit.old,
            &edit.stamp,
            revision,
            edit.request.input.observed_digest,
        )
        .await
    }

    async fn finish_import(
        &mut self,
        (candidate, result): (Candidate, Result<Committed<NoteRevision>, PortError>),
    ) -> Result<(), VaultError> {
        match result {
            Ok(committed) => {
                self.known.remove(&candidate.path.key);
                self.materialize(&committed.value.note).await
            }
            Err(PortError::Domain(error)) => {
                let reason = if matches!(error, DomainError::ResourceNotFound) {
                    ConflictReason::ClaimedPurgedIdentity
                } else {
                    ConflictReason::NameCollision
                };
                self.conflict(&candidate.relative, reason, None)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn delete_missing(&mut self, old: VaultObservation, loss: u64) -> Result<(), VaultError> {
        let path = Path::new(&old.path.relative);
        if self.git_busy() || !self.watcher.quiet_since(loss) {
            self.missing_paths.insert(path.to_owned());
            return Ok(());
        }
        if self.blocks_ordinary_input(path) || !matches!(self.vault.entry_kind(path), Ok(None)) {
            return Ok(());
        }
        let identity = self.command(
            "trash",
            &[old.path.key.as_bytes(), old.revision.as_str().as_bytes()],
        );
        let request = Mutation {
            identity,
            preconditions: Preconditions {
                revision: Some(old.revision.clone()),
                ..Default::default()
            },
            input: DeleteNote {
                note: old.note.clone(),
                disposition: DeleteDisposition::Trash,
            },
        };
        if !self.watcher.quiet_since(loss) {
            self.missing_paths.insert(path.to_owned());
            return Ok(());
        }
        match self
            .store
            .trash_vault_note_with_fence(
                self.config.context.clone(),
                &self.binding,
                old.clone(),
                request,
                self.watcher.deletion_fence(loss),
            )
            .await
        {
            Ok(_) => {
                self.known.remove(&old.path.key);
                self.clear_conflict(path)
            }
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale =>
            {
                self.missing_paths.insert(path.to_owned());
                Ok(())
            }
            Err(PortError::Domain(_)) => {
                self.conflict(path, ConflictReason::CanonicalDiverged, None)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn old_name_left(&self, old: &VaultObservation, new: &Path) -> Result<bool, VaultError> {
        let previous = Path::new(&old.path.relative);
        let entry = if previous != new && old.path.key == vault_path(new)?.key {
            self.vault.entry_kind_exact(previous)
        } else {
            self.vault.entry_kind(previous)
        };
        Ok(matches!(entry, Ok(None)))
    }

    async fn reconcile_folder_spelling(&self, old: &Path, new: &Path) -> Result<(), VaultError> {
        let previous_parent = old.parent().unwrap_or(Path::new(""));
        let new_parent = new.parent().unwrap_or(Path::new(""));
        if previous_parent == new_parent {
            return Ok(());
        }
        let mut parent = None;
        let mut previous_prefix = PathBuf::new();
        let mut new_prefix = PathBuf::new();
        let invalid = || DomainError::validation(ValidationReason::InvalidPathComponent);
        for (previous, new) in previous_parent.components().zip(new_parent.components()) {
            let previous = previous.as_os_str().to_str().ok_or_else(invalid)?;
            let new = new.as_os_str().to_str().ok_or_else(invalid)?;
            previous_prefix.push(previous);
            new_prefix.push(new);
            let folder = self
                .store
                .vault_folder_at(&self.config.context, &self.binding, parent.as_ref(), new)
                .await?
                .ok_or_else(invalid)?;
            if folder.name != new {
                if folder.name != previous
                    || self.vault.entry_kind_exact(&previous_prefix)?.is_some()
                    || self.vault.entry_kind(&new_prefix)? != Some(EntryKind::Directory)
                {
                    return Err(invalid().into());
                }
                let identity = self.command(
                    "folder spelling",
                    &[
                        folder.id.as_str().as_bytes(),
                        folder.revision.as_str().as_bytes(),
                        new.as_bytes(),
                    ],
                );
                self.store
                    .rename_folder(
                        self.config.context.clone(),
                        Mutation {
                            identity,
                            preconditions: Preconditions {
                                revision: Some(folder.revision),
                                ..Preconditions::default()
                            },
                            input: RenameFolder {
                                folder: folder.id.clone(),
                                name: new.to_owned(),
                            },
                        },
                    )
                    .await?;
            }
            parent = Some(folder.id);
        }
        Ok(())
    }

    async fn destination(&self, relative: &Path) -> Result<(Option<FolderId>, String), VaultError> {
        let slug = relative
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid Markdown filename")
            })?;
        let mut parent = None;
        for component in relative.parent().unwrap_or(Path::new("")).components() {
            let name = component.as_os_str().to_str().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid vault folder name")
            })?;
            parent = Some(self.resolve_folder(parent, name).await?);
        }
        Ok((parent, slug.to_owned()))
    }

    async fn resolve_folder(
        &self,
        parent: Option<FolderId>,
        name: &str,
    ) -> Result<FolderId, VaultError> {
        let parent_key = parent.as_ref().map_or("", FolderId::as_str);
        let lookup = notarium_syntax::unicode::lookup_key(name);
        let locator = self
            .command(
                "folder locator",
                &[parent_key.as_bytes(), lookup.as_bytes()],
            )
            .hash;
        for retry in [false, true] {
            let attempt = self.journal.folder_attempt(locator)?;
            let identity = self.command("folder", &[locator.as_bytes(), attempt.as_bytes()]);
            let candidate =
                FolderId::from_bytes(derived_id(identity.hash, "notarium v1 vault folder"));
            let result = self
                .store
                .resolve_vault_folder(
                    self.config.context.clone(),
                    &self.binding,
                    parent.clone(),
                    name,
                    candidate,
                    identity,
                )
                .await;
            match result {
                Ok(folder) => {
                    self.journal.clear_folder_attempt(locator)?;
                    return Ok(folder);
                }
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if diagnostic.reason == ValidationReason::CursorStale && !retry =>
                {
                    // A completed older attempt no longer names this
                    // placement. Issue a fresh identity for the new folder.
                    self.journal.clear_folder_attempt(locator)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        unreachable!("second attempt returns its result")
    }

    pub(super) fn command(&self, kind: &str, parts: &[&[u8]]) -> CommandIdentity {
        let mut hash = blake3::Hasher::new_derive_key("notarium v1 vault command");
        hash.update(self.binding.generation.as_bytes());
        hash.update(kind.as_bytes());
        for part in parts {
            hash.update(&(part.len() as u64).to_be_bytes());
            hash.update(part);
        }
        let hash = ContentDigest::from_bytes(*hash.finalize().as_bytes());
        CommandIdentity {
            scope: self.binding.scope.clone(),
            actor: self.config.context.auth().principal().clone(),
            key: CommandKey::from_bytes(derived_id(hash, "notarium v1 vault command key")),
            hash,
        }
    }

    fn identity(
        &self,
        kind: &str,
        path: &VaultPath,
        stamp: &FileStamp,
        base: Option<&RevisionId>,
    ) -> CommandIdentity {
        self.command(
            kind,
            &[
                path.relative.as_bytes(),
                path.key.as_bytes(),
                file_identity(&stamp.identity).as_bytes(),
                stamp.digest.as_bytes(),
                &stamp.mtime_ns.to_be_bytes(),
                base.map_or("", RevisionId::as_str).as_bytes(),
            ],
        )
    }
}

fn paired_source(path: &Path, renames: &HashMap<PathBuf, PathBuf>) -> Option<PathBuf> {
    path.ancestors().find_map(|to| {
        let from = renames.get(to)?;
        let suffix = path.strip_prefix(to).ok()?;
        if suffix.as_os_str().is_empty() {
            Some(from.clone())
        } else {
            Some(from.join(suffix))
        }
    })
}

fn derived_id(digest: ContentDigest, domain: &str) -> [u8; 16] {
    let mut id = [0; 16];
    let mut hash = blake3::Hasher::new_derive_key(domain);
    hash.update(digest.as_bytes());
    hash.finalize_xof().fill(&mut id);
    id
}

pub(super) fn markdown(observed: &ObservedFile) -> io::Result<&str> {
    std::str::from_utf8(&observed.bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub(super) fn path_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::InvalidData
            | io::ErrorKind::InvalidInput
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::AlreadyExists
            | io::ErrorKind::NotADirectory
            | io::ErrorKind::Unsupported
    )
}
