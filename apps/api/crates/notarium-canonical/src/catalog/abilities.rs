const READ_PACKAGE: &str = "SELECT entrypoint_note_id,manifest_rev_id,lifecycle_state,slug_fold
    FROM ability_packages
    WHERE space_id=$1 AND ability_id=$2";
const READ_REVISION: &str =
    "SELECT metadata_msgpack, visibility_seq
    FROM revisions
    WHERE space_id=$1 AND rev_id=$2 AND history_incarnation=$3 AND entity_type='ability' AND entity_key=$4";
const LIST_PACKAGES: &str = "SELECT ability_id, created_seq
    FROM ability_packages
    WHERE space_id=$1 AND ability_id>$2 AND lifecycle_state='active'
    AND ($3='' OR kind=$3)
    AND ($4='' OR slug_fold=$4)
    ORDER BY ability_id
    LIMIT $5";

use super::*;
use crate::codec::{AbilityRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload};

struct ResolvedAbility {
    reference: AbilityRef,
    entrypoint: NoteRef,
    metadata: AbilityRevisionMetadata,
    name: String,
    facts: ResourceFacts,
}

async fn resolve(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    id: &AbilityId,
    exact: Option<&RevisionId>,
) -> Result<ResolvedAbility, PortError> {
    let (entry, tip, state, current_name): (String, String, String, String) = db!(
        read tx,
        sqlx::query_as(READ_PACKAGE),
        fetch_optional,
        space.space.id.as_str(),
        id.as_str()
    )?
    .ok_or(DomainError::ResourceNotFound)?;
    if state != "active" {
        return Err(DomainError::ResourceNotFound.into());
    }
    let entrypoint = NoteRef {
        space_id: space.space.id.clone(),
        note_id: NoteId::parse(&entry)?,
    };
    let note = note_metadata(tx, auth, space, entrypoint.clone()).await?;
    if note.facts.class != DocClass::Skill || note.facts.ability_package.as_ref() != Some(id) {
        return Err(DomainError::ResourceNotFound.into());
    }
    // Projects are root children. A descendant package belongs to that exact
    // project regardless of folder/path renames.
    let mut placement = match space.space.kind {
        SpaceKind::Personal => AbilityPlacement::OwnedPersonal(space.owner.clone()),
        SpaceKind::Shared => AbilityPlacement::OwnedSpace(space.space.id.clone()),
    };
    if let Some(folder) = note.facts.ancestor_folders.iter().rev().nth(1)
        && load_folder_head_row(tx, &space.space.id, folder)
            .await?
            .is_project
    {
        placement = AbilityPlacement::OwnedProject(FolderRef {
            space_id: space.space.id.clone(),
            folder_id: folder.clone(),
        });
    }
    if matches!(&placement,AbilityPlacement::OwnedPersonal(owner) if owner!=auth.principal()) {
        return Err(DomainError::ResourceNotFound.into());
    }
    let revision = match exact {
        Some(id) => id.clone(),
        None => RevisionId::parse(&tip)?,
    };
    let (bytes, visibility): (Vec<u8>, i64) = db!(
        read tx,
        sqlx::query_as(READ_REVISION),
        fetch_optional,
        space.space.id.as_str(),
        revision.as_str(),
        space.scope.incarnation.as_bytes().as_slice(),
        id.as_str()
    )?
    .ok_or(DomainError::ResourceNotFound)?;
    let RevisionMetadataPayload::Ability(meta) = RevisionMetadataEnvelope::decode(&bytes)?.payload
    else {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    };
    if meta.entrypoint_note_id != entrypoint.note_id || meta.ability_id != *id {
        return Err(DomainError::ResourceNotFound.into());
    }
    let mut facts = note.facts;
    // The manifest, including the auxiliary filenames in a current descriptor,
    // still belongs to its publication snapshot after its entrypoint moves.
    {
        let cutoff = crate::codec::i64_to_space_seq(visibility)?;
        let entry = crate::runtime::read_immutable_revision_tx(
            tx,
            &space.scope,
            "note",
            entrypoint.note_id.as_str(),
            cutoff,
        )
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
        let RevisionMetadataPayload::Note(snapshot) = entry.metadata.payload else {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        };
        if entry.revision_id != meta.entrypoint_revision
            || snapshot.lifecycle != Lifecycle::Active
            || snapshot.doc_class != DocClass::Skill
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let (historical, _) =
            crate::domain::common::FolderAncestryCache::at_cut(&space.scope, cutoff)
                .build_resource_facts_tx(
                    tx,
                    &space.space,
                    &snapshot.parent_folder_id,
                    snapshot.doc_class,
                    Some(id.clone()),
                    true,
                )
                .await?;
        auth.can_view_resource(&historical)?;
        // A classified resource can be handed to another reader. A project
        // grant must cover both locations when that reader opens the content.
        facts
            .ancestor_folders
            .retain(|folder| historical.ancestor_folders.contains(folder));
    }
    let name = if revision.as_str() == tip {
        current_name
    } else {
        meta.slug_fold.clone()
    };
    Ok(ResolvedAbility {
        name,
        reference: AbilityRef {
            id: id.clone(),
            placement,
            revision,
        },
        entrypoint,
        metadata: meta,
        facts,
    })
}

async fn descriptor(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    id: &AbilityId,
    exact: Option<&RevisionId>,
) -> Result<AbilityDescriptor, PortError> {
    let ResolvedAbility {
        reference,
        entrypoint,
        metadata: meta,
        name,
        ..
    } = resolve(tx, auth, space, id, exact).await?;
    Ok(AbilityDescriptor {
        reference,
        kind: meta.kind,
        name,
        enabled: true,
        healthy: true,
        lifecycle: meta.lifecycle,
        entrypoint,
        auxiliary_files: meta
            .resources
            .into_keys()
            .filter(|p| p != crate::domain::packages::ABILITY_ENTRYPOINT_KEY)
            .collect(),
    })
}

pub(crate) async fn authorize_change_tx(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    id: &AbilityId,
    revision: &RevisionId,
) -> Result<(), PortError> {
    let package = resolve(tx, auth, space, id, Some(revision)).await?;
    Ok(auth.authorize_read(&package.facts)?)
}

pub(crate) async fn resource_digest_tx(
    tx: &mut BackendConn<'_>,
    ctx: &SpaceContext,
    request: &ReadAbilityResource,
    key: &str,
) -> Result<(ContentDigest, ResourceFacts), PortError> {
    let space = load_space_record(tx, &ctx.scope().space_id).await?;
    space.scope.check(ctx.scope())?;
    let package = resolve(
        tx,
        ctx.auth(),
        &space,
        &request.ability,
        Some(&request.package_revision),
    )
    .await?;
    if package.metadata.lifecycle != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let digest = package
        .metadata
        .resources
        .get(key)
        .copied()
        .ok_or(DomainError::ResourceNotFound)?;
    ctx.auth().authorize_read(&package.facts)?;
    Ok((digest, package.facts))
}

pub(super) async fn lookup(
    store: &CanonicalStore,
    ctx: AccountContext,
    id: AbilityIdentity,
    exact: Option<RevisionId>,
) -> Result<AbilityDescriptor, PortError> {
    let budget = ctx.budget.clone();
    store
        .with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                let space = match &id.placement {
                    AbilityPlacement::OwnedProject(r) => r.space_id.clone(),
                    AbilityPlacement::OwnedSpace(r) => r.clone(),
                    AbilityPlacement::OwnedPersonal(owner) if owner == ctx.auth().principal() => {
                        super::memory::personal_space(tx, ctx.auth(), owner).await?
                    }
                    _ => return Err(DomainError::ResourceNotFound.into()),
                };
                if !ctx.auth().spaces().contains_key(&space) {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let rec = load_space_record(tx, &space).await?;
                let value = descriptor(tx, ctx.auth(), &rec, &id.id, exact.as_ref()).await?;
                if value.reference.identity() != id {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Ok(value)
            })
        })
        .await
}

pub(super) async fn page(
    store: &CanonicalStore,
    ctx: AccountContext,
    query: AbilityQuery,
) -> Result<ControlPage<AbilityDescriptor>, PortError> {
    if query.authoring {
        ctx.auth().authorize_ability_mutation()?;
    }
    let budget = ctx.budget.clone();
    store
        .with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                let mut live = Vec::new();
                let mut versions = Vec::new();
                for (id, grant) in ctx.auth().spaces() {
                    if !grant.read_classes.contains(&DocClass::Skill) {
                        continue;
                    }
                    let space = match load_space_record(tx, id).await {
                        Ok(rec) if rec.space.lifecycle == SpaceLifecycle::Active => rec,
                        Ok(_) | Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                        Err(e) => return Err(e),
                    };
                    versions.push((
                        space.scope.clone(),
                        space.last_seq,
                        grant.project_root.clone(),
                    ));
                    live.push(space);
                }
                let scope = digest((
                    "visible-abilities-v2",
                    ctx.auth().principal(),
                    ctx.auth().grant(),
                    ctx.auth().readonly_abilities(),
                    versions,
                    &query.project,
                    query.kind,
                    &query.name,
                    query.authoring,
                ))?;
                let after: Option<(SpaceId, i64)> = continuation(&query.page, &scope)?;
                let cap = usize::from(query.page.limit());
                let mut keys = Vec::new();
                for (index, rec) in live.iter().enumerate() {
                    let after_id = match &after {
                        Some((sid, _)) if sid > &rec.space.id => continue,
                        Some((sid, seq)) if sid == &rec.space.id => {
                            cursor_entity(tx, sid, "ability", *seq).await?
                        }
                        _ => String::new(),
                    };
                    let remaining = (cap + 1 - keys.len()) as i64;
                    let ids: Vec<(String, i64)> = db!(
                        read tx,
                        sqlx::query_as(LIST_PACKAGES),
                        fetch_all,
                        rec.space.id.as_str(),
                        after_id,
                        query.kind.map_or("", crate::codec::ability_kind_to_db),
                        query.name.as_deref().unwrap_or(""),
                        remaining
                    )?;
                    for (id, seq) in ids {
                        keys.push((index, AbilityId::parse(&id)?, seq));
                    }
                    if keys.len() > cap {
                        break;
                    }
                }
                let next = if keys.len() > cap {
                    keys.pop();
                    let (index, _, seq) = keys.last().expect("nonempty page");
                    Some(encode_cursor(scope, (&live[*index].space.id, seq))?)
                } else {
                    None
                };
                let mut items = Vec::new();
                for (index, id, _) in keys {
                    match descriptor(tx, ctx.auth(), &live[index], &id, None).await {
                        Ok(value) => {
                            let visible = match &value.reference.placement {
                                AbilityPlacement::OwnedProject(folder) => {
                                    Some(folder) == query.project.as_ref()
                                }
                                AbilityPlacement::OwnedSpace(space) => {
                                    query.project.as_ref().is_none_or(|p| &p.space_id == space)
                                }
                                _ => true,
                            };
                            if visible {
                                items.push(value);
                            }
                        }
                        Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
                        Err(e) => return Err(e),
                    }
                }
                Ok(ControlPage {
                    items,
                    continuation: next,
                })
            })
        })
        .await
}
