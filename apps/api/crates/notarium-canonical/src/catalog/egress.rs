//! Pins the canonical source snapshot through provider admission and dispatch.
use std::collections::{BTreeMap, BTreeSet};

use notarium_core::classes::{
    CanonicalMetadataContent, ClassEgressFence, ClassifiedMetadata, ProviderCurrentContent,
    ProviderOrigin,
};
use tokio::{sync::OwnedMutexGuard, time::Instant};

use super::*;
use crate::{
    codec::{
        RevisionMetadataEnvelope, RevisionMetadataPayload, cancelled_not_committed,
        deadline_not_committed, i64_to_space_seq,
    },
    dialect::postgres::StorePgConnection,
    domain::common::FolderAncestryCache,
    runtime::{SqlDriverState, pg_read_error},
    sqlite_fast::SqliteWriterPair,
};

enum DisclosureConnection {
    Sqlite(OwnedMutexGuard<Option<SqliteWriterPair>>),
    Postgres(StorePgConnection),
}

pub(crate) struct CanonicalDisclosureGuard {
    connection: DisclosureConnection,
    deadline: Instant,
    cancellation: Cancellation,
}

impl CanonicalDisclosureGuard {
    pub(crate) fn connection(&mut self) -> BackendConn<'_> {
        match &mut self.connection {
            DisclosureConnection::Sqlite(writer) => BackendConn::Sqlite(
                &mut writer.as_mut().expect("pinned canonical writer").sqlx_conn,
            ),
            DisclosureConnection::Postgres(conn) => BackendConn::Postgres(conn),
        }
    }

    pub(crate) fn check(&self) -> notarium_core::DomainResult<()> {
        if self.cancellation.is_cancelled() || Instant::now() >= self.deadline {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded));
        }
        Ok(())
    }
}

fn expired() -> PortError {
    deadline_not_committed("canonical_disclosure", "canonical disclosure deadline")
}

fn cancelled() -> PortError {
    cancelled_not_committed("canonical_disclosure", "canonical disclosure cancelled")
}

impl CanonicalStore {
    pub(crate) async fn pin_disclosure(
        &self,
        budget: &CallBudget,
        spaces: &BTreeSet<SpaceId>,
        cancellation: &Cancellation,
    ) -> Result<CanonicalDisclosureGuard, PortError> {
        self.ensure_open()?;
        let deadline = Instant::now() + budget.remaining;
        let acquire = async {
            let connection = match &self.inner.sql {
                SqlDriverState::Sqlite { writer, .. } => {
                    // All SQLite canonical writes share this connection pair.
                    let writer = writer.clone().lock_owned().await;
                    if writer.is_none() {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    DisclosureConnection::Sqlite(writer)
                }
                SqlDriverState::Postgres { pool, .. } => {
                    let mut conn = pool
                        .acquire()
                        .await
                        .map_err(|e| pg_read_error("egress_acquire", e))?;
                    // A canceled acquisition may leave a partially opened transaction.
                    // Discarding the dedicated connection releases its locks in all paths.
                    conn.close_on_drop();
                    sqlx::raw_sql("BEGIN; SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema(), 7311229))")
                        .execute(&mut *conn)
                        .await
                        .map_err(|e| pg_read_error("egress_begin", e))?;
                    for space in spaces {
                        sqlx::query_scalar::<_, String>(
                            "SELECT space_id FROM spaces WHERE space_id=$1 FOR SHARE",
                        )
                        .bind(space.as_str())
                        .fetch_optional(&mut *conn)
                        .await
                        .map_err(|e| pg_read_error("egress_lock_space", e))?
                        .ok_or(DomainError::ResourceNotFound)?;
                    }
                    DisclosureConnection::Postgres(conn)
                }
            };
            Ok(CanonicalDisclosureGuard {
                connection,
                deadline,
                cancellation: cancellation.clone(),
            })
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cancelled()),
            _ = budget.cancellation.cancelled() => Err(cancelled()),
            _ = tokio::time::sleep_until(deadline) => Err(expired()),
            result = acquire => result,
        }
    }
}

struct EgressLease {
    guard: Option<CanonicalDisclosureGuard>,
    cancellation: Cancellation,
    current: Vec<ProviderCurrentContent>,
    project: Option<FolderRef>,
    secondary_projects: Vec<FolderRef>,
}

impl ProviderEgressLease for EgressLease {
    fn current(&self) -> &[ProviderCurrentContent] {
        &self.current
    }

    fn project(&self) -> Option<&FolderRef> {
        self.project.as_ref()
    }

    fn secondary_projects(&self) -> &[FolderRef] {
        &self.secondary_projects
    }

    fn mark_dispatched(&mut self) {
        drop(self.guard.take());
    }

    fn check(&self) -> notarium_core::DomainResult<()> {
        if self.cancellation.is_cancelled() {
            return Err(DomainError::AccessDenied);
        }
        self.guard
            .as_ref()
            .map_or(Ok(()), CanonicalDisclosureGuard::check)
    }
}

impl ProviderEgressCatalogPort for CanonicalStore {
    fn acquire_egress(
        &self,
        ctx: AccountContext,
        request: ProviderEgressRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>> {
        Box::pin(async move {
            if request.origins.len() > MAX_PROVIDER_ORIGINS
                || request.secondary_projects.len() > MAX_PROVIDER_SECONDARY_PROJECTS
            {
                return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
            }
            let spaces = request
                .origins
                .iter()
                .map(|origin| {
                    origin
                        .space_id()
                        .cloned()
                        .ok_or(DomainError::ResourceNotFound)
                })
                .chain(std::iter::once(Ok(request.primary.space_id.clone())))
                .collect::<Result<BTreeSet<_>, _>>()?;
            if spaces.len() > MAX_PROVIDER_SOURCE_SPACES {
                return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
            }
            if spaces
                .iter()
                .any(|space| !ctx.auth().spaces().contains_key(space))
            {
                return Err(DomainError::ResourceNotFound.into());
            }
            if request
                .project
                .as_ref()
                .is_some_and(|project| project.space_id != request.primary.space_id)
                || request.secondary_projects.iter().any(|project| {
                    project.space_id == request.primary.space_id
                        || !spaces.contains(&project.space_id)
                })
            {
                return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
            }

            let mut guard = self
                .pin_disclosure(&ctx.budget, &spaces, &cancellation)
                .await?;
            let deadline = guard.deadline;
            let mut connection = guard.connection();
            let current = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(cancelled()),
                _ = ctx.budget.cancellation.cancelled() => return Err(cancelled()),
                _ = tokio::time::sleep_until(deadline) => return Err(expired()),
                rows = snapshot(&mut connection, &ctx, &request, spaces) => rows?,
            };
            Ok(Box::new(EgressLease {
                guard: Some(guard),
                cancellation,
                current,
                project: request.project,
                secondary_projects: request.secondary_projects,
            }) as Box<dyn ProviderEgressLease>)
        })
    }
}

async fn snapshot(
    tx: &mut BackendConn<'_>,
    ctx: &AccountContext,
    request: &ProviderEgressRequest,
    spaces: BTreeSet<SpaceId>,
) -> Result<Vec<ProviderCurrentContent>, PortError> {
    let mut records = BTreeMap::new();
    for id in spaces {
        let space = load_space_record(tx, &id).await?;
        if space.space.lifecycle != SpaceLifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        records.insert(id, space);
    }
    records
        .get(&request.primary.space_id)
        .ok_or(DomainError::ResourceNotFound)?
        .scope
        .check(&request.primary)?;
    for project in request.project.iter().chain(&request.secondary_projects) {
        let record = records
            .get(&project.space_id)
            .ok_or(DomainError::ResourceNotFound)?;
        let (_, row) = folder_metadata(tx, ctx.auth(), record, project.clone()).await?;
        if !row.is_project {
            return Err(DomainError::ResourceNotFound.into());
        }
    }

    let mut result = Vec::with_capacity(request.origins.len());
    for origin in &request.origins {
        let record = records
            .get(origin.space_id().ok_or(DomainError::ResourceNotFound)?)
            .ok_or(DomainError::ResourceNotFound)?;
        let current = match origin {
            ProviderOrigin::Note {
                reference,
                revision,
                ..
            } => note_current(tx, ctx.auth(), record, reference, revision).await?,
            ProviderOrigin::Ability { reference, .. } => {
                abilities::egress_current(tx, ctx.auth(), record, reference).await?
            }
            ProviderOrigin::Chat { thread, entry, .. } => {
                crate::chats::load_current_chat_for_egress_tx(
                    tx,
                    ctx.auth(),
                    record,
                    thread,
                    *entry,
                )
                .await?
            }
            ProviderOrigin::Folder { reference, .. } => {
                folder_content(tx, ctx.auth(), record, reference.clone())
                    .await?
                    .current()
                    .clone()
            }
            ProviderOrigin::Space { .. } => space_content(ctx.auth(), record)?.current().clone(),
            ProviderOrigin::SystemAbility { .. } => {
                return Err(DomainError::ResourceNotFound.into());
            }
        };
        if &current.origin() != origin {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
        result.push(current);
    }
    Ok(result)
}

async fn note_current(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: &NoteRef,
    revision: &RevisionId,
) -> Result<ProviderCurrentContent, PortError> {
    let live = note_metadata(tx, auth, space, reference.clone()).await?;
    let (raw_metadata, visible): (Vec<u8>, i64) = db!(
        read tx,
        sqlx::query_as(
            "SELECT metadata_msgpack, visibility_seq FROM revisions
            WHERE space_id=$1 AND rev_id=$2 AND history_incarnation=$3
            AND entity_type='note' AND entity_key=$4"
        ),
        fetch_optional,
        space.space.id.as_str(),
        revision.as_str(),
        space.scope.incarnation.as_bytes().as_slice(),
        reference.note_id.as_str(),
    )?
    .ok_or(DomainError::ResourceNotFound)?;
    let RevisionMetadataPayload::Note(snapshot) =
        RevisionMetadataEnvelope::decode(&raw_metadata)?.payload
    else {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    };
    let digest = snapshot
        .content_digest
        .ok_or(DomainError::ResourceNotFound)?;
    let visibility = i64_to_space_seq(visible)?;
    let (recorded, _) = FolderAncestryCache::at_cut(&space.scope, visibility)
        .build_resource_facts_tx(
            tx,
            &space.space,
            &snapshot.parent_folder_id,
            snapshot.doc_class,
            snapshot.ability_id,
            true,
        )
        .await?;
    let mut metadata = ClassifiedMetadata::from_canonical(
        reference.clone(),
        revision.clone(),
        recorded,
        snapshot.lifecycle,
        digest,
    )?;
    metadata.bind_current(live.facts, live.lifecycle)?;
    ClassEgressFence::search_metadata(metadata.clone(), auth)?;
    Ok(ProviderCurrentContent::Note(metadata))
}

pub(super) async fn metadata(
    store: &CanonicalStore,
    ctx: AccountContext,
    source: CatalogDisclosure,
) -> Result<CanonicalMetadataContent, PortError> {
    let budget = ctx.budget.clone();
    store
        .with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                match source {
                    CatalogDisclosure::Folder(reference) => {
                        let space = load_space_record(tx, &reference.space_id).await?;
                        folder_content(tx, ctx.auth(), &space, reference).await
                    }
                    CatalogDisclosure::Space(scope) => {
                        let space = load_space_record(tx, &scope.space_id).await?;
                        space.scope.check(&scope)?;
                        space_content(ctx.auth(), &space)
                    }
                }
            })
        })
        .await
}

async fn folder_content(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: FolderRef,
) -> Result<CanonicalMetadataContent, PortError> {
    if reference.space_id != space.space.id {
        return Err(DomainError::ResourceNotFound.into());
    }
    let row = load_folder_head_row(tx, &reference.space_id, &reference.folder_id).await?;
    let ancestry =
        load_folder_ancestry_tx(tx, &reference.space_id, &reference.folder_id, true).await?;
    auth.authorize_folder_read(&space.space, &reference.folder_id, &ancestry.ancestors)?;
    let text = serde_json::json!({
        "id": reference.folder_id,
        "name": row.display_name,
        "path": ancestry.folder_path,
        "parent": row.parent_folder_id,
        "project": ancestry.project,
        "projectSlug": row.project_slug,
        "spaceSlug": space.slug,
    })
    .to_string();
    let current = ProviderCurrentContent::Folder {
        history: space.scope.clone(),
        reference,
        revision: row.head_rev_id,
        digest: ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes()),
        space: space.space.clone(),
        lifecycle: row.lifecycle,
        ancestor_folders: ancestry.ancestors,
    };
    Ok(CanonicalMetadataContent::from_canonical(current, text)?)
}

fn space_content(
    auth: &EngineAuthContext,
    space: &SpaceRecord,
) -> Result<CanonicalMetadataContent, PortError> {
    auth.authorize_folder_read(&space.space, &space.root_folder_id, &[])?;
    let text = serde_json::json!({
        "id": space.space.id,
        "slug": space.slug,
        "kind": space.space.kind,
    })
    .to_string();
    let current = ProviderCurrentContent::Space {
        history: space.scope.clone(),
        digest: ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes()),
        space: space.space.clone(),
        root: space.root_folder_id.clone(),
    };
    Ok(CanonicalMetadataContent::from_canonical(current, text)?)
}
