const READ_PACKAGE: &str = "SELECT entrypoint_note_id,manifest_rev_id,lifecycle_state,slug_fold
    FROM ability_packages
    WHERE space_id=$1 AND ability_id=$2";
const READ_REVISION: &str =
    "SELECT metadata_msgpack, visibility_seq
    FROM revisions
    WHERE space_id=$1 AND rev_id=$2 AND history_incarnation=$3 AND entity_type='ability' AND entity_key=$4";
const LIST_PACKAGES_SQLITE: &str = "SELECT ability_id, created_seq
    FROM ability_packages
    WHERE space_id=$1 AND ability_id>$2 AND lifecycle_state='active'
    AND ($3='' OR kind=$3)
    AND ($4='' OR slug_fold=$4)
    ORDER BY ability_id
    LIMIT $5";
const LIST_PACKAGES_PG: &str = "SELECT ability_id, created_seq
    FROM ability_packages
    WHERE space_id=$1 AND ability_id COLLATE \"C\" > $2 AND lifecycle_state='active'
    AND ($3='' OR kind=$3)
    AND ($4='' OR slug_fold=$4)
    ORDER BY ability_id COLLATE \"C\"
    LIMIT $5";

use super::*;
use crate::codec::{AbilityRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload};
use notarium_core::classes::{AbilityResourceLocation, AbilityResourceProvenance};

pub(crate) async fn ability_manifest_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    id: &AbilityId,
    revision: &RevisionId,
) -> Result<(AbilityRevisionMetadata, SpaceSeq), PortError> {
    let (bytes, visibility): (Vec<u8>, i64) = db!(
        read tx, sqlx::query_as(READ_REVISION), fetch_optional,
        scope.space_id.as_str(),
        revision.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        id.as_str()
    )?
    .ok_or(DomainError::ResourceNotFound)?;
    let RevisionMetadataPayload::Ability(meta) = RevisionMetadataEnvelope::decode(&bytes)?.payload
    else {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    };
    Ok((meta, crate::codec::i64_to_space_seq(visibility)?))
}

struct ResolvedAbility {
    reference: AbilityRef,
    entrypoint: NoteRef,
    metadata: AbilityRevisionMetadata,
    name: String,
    provenance: AbilityResourceProvenance,
    entrypoint_matches_manifest: bool,
    promoted_from: Option<AbilityRef>,
}

async fn resolve(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    id: &AbilityId,
    exact: Option<&RevisionId>,
    live_ancestry: &mut crate::domain::common::FolderAncestryCache,
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
    let (note, current_digest) =
        note_metadata_with_digest(tx, auth, space, entrypoint.clone(), live_ancestry).await?;
    if note.facts.class != DocClass::Skill || note.facts.ability_package.as_ref() != Some(id) {
        return Err(DomainError::ResourceNotFound.into());
    }
    // Projects are root children. A descendant package belongs to that exact
    // project regardless of folder/path renames.
    let mut current_project = None;
    if let Some(folder) = note.facts.ancestor_folders.iter().rev().nth(1) {
        let is_project = match live_ancestry.is_project_cached(&space.space.id, folder) {
            Some(flag) => flag,
            None => {
                load_folder_head_row(tx, &space.space.id, folder)
                    .await?
                    .is_project
            }
        };
        if is_project {
            current_project = Some(folder.clone());
        }
    }
    let placement = proven_placement(space, current_project);
    if matches!(&placement,AbilityPlacement::OwnedPersonal(owner) if owner!=auth.principal()) {
        return Err(DomainError::ResourceNotFound.into());
    }
    let revision = match exact {
        Some(id) => id.clone(),
        None => RevisionId::parse(&tip)?,
    };
    let (meta, cutoff) = ability_manifest_tx(tx, &space.scope, id, &revision).await?;
    if meta.entrypoint_note_id != entrypoint.note_id || meta.ability_id != *id {
        return Err(DomainError::ResourceNotFound.into());
    }
    // The manifest, including the auxiliary filenames in a current descriptor,
    // still belongs to its publication snapshot after its entrypoint moves.
    let published = {
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
        let (facts, ancestry) =
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
        auth.can_view_resource(&facts)?;
        let placement = proven_placement(space, ancestry.project);
        if matches!(&placement, AbilityPlacement::OwnedPersonal(owner) if owner != auth.principal())
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        AbilityResourceLocation { placement, facts }
    };
    let name = if revision.as_str() == tip {
        current_name
    } else {
        meta.slug_fold.clone()
    };
    // A placement-only note revision leaves the published instructions intact.
    // A dirty carrier requires a package publication before runtime activation.
    let entrypoint_matches_manifest = current_digest.as_ref().is_some_and(|digest| {
        meta.resources
            .get(crate::domain::packages::ABILITY_ENTRYPOINT_KEY)
            == Some(digest)
    });
    let current = AbilityResourceLocation {
        placement: placement.clone(),
        facts: note.facts,
    };
    let promoted_from = meta.promoted_from.clone().or_else(|| {
        if let (AbilityPlacement::OwnedSpace(space), AbilityPlacement::OwnedProject(project)) =
            (&current.placement, &published.placement)
            && space == &project.space_id
        {
            Some(AbilityRef {
                id: id.clone(),
                revision: revision.clone(),
                placement: published.placement.clone(),
            })
        } else {
            None
        }
    });
    Ok(ResolvedAbility {
        name,
        reference: AbilityRef {
            id: id.clone(),
            placement,
            revision,
        },
        entrypoint,
        metadata: meta,
        provenance: AbilityResourceProvenance {
            current,
            published,
            promoted_from: promoted_from.clone(),
        },
        entrypoint_matches_manifest,
        promoted_from,
    })
}

fn proven_placement(space: &SpaceRecord, project: Option<FolderId>) -> AbilityPlacement {
    if let Some(folder_id) = project {
        AbilityPlacement::OwnedProject(FolderRef {
            space_id: space.space.id.clone(),
            folder_id,
        })
    } else if space.space.kind == SpaceKind::Personal {
        AbilityPlacement::OwnedPersonal(space.owner.clone())
    } else {
        AbilityPlacement::OwnedSpace(space.space.id.clone())
    }
}

async fn descriptor(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    id: &AbilityId,
    exact: Option<&RevisionId>,
) -> Result<AbilityDescriptor, PortError> {
    let mut live_ancestry = crate::domain::common::FolderAncestryCache::default();
    descriptor_with_cache(tx, auth, space, id, exact, &mut live_ancestry).await
}

async fn descriptor_with_cache(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    id: &AbilityId,
    exact: Option<&RevisionId>,
    live_ancestry: &mut crate::domain::common::FolderAncestryCache,
) -> Result<AbilityDescriptor, PortError> {
    let ResolvedAbility {
        reference,
        entrypoint,
        metadata: meta,
        name,
        entrypoint_matches_manifest,
        promoted_from,
        ..
    } = resolve(tx, auth, space, id, exact, live_ancestry).await?;
    Ok(AbilityDescriptor {
        reference,
        kind: meta.kind,
        name,
        description: meta.description,
        enabled: true,
        healthy: entrypoint_matches_manifest,
        lifecycle: meta.lifecycle,
        entrypoint: Some(entrypoint),
        auxiliary_files: meta
            .resources
            .into_keys()
            .filter(|p| p != crate::domain::packages::ABILITY_ENTRYPOINT_KEY)
            .collect(),
        attached_skills: meta.attached_skills,
        promoted_from,
        requires_explicit_binding: meta.requires_explicit_binding,
    })
}

pub(crate) async fn authorize_change_tx(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    id: &AbilityId,
    revision: &RevisionId,
) -> Result<(), PortError> {
    let mut live_ancestry = crate::domain::common::FolderAncestryCache::default();
    let package = resolve(tx, auth, space, id, Some(revision), &mut live_ancestry).await?;
    Ok(auth.authorize_read(&package.provenance.published.facts)?)
}

pub(crate) async fn resource_digest_tx(
    tx: &mut BackendConn<'_>,
    ctx: &SpaceContext,
    request: &ReadAbilityResource,
    key: &str,
) -> Result<(ContentDigest, AbilityResourceProvenance), PortError> {
    let space = load_space_record(tx, &ctx.scope().space_id).await?;
    space.scope.check(ctx.scope())?;
    let mut live_ancestry = crate::domain::common::FolderAncestryCache::default();
    let package = resolve(
        tx,
        ctx.auth(),
        &space,
        &request.ability,
        Some(&request.package_revision),
        &mut live_ancestry,
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
    ctx.auth()
        .authorize_read(&package.provenance.published.facts)?;
    Ok((digest, package.provenance))
}

pub(super) async fn egress_current(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: &AbilityResourceRef,
) -> Result<notarium_core::classes::ProviderCurrentContent, PortError> {
    let mut live_ancestry = crate::domain::common::FolderAncestryCache::default();
    let package = resolve(
        tx,
        auth,
        space,
        &reference.ability,
        None,
        &mut live_ancestry,
    )
    .await?;
    if package.reference.revision != reference.package_revision
        || package.metadata.lifecycle != Lifecycle::Active
        || !package.entrypoint_matches_manifest
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let key = match &reference.resource {
        AbilityResourceName::Entrypoint => crate::domain::packages::ABILITY_ENTRYPOINT_KEY,
        AbilityResourceName::Auxiliary(path) => path,
    };
    let digest = *package
        .metadata
        .resources
        .get(key)
        .ok_or(DomainError::ResourceNotFound)?;
    auth.authorize_read(&package.provenance.published.facts)?;
    Ok(notarium_core::classes::ProviderCurrentContent::Ability {
        reference: reference.clone(),
        digest,
        provenance: Box::new(package.provenance),
        lifecycle: package.metadata.lifecycle,
        promoted_from: package.promoted_from,
        requires_explicit_binding: package.metadata.requires_explicit_binding,
    })
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

struct SchedulePin {
    guard: Option<super::egress::CanonicalDisclosureGuard>,
    history: HistoryScope,
    abilities: Vec<AbilityDescriptor>,
}

impl ScheduleAbilityLease for SchedulePin {
    fn history(&self) -> &HistoryScope {
        &self.history
    }

    fn abilities(&self) -> &[AbilityDescriptor] {
        &self.abilities
    }

    fn close(&mut self) -> PortFuture<'_, ()> {
        let guard = self.guard.take();
        Box::pin(async move {
            if let Some(guard) = guard {
                guard.release_clean().await;
            }
            Ok(())
        })
    }
}

pub(super) async fn locate(
    store: &CanonicalStore,
    ctx: AccountContext,
    id: AbilityId,
) -> Result<Vec<AbilityDescriptor>, PortError> {
    let spaces: Vec<String> = ctx
        .auth()
        .spaces()
        .iter()
        .filter(|(_, grant)| !grant.read_classes.is_empty())
        .map(|(space_id, _)| space_id.as_str().to_owned())
        .collect();
    if spaces.is_empty() {
        return Ok(Vec::new());
    }
    let budget = ctx.budget.clone();
    store
        .with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                let matched: Vec<String> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let encoded = serde_json::to_string(&spaces).map_err(|err| {
                            crate::codec::internal_not_committed(
                                "encode_locate_ability_spaces",
                                err.to_string(),
                            )
                        })?;
                        sqlx::query_scalar(
                            "SELECT space_id FROM ability_packages
                             WHERE space_id IN (SELECT value FROM json_each($1))
                               AND ability_id = $2
                               AND lifecycle_state = 'active'
                             ORDER BY space_id",
                        )
                        .bind(encoded)
                        .bind(id.as_str())
                        .fetch_all(&mut **conn)
                        .await
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query_scalar(
                            "SELECT space_id FROM ability_packages
                             WHERE space_id = ANY($1)
                               AND ability_id = $2
                               AND lifecycle_state = 'active'
                             ORDER BY space_id COLLATE \"C\"",
                        )
                        .bind(&spaces)
                        .bind(id.as_str())
                        .fetch_all(&mut **conn)
                        .await
                    }
                }
                .map_err(|err| crate::runtime::pg_read_error("locate_ability", err))?;
                let mut found = Vec::new();
                for raw_space in matched {
                    let space_id = SpaceId::parse(&raw_space)?;
                    let space = match load_space_record(tx, &space_id).await {
                        Ok(rec) => rec,
                        Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                        Err(err) => return Err(err),
                    };
                    if space.space.lifecycle != SpaceLifecycle::Active {
                        continue;
                    }
                    match descriptor(tx, ctx.auth(), &space, &id, None).await {
                        Ok(desc) => {
                            found.push(desc);
                            if found.len() >= 200 {
                                break;
                            }
                        }
                        Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                        Err(err) => return Err(err),
                    }
                }
                Ok(found)
            })
        })
        .await
}

pub(super) async fn pin_schedule(
    store: &CanonicalStore,
    ctx: AccountContext,
    refs: Vec<AbilityRef>,
) -> Result<Box<dyn ScheduleAbilityLease>, PortError> {
    if ctx.auth().spaces().len() != 1 || refs.len() > MAX_ATTACHED_SKILLS + 1 {
        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
    }
    let (space, grant) = ctx
        .auth()
        .spaces()
        .iter()
        .next()
        .expect("one admitted space");
    let mut guard = store
        .pin_disclosure(
            &ctx.budget,
            &[space.clone()].into(),
            &ctx.budget.cancellation,
        )
        .await?;
    let pinned = async {
        let (history, abilities) = {
            let mut tx = guard.connection();
            let space = load_space_record(&mut tx, space).await?;
            if space.space.lifecycle != SpaceLifecycle::Active || grant.read_classes.is_empty() {
                return Err(DomainError::ResourceNotFound.into());
            }
            if let Some(project) = &grant.project_root {
                let reference = FolderRef {
                    space_id: space.space.id.clone(),
                    folder_id: project.clone(),
                };
                let (_, row) = folder_metadata(&mut tx, ctx.auth(), &space, reference).await?;
                if !row.is_project {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            let mut abilities = Vec::with_capacity(refs.len());
            let mut live_ancestry = crate::domain::common::FolderAncestryCache::default();
            for reference in refs {
                let current = descriptor_with_cache(
                    &mut tx,
                    ctx.auth(),
                    &space,
                    &reference.id,
                    None,
                    &mut live_ancestry,
                )
                .await?;
                if current.reference != reference {
                    return Err(DomainError::ResourceNotFound.into());
                }
                abilities.push(current);
            }
            (space.scope, abilities)
        };
        guard.check()?;
        Ok::<_, PortError>((history, abilities))
    }
    .await;
    let (history, abilities) = match pinned {
        Ok(pair) => pair,
        Err(error) => {
            guard.release_clean().await;
            return Err(error);
        }
    };
    guard.finish_snapshot().await;
    Ok(Box::new(SchedulePin {
        guard: Some(guard),
        history,
        abilities,
    }))
}

pub(super) async fn page(
    store: &CanonicalStore,
    ctx: AccountContext,
    query: AbilityQuery,
) -> Result<ControlPage<AbilityDescriptor>, PortError> {
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
                    let catalog_version: (i64, i64, i64, i64) = db!(
                        read tx,
                        sqlx::query_as(
                            "SELECT \
                                (SELECT COALESCE(MAX(updated_seq), 0) FROM ability_packages WHERE space_id = $1), \
                                (SELECT COUNT(*) FROM ability_packages WHERE space_id = $1), \
                                (SELECT COALESCE(MAX(nh.updated_seq), 0) \
                                 FROM ability_packages ap \
                                 JOIN note_heads nh ON nh.space_id = ap.space_id AND nh.note_id = ap.entrypoint_note_id \
                                 WHERE ap.space_id = $1), \
                                CASE WHEN EXISTS (SELECT 1 FROM ability_packages WHERE space_id = $1) \
                                     THEN (SELECT COALESCE(MAX(updated_seq), 0) FROM folder_heads WHERE space_id = $1) \
                                     ELSE 0 END"
                        ),
                        fetch_one,
                        space.space.id.as_str()
                    )?;
                    versions.push((
                        space.scope.clone(),
                        catalog_version,
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
                    let ids: Vec<(String, i64)> = match tx {
                        BackendConn::Sqlite(conn) => sqlx::query_as(LIST_PACKAGES_SQLITE)
                            .bind(rec.space.id.as_str())
                            .bind(&after_id)
                            .bind(query.kind.map_or("", crate::codec::ability_kind_to_db))
                            .bind(query.name.as_deref().unwrap_or(""))
                            .bind(remaining)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                crate::runtime::pg_read_error("list_ability_packages", err)
                            })?,
                        BackendConn::Postgres(conn) => sqlx::query_as(LIST_PACKAGES_PG)
                            .bind(rec.space.id.as_str())
                            .bind(&after_id)
                            .bind(query.kind.map_or("", crate::codec::ability_kind_to_db))
                            .bind(query.name.as_deref().unwrap_or(""))
                            .bind(remaining)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                crate::runtime::pg_read_error("list_ability_packages", err)
                            })?,
                    };
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
                let mut space_caches: Vec<crate::domain::common::FolderAncestryCache> = (0..live
                    .len())
                    .map(|_| crate::domain::common::FolderAncestryCache::default())
                    .collect();
                for (index, id, _) in keys {
                    match descriptor_with_cache(
                        tx,
                        ctx.auth(),
                        &live[index],
                        &id,
                        None,
                        &mut space_caches[index],
                    )
                    .await
                    {
                        Ok(value) => {
                            let visible = (query.authoring && query.project.is_none())
                                || match &value.reference.placement {
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
