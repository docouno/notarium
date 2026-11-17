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
        tx,
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

pub(super) async fn resolve(
    store: &CanonicalStore,
    ctx: AccountContext,
    target: MemoryTarget,
    category: String,
) -> Result<ResolvedMemoryTarget, PortError> {
    let note = fixed_note_id(&target, &category)?;
    let (scope, parent, existing) = {
        let target = target.clone();
        let note = note.clone();
        let auth = ctx.auth().clone();
        store
            .with_read_tx_budget(Some(&ctx.budget), move |tx| {
                Box::pin(async move {
                    let space = match &target {
                        MemoryTarget::User { owner } => personal_space(tx, &auth, owner).await?,
                        MemoryTarget::Project { folder } => folder.space_id.clone(),
                    };
                    let rec = load_space_record(tx, &space).await?;
                    let parent = match target {
                        MemoryTarget::User { .. } => rec.root_folder_id.clone(),
                        MemoryTarget::Project { folder } => {
                            let (_, row) = folder_metadata(tx, &auth, &rec, folder.clone()).await?;
                            if !row.is_project {
                                return Err(DomainError::ResourceNotFound.into());
                            }
                            folder.folder_id
                        }
                    };
                    let (facts, _) = build_resource_facts_tx(
                        tx,
                        &rec.space,
                        &parent,
                        DocClass::AgentMemory,
                        None,
                        true,
                    )
                    .await?;
                    auth.authorize_direct_write(&facts, &facts)?;
                    let head =
                        crate::domain::common::load_note_head_row_opt_tx(tx, &space, &note).await?;
                    if let Some(head) = &head
                        && (head.parent_folder_id != parent
                            || head.doc_class != DocClass::AgentMemory
                            || head.lifecycle != Lifecycle::Active)
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    Ok((rec.scope, parent, head.is_some()))
                })
            })
            .await?
    };
    let reference = NoteRef {
        space_id: scope.space_id.clone(),
        note_id: note.clone(),
    };
    if !existing {
        let hash = blake3::hash(&crate::codec::encode_msgpack(&(
            "ensure-memory-v1",
            &reference,
            &category,
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
                note,
                parent: Some(parent.clone()),
                slug: format!("memory-{category}"),
                class: DocClass::AgentMemory,
                carrier: format!("---\nclass: agent-memory\ntitle: {category}\n---\n"),
            },
        };
        if let Err(e) = store.create_note(scoped, request).await
            && !matches!(e, PortError::Domain(DomainError::PathConflict { .. }))
        {
            return Err(e);
        }
    }
    let current = ControlCatalogPort::note(store, ctx.clone(), reference.clone()).await?;
    if current.facts.class != DocClass::AgentMemory
        || current.facts.ancestor_folders.first() != Some(&parent)
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    ctx.auth()
        .authorize_direct_write(&current.facts, &current.facts)?;
    Ok(ResolvedMemoryTarget {
        target,
        note: reference,
        category,
    })
}
