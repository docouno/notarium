use std::path::{Path, PathBuf};

use notarium_canonical::vault::{VaultHandoff, VaultNote, VaultObservation};
use notarium_core::{
    classes::DocClass,
    error::PortError,
    ids::{ContentDigest, NoteId},
    ports::FilenamePin,
};

use super::{ConversionPublication, VaultError, Worker, disk::path_error};
use crate::{
    carrier::{self, NoteCarrier},
    filesystem::{CaptureCleanup, CapturedFile, FileStamp},
    journal::{
        Action, ArchivedCapture, ConflictReason, ConversionName, DesiredFile, Intent,
        PublishPurpose,
    },
    paths::{digest, file_identity, file_stamp, note_path, same_file, vault_path},
    publication::{self, Placement, Removal},
};

impl Worker<'_> {
    pub(super) async fn confirm_observation(
        &mut self,
        expected: Option<VaultObservation>,
        actual: VaultObservation,
    ) -> Result<(), VaultError> {
        self.store
            .put_vault_observation(
                self.config.context.clone(),
                &self.binding,
                expected.clone(),
                actual.clone(),
            )
            .await?;
        if let Some(expected) = expected {
            self.known.remove(&expected.path.key);
        }
        self.known.insert(actual.path.key.clone(), actual);
        Ok(())
    }

    pub(super) async fn materialize(&mut self, id: &NoteId) -> Result<(), VaultError> {
        if self.conversion_paths.contains(id) {
            return Ok(());
        }
        let previous = self
            .store
            .vault_observation_for(&self.config.context, &self.binding, id)
            .await?;
        let Some(current) = self.store.read_vault_note(&self.config.context, id).await? else {
            self.journal.clear_conversion_name(id)?;
            if let Some(previous) = previous {
                self.retire_observation(previous).await?;
            }
            return Ok(());
        };
        let preferred = match note_path(&current.folders, &current.slug) {
            Ok(path) => path,
            Err(_) => {
                let path = current
                    .folders
                    .iter()
                    .collect::<PathBuf>()
                    .join(format!("{}.md", current.slug));
                return self.conflict(&path, ConflictReason::UnsafePath, None);
            }
        };
        let mut target = match self.journal.conversion_name(id)? {
            Some(name) if name.canonical == preferred => name.published,
            Some(_) => {
                self.journal.clear_conversion_name(id)?;
                preferred.clone()
            }
            None => preferred.clone(),
        };
        if let Some(interceptor) = &self.config.live_collaboration {
            match interceptor
                .filename_pin(self.config.context.clone(), id.clone())
                .await?
            {
                FilenamePin::Pinned { note, filename, .. } if note == *id => {
                    let name = notarium_syntax::unicode::PortableFilename::parse(&filename)?;
                    target = previous.as_ref().map_or_else(
                        || preferred.with_file_name(name.as_str()),
                        |old| PathBuf::from(&old.path.relative),
                    );
                    if target != preferred && self.deferred.insert(id.clone()) {
                        self.journal.defer(id)?;
                    }
                }
                FilenamePin::Unpinned => {
                    if self.deferred.remove(id) {
                        self.journal.clear_deferred(id)?;
                    }
                }
                _ => return Ok(()),
            }
        }
        if self.blocks_publication(&target, id) {
            return Ok(());
        }
        let bytes = carrier::materialize(&current.carrier, current.class, id)?;
        let mut expected = None;
        let mut retire = None;
        if let Some(old) = &previous {
            let old_path = PathBuf::from(&old.path.relative);
            let observed = match self.read_disk(&old_path) {
                Ok(observed) => observed,
                Err(error) if path_error(&error) => {
                    return self.conflict(&old_path, ConflictReason::UnsafePath, None);
                }
                Err(error) => return Err(error.into()),
            };
            if let Some(observed) = observed {
                if !same_file(&old.file, &observed.stamp) {
                    let canonical_bytes =
                        carrier::materialize(&current.carrier, current.class, id)?;
                    if observed.bytes == canonical_bytes.as_bytes() {
                        // Equal bytes can come from editor safe-save and a
                        // changed inode. Accept the new publication stamp.
                    } else {
                        let source = super::disk::markdown(&observed)?;
                        return self
                            .diverged(&old_path, old, &observed.stamp, source, &current)
                            .await;
                    }
                }
                if old_path == target {
                    let actual = observation(&current, &target, &observed.stamp)?;
                    if observed.bytes == bytes.as_bytes() {
                        return self.confirm_observation(Some(old.clone()), actual).await;
                    }
                    expected = Some(observed.stamp);
                } else {
                    retire = Some((old_path, observed.stamp));
                }
            } else if old_path == target {
                // A known path went missing between feed and watcher. Leave
                // its absence to move/delete classification.
                return Ok(());
            }
        }
        self.place_note(target, &current, bytes, previous, expected, retire)
            .await
    }

    fn blocks_publication(&self, target: &Path, note: &NoteId) -> bool {
        self.conflicts
            .get(target.to_string_lossy().as_ref())
            .is_some_and(|issue| {
                matches!(
                    issue.reason,
                    ConflictReason::ClaimedPurgedIdentity
                        | ConflictReason::ChangedWhilePublishing
                        | ConflictReason::UnresolvedPublication
                )
            })
            || self.pending.iter().any(|intent| {
                intent.target == target
                    && match &intent.action {
                        Action::Publish(action) => action.desired.note != *note,
                        Action::Withdraw { .. } => true,
                    }
            })
    }

    async fn place_note(
        &mut self,
        target: PathBuf,
        current: &VaultNote,
        bytes: String,
        previous: Option<VaultObservation>,
        expected: Option<FileStamp>,
        retire: Option<(PathBuf, FileStamp)>,
    ) -> Result<(), VaultError> {
        let desired = desired(current, bytes.as_bytes());
        let Some((intent, placement)) = self.place(
            target.clone(),
            expected,
            desired,
            PublishPurpose::Note,
            retire,
            bytes.as_bytes(),
        )?
        else {
            return Ok(());
        };
        let Placement::Applied { stamp, captured } = placement else {
            return Ok(());
        };
        let actual = observation(current, &target, &stamp)?;
        match self.confirm_observation(previous, actual).await {
            Ok(()) => self.finish_publication(intent, captured).map(|_| ()),
            Err(VaultError::Canonical(PortError::Domain(_))) => {
                self.conflict(&target, ConflictReason::UnresolvedPublication, None)
            }
            Err(error) => Err(error),
        }
    }

    fn place(
        &mut self,
        target: PathBuf,
        expected: Option<FileStamp>,
        desired: DesiredFile,
        purpose: PublishPurpose,
        retire: Option<(PathBuf, FileStamp)>,
        bytes: &[u8],
    ) -> Result<Option<(Intent, Placement)>, VaultError> {
        let mut previous = self
            .pending
            .iter()
            .find(|intent| intent.target == target)
            .cloned();
        if let Some(intent) = &mut previous
            && !matches!(&intent.action, Action::Publish(prior)
                if prior.desired.same_revision_bytes(&desired)
                    && prior.purpose == purpose && !prior.abandoned)
        {
            let superseded = matches!(&intent.action, Action::Publish(prior)
                if prior.desired.note == desired.note && prior.purpose == purpose
                    && (prior.abandoned || prior.desired.revision != desired.revision));
            if !superseded || !self.abandon_preparation(intent)? {
                self.conflict(&target, ConflictReason::UnresolvedPublication, None)?;
                return Ok(None);
            }
            previous = None;
        }
        let mut intent = match previous {
            Some(intent) => intent,
            None => {
                let intent = publication::plan(
                    &self.journal,
                    target.clone(),
                    expected,
                    desired,
                    purpose,
                    retire,
                )?;
                self.pending.push(intent.clone());
                intent
            }
        };
        let result = publication::place(self.vault, &self.journal, &mut intent, bytes);
        if let Some(saved) = self.pending.iter_mut().find(|saved| saved.id == intent.id) {
            *saved = intent.clone();
        }
        match result {
            Ok(Placement::Conflict(preserved)) => {
                let reason = if preserved.is_some() {
                    ConflictReason::ChangedWhilePublishing
                } else {
                    ConflictReason::NameCollision
                };
                self.conflict(&target, reason, preserved)?;
                Ok(None)
            }
            Ok(placement) => Ok(Some((intent, placement))),
            Err(error) if path_error(&error) => {
                self.conflict(&target, ConflictReason::UnsafePath, None)?;
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn abandon_preparation(&mut self, intent: &mut Intent) -> Result<bool, VaultError> {
        let Action::Publish(action) = &intent.action else {
            return Ok(false);
        };
        if !action.abandoned {
            match publication::is_unapplied(self.vault, intent) {
                Ok(true) => {}
                Ok(false) => return Ok(false),
                Err(error) if path_error(&error) => return Ok(false),
                Err(error) => return Err(error.into()),
            }
            if let Action::Publish(action) = &mut intent.action {
                action.abandoned = true;
            }
            // Persist the decision before moving the staged object. Replay
            // can clean its exact witness even if it is already parked.
            self.journal.save(intent)?;
            if let Some(saved) = self.pending.iter_mut().find(|saved| saved.id == intent.id) {
                *saved = intent.clone();
            }
        }
        let Action::Publish(action) = &intent.action else {
            unreachable!("checked above")
        };
        let slot = publication::slot(intent)?;
        if let Some(expected) = &action.staged {
            self.clean_captured(
                intent.id,
                &intent.target,
                CapturedFile {
                    path: slot,
                    stamp: expected.clone(),
                },
                None,
            )?;
        } else if self.vault.entry_kind(&slot)?.is_some() {
            // There is no recorded stamp for this file. Preserve it out
            // of admission without preventing the new publication.
            self.conflict(
                &slot,
                ConflictReason::UnresolvedPublication,
                Some(slot.clone()),
            )?;
        }
        self.journal.finish(intent)?;
        self.pending.retain(|saved| saved.id != intent.id);
        self.clear_conflict(&intent.target)?;
        Ok(true)
    }

    fn finish_publication(
        &mut self,
        intent: Intent,
        captured: Option<CapturedFile>,
    ) -> Result<bool, VaultError> {
        if let Action::Publish(action) = &intent.action
            && let Some((path, stamp)) = &action.retire
        {
            // An intervening writer keeps its bytes and the durable conflict.
            self.withdraw(path, stamp)?;
        }
        let successor = match &intent.action {
            Action::Publish(action) if action.purpose == PublishPurpose::Conversion => {
                Some(action.desired.note.clone())
            }
            _ => None,
        };
        let complete = self.finish_capture(&intent, captured, successor)?;
        self.journal.finish(&intent)?;
        self.pending.retain(|saved| saved.id != intent.id);
        self.clear_conflict(&intent.target)?;
        Ok(complete)
    }

    fn withdraw(&mut self, path: &Path, expected: &FileStamp) -> Result<bool, VaultError> {
        let existing = self.pending.iter().find(|intent| {
            intent.target == path && matches!(intent.action, Action::Withdraw { .. })
        });
        let intent = match existing {
            Some(intent) => intent.clone(),
            None => {
                let intent = self.journal.intent(
                    path.to_owned(),
                    Action::Withdraw {
                        expected: expected.clone(),
                    },
                )?;
                self.pending.push(intent.clone());
                intent
            }
        };
        self.finish_withdrawal(&intent)
    }

    fn finish_withdrawal(&mut self, intent: &Intent) -> Result<bool, VaultError> {
        let result = match publication::remove(self.vault, intent) {
            Ok(result) => result,
            Err(error) if path_error(&error) => {
                self.conflict(&intent.target, ConflictReason::UnsafePath, None)?;
                return Ok(false);
            }
            Err(error) => return Err(error.into()),
        };
        let captured = match result {
            Removal::Withdrawn(captured) => captured,
            Removal::Conflict(preserved) => {
                self.conflict(
                    &intent.target,
                    ConflictReason::ChangedWhilePublishing,
                    preserved,
                )?;
                return Ok(false);
            }
        };
        self.finish_capture(intent, captured, None)?;
        self.journal.finish(intent)?;
        self.pending.retain(|saved| saved.id != intent.id);
        self.clear_conflict(&intent.target)?;
        Ok(true)
    }

    fn finish_capture(
        &mut self,
        intent: &Intent,
        captured: Option<CapturedFile>,
        successor: Option<NoteId>,
    ) -> Result<bool, VaultError> {
        if let Some(captured) = captured {
            self.clean_captured(intent.id, &intent.target, captured, successor)
        } else {
            Ok(true)
        }
    }

    pub(super) fn clean_captured(
        &mut self,
        operation: ContentDigest,
        target: &Path,
        captured: CapturedFile,
        successor: Option<NoteId>,
    ) -> Result<bool, VaultError> {
        match self.vault.clean_capture(&captured.path, &captured.stamp)? {
            CaptureCleanup::Removed => {
                self.journal.clear_capture(operation)?;
                self.captures.remove(&operation);
                Ok(true)
            }
            CaptureCleanup::Retained { path } => {
                let record = ArchivedCapture {
                    operation,
                    target: target.to_owned(),
                    slot: captured.path,
                    expected: captured.stamp,
                    retained_at: path,
                    successor,
                };
                self.journal.archive_capture(&record)?;
                self.captures.insert(operation, record);
                // A retained, independently recorded capture must not
                // block later revisions at the original publication path.
                Ok(false)
            }
        }
    }

    pub(super) fn recover_captures(
        &mut self,
        successor: Option<&NoteId>,
    ) -> Result<(), VaultError> {
        let captures = self
            .captures
            .values()
            .filter(|capture| successor.is_none_or(|note| capture.successor.as_ref() == Some(note)))
            .cloned()
            .collect::<Vec<_>>();
        for capture in captures {
            self.check_stop()?;
            self.clean_captured(
                capture.operation,
                &capture.target,
                CapturedFile {
                    path: capture.slot,
                    stamp: capture.expected,
                },
                capture.successor,
            )?;
        }
        Ok(())
    }

    async fn retire_observation(&mut self, old: VaultObservation) -> Result<(), VaultError> {
        let relative = PathBuf::from(&old.path.relative);
        let can_forget = match self.read_disk(&relative) {
            Ok(Some(file)) if same_file(&old.file, &file.stamp) => {
                self.withdraw(&relative, &file.stamp)?
            }
            Ok(Some(_)) => {
                self.conflict(&relative, ConflictReason::ChangedWhilePublishing, None)?;
                true
            }
            Ok(None) => true,
            Err(error) if path_error(&error) => {
                self.conflict(&relative, ConflictReason::UnsafePath, None)?;
                false
            }
            Err(error) => return Err(error.into()),
        };
        if can_forget {
            self.store
                .remove_vault_observation(self.config.context.clone(), &self.binding, old.clone())
                .await?;
            self.known.remove(&old.path.key);
        }
        Ok(())
    }

    pub(super) async fn diverged(
        &mut self,
        relative: &Path,
        old: &VaultObservation,
        stamp: &FileStamp,
        source: &str,
        current: &VaultNote,
    ) -> Result<(), VaultError> {
        if current.class != DocClass::EncryptedNote
            || !carrier::inspect(source)
                .is_ok_and(|observed| observed.class == DocClass::EncryptedNote)
        {
            return self.conflict(relative, ConflictReason::CanonicalDiverged, None);
        }
        let slug = relative
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("note");
        let filename = carrier::conflict_filename(slug, &current.note.revision)?;
        let conflict = relative.with_file_name(filename.as_str());
        let copy = desired(current, source.as_bytes());
        let copy_exists = self.journal.has_conflict_copy(&conflict, &copy)?
            && self
                .read_disk(&conflict)?
                .is_some_and(|observed| observed.stamp.digest == copy.disk_digest);
        if !copy_exists {
            let Some((intent, Placement::Applied { captured, .. })) = self.place(
                conflict.clone(),
                None,
                copy.clone(),
                PublishPurpose::ConflictCopy,
                None,
                source.as_bytes(),
            )?
            else {
                return self.conflict(relative, ConflictReason::NameCollision, Some(conflict));
            };
            self.journal.record_conflict_copy(&conflict, &copy)?;
            self.finish_publication(intent, captured)?;
        }
        let bytes = carrier::materialize(&current.carrier, current.class, &current.note.note)?;
        self.place_note(
            relative.to_owned(),
            current,
            bytes,
            Some(old.clone()),
            Some(stamp.clone()),
            None,
        )
        .await?;
        self.conflict(relative, ConflictReason::CiphertextConflict, Some(conflict))
    }

    pub(super) async fn apply_handoffs(
        &mut self,
        handoffs: &[VaultHandoff],
    ) -> Result<(), VaultError> {
        self.conversion_paths.clear();
        for handoff in handoffs {
            self.check_stop()?;
            self.known.remove(&handoff.observation.path.key);
            let path = PathBuf::from(&handoff.observation.path.relative);
            if let Some(new_note) = &handoff.new_note {
                if self
                    .apply_conversion(handoff, &path, &new_note.note)
                    .await?
                    == ConversionPublication::Pending
                {
                    self.conversion_paths.insert(new_note.note.clone());
                }
            } else {
                self.withdraw_handoff(&path, handoff)?;
            }
        }
        Ok(())
    }

    pub(super) async fn filter_handoffs(
        &mut self,
        path: &Path,
        stamp: &FileStamp,
        carrier: &NoteCarrier,
        handoffs: &[VaultHandoff],
    ) -> Result<bool, VaultError> {
        let locator = vault_path(path)?;
        let current = handoffs.iter().find(|handoff| {
            handoff.observation.path.key == locator.key
                || carrier.asserted_id.as_ref() == Some(&handoff.old_note)
                || (carrier.asserted_id.is_none()
                    && (handoff.observation.file.identity == file_identity(&stamp.identity)
                        || handoff.observation.file.digest == stamp.digest))
        });
        if let Some(handoff) = current {
            if handoff.new_note.is_none()
                && carrier
                    .asserted_id
                    .as_ref()
                    .is_none_or(|id| *id == handoff.old_note)
                && same_file(&handoff.observation.file, stamp)
            {
                self.withdraw(path, stamp)?;
            } else {
                self.conflict(path, ConflictReason::ClaimedPurgedIdentity, None)?;
            }
            return Ok(true);
        }
        if self
            .store
            .vault_candidate_is_quarantined(
                &self.config.context,
                &self.binding,
                &locator,
                &file_stamp(stamp),
                carrier.asserted_id.as_ref(),
            )
            .await?
        {
            self.conflict(path, ConflictReason::ClaimedPurgedIdentity, None)?;
            return Ok(true);
        }
        Ok(false)
    }

    fn withdraw_handoff(&mut self, path: &Path, handoff: &VaultHandoff) -> Result<(), VaultError> {
        match self.read_disk(path) {
            Ok(Some(file)) if same_file(&handoff.observation.file, &file.stamp) => {
                self.withdraw(path, &file.stamp)?;
            }
            Ok(Some(_)) => self.conflict(path, ConflictReason::ClaimedPurgedIdentity, None)?,
            Ok(None) => {}
            Err(error) if path_error(&error) => {
                self.conflict(path, ConflictReason::UnsafePath, None)?
            }
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    pub(super) async fn apply_conversion(
        &mut self,
        handoff: &VaultHandoff,
        target: &Path,
        successor: &NoteId,
    ) -> Result<ConversionPublication, VaultError> {
        let Some(current) = self
            .store
            .read_vault_note(&self.config.context, successor)
            .await?
        else {
            self.conflict(target, ConflictReason::UnresolvedPublication, None)?;
            return Ok(ConversionPublication::Pending);
        };
        if current.class != DocClass::EncryptedNote {
            self.conflict(target, ConflictReason::InvalidCarrier, None)?;
            return Ok(ConversionPublication::Pending);
        }
        let prepared = self.pending.iter().find_map(|intent| {
            if intent.target == target
                && let Action::Publish(action) = &intent.action
                && action.purpose == PublishPurpose::Conversion
                && &action.desired.note == successor
            {
                Some((intent.clone(), action.expected.clone(), action.abandoned))
            } else {
                None
            }
        });
        let expected = if let Some((intent, expected, abandoned)) = prepared {
            if !abandoned {
                match publication::recover_published(self.vault, &intent) {
                    Ok(Some(Placement::Applied { stamp, captured })) => {
                        return self
                            .finish_conversion_handoff(handoff, intent, stamp, captured)
                            .await;
                    }
                    Ok(Some(Placement::Conflict(path))) => {
                        self.conflict(target, ConflictReason::ChangedWhilePublishing, path)?;
                        return Ok(ConversionPublication::Pending);
                    }
                    Ok(None) => {}
                    Err(error) if path_error(&error) => {
                        self.conflict(target, ConflictReason::UnsafePath, None)?;
                        return Ok(ConversionPublication::Pending);
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            expected
        } else {
            match self.read_disk(target) {
                Ok(Some(file)) if same_file(&handoff.observation.file, &file.stamp) => {
                    Some(file.stamp)
                }
                Ok(Some(_)) => {
                    self.conflict(target, ConflictReason::ChangedWhilePublishing, None)?;
                    return Ok(ConversionPublication::Pending);
                }
                Ok(None) => {
                    self.conflict(target, ConflictReason::UnresolvedPublication, None)?;
                    return Ok(ConversionPublication::Pending);
                }
                Err(error) if path_error(&error) => {
                    self.conflict(target, ConflictReason::UnsafePath, None)?;
                    return Ok(ConversionPublication::Pending);
                }
                Err(error) => return Err(error.into()),
            }
        };
        let bytes = carrier::materialize(&current.carrier, current.class, successor)?;
        let mut desired = desired(&current, bytes.as_bytes());
        desired.conversion_path = note_path(&current.folders, &current.slug).ok();
        let Some((intent, Placement::Applied { stamp, captured })) = self.place(
            target.to_owned(),
            expected,
            desired,
            PublishPurpose::Conversion,
            None,
            bytes.as_bytes(),
        )?
        else {
            return Ok(ConversionPublication::Pending);
        };
        self.finish_conversion_handoff(handoff, intent, stamp, captured)
            .await
    }

    async fn finish_conversion_handoff(
        &mut self,
        handoff: &VaultHandoff,
        intent: Intent,
        stamp: FileStamp,
        captured: Option<CapturedFile>,
    ) -> Result<ConversionPublication, VaultError> {
        let Action::Publish(action) = &intent.action else {
            unreachable!("conversion uses a publication intent");
        };
        let desired = &action.desired;
        let observation = VaultObservation {
            note: desired.note.clone(),
            revision: desired.revision.clone(),
            path: vault_path(&intent.target)?,
            file: file_stamp(&stamp),
            carrier_digest: desired.carrier_digest,
        };
        // Mint-and-Purge hands the checked path to the new ID. Remember
        // the canonical placement it had at conversion so equivalent
        // changes or a seed cannot immediately move the replacement.
        if let Some(canonical) = &desired.conversion_path
            && *canonical != intent.target
        {
            self.journal.remember_conversion(
                &desired.note,
                &ConversionName {
                    published: intent.target.clone(),
                    canonical: canonical.clone(),
                },
            )?;
        }
        self.store
            .complete_vault_handoff(
                self.config.context.clone(),
                &self.binding,
                handoff.clone(),
                Some(observation.clone()),
            )
            .await?;
        self.known.insert(observation.path.key.clone(), observation);
        Ok(if self.finish_publication(intent, captured)? {
            ConversionPublication::Complete
        } else {
            ConversionPublication::CleanupPending
        })
    }

    pub(super) async fn recover_publications(
        &mut self,
        handoffs: &[VaultHandoff],
    ) -> Result<(), VaultError> {
        for mut intent in self.pending.clone() {
            self.check_stop()?;
            let Action::Publish(action) = &intent.action else {
                self.finish_withdrawal(&intent)?;
                continue;
            };
            let desired = &action.desired;
            if action.abandoned {
                self.abandon_preparation(&mut intent)?;
                continue;
            }
            if action.purpose == PublishPurpose::Conversion
                && handoffs.iter().any(|handoff| {
                    handoff
                        .new_note
                        .as_ref()
                        .is_some_and(|new_note| new_note.note == desired.note)
                })
            {
                continue;
            }
            match publication::recover_published(self.vault, &intent) {
                Ok(Some(Placement::Applied { stamp, captured })) => {
                    if action.purpose == PublishPurpose::ConflictCopy {
                        self.journal.record_conflict_copy(&intent.target, desired)?;
                    } else {
                        let expected = self
                            .store
                            .vault_observation_for(
                                &self.config.context,
                                &self.binding,
                                &desired.note,
                            )
                            .await?;
                        if self
                            .store
                            .vault_is_purge_fenced(
                                &self.config.context,
                                &self.binding,
                                &desired.note,
                            )
                            .await?
                        {
                            self.withdraw(&intent.target, &stamp)?;
                        } else {
                            let actual = VaultObservation {
                                note: desired.note.clone(),
                                revision: desired.revision.clone(),
                                path: vault_path(&intent.target)?,
                                file: file_stamp(&stamp),
                                carrier_digest: desired.carrier_digest,
                            };
                            if let Err(error) = self.confirm_observation(expected, actual).await {
                                if let VaultError::Canonical(PortError::Domain(_)) = error {
                                    self.conflict(
                                        &intent.target,
                                        ConflictReason::UnresolvedPublication,
                                        None,
                                    )?;
                                    continue;
                                }
                                return Err(error);
                            }
                        }
                    }
                    self.finish_publication(intent, captured)?;
                }
                Ok(None) if action.purpose != PublishPurpose::ConflictCopy => {
                    let latest = self
                        .store
                        .read_vault_note(&self.config.context, &desired.note)
                        .await?;
                    if latest.is_none_or(|note| note.note.revision != desired.revision) {
                        self.abandon_preparation(&mut intent)?;
                    }
                }
                Ok(None) => {}
                Ok(Some(Placement::Conflict(path))) => {
                    self.conflict(&intent.target, ConflictReason::ChangedWhilePublishing, path)?;
                }
                Err(error) if path_error(&error) => {
                    self.conflict(&intent.target, ConflictReason::UnsafePath, None)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

fn desired(current: &VaultNote, bytes: &[u8]) -> DesiredFile {
    DesiredFile {
        note: current.note.note.clone(),
        revision: current.note.revision.clone(),
        carrier_digest: current.carrier_digest,
        disk_digest: digest(bytes),
        conversion_path: None,
    }
}

fn observation(
    current: &VaultNote,
    target: &Path,
    stamp: &FileStamp,
) -> Result<VaultObservation, VaultError> {
    Ok(VaultObservation {
        note: current.note.note.clone(),
        revision: current.note.revision.clone(),
        path: vault_path(target)?,
        file: file_stamp(stamp),
        carrier_digest: current.carrier_digest,
    })
}
