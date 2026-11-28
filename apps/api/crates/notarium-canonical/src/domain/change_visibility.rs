//! Authority for log metadata and bounded overlay versions at one command boundary.
use super::common::{FolderAncestryCache, NoteHeadRow, combine_lifecycle};
use crate::{
    CanonicalStore, SpaceRecord,
    codec::{RevisionMetadataEnvelope, RevisionMetadataPayload},
    runtime::{
        StoredRevisionRecord, load_space_record, read_immutable_revision_tx, require_command_end_tx,
    },
    sql_exec::BackendConn,
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, PrincipalKind},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{JobId, NoteId, RevisionId, SpaceSeq},
    model::Lifecycle,
    ports::{
        Change, ChangeKind, ContentJobKind, EntityId, MaintenanceContext, NoteProvenance,
        SpaceContext,
    },
    receipt::{AwaitReason, MutationEffect},
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

pub(crate) struct ChangePagePreload {
    pub(crate) folder_cuts: Vec<i64>,
    pub(crate) preloaded_notes: HashSet<NoteId>,
    pub(crate) fenced_notes: HashSet<NoteId>,
    pub(crate) note_heads: Option<BTreeMap<NoteId, NoteHeadRow>>,
}

pub(crate) struct ChangeVisibility<'a> {
    space: &'a SpaceRecord,
    auth: &'a EngineAuthContext,
    live: FolderAncestryCache,
    historical: FolderAncestryCache,
    cut: SpaceSeq,
    folder_cuts: Option<Vec<i64>>,
    historical_epoch: Option<usize>,
    preloaded_notes: Option<HashSet<NoteId>>,
    fenced_notes: Option<HashSet<NoteId>>,
    preloaded_heads: Option<BTreeMap<NoteId, NoteHeadRow>>,
    all_notes_visible: bool,
    live_notes: HashMap<NoteId, bool>,
    jobs: HashMap<JobId, Option<Arc<[NoteId]>>>,
    visible_versions: HashMap<NoteId, Option<RevisionId>>,
}

impl<'a> ChangeVisibility<'a> {
    pub(crate) fn new(space: &'a SpaceRecord, auth: &'a EngineAuthContext) -> Self {
        let all_notes_visible = !matches!(auth.kind(), PrincipalKind::Keeper(_))
            && auth.spaces().get(&space.space.id).is_some_and(|grant| {
                grant.project_root.is_none() && grant.read_classes == DocClass::all()
            });
        Self {
            space,
            auth,
            all_notes_visible,
            live: Default::default(),
            historical: Default::default(),
            cut: SpaceSeq::ZERO,
            folder_cuts: None,
            historical_epoch: None,
            preloaded_notes: None,
            fenced_notes: None,
            preloaded_heads: None,
            live_notes: HashMap::new(),
            jobs: HashMap::new(),
            visible_versions: HashMap::new(),
        }
    }

    pub(crate) fn with_preload(mut self, preload: ChangePagePreload) -> Self {
        self.folder_cuts = Some(preload.folder_cuts);
        self.preloaded_notes = Some(preload.preloaded_notes);
        self.fenced_notes = Some(preload.fenced_notes);
        self.preloaded_heads = preload.note_heads;
        self
    }

    pub(crate) fn all_notes_visible(&self) -> bool {
        self.all_notes_visible
    }

    fn is_preloaded_fenced(&self, note: &NoteId) -> Option<bool> {
        let notes = self.preloaded_notes.as_ref()?;
        if !notes.contains(note) {
            return None;
        }
        Some(
            self.fenced_notes
                .as_ref()
                .is_some_and(|set| set.contains(note)),
        )
    }

    async fn live_note_visible(
        &mut self,
        tx: &mut BackendConn<'_>,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        if let Some(&allowed) = self.live_notes.get(note) {
            return Ok(allowed);
        }
        let allowed = if self
            .preloaded_notes
            .as_ref()
            .is_some_and(|notes| notes.contains(note))
            && self.preloaded_heads.is_some()
        {
            if self
                .fenced_notes
                .as_ref()
                .is_some_and(|set| set.contains(note))
            {
                false
            } else if let Some(head) = self
                .preloaded_heads
                .as_ref()
                .and_then(|heads| heads.get(note))
                .cloned()
            {
                if head.lifecycle == Lifecycle::Purged {
                    false
                } else {
                    let (facts, anc) = self
                        .live
                        .build_resource_facts_tx(
                            tx,
                            &self.space.space,
                            &head.parent_folder_id,
                            head.doc_class,
                            head.ability_id,
                            false,
                        )
                        .await?;
                    let effective = combine_lifecycle(head.lifecycle, anc.folder_lifecycle);
                    effective != Lifecycle::Purged && self.auth.can_view_resource(&facts).is_ok()
                }
            } else {
                false
            }
        } else {
            self.live
                .live_note_facts(tx, &self.space.space, note, false)
                .await?
                .is_some_and(|(facts, _)| self.auth.can_view_resource(&facts).is_ok())
        };
        self.live_notes.insert(note.clone(), allowed);
        Ok(allowed)
    }

    async fn note_version_inner(
        &mut self,
        tx: &mut BackendConn<'_>,
        note: &NoteId,
        preloaded_rev: Option<&StoredRevisionRecord>,
        want_provenance: bool,
    ) -> Result<(Option<RevisionId>, Option<NoteProvenance>), PortError> {
        if !want_provenance && let Some(known) = self.visible_versions.get(note) {
            return Ok((known.clone(), None));
        }
        let result: Result<(RevisionId, Option<NoteProvenance>), PortError> = async {
            if !self.live_note_visible(tx, note).await? {
                return Err(DomainError::ResourceNotFound.into());
            }
            let owned_rev;
            let revision = if let Some(hit) = preloaded_rev
                && self.is_preloaded_fenced(note) == Some(false)
                && hit.visibility_seq == self.cut
                && hit.space_seq == self.cut
            {
                hit
            } else if self.is_preloaded_fenced(note) == Some(true) {
                return Err(DomainError::ResourceNotFound.into());
            } else {
                owned_rev = read_immutable_revision_tx(
                    tx,
                    &self.space.scope,
                    "note",
                    note.as_str(),
                    self.cut,
                )
                .await?
                .ok_or(DomainError::ResourceNotFound)?;
                &owned_rev
            };
            let RevisionMetadataPayload::Note(meta) = &revision.metadata.payload else {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            };
            let (facts, ancestry) = self
                .historical
                .build_resource_facts_tx(
                    tx,
                    &self.space.space,
                    &meta.parent_folder_id,
                    meta.doc_class,
                    meta.ability_id.clone(),
                    false,
                )
                .await?;
            self.auth.authorize_read(&facts)?;
            let provenance = want_provenance.then(|| {
                ancestry.note_provenance(
                    note,
                    &meta.slug,
                    meta.title.clone(),
                    revision.actor_id.clone(),
                    revision.created_at,
                )
            });
            Ok((revision.revision_id.clone(), provenance))
        }
        .await;
        match admitted(result)? {
            Some((rev_id, provenance)) => {
                self.visible_versions
                    .insert(note.clone(), Some(rev_id.clone()));
                Ok((Some(rev_id), provenance))
            }
            None => {
                self.visible_versions.insert(note.clone(), None);
                Ok((None, None))
            }
        }
    }

    async fn note_version(
        &mut self,
        tx: &mut BackendConn<'_>,
        note: &NoteId,
    ) -> Result<Option<RevisionId>, PortError> {
        Ok(self.note_version_inner(tx, note, None, false).await?.0)
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
        self.filter_page_change(tx, change, None, false).await
    }

    pub(crate) async fn filter_page_change(
        &mut self,
        tx: &mut BackendConn<'_>,
        change: &mut Change,
        preloaded_rev: Option<&StoredRevisionRecord>,
        with_provenance: bool,
    ) -> Result<bool, PortError> {
        let cut = change.command_range.last_seq;
        if self.cut != cut {
            let prev_cut = self.cut;
            self.cut = cut;
            self.visible_versions.clear();
            let keep_historical = self.folder_cuts.as_ref().is_some_and(|cuts| {
                let epoch = cuts.partition_point(|&v| v <= cut.get() as i64);
                let can_keep = cut >= prev_cut && self.historical_epoch == Some(epoch);
                if !can_keep {
                    self.historical_epoch = Some(epoch);
                }
                can_keep
            });
            if !keep_historical {
                self.historical = FolderAncestryCache::at_cut(&self.space.scope, cut);
            }
        }
        let record = self.space;
        let space = &record.space;
        let want_note_provenance = with_provenance
            && change.lifecycle != Lifecycle::Purged
            && change.class != Some(DocClass::EncryptedNote);
        let mut computed_provenance: Option<NoteProvenance> = None;
        let allowed: Result<(), PortError> = async {
            match &change.entity {
                EntityId::Note(note) if self.all_notes_visible => {
                    if change.lifecycle != Lifecycle::Purged {
                        let fenced = match self.is_preloaded_fenced(note) {
                            Some(fenced) => fenced,
                            None => {
                                crate::runtime::is_note_purge_fenced_tx(
                                    tx,
                                    &space.id,
                                    note.as_str(),
                                )
                                .await?
                            }
                        };
                        if fenced {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                    }
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
                        || (matches!(self.auth.kind(), PrincipalKind::Keeper(_))
                            && change.class == Some(DocClass::Skill))
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
                    let (version, provenance) = self
                        .note_version_inner(tx, note, preloaded_rev, want_note_provenance)
                        .await?;
                    let version = version.ok_or(DomainError::ResourceNotFound)?;
                    if version == change.revision {
                        computed_provenance = provenance;
                    } else if change.kind == ChangeKind::Move {
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
                    let tainted =
                        crate::chats::can_view_live_thread_tx(tx, space, self.auth, id).await?;
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
                    self.auth.can_view_chat_thread(
                        space,
                        id,
                        meta.kind,
                        &meta.owner_id,
                        meta.project_folder_id.as_ref(),
                        meta.tainted,
                    )?;
                    self.auth
                        .mark_chat_read_taint(space, tainted || meta.tainted);
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
        if want_note_provenance && let EntityId::Note(note) = &change.entity {
            if let Some(provenance) = computed_provenance {
                change.provenance = Some(provenance);
            } else if self.all_notes_visible {
                let owned_rev;
                let revision = if let Some(hit) = preloaded_rev
                    && self.is_preloaded_fenced(note) == Some(false)
                    && hit.visibility_seq == cut
                    && hit.space_seq == cut
                {
                    Some(hit)
                } else if self.is_preloaded_fenced(note) == Some(true) {
                    return Ok(false);
                } else {
                    match read_immutable_revision_tx(
                        tx,
                        &self.space.scope,
                        "note",
                        note.as_str(),
                        cut,
                    )
                    .await
                    {
                        Err(PortError::Domain(DomainError::ResourceNotFound)) => return Ok(false),
                        result => {
                            owned_rev = result?;
                            owned_rev.as_ref()
                        }
                    }
                };
                if let Some(revision) = revision
                    && revision.revision_id == change.revision
                    && let RevisionMetadataPayload::Note(meta) = &revision.metadata.payload
                {
                    let ancestry = self
                        .historical
                        .load_ancestry_tx(
                            tx,
                            &self.space.scope.space_id,
                            &meta.parent_folder_id,
                            false,
                        )
                        .await?;
                    change.provenance = Some(ancestry.note_provenance(
                        note,
                        &meta.slug,
                        meta.title.clone(),
                        revision.actor_id.clone(),
                        revision.created_at,
                    ));
                }
            }
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

impl CanonicalStore {
    /// Applies canonical change visibility before a worker publishes an event
    /// to one specific subscriber. The trusted projection context only bounds
    /// the read. The subscriber's own authority decides the returned data.
    pub async fn filter_projection_event_change(
        &self,
        projection: &MaintenanceContext,
        subscriber: &SpaceContext,
        mut change: Change,
    ) -> Result<Option<Change>, PortError> {
        change.cursor.check(subscriber.scope())?;
        let auth = subscriber.auth().clone();
        self.with_projection_read(projection, move |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &change.cursor.scope.space_id).await?;
                change.cursor.check(&record.scope)?;
                require_command_end_tx(tx, &record.scope, change.command_range.last_seq).await?;
                let visible = ChangeVisibility::new(&record, &auth)
                    .filter(tx, &mut change)
                    .await?;
                Ok(visible.then_some(change))
            })
        })
        .await
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
