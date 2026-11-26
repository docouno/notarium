//! Live authority for delivery of previously committed command results.
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, ResourceFacts, Space},
    classes::DocClass,
    error::PortError,
    ids::{AgentRunId, ChatThreadId, FolderId, JobId, NoteId, ThreadEntrySeq},
    model::{HistoryScope, NoteRef},
    ports::{CanonicalEffectAdmission, LinkTarget, ResolvedMemoryTarget},
};

use super::CommandIdentitySpec;
use crate::{
    domain::{
        common::{build_resource_facts_tx, load_note_head_row_opt_tx},
        folders::folder_mutation_class,
    },
    runtime::{SpaceRecord, load_space_record},
    sql_exec::BackendConn,
};

#[derive(Clone, Debug)]
pub(crate) enum ReplayResource {
    Write(NoteId),
    Read(NoteId),
    View(NoteId),
    RollbackView(NoteId),
    Create(NoteId, Option<FolderId>, DocClass),
    Move(NoteId, Option<FolderId>),
    WriteFolder(Option<FolderId>),
    WriteFolderSubtree(FolderId),
    ReadLinkFolder(FolderId, NoteId),
}

#[derive(Clone, Debug)]
pub(crate) enum ReplayPolicy {
    Documents(Vec<ReplayResource>),
    RollbackRun(AgentRunId),
    RollbackDocuments(Vec<ReplayResource>),
    Schema(Vec<ReplayResource>),
    Memory(ResolvedMemoryTarget),
    Chat(ChatThreadId, Option<ThreadEntrySeq>, Vec<NoteRef>, bool),
    Job(Option<JobId>, Vec<NoteId>),
}

#[derive(Debug)]
pub(crate) struct ReplayAuthority {
    pub(crate) auth: EngineAuthContext,
    pub(crate) policy: ReplayPolicy,
    pub(crate) canonical_effect: Option<CanonicalEffectAdmission>,
}

/// A domain fingerprint becomes usable by the writer only after binding a policy.
pub(crate) struct UnboundCommand(
    pub(crate) CommandIdentitySpec,
    Option<CanonicalEffectAdmission>,
);

impl UnboundCommand {
    pub(crate) fn new(
        spec: CommandIdentitySpec,
        canonical_effect: Option<CanonicalEffectAdmission>,
    ) -> Self {
        Self(spec, canonical_effect)
    }

    #[cfg(test)]
    pub(crate) fn command_hash(&self) -> notarium_core::ids::ContentDigest {
        self.0.command_hash
    }

    pub(crate) fn with_policy(
        mut self,
        auth: &EngineAuthContext,
        policy: ReplayPolicy,
    ) -> CommandIdentitySpec {
        self.0.authority = Some(std::sync::Arc::new(ReplayAuthority {
            auth: auth.clone(),
            policy,
            canonical_effect: self.1,
        }));
        self.0
    }

    pub(crate) fn for_note(self, auth: &EngineAuthContext, note: &NoteId) -> CommandIdentitySpec {
        self.with_policy(
            auth,
            ReplayPolicy::Documents(vec![ReplayResource::Write(note.clone())]),
        )
    }

    pub(crate) fn for_create(
        self,
        auth: &EngineAuthContext,
        note: &NoteId,
        parent: Option<&FolderId>,
        class: DocClass,
    ) -> CommandIdentitySpec {
        self.with_policy(
            auth,
            ReplayPolicy::Documents(vec![ReplayResource::Create(
                note.clone(),
                parent.cloned(),
                class,
            )]),
        )
    }

    pub(crate) fn for_move(
        self,
        auth: &EngineAuthContext,
        note: &NoteId,
        parent: Option<&FolderId>,
    ) -> CommandIdentitySpec {
        self.with_policy(
            auth,
            ReplayPolicy::Documents(vec![ReplayResource::Move(note.clone(), parent.cloned())]),
        )
    }

    pub(crate) fn for_job(
        self,
        auth: &EngineAuthContext,
        job: Option<&JobId>,
        notes: &[NoteId],
    ) -> CommandIdentitySpec {
        self.with_policy(auth, ReplayPolicy::Job(job.cloned(), notes.to_vec()))
    }

    pub(crate) fn for_chat(
        self,
        auth: &EngineAuthContext,
        thread: &ChatThreadId,
        reads: Vec<NoteRef>,
    ) -> CommandIdentitySpec {
        self.with_policy(auth, ReplayPolicy::Chat(thread.clone(), None, reads, false))
    }

    pub(crate) fn for_chat_leaf(
        self,
        auth: &EngineAuthContext,
        thread: &ChatThreadId,
        leaf: ThreadEntrySeq,
    ) -> CommandIdentitySpec {
        self.with_policy(
            auth,
            ReplayPolicy::Chat(thread.clone(), Some(leaf), Vec::new(), false),
        )
    }

    pub(crate) fn for_link(
        self,
        auth: &EngineAuthContext,
        source: &NoteId,
        target: &LinkTarget,
    ) -> CommandIdentitySpec {
        let mut resources = vec![ReplayResource::Write(source.clone())];
        match target {
            LinkTarget::Note(note) => resources.push(ReplayResource::Read(note.clone())),
            LinkTarget::Folder(folder) => resources.push(ReplayResource::ReadLinkFolder(
                folder.clone(),
                source.clone(),
            )),
            LinkTarget::AuthoredName(_) => {}
        }
        self.with_policy(auth, ReplayPolicy::Documents(resources))
    }
}

impl CommandIdentitySpec {
    pub(crate) async fn authorize_confirmed_chat_step(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
        committing: bool,
    ) -> Result<(), PortError> {
        let Some(super::fingerprint::CommandProof::Confirmed { step, kind }) =
            self.fingerprint_proof.as_deref()
        else {
            return Ok(());
        };
        let Some(ReplayAuthority { auth, .. }) = self.authority.as_deref() else {
            return Err(DomainError::validation(
                notarium_core::error::ValidationReason::InvalidAuthority,
            )
            .into());
        };
        if step.identity().actor != self.actor || step.identity().key != self.command_key {
            return Err(DomainError::validation(
                notarium_core::error::ValidationReason::InvalidAuthority,
            )
            .into());
        }
        crate::chats::verify_confirmed_chat_step_tx(tx, auth, scope, step, kind, committing).await
    }

    /// A purge can remove the revisions that once attributed a skipped note to
    /// the run. Older detailed and sanitized envelopes still name that note.
    pub(crate) fn rollback_disclosures(
        &self,
        scope: &HistoryScope,
        receipt: &super::StoredReceiptRow,
    ) -> Result<std::collections::BTreeMap<NoteId, bool>, PortError> {
        let mut notes = std::collections::BTreeMap::new();
        if receipt.command_hash == self.command_hash
            && receipt.status == "completed"
            && self.authority.as_deref().is_some_and(|a| {
                matches!(
                    a.policy,
                    ReplayPolicy::RollbackRun(_) | ReplayPolicy::RollbackDocuments(_)
                )
            })
        {
            let wire: crate::domain::common::StoredCommittedRollbackV1 =
                rmp_serde::from_slice(&receipt.response_blob).map_err(|err| {
                    crate::codec::internal_not_committed(
                        "decode_replayed_rollback",
                        err.to_string(),
                    )
                })?;
            scope.check(wire.receipt.scope())?;
            notes.extend(wire.disclosed_notes().map(|note| (note.clone(), false)));
            notes.extend(
                wire.restored_ranks
                    .into_iter()
                    .map(|rank| (rank.view.note, true)),
            );
        }
        Ok(notes)
    }

    pub(crate) async fn authorize_rollback_disclosures(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
        receipt: &super::StoredReceiptRow,
    ) -> Result<(), PortError> {
        let notes = self.rollback_disclosures(scope, receipt)?;
        if notes.is_empty() {
            return Ok(());
        }
        let auth = &self.authority.as_ref().expect("rollback authority").auth;
        let space = load_space_record(tx, &scope.space_id).await?;
        space.scope.check(scope)?;
        let ids = notes.keys().cloned().collect::<Vec<_>>();
        if crate::runtime::are_any_notes_purge_fenced_tx(tx, &scope.space_id, &ids).await? {
            return Err(DomainError::ResourceNotFound.into());
        }
        for (note, is_view) in notes {
            let target = if is_view {
                ReplayResource::RollbackView(note)
            } else {
                ReplayResource::Read(note)
            };
            authorize_resource(tx, &space, auth, &target).await?;
        }
        Ok(())
    }

    pub(crate) async fn authorize_replay(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
    ) -> Result<(), PortError> {
        self.authorize_confirmed_chat_step(tx, scope, false).await?;
        let Some(ReplayAuthority { auth, policy, .. }) = self.authority.as_deref() else {
            return Ok(());
        };
        let srec = load_space_record(tx, &scope.space_id).await?;
        srec.scope.check(scope)?;
        match policy {
            ReplayPolicy::RollbackRun(run) => {
                // `rollback_agent_run_by_id` replay intentionally enforces live active-folder
                // visibility on the run's current sources (see `rollback_receipts`).
                crate::domain::rollback::prepare_rollback_sources_tx(
                    tx,
                    &srec,
                    auth,
                    run.clone(),
                    true,
                )
                .await?;
            }
            ReplayPolicy::Memory(target) => {
                let (_, head) =
                    crate::catalog::memory::authorized_slot(tx, auth, &srec, target).await?;
                if head.is_none_or(|head| head.lifecycle != notarium_core::model::Lifecycle::Active)
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            ReplayPolicy::Chat(thread, leaf, reads, legacy_staged) => {
                crate::chats::authorize_chat_replay_tx(
                    tx,
                    &srec.space,
                    auth,
                    thread,
                    *leaf,
                    *legacy_staged,
                )
                .await?;
                for note in reads {
                    if note.space_id == srec.space.id {
                        authorize_resource(
                            tx,
                            &srec,
                            auth,
                            &ReplayResource::Read(note.note_id.clone()),
                        )
                        .await?;
                    } else {
                        if !auth.spaces().contains_key(&note.space_id) {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        auth.taint().mark_external_read();
                    }
                }
            }
            ReplayPolicy::Job(job, notes) => {
                crate::peers::authorize_job_replay_tx(tx, &srec.space, auth, job.as_ref(), notes)
                    .await?
            }
            ReplayPolicy::Documents(targets)
            | ReplayPolicy::RollbackDocuments(targets)
            | ReplayPolicy::Schema(targets) => {
                auth.authorize_space_write(&srec.space)?;
                if matches!(policy, ReplayPolicy::Schema(_)) {
                    authorize_schema_space(auth, &srec.space)?;
                }
                for target in targets {
                    authorize_resource(tx, &srec, auth, target).await?;
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn authorize_schema_space(
    auth: &EngineAuthContext,
    space: &Space,
) -> Result<(), PortError> {
    auth.authorize_space_write(space)?;
    if auth.spaces()[&space.id].project_root.is_some() {
        return Err(DomainError::SpaceReadOnly.into());
    }
    Ok(())
}

async fn authorize_resource(
    tx: &mut BackendConn<'_>,
    srec: &SpaceRecord,
    auth: &EngineAuthContext,
    target: &ReplayResource,
) -> Result<(), PortError> {
    let note = match target {
        ReplayResource::WriteFolder(folder) => {
            let folder = folder.as_ref().unwrap_or(&srec.root_folder_id);
            let (facts, ancestry) = build_resource_facts_tx(
                tx,
                &srec.space,
                folder,
                folder_mutation_class(auth, &srec.space.id)?,
                None,
                false,
            )
            .await?;
            for anc in &ancestry.ancestors {
                let row = crate::runtime::load_folder_head_row(tx, &srec.space.id, anc).await?;
                if row.lifecycle == notarium_core::model::Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            return Ok(auth.authorize_direct_write(&facts, &facts)?);
        }
        ReplayResource::WriteFolderSubtree(folder) => {
            let (facts, ancestry) = build_resource_facts_tx(
                tx,
                &srec.space,
                folder,
                folder_mutation_class(auth, &srec.space.id)?,
                None,
                false,
            )
            .await?;
            for anc in &ancestry.ancestors {
                let row = crate::runtime::load_folder_head_row(tx, &srec.space.id, anc).await?;
                if row.lifecycle == notarium_core::model::Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            auth.authorize_direct_write(&facts, &facts)?;
            return crate::domain::folders::authorize_folder_subtree_tx(
                tx,
                &srec.space.id,
                folder,
                auth,
                true,
            )
            .await;
        }
        ReplayResource::ReadLinkFolder(folder, source) => {
            let head =
                crate::domain::common::load_note_head_row_tx(tx, &srec.space.id, source).await?;
            let (facts, ancestry) =
                build_resource_facts_tx(tx, &srec.space, folder, head.doc_class, None, false)
                    .await?;
            if ancestry.folder_lifecycle == notarium_core::model::Lifecycle::Purged {
                return Err(DomainError::ResourceNotFound.into());
            }
            return Ok(auth.authorize_read(&facts)?);
        }
        ReplayResource::View(note) => {
            return crate::domain::board::authorized_view_head(tx, &srec.space, auth, note)
                .await
                .map(|_| ());
        }
        ReplayResource::RollbackView(note) => {
            return crate::domain::board::authorized_rollback_view_head_opt(
                tx,
                &srec.space,
                auth,
                note,
            )
            .await
            .map(|_| ());
        }
        ReplayResource::Read(note)
        | ReplayResource::Write(note)
        | ReplayResource::Create(note, ..)
        | ReplayResource::Move(note, ..) => note,
    };
    let head = load_note_head_row_opt_tx(tx, &srec.space.id, note).await?;
    if let Some((parent, class)) = destination(target, head.as_ref().map(|h| h.doc_class)) {
        let (facts, ancestry) = build_resource_facts_tx(
            tx,
            &srec.space,
            parent.unwrap_or(&srec.root_folder_id),
            class,
            None,
            false,
        )
        .await?;
        if ancestry.folder_lifecycle == notarium_core::model::Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound.into());
        }
        auth.authorize_direct_write(&facts, &facts)?;
    }
    if let Some(head) = head {
        let (facts, ancestry) = build_resource_facts_tx(
            tx,
            &srec.space,
            &head.parent_folder_id,
            head.doc_class,
            head.ability_id,
            false,
        )
        .await?;
        if ancestry.folder_lifecycle == notarium_core::model::Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound.into());
        }
        authorize_head(
            auth,
            target,
            &facts,
            crate::domain::common::combine_lifecycle(head.lifecycle, ancestry.folder_lifecycle),
        )?;
    } else if !matches!(target, ReplayResource::Create(..)) {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}

pub(crate) fn destination(
    target: &ReplayResource,
    current: Option<DocClass>,
) -> Option<(Option<&FolderId>, DocClass)> {
    match target {
        ReplayResource::Create(_, parent, class) => Some((parent.as_ref(), *class)),
        ReplayResource::Move(_, parent) => Some((parent.as_ref(), current?)),
        _ => None,
    }
}

pub(crate) fn authorize_head(
    auth: &EngineAuthContext,
    target: &ReplayResource,
    facts: &ResourceFacts,
    lifecycle: notarium_core::model::Lifecycle,
) -> Result<(), PortError> {
    if matches!(target, ReplayResource::View(_))
        && lifecycle != notarium_core::model::Lifecycle::Active
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    if matches!(target, ReplayResource::Read(_) | ReplayResource::View(_)) {
        auth.authorize_read(facts)?;
    } else {
        auth.authorize_direct_write(facts, facts)?;
    }
    Ok(())
}
