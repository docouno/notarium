//! Local conversion admission carries the exact command across a restart.
//! The sibling holds ciphertext only. The canonical writer owns the handoff
//! once the command commits.

use std::path::{Path, PathBuf};

use notarium_canonical::vault::VaultHandoff;
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::PortError,
    ids::{CommandKey, ContentDigest, LeaseEpoch, LineageEpoch, NoteId, PrincipalId, RevisionId},
    model::HistoryScope,
    ports::{Committed, MintAndPurge, MintAndPurgeResult, Mutation, NoteWritePort, Preconditions},
    receipt::CommandIdentity,
};
use serde::{Deserialize, Serialize};

use super::{Conversion, VaultError, Worker, disk::markdown};
use crate::{
    carrier,
    filesystem::{CapturedFile, FileStamp, VaultDir},
    journal::{Action, ConflictReason, PublishPurpose, random_digest},
    paths::{digest, same_file},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PendingMint {
    pub key: CommandKey,
    scope: HistoryScope,
    actor: PrincipalId,
    hash: ContentDigest,
    operation: ContentDigest,
    old: NoteId,
    new: NoteId,
    base: RevisionId,
    requested_slug: Option<String>,
    revision: Option<RevisionId>,
    lease: Option<LeaseEpoch>,
    lineage: Option<LineageEpoch>,
    target: PathBuf,
    old_file: FileStamp,
    cipher_digest: ContentDigest,
    staged: Option<FileStamp>,
}

impl PendingMint {
    fn slot(&self) -> Result<PathBuf, VaultError> {
        Ok(VaultDir::operation_slot(
            &self.target,
            &self.operation.to_hex(),
        )?)
    }

    fn request(&self, encrypted_carrier: String) -> Mutation<MintAndPurge> {
        Mutation {
            identity: CommandIdentity {
                scope: self.scope.clone(),
                actor: self.actor.clone(),
                key: self.key.clone(),
                hash: self.hash,
            },
            preconditions: Preconditions {
                revision: self.revision.clone(),
                lease: self.lease,
                lineage: self.lineage,
            },
            input: MintAndPurge {
                old_note: self.old.clone(),
                expected_revision: self.base.clone(),
                new_note: self.new.clone(),
                new_slug: self.requested_slug.clone(),
                encrypted_carrier,
            },
        }
    }

    fn same_request(&self, request: &Mutation<MintAndPurge>) -> bool {
        let saved = self.request(request.input.encrypted_carrier.clone());
        saved.identity == request.identity
            && saved.preconditions == request.preconditions
            && saved.input.old_note == request.input.old_note
            && saved.input.new_note == request.input.new_note
            && saved.input.new_slug == request.input.new_slug
            && saved.input.expected_revision == request.input.expected_revision
            && self.cipher_digest == digest(request.input.encrypted_carrier.as_bytes())
    }
}

impl Worker<'_> {
    pub(super) async fn convert(
        &mut self,
        request: Mutation<MintAndPurge>,
    ) -> Result<Conversion, VaultError> {
        self.check_stop()?;
        self.binding.scope.check(&request.identity.scope)?;
        let previous = self
            .store
            .vault_observation_for(&self.config.context, &self.binding, &request.input.old_note)
            .await?;
        let mut prepared = if let Some(saved) = self.journal.mint(&request.identity.key)? {
            if !saved.same_request(&request) {
                return Err(DomainError::IdempotencyKeyReused.into());
            }
            saved
        } else if let Some(previous) = previous {
            let target = PathBuf::from(&previous.path.relative);
            let file = self
                .read_disk(&target)?
                .ok_or(VaultError::ConversionConflict)?;
            if previous.revision != request.input.expected_revision
                || !same_file(&previous.file, &file.stamp)
                || self.git_busy()
            {
                return Err(VaultError::ConversionConflict);
            }
            carrier::materialize(
                &request.input.encrypted_carrier,
                DocClass::EncryptedNote,
                &request.input.new_note,
            )?;
            self.vault
                .probe_conversion(&target, &random_digest()?.to_hex())?;
            PendingMint {
                key: request.identity.key.clone(),
                scope: request.identity.scope.clone(),
                actor: request.identity.actor.clone(),
                hash: request.identity.hash,
                operation: random_digest()?,
                old: request.input.old_note.clone(),
                new: request.input.new_note.clone(),
                base: request.input.expected_revision.clone(),
                requested_slug: request.input.new_slug.clone(),
                revision: request.preconditions.revision.clone(),
                lease: request.preconditions.lease,
                lineage: request.preconditions.lineage,
                target,
                old_file: file.stamp,
                cipher_digest: digest(request.input.encrypted_carrier.as_bytes()),
                staged: None,
            }
        } else {
            // The original preparation may already have been retired. Use
            // the writer's exact receipt replay once the old note is fenced.
            if !self
                .store
                .vault_is_purge_fenced(&self.config.context, &self.binding, &request.input.old_note)
                .await?
            {
                return Err(VaultError::ConversionConflict);
            }
            let committed = self
                .store
                .mint_and_purge(self.config.context.clone(), request)
                .await?;
            return Ok(Conversion {
                published: self.finish_committed_mint(&committed).await,
                committed,
            });
        };
        if prepared.staged.is_none() {
            self.journal.save_mint(&prepared)?;
            let slot = prepared.slot()?;
            prepared.staged = Some(self.vault.stage(
                &prepared.target,
                &slot,
                request.input.encrypted_carrier.as_bytes(),
            )?);
            self.journal.save_mint(&prepared)?;
        }
        let committed = self.commit_prepared(&prepared, request).await?;
        let published = self.finish_committed_mint(&committed).await;
        if let Err(error) = self.retire_preparation(&prepared) {
            tracing::warn!(%error, "could not retire encrypted conversion preparation");
        }
        Ok(Conversion {
            committed,
            published,
        })
    }

    async fn commit_prepared(
        &mut self,
        prepared: &PendingMint,
        request: Mutation<MintAndPurge>,
    ) -> Result<Committed<MintAndPurgeResult>, VaultError> {
        if !self
            .store
            .vault_is_purge_fenced(&self.config.context, &self.binding, &prepared.old)
            .await?
            && (self.git_busy()
                || self
                    .read_disk(&prepared.target)?
                    .is_none_or(|file| file.stamp != prepared.old_file))
        {
            self.conflict(
                &prepared.target,
                ConflictReason::ChangedWhilePublishing,
                None,
            )?;
            return Err(VaultError::ConversionConflict);
        }
        Ok(self
            .store
            .mint_and_purge(self.config.context.clone(), request)
            .await?)
    }

    async fn finish_committed_mint(&mut self, committed: &Committed<MintAndPurgeResult>) -> bool {
        let result = async {
            let successor = &committed.value.new_note.note;
            self.recover_captures(Some(successor))?;
            let handoffs = self
                .store
                .vault_handoffs(&self.config.context, &self.binding)
                .await?;
            if let Some(handoff) = handoffs
                .iter()
                .find(|item| item.old_note == committed.value.old_note)
            {
                let path = Path::new(&handoff.observation.path.relative);
                return self
                    .apply_conversion(handoff, path, successor)
                    .await;
            }
            let observation = self
                .store
                .vault_observation_for(
                    &self.config.context,
                    &self.binding,
                    &committed.value.new_note.note,
                )
                .await?;
            let capture_pending = self.captures.values().any(|capture| capture.successor.as_ref() == Some(successor));
            let publication_pending = self.pending.iter().any(|intent| matches!(
                &intent.action, Action::Publish(action)
                    if action.purpose == PublishPurpose::Conversion && &action.desired.note == successor
            ));
            Ok(observation.is_some() && !capture_pending && !publication_pending)
        }
        .await;
        match result {
            Ok(published) => published,
            Err(error) => {
                tracing::warn!(%error, "encrypted conversion publication remains pending");
                false
            }
        }
    }

    pub(super) async fn recover_preparations(
        &mut self,
        handoffs: &[VaultHandoff],
    ) -> Result<(), VaultError> {
        for prepared in self.journal.mints()? {
            self.check_stop()?;
            if &prepared.scope != self.config.context.scope()
                || &prepared.actor != self.config.context.auth().principal()
            {
                continue;
            }
            if handoffs.iter().any(|item| {
                item.old_note == prepared.old
                    && item
                        .new_note
                        .as_ref()
                        .is_some_and(|note| note.note == prepared.new)
            }) {
                self.retire_preparation(&prepared)?;
                continue;
            }
            let slot = prepared.slot()?;
            let found = self.read_disk(&slot)?;
            let Some(observed) = found else {
                self.journal.clear_mint(&prepared.key)?;
                continue;
            };
            if prepared.staged.as_ref() != Some(&observed.stamp)
                || observed.stamp.digest != prepared.cipher_digest
            {
                self.conflict(
                    &prepared.target,
                    ConflictReason::UnresolvedPublication,
                    Some(slot),
                )?;
                continue;
            }
            let carrier = markdown(&observed)?.to_owned();
            match self
                .commit_prepared(&prepared, prepared.request(carrier))
                .await
            {
                Ok(committed) => {
                    self.finish_committed_mint(&committed).await;
                    self.retire_preparation(&prepared)?;
                }
                Err(
                    VaultError::ConversionConflict | VaultError::Canonical(PortError::Domain(_)),
                ) => {
                    self.conflict(
                        &prepared.target,
                        ConflictReason::UnresolvedPublication,
                        Some(slot),
                    )?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn retire_preparation(&mut self, prepared: &PendingMint) -> Result<(), VaultError> {
        let slot = prepared.slot()?;
        if let Some(stamp) = &prepared.staged {
            self.clean_captured(
                prepared.operation,
                &prepared.target,
                CapturedFile {
                    path: slot,
                    stamp: stamp.clone(),
                },
                None,
            )?;
        } else if self.vault.entry_kind(&slot)?.is_some() {
            return self.conflict(
                &prepared.target,
                ConflictReason::CaptureUnverified,
                Some(slot),
            );
        }
        self.journal.clear_mint(&prepared.key)?;
        Ok(())
    }
}
