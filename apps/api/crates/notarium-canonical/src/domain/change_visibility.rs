//! Authority for log metadata and bounded overlay versions at one command boundary.
use super::common::FolderAncestryCache;
use crate::{
    SpaceRecord,
    codec::{RevisionMetadataEnvelope, RevisionMetadataPayload},
    runtime::read_immutable_revision_tx,
    sql_exec::BackendConn,
};
use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{JobId, NoteId, RevisionId, SpaceSeq},
    ports::{Change, ChangeKind, ContentJobKind, EntityId},
    receipt::{AwaitReason, MutationEffect},
};
use std::{collections::HashMap, sync::Arc};

pub(crate) struct ChangeVisibility<'a> {
    space: &'a SpaceRecord,
    auth: &'a EngineAuthContext,
    live: FolderAncestryCache,
    historical: FolderAncestryCache,
    cut: SpaceSeq,
    all_notes_visible: bool,
    live_notes: HashMap<NoteId, bool>,
    jobs: HashMap<JobId, Option<Arc<[NoteId]>>>,
    visible_versions: HashMap<NoteId, Option<RevisionId>>,
}

impl<'a> ChangeVisibility<'a> {
    pub(crate) fn new(space: &'a SpaceRecord, auth: &'a EngineAuthContext) -> Self {
        let all_notes_visible = auth.spaces().get(&space.space.id).is_some_and(|grant| {
            grant.project_root.is_none() && grant.read_classes == DocClass::all()
        });
        Self {
            space,
            auth,
            all_notes_visible,
            live: Default::default(),
            historical: Default::default(),
            cut: SpaceSeq::ZERO,
            live_notes: HashMap::new(),
            jobs: HashMap::new(),
            visible_versions: HashMap::new(),
        }
    }

    async fn note_version(
        &mut self,
        tx: &mut BackendConn<'_>,
        note: &NoteId,
    ) -> Result<Option<RevisionId>, PortError> {
        if let Some(known) = self.visible_versions.get(note) {
            return Ok(known.clone());
        }
        let result = async {
            let current = match self.live_notes.get(note) {
                Some(&allowed) => allowed,
                None => {
                    let allowed = self
                        .live
                        .live_note_facts(tx, &self.space.space, note, false)
                        .await?
                        .is_some_and(|(facts, _)| self.auth.can_view_resource(&facts).is_ok());
                    self.live_notes.insert(note.clone(), allowed);
                    allowed
                }
            };
            if !current {
                return Err(DomainError::ResourceNotFound.into());
            }
            let revision =
                read_immutable_revision_tx(tx, &self.space.scope, "note", note.as_str(), self.cut)
                    .await?
                    .ok_or(DomainError::ResourceNotFound)?;
            let RevisionMetadataPayload::Note(meta) = revision.metadata.payload else {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            };
            let (facts, _) = self
                .historical
                .build_resource_facts_tx(
                    tx,
                    &self.space.space,
                    &meta.parent_folder_id,
                    meta.doc_class,
                    meta.ability_id,
                    false,
                )
                .await?;
            self.auth.authorize_read(&facts)?;
            Ok(revision.revision_id)
        }
        .await;
        let visible = admitted(result)?;
        self.visible_versions.insert(note.clone(), visible.clone());
        Ok(visible)
    }

    async fn authorize_job(
        &mut self,
        tx: &mut BackendConn<'_>,
        job: &JobId,
    ) -> Result<(), PortError> {
        let notes = match self.jobs.get(job) {
            Some(cached) => cached.clone(),
            None => {
                let found = admitted(
                    crate::peers::read_visible_job_tx(tx, &self.space.space, self.auth, job).await,
                )?;
                let notes = found.map(|job| match job.kind {
                    ContentJobKind::Export { notes, .. } if !self.all_notes_visible => {
                        Arc::from(notes)
                    }
                    _ => Arc::from([]),
                });
                self.jobs.insert(job.clone(), notes.clone());
                notes
            }
        }
        .ok_or(DomainError::ResourceNotFound)?;
        for note in notes.iter() {
            self.note_version(tx, note)
                .await?
                .ok_or(DomainError::ResourceNotFound)?;
        }
        Ok(())
    }

    pub(crate) async fn filter(
        &mut self,
        tx: &mut BackendConn<'_>,
        change: &mut Change,
    ) -> Result<bool, PortError> {
        let cut = change.command_range.last_seq;
        if self.cut != cut {
            self.cut = cut;
            self.visible_versions.clear();
            self.historical = FolderAncestryCache::at_cut(&self.space.scope, cut);
        }
        let record = self.space;
        let space = &record.space;
        let allowed: Result<(), PortError> = async {
            match &change.entity {
                EntityId::Note(_) if self.all_notes_visible => {
                    self.auth
                        .authorize_folder_read(space, &record.root_folder_id, &[])?;
                }
                EntityId::Note(_) if change.kind == ChangeKind::Purge => {
                    let grant = self
                        .auth
                        .spaces()
                        .get(&space.id)
                        .ok_or(DomainError::ResourceNotFound)?;
                    if grant.project_root.is_some()
                        || !change
                            .class
                            .is_some_and(|class| grant.read_classes.contains(&class))
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    self.auth
                        .authorize_folder_read(space, &record.root_folder_id, &[])?;
                }
                EntityId::Note(note) => {
                    let version = self
                        .note_version(tx, note)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    if change.kind == ChangeKind::Move && version != change.revision {
                        // Physical Board moves publish rank revisions owned by both the card and its View.
                        let raw = super::notes::load_revision_metadata_opt_tx(
                            tx,
                            &record.scope,
                            &change.revision,
                        )
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                        let RevisionMetadataPayload::Rank(rank) =
                            RevisionMetadataEnvelope::decode(&raw)?.payload
                        else {
                            return Err(DomainError::ResourceNotFound.into());
                        };
                        if rank.target_note_id != *note {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        self.note_version(tx, &rank.view_note_id)
                            .await?
                            .ok_or(DomainError::ResourceNotFound)?;
                    }
                }
                EntityId::Folder(folder)
                    if self
                        .auth
                        .spaces()
                        .get(&space.id)
                        .is_some_and(|g| g.project_root.is_none()) =>
                {
                    self.auth.authorize_folder_read(space, folder, &[])?;
                }
                EntityId::Folder(folder) => {
                    let live = self
                        .live
                        .load_ancestry_tx(tx, &space.id, folder, false)
                        .await?;
                    self.auth.can_view_folder(space, folder, &live.ancestors)?;
                    let old = self
                        .historical
                        .load_ancestry_tx(tx, &space.id, folder, false)
                        .await?;
                    self.auth
                        .authorize_folder_read(space, folder, &old.ancestors)?;
                }
                EntityId::Ability(id) => {
                    crate::catalog::authorize_ability_change_tx(
                        tx,
                        self.auth,
                        record,
                        id,
                        &change.revision,
                    )
                    .await?;
                }
                EntityId::Thread(id) => {
                    crate::chats::authorize_live_thread_read_tx(tx, space, self.auth, id).await?;
                    let old = read_immutable_revision_tx(
                        tx,
                        &self.space.scope,
                        "thread",
                        id.as_str(),
                        cut,
                    )
                    .await?
                    .ok_or(DomainError::ResourceNotFound)?;
                    let RevisionMetadataPayload::Thread(meta) = old.metadata.payload else {
                        return Err(DomainError::validation(ValidationReason::InvalidState).into());
                    };
                    crate::chats::authorize_thread_read(
                        self.auth,
                        space,
                        id,
                        meta.kind,
                        &meta.owner_id,
                        meta.project_folder_id.as_ref(),
                        meta.tainted,
                    )?;
                }
                EntityId::Job(id) => {
                    self.authorize_job(tx, id).await?;
                }
            }
            Ok(())
        }
        .await;
        if admitted(allowed)?.is_none() {
            return Ok(false);
        }
        // An overlay describes the complete command. A scoped subscriber cannot
        // apply just the visible rows. Fall back to its projection watermark.
        if !self.all_notes_visible
            && let MutationEffect::Notes { versions, .. } = &change.effect
        {
            let single = match (&change.entity, versions.as_slice()) {
                (EntityId::Note(id), [row])
                    if id == &row.note_id
                        && row.rank_version
                            == super::common::note_rank_version_digest(&row.revision, None) =>
                {
                    self.note_version(tx, id).await?.as_ref() == Some(&row.revision)
                }
                _ => false,
            };
            if !single {
                change.effect = MutationEffect::AwaitProjection {
                    reason: AwaitReason::UnavailableVersion,
                };
            }
        }
        Ok(true)
    }
}

fn admitted<T>(result: Result<T, PortError>) -> Result<Option<T>, PortError> {
    match result {
        Ok(item) => Ok(Some(item)),
        Err(PortError::Domain(
            DomainError::ResourceNotFound
            | DomainError::AccessDenied
            | DomainError::CrossSpaceTainted,
        )) => Ok(None),
        Err(error) => Err(error),
    }
}
