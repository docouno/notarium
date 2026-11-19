use std::collections::BTreeSet;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{FolderId, SpaceSeq},
    model::Lifecycle,
    ports::{ChangeKind, ChangeRead, ChangeReadResult, EntityId, PageLimit},
    receipt::ChangeCursor,
};

use super::{PAGE, VaultError, Worker};

impl Worker<'_> {
    pub(super) async fn read_changes(&mut self) -> Result<bool, VaultError> {
        let through = self.store.vault_head(&self.config.context).await?;
        let mut after = ChangeCursor {
            scope: self.binding.scope.clone(),
            after: self.binding.cursor,
        };
        if after.after == through {
            return Ok(true);
        }
        loop {
            self.check_stop()?;
            let result = self
                .store
                .read_changes(
                    self.config.context.clone(),
                    ChangeRead::Log {
                        after,
                        through,
                        limit: PageLimit::new(200)?,
                    },
                )
                .await;
            let page = match result {
                Ok(ChangeReadResult::Log(page)) => page,
                Ok(ChangeReadResult::Seed(_)) => return Err(invalid_cutoff()),
                Err(error) if needs_seed(&error) => return Ok(false),
                Err(error) => return Err(error.into()),
            };
            let mut notes = BTreeSet::new();
            let mut folders = BTreeSet::new();
            let mut abilities = BTreeSet::new();
            let mut recheck_abilities = false;
            let mut schema = false;
            for change in page.changes {
                match change.entity {
                    EntityId::Note(note) => {
                        schema = true;
                        recheck_abilities |=
                            change.class.is_none_or(|class| class == DocClass::Skill);
                        if change.class.is_none_or(allowed_class) {
                            notes.insert(note);
                        }
                    }
                    EntityId::Folder(folder)
                        if matches!(
                            change.kind,
                            ChangeKind::Move
                                | ChangeKind::Rename
                                | ChangeKind::Restore
                                | ChangeKind::Trash
                        ) =>
                    {
                        folders.insert(folder);
                        recheck_abilities = true;
                    }
                    EntityId::Ability(ability) => {
                        abilities.insert(ability);
                    }
                    _ => {}
                }
            }
            for folder in folders {
                self.materialize_folder(&folder).await?;
            }
            for note in notes {
                self.check_stop()?;
                self.materialize(&note).await?;
            }
            if schema {
                self.reserved
                    .sync_schema(self.vault, &self.store, &self.config.context)
                    .await?;
            }
            for ability in &self.config.owned_abilities {
                if recheck_abilities || abilities.contains(&ability.id) {
                    self.reserved
                        .sync_ability(self.vault, &self.store, &self.config.context, ability)
                        .await?;
                }
            }
            self.advance(page.safe_ack_end).await?;
            if page.complete {
                return Ok(true);
            }
            after = page.next;
        }
    }

    pub(super) async fn seed(&mut self) -> Result<bool, VaultError> {
        let mut request = ChangeRead::Seed {
            scope: self.binding.scope.clone(),
            cutoff: None,
            limit: PageLimit::new(PAGE)?,
        };
        let cutoff = loop {
            self.check_stop()?;
            let seed = match self
                .store
                .read_changes(self.config.context.clone(), request)
                .await
            {
                Ok(ChangeReadResult::Seed(seed)) => seed,
                Ok(ChangeReadResult::Log(_)) => return Err(invalid_cutoff()),
                Err(error) if needs_seed(&error) => return Ok(false),
                Err(error) => return Err(error.into()),
            };
            for note in seed.notes {
                if note.document.lifecycle() == Lifecycle::Active
                    && allowed_class(note.document.class())
                {
                    self.check_stop()?;
                    self.materialize(&note.document.reference().note_id).await?;
                }
            }
            match seed.next {
                Some(cursor) => request = ChangeRead::ContinueSeed { cursor },
                None => break seed.cutoff.after,
            }
        };

        // A retained binding may refer to a note erased before compaction.
        // Discover those outputs even when the seed no longer lists the note.
        let mut after = None;
        loop {
            self.check_stop()?;
            let page = self
                .store
                .vault_observations(
                    &self.config.context,
                    &self.binding,
                    None,
                    after.as_deref(),
                    PAGE,
                )
                .await?;
            if page.is_empty() {
                break;
            }
            after = page.last().map(|entry| entry.path.key.clone());
            for observation in page {
                if self
                    .store
                    .read_vault_note(&self.config.context, &observation.note)
                    .await?
                    .is_none()
                {
                    self.materialize(&observation.note).await?;
                }
            }
        }
        self.reserved
            .retain_abilities(self.vault, &self.config.owned_abilities)?;
        self.reserved
            .sync_schema(self.vault, &self.store, &self.config.context)
            .await?;
        for ability in &self.config.owned_abilities {
            self.reserved
                .sync_ability(self.vault, &self.store, &self.config.context, ability)
                .await?;
        }
        self.advance(cutoff).await?;
        self.read_changes().await
    }

    async fn materialize_folder(&mut self, folder: &FolderId) -> Result<(), VaultError> {
        let mut after = None;
        loop {
            let notes = self
                .store
                .vault_note_ids_below_folder(&self.config.context, folder, after.as_ref(), PAGE)
                .await?;
            if notes.is_empty() {
                return Ok(());
            }
            after = notes.last().cloned();
            for note in notes {
                self.check_stop()?;
                self.materialize(&note).await?;
            }
        }
    }

    async fn advance(&mut self, next: SpaceSeq) -> Result<(), VaultError> {
        if next > self.binding.cursor {
            self.store
                .advance_vault_cursor(
                    self.config.context.clone(),
                    &self.binding,
                    self.binding.cursor,
                    next,
                )
                .await?;
            self.binding.cursor = next;
        }
        Ok(())
    }

    pub(super) async fn resume_deferred(&mut self) -> Result<(), VaultError> {
        for note in self.deferred.clone() {
            self.check_stop()?;
            self.materialize(&note).await?;
        }
        Ok(())
    }
}

fn allowed_class(class: DocClass) -> bool {
    matches!(class, DocClass::UserDoc | DocClass::EncryptedNote)
}

fn invalid_cutoff() -> VaultError {
    DomainError::validation(ValidationReason::InvalidCutoff).into()
}

fn needs_seed(error: &PortError) -> bool {
    matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
        if matches!(diagnostic.reason, ValidationReason::PurgeResync | ValidationReason::CursorStale))
}
