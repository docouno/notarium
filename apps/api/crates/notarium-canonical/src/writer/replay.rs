//! Live authority for delivery of previously committed command results.
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, ResourceFacts, Space},
    classes::DocClass,
    error::PortError,
    ids::{ChatThreadId, FolderId, JobId, NoteId, ThreadEntrySeq},
    model::{HistoryScope, NoteRef},
    ports::LinkTarget,
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
    Create(NoteId, Option<FolderId>, DocClass),
    Move(NoteId, Option<FolderId>),
    WriteFolder(Option<FolderId>),
    ReadLinkFolder(FolderId, NoteId),
}

#[derive(Clone, Debug)]
pub(crate) enum ReplayPolicy {
    Documents(Vec<ReplayResource>),
    Schema(Vec<ReplayResource>),
    Chat(ChatThreadId, Option<ThreadEntrySeq>, Vec<NoteRef>, bool),
    Job(Option<JobId>, Vec<NoteId>),
}

/// A domain fingerprint becomes usable by the writer only after binding a policy.
pub(crate) struct UnboundCommand(pub(crate) CommandIdentitySpec);

impl UnboundCommand {
    pub(crate) fn command_hash(&self) -> notarium_core::ids::ContentDigest {
        self.0.command_hash
    }

    pub(crate) fn with_policy(
        mut self,
        auth: &EngineAuthContext,
        policy: ReplayPolicy,
    ) -> CommandIdentitySpec {
        self.0.authority = Some(std::sync::Arc::new((auth.clone(), policy)));
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
    pub(crate) async fn authorize_replay(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
    ) -> Result<(), PortError> {
        let Some((auth, policy)) = self.authority.as_deref() else {
            return Ok(());
        };
        let srec = load_space_record(tx, &scope.space_id).await?;
        srec.scope.check(scope)?;
        match policy {
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
            ReplayPolicy::Documents(targets) | ReplayPolicy::Schema(targets) => {
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
            let (facts, _) = build_resource_facts_tx(
                tx,
                &srec.space,
                folder,
                folder_mutation_class(auth, &srec.space.id)?,
                None,
                true,
            )
            .await?;
            return Ok(auth.authorize_direct_write(&facts, &facts)?);
        }
        ReplayResource::ReadLinkFolder(folder, source) => {
            let head =
                crate::domain::common::load_note_head_row_tx(tx, &srec.space.id, source).await?;
            let (facts, _) =
                build_resource_facts_tx(tx, &srec.space, folder, head.doc_class, None, true)
                    .await?;
            return Ok(auth.authorize_read(&facts)?);
        }
        ReplayResource::View(note) => {
            return crate::domain::board::authorized_view_head(tx, &srec.space, auth, note)
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
        let (facts, _) = build_resource_facts_tx(
            tx,
            &srec.space,
            parent.unwrap_or(&srec.root_folder_id),
            class,
            None,
            true,
        )
        .await?;
        auth.authorize_direct_write(&facts, &facts)?;
    }
    if let Some(head) = head {
        let (facts, _) = build_resource_facts_tx(
            tx,
            &srec.space,
            &head.parent_folder_id,
            head.doc_class,
            head.ability_id,
            true,
        )
        .await?;
        authorize_head(auth, target, &facts, head.lifecycle)?;
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
