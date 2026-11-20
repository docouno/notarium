use super::*;
use notarium_core::receipt::CommandIdentity;

pub(crate) fn fixed_note_id(target: &MemoryTarget, category: &str) -> Result<NoteId, PortError> {
    if category.is_empty()
        || category.len() > 64
        || !category.as_bytes()[0].is_ascii_lowercase()
        || !category
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(DomainError::validation(ValidationReason::InvalidQuery).into());
    }
    let bytes = match target {
        MemoryTarget::User { owner } => {
            crate::codec::encode_msgpack(&("account-memory-v1", owner, category))?
        }
        MemoryTarget::Project { folder } => {
            crate::codec::encode_msgpack(&("project-memory-v1", folder, category))?
        }
    };
    Ok(NoteId::from_bytes(
        blake3::hash(&bytes).as_bytes()[..16]
            .try_into()
            .expect("digest prefix"),
    ))
}
pub(super) async fn personal_space(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    owner: &PrincipalId,
) -> Result<SpaceId, PortError> {
    if owner != auth.principal() {
        return Err(DomainError::ResourceNotFound.into());
    }
    let matches: Vec<String> = db!(
        read tx,
        sqlx::query_scalar(
            "SELECT space_id FROM spaces WHERE owner_id=$1 AND space_kind='personal' AND lifecycle_state='active' LIMIT 2"
        ),
        fetch_all,
        owner.as_str()
    )?;
    let [id] = matches.as_slice() else {
        return Err(DomainError::ResourceNotFound.into());
    };
    let space = SpaceId::parse(id)?;
    if !auth.spaces().contains_key(&space) {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(space)
}

pub(crate) fn initial_carrier(category: &str) -> String {
    format!("---\nclass: agent-memory\ntitle: {category}\n---\n")
}

/// Resolve the exact stable slot under a current Space snapshot. The same
/// placement checks apply while reading a base, executing a write and replaying
/// its receipt.
pub(crate) async fn authorized_slot(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    rec: &SpaceRecord,
    target: &ResolvedMemoryTarget,
) -> Result<(FolderId, Option<crate::domain::common::NoteHeadRow>), PortError> {
    if target.note.space_id != rec.scope.space_id
        || target.note.note_id != fixed_note_id(&target.target, &target.category)?
    {
        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
    }
    let parent = match &target.target {
        MemoryTarget::User { owner }
            if owner == auth.principal()
                && owner == &rec.owner
                && rec.space.kind == SpaceKind::Personal =>
        {
            rec.root_folder_id.clone()
        }
        MemoryTarget::Project { folder } if folder.space_id == rec.scope.space_id => {
            let (_, row) = folder_metadata(tx, auth, rec, folder.clone()).await?;
            if !row.is_project {
                return Err(DomainError::ResourceNotFound.into());
            }
            folder.folder_id.clone()
        }
        _ => return Err(DomainError::ResourceNotFound.into()),
    };
    let (facts, _) =
        build_resource_facts_tx(tx, &rec.space, &parent, DocClass::AgentMemory, None, true).await?;
    auth.can_view_resource(&facts)?;
    auth.authorize_direct_write(&facts, &facts)?;
    let note = &target.note.note_id;
    if crate::runtime::is_note_purge_fenced_tx(tx, &rec.scope.space_id, note.as_str()).await? {
        return Err(DomainError::ResourceNotFound.into());
    }
    let head =
        crate::domain::common::load_note_head_row_opt_tx(tx, &rec.scope.space_id, note).await?;
    if let Some(head) = &head {
        if head.parent_folder_id != parent
            || head.doc_class != DocClass::AgentMemory
            || head.ability_id.is_some()
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        if head.lifecycle != Lifecycle::Active {
            // A rollback that undoes creation writes a tombstone in the same atomic cut as
            // the creator run's revision. A manual trash has no such witness. Repeated
            // rollbacks may restore this same tombstone through restored_from_rev_id.
            let sql = "WITH RECURSIVE source(rev_id, parent_rev_id, restored_from_rev_id, visibility_seq, agent_run_id) AS (
                SELECT rev_id, parent_rev_id, restored_from_rev_id, visibility_seq, agent_run_id
                FROM revisions WHERE space_id=$1 AND rev_id=$2 AND entity_type='note' AND entity_key=$3
                UNION
                SELECT r.rev_id, r.parent_rev_id, r.restored_from_rev_id, r.visibility_seq, r.agent_run_id
                FROM source JOIN revisions r ON r.space_id=$1 AND r.rev_id=source.restored_from_rev_id
                WHERE r.entity_type='note' AND r.entity_key=$3
            )
            SELECT CAST(1 AS BIGINT) FROM source
            JOIN revisions parent ON parent.space_id=$1 AND parent.rev_id=source.parent_rev_id
            JOIN revisions run ON run.space_id=$1 AND run.entity_type='agent_run'
                AND run.entity_key=parent.agent_run_id AND run.visibility_seq=source.visibility_seq
            WHERE source.restored_from_rev_id IS NULL AND source.agent_run_id IS NULL LIMIT 1";
            let undone: Option<i64> = db!(read tx, sqlx::query_scalar(sql), fetch_optional,
                rec.scope.space_id.as_str(), head.head_rev_id.as_str(), note.as_str())?;
            if head.lifecycle != Lifecycle::Trashed || undone.is_none() {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
    }
    Ok((parent, head))
}

pub(super) async fn inspect(
    store: &CanonicalStore,
    ctx: &AccountContext,
    target: MemoryTarget,
    category: String,
    for_append: bool,
) -> Result<MemoryTargetSnapshot, PortError> {
    let note_id = fixed_note_id(&target, &category)?;
    let auth = ctx.auth().clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), move |tx| {
            Box::pin(async move {
                let space = match &target {
                    MemoryTarget::User { owner } => personal_space(tx, &auth, owner).await?,
                    MemoryTarget::Project { folder } => folder.space_id.clone(),
                };
                let rec = load_space_record(tx, &space).await?;
                let resolved = ResolvedMemoryTarget {
                    target,
                    note: NoteRef {
                        space_id: space,
                        note_id,
                    },
                    category,
                };
                let (parent, head) = authorized_slot(tx, &auth, &rec, &resolved).await?;
                if !for_append
                    && head
                        .as_ref()
                        .is_some_and(|head| head.lifecycle == Lifecycle::Trashed)
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Ok(MemoryTargetSnapshot {
                    resolved,
                    scope: rec.scope,
                    parent,
                    revision: head
                        .filter(|head| head.lifecycle == Lifecycle::Active)
                        .map(|head| head.head_rev_id),
                })
            })
        })
        .await
}

pub(super) async fn resolve(
    store: &CanonicalStore,
    ctx: AccountContext,
    target: MemoryTarget,
    category: String,
) -> Result<ResolvedMemoryTarget, PortError> {
    let MemoryTargetSnapshot {
        resolved,
        scope,
        parent,
        revision,
    } = inspect(store, &ctx, target, category, false).await?;
    if revision.is_none() {
        let reference = &resolved.note;
        let category = &resolved.category;
        let hash = blake3::hash(&crate::codec::encode_msgpack(&(
            "ensure-memory-v1",
            reference,
            category,
        ))?);
        let scoped = SpaceContext::new(ctx.auth().clone(), scope.clone(), ctx.budget.clone())?;
        let identity = CommandIdentity {
            scope,
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes(hash.as_bytes()[..16].try_into().expect("digest prefix")),
            hash: ContentDigest::from_bytes(*hash.as_bytes()),
        };
        let request = Mutation {
            identity,
            preconditions: Preconditions::default(),
            input: CreateNote {
                folder_page: false,
                note: reference.note_id.clone(),
                parent: Some(parent.clone()),
                slug: format!("memory-{category}"),
                class: DocClass::AgentMemory,
                carrier: initial_carrier(category),
            },
        };
        if let Err(e) = store.create_note(scoped, request).await
            && !matches!(e, PortError::Domain(DomainError::PathConflict { .. }))
        {
            return Err(e);
        }
    }
    let current = ControlCatalogPort::note(store, ctx.clone(), resolved.note.clone()).await?;
    if current.facts.class != DocClass::AgentMemory
        || current.facts.ancestor_folders.first() != Some(&parent)
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    ctx.auth()
        .authorize_direct_write(&current.facts, &current.facts)?;
    Ok(resolved)
}
