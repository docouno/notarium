//! Pins the canonical source snapshot through provider admission and dispatch.
use std::collections::{BTreeMap, BTreeSet};

use notarium_core::classes::{
    CanonicalMetadataContent, ClassEgressFence, ClassifiedMetadata, ProviderCurrentContent,
    ProviderOrigin,
};
use tokio::time::Instant;

use super::*;
use crate::{
    chats::ProofFoldCache,
    codec::{
        RevisionMetadataEnvelope, RevisionMetadataPayload, cancelled_not_committed,
        deadline_not_committed, i64_to_space_seq,
    },
    dialect::postgres::StorePgConnection,
    domain::common::FolderAncestryCache,
    runtime::{SqlDriverState, pg_read_error},
};

const ROLLBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

trait CloseOnDropConn {
    fn close_conn_on_drop(&mut self);
}

impl CloseOnDropConn for StorePgConnection {
    fn close_conn_on_drop(&mut self) {
        self.close_on_drop();
    }
}

impl CloseOnDropConn for sqlx::pool::PoolConnection<sqlx::Sqlite> {
    fn close_conn_on_drop(&mut self) {
        self.close_on_drop();
    }
}

struct CloseOnAbort<C: CloseOnDropConn>(Option<C>);

impl<C: CloseOnDropConn> CloseOnAbort<C> {
    fn new(conn: C) -> Self {
        Self(Some(conn))
    }

    fn as_mut(&mut self) -> &mut C {
        self.0.as_mut().expect("active database connection")
    }

    fn disarm(mut self) -> C {
        self.0.take().expect("active database connection")
    }
}

impl<C: CloseOnDropConn> Drop for CloseOnAbort<C> {
    fn drop(&mut self) {
        if let Some(mut conn) = self.0.take() {
            conn.close_conn_on_drop();
        }
    }
}

async fn rollback_sqlite_clean(conn: sqlx::pool::PoolConnection<sqlx::Sqlite>) {
    let mut guarded = CloseOnAbort::new(conn);
    if matches!(
        tokio::time::timeout(
            ROLLBACK_TIMEOUT,
            sqlx::raw_sql("ROLLBACK").execute(&mut **guarded.as_mut()),
        )
        .await,
        Ok(Ok(_))
    ) {
        drop(guarded.disarm());
    }
}

async fn rollback_pg_clean(conn: StorePgConnection) {
    let mut guarded = CloseOnAbort::new(conn);
    if matches!(
        tokio::time::timeout(
            ROLLBACK_TIMEOUT,
            sqlx::raw_sql("ROLLBACK").execute(&mut **guarded.as_mut()),
        )
        .await,
        Ok(Ok(_))
    ) {
        drop(guarded.disarm());
    }
}

enum DisclosureConnection {
    Sqlite {
        snapshot: Option<sqlx::pool::PoolConnection<sqlx::Sqlite>>,
        wal_guard: Option<crate::wal::ReaderGateGuard>,
        _pin: crate::runtime::disclosure::DisclosurePin,
    },
    Postgres(Option<StorePgConnection>),
}

pub(crate) struct CanonicalDisclosureGuard {
    connection: DisclosureConnection,
    deadline: Instant,
    snapshot_deadline: Instant,
    cancellation: Cancellation,
}

impl Drop for CanonicalDisclosureGuard {
    fn drop(&mut self) {
        match &mut self.connection {
            DisclosureConnection::Sqlite {
                snapshot,
                wal_guard,
                ..
            } => {
                if let Some(mut conn) = snapshot.take() {
                    conn.close_on_drop();
                }
                let _ = wal_guard.take();
            }
            DisclosureConnection::Postgres(conn) => {
                if let Some(mut conn) = conn.take() {
                    conn.close_on_drop();
                }
            }
        }
    }
}

impl CanonicalDisclosureGuard {
    pub(crate) fn connection(&mut self) -> BackendConn<'_> {
        match &mut self.connection {
            DisclosureConnection::Sqlite { snapshot, .. } => {
                BackendConn::Sqlite(snapshot.as_mut().expect("open SQLite disclosure snapshot"))
            }
            DisclosureConnection::Postgres(conn) => {
                BackendConn::Postgres(conn.as_mut().expect("open PostgreSQL disclosure snapshot"))
            }
        }
    }

    pub(super) async fn finish_snapshot(&mut self) {
        match &mut self.connection {
            DisclosureConnection::Sqlite {
                snapshot,
                wal_guard,
                ..
            } => {
                if let Some(conn) = snapshot.take() {
                    rollback_sqlite_clean(conn).await;
                }
                if let Some(guard) = wal_guard.take() {
                    guard.finish_cleanly();
                }
            }
            DisclosureConnection::Postgres(conn) => {
                // Return the PostgreSQL connection to the pool immediately after snapshot
                // verification; never hold a PG transaction across Control TXs or LLM I/O.
                if let Some(conn) = conn.take() {
                    rollback_pg_clean(conn).await;
                }
            }
        }
    }

    pub(super) async fn release_clean(mut self) {
        match &mut self.connection {
            DisclosureConnection::Sqlite {
                snapshot,
                wal_guard,
                ..
            } => {
                if let Some(conn) = snapshot.take() {
                    rollback_sqlite_clean(conn).await;
                }
                if let Some(guard) = wal_guard.take() {
                    guard.finish_cleanly();
                }
            }
            DisclosureConnection::Postgres(conn) => {
                if let Some(conn) = conn.take() {
                    rollback_pg_clean(conn).await;
                }
            }
        }
    }

    pub(crate) fn check(&self) -> notarium_core::DomainResult<()> {
        if self.cancellation.is_cancelled() || Instant::now() >= self.deadline {
            return Err(DomainError::validation(ValidationReason::BudgetExceeded));
        }
        Ok(())
    }

    pub(super) fn snapshot_deadline(&self) -> Instant {
        self.snapshot_deadline
    }
}

pub(super) fn expired() -> PortError {
    deadline_not_committed("canonical_disclosure", "canonical disclosure deadline")
}

pub(super) fn cancelled() -> PortError {
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
        let deadline = Instant::now()
            .checked_add(budget.remaining)
            .unwrap_or_else(|| Instant::now() + std::time::Duration::from_secs(365 * 24 * 3600));
        let acquire = async {
            let (connection, snapshot_deadline) = match &self.inner.sql {
                SqlDriverState::Sqlite {
                    read_pool,
                    disclosures,
                    ..
                } => {
                    let pin = disclosures.pin(spaces).await;
                    self.ensure_open()?;
                    let (wal_guard, snapshot_deadline) =
                        if let Some(wal) = self.inner.wal_coord.get() {
                            let (guard, read_deadline) =
                                wal.acquire_reader_gate_slot(Some(budget)).await?;
                            (Some(guard), deadline.min(read_deadline))
                        } else {
                            (None, deadline)
                        };
                    let conn = read_pool
                        .acquire()
                        .await
                        .map_err(|e| internal_not_committed("egress_acquire", e.to_string()))?;
                    let mut guarded = CloseOnAbort::new(conn);
                    sqlx::raw_sql("BEGIN DEFERRED")
                        .execute(&mut **guarded.as_mut())
                        .await
                        .map_err(|e| internal_not_committed("egress_begin", e.to_string()))?;
                    (
                        DisclosureConnection::Sqlite {
                            snapshot: Some(guarded.disarm()),
                            wal_guard,
                            _pin: pin,
                        },
                        snapshot_deadline,
                    )
                }
                SqlDriverState::Postgres { pool, .. } => {
                    let conn = pool
                        .acquire()
                        .await
                        .map_err(|e| pg_read_error("egress_acquire", e))?;
                    // Short read-only repeatable-read snapshot (no FOR SHARE / advisory locks);
                    // released back to the pool in `finish_snapshot` before Control TXs or LLM I/O.
                    let mut guarded = CloseOnAbort::new(conn);
                    sqlx::raw_sql("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                        .execute(&mut **guarded.as_mut())
                        .await
                        .map_err(|e| pg_read_error("egress_begin", e))?;
                    if !spaces.is_empty() {
                        let space_ids: Vec<&str> = spaces.iter().map(SpaceId::as_str).collect();
                        let found: i64 = sqlx::query_scalar(
                            "SELECT COUNT(*) FROM spaces WHERE space_id = ANY($1)",
                        )
                        .bind(&space_ids)
                        .fetch_one(&mut **guarded.as_mut())
                        .await
                        .map_err(|e| pg_read_error("egress_check_spaces", e))?;
                        if found as usize != space_ids.len() {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                    }
                    (
                        DisclosureConnection::Postgres(Some(guarded.disarm())),
                        deadline,
                    )
                }
            };
            Ok(CanonicalDisclosureGuard {
                connection,
                deadline,
                snapshot_deadline,
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
    project_folders: BTreeSet<FolderId>,
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

    fn project_folders(&self) -> &BTreeSet<FolderId> {
        &self.project_folders
    }

    fn mark_dispatched(&mut self) -> PortFuture<'_, ()> {
        let guard = self.guard.take();
        Box::pin(async move {
            if let Some(guard) = guard {
                guard.release_clean().await;
            }
            Ok(())
        })
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
    fn chat_dependencies(
        &self,
        ctx: AccountContext,
        roots: Vec<ProviderOrigin>,
    ) -> PortFuture<'_, ProviderEgressDependencies> {
        Box::pin(async move {
            if roots.len() > MAX_PROVIDER_ORIGINS {
                return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
            }
            discover_chat_dependencies(self, &ctx, roots).await
        })
    }

    fn acquire_egress(
        &self,
        ctx: AccountContext,
        request: ProviderEgressRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>> {
        Box::pin(async move {
            if request.origins.len() > MAX_PROVIDER_ORIGINS
                || request.secondary_projects.len() > MAX_PROVIDER_SECONDARY_PROJECTS
                || request.project_folders.len() > MAX_PROVIDER_ORIGINS
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
            let deadline = guard.snapshot_deadline;
            let current = {
                let mut connection = guard.connection();
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(cancelled()),
                    _ = ctx.budget.cancellation.cancelled() => Err(cancelled()),
                    _ = tokio::time::sleep_until(deadline) => Err(expired()),
                    rows = snapshot(&mut connection, &ctx, &request, spaces) => rows,
                }
            };
            let current = match current {
                Ok(current) => current,
                Err(error) => {
                    guard.release_clean().await;
                    return Err(error);
                }
            };
            guard.finish_snapshot().await;
            Ok(Box::new(EgressLease {
                guard: Some(guard),
                cancellation,
                current,
                project: request.project,
                secondary_projects: request.secondary_projects,
                project_folders: request.project_folders,
            }) as Box<dyn ProviderEgressLease>)
        })
    }
}

// Discovery identifies graph keys. The egress lease revalidates them after
// acquiring all participating Space locks. No authority is derived here.
async fn discover_chat_dependencies(
    store: &CanonicalStore,
    ctx: &AccountContext,
    roots: Vec<ProviderOrigin>,
) -> Result<ProviderEgressDependencies, PortError> {
    let mut work = Vec::new();
    let mut seen = BTreeSet::new();
    let mut spaces = BTreeSet::new();
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "chat_dependencies");
    let mut projects = BTreeMap::new();
    for root in roots {
        if !matches!(root, ProviderOrigin::Chat { .. }) {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
        if seen.insert(origin_key(&root)?) {
            work.push(root);
        }
    }
    let mut origins = Vec::new();
    let mut proof_memo = ProofFoldCache::new();
    while !work.is_empty() {
        let batch = work.split_off(work.len().saturating_sub(16));
        let auth = ctx.auth().clone();
        let mut budget = ctx.budget.clone();
        budget.remaining = deadline.remaining(&ctx.budget)?;
        let sources = store
            .with_read_tx_budget(Some(&budget), move |tx| {
                Box::pin(async move {
                    let mut records = BTreeMap::new();
                    let mut sources = Vec::with_capacity(batch.len());
                    for origin in batch {
                        let ProviderOrigin::Chat {
                            space,
                            thread,
                            entry,
                            ..
                        } = &origin
                        else {
                            return Err(
                                DomainError::validation(ValidationReason::SourceMismatch).into()
                            );
                        };
                        if !auth.spaces().contains_key(space) {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let record = match records.entry(space.clone()) {
                            std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                            std::collections::btree_map::Entry::Vacant(entry) => {
                                entry.insert(load_space_record(tx, space).await?)
                            }
                        };
                        let source =
                            crate::chats::chat_source_tx(tx, &auth, record, thread, *entry).await?;
                        sources.push((origin, source));
                    }
                    Ok(sources)
                })
            })
            .await?;
        for (origin, source) in sources {
            let ProviderOrigin::Chat {
                space,
                thread,
                entry,
                ..
            } = &origin
            else {
                unreachable!()
            };
            spaces.insert(space.clone());
            if spaces.len() > MAX_PROVIDER_SOURCE_SPACES {
                return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
            }
            let current = source
                .discover(store, ctx.auth(), &ctx.budget, deadline, &mut proof_memo)
                .await?;
            if current.origin() != origin {
                return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
            }
            let Some(proof) = current.provenance() else {
                continue;
            };
            for project in &proof.projects {
                projects.insert(
                    (project.space_id.clone(), project.folder_id.clone()),
                    project.clone(),
                );
                // A recorded proof may also name the primary project.
                if projects.len() > MAX_PROVIDER_SECONDARY_PROJECTS + 1 {
                    return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
                }
            }
            for dependency in &proof.origins {
                if let ProviderOrigin::Chat {
                    space: child_space,
                    thread: child_thread,
                    entry: child_entry,
                    ..
                } = dependency
                    && (child_space != space || child_thread != thread || child_entry >= entry)
                {
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }
                if let Some(id) = dependency.space_id() {
                    spaces.insert(id.clone());
                    if spaces.len() > MAX_PROVIDER_SOURCE_SPACES {
                        return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
                    }
                }
                if seen.insert(origin_key(dependency)?) {
                    if seen.len() > MAX_PROVIDER_ORIGINS {
                        return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
                    }
                    origins.push(dependency.clone());
                    if matches!(dependency, ProviderOrigin::Chat { .. }) {
                        work.push(dependency.clone());
                    }
                }
            }
        }
    }
    deadline.remaining(&ctx.budget)?;
    Ok(ProviderEgressDependencies {
        origins,
        projects: projects.into_values().collect(),
    })
}

fn origin_key(origin: &ProviderOrigin) -> Result<String, PortError> {
    serde_json::to_string(origin)
        .map_err(|_| DomainError::validation(ValidationReason::InvalidState).into())
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

    let mut live_ancestry = FolderAncestryCache::default();
    let mut historical_ancestry = crate::domain::common::HistoricalFolderCache::default();
    let mut proof_memo = ProofFoldCache::new();

    if !request.project_folders.is_empty() {
        let project = request.project.as_ref().ok_or(DomainError::AccessDenied)?;
        let record = records
            .get(&project.space_id)
            .ok_or(DomainError::ResourceNotFound)?;
        for folder in &request.project_folders {
            let facts = live_ancestry
                .load_ancestry_tx(tx, &project.space_id, folder, true)
                .await?;
            ctx.auth()
                .can_view_folder(&record.space, folder, &facts.ancestors)?;
            if !facts.ancestors.contains(&project.folder_id) {
                return Err(DomainError::AccessDenied.into());
            }
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
            } => {
                note_current(
                    tx,
                    ctx.auth(),
                    record,
                    reference,
                    revision,
                    &mut live_ancestry,
                    &mut historical_ancestry,
                )
                .await?
            }
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
                    &mut proof_memo,
                )
                .await?
            }
            ProviderOrigin::Folder { reference, .. } => folder_content(
                tx,
                ctx.auth(),
                record,
                reference.clone(),
                &mut live_ancestry,
            )
            .await?
            .current()
            .clone(),
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
    live_ancestry: &mut FolderAncestryCache,
    historical_ancestry: &mut crate::domain::common::HistoricalFolderCache,
) -> Result<ProviderCurrentContent, PortError> {
    if !auth.spaces().contains_key(&reference.space_id) || reference.space_id != space.space.id {
        return Err(DomainError::ResourceNotFound.into());
    }
    if crate::runtime::is_note_purge_fenced_tx(tx, &reference.space_id, reference.note_id.as_str())
        .await?
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let live_row = load_note_head_row_tx(tx, &reference.space_id, &reference.note_id).await?;
    if live_row.lifecycle != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let (live_facts, _) = live_ancestry
        .build_resource_facts_tx(
            tx,
            &space.space,
            &live_row.parent_folder_id,
            live_row.doc_class,
            live_row.ability_id,
            true,
        )
        .await?;
    auth.can_view_resource(&live_facts)?;
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
    let (recorded, _) = historical_ancestry
        .build_resource_facts_at_cut_tx(
            tx,
            &space.scope,
            &space.space,
            visibility,
            live_ancestry,
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
    metadata.bind_current(live_facts, live_row.lifecycle)?;
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
                        let mut ancestry = FolderAncestryCache::default();
                        folder_content(tx, ctx.auth(), &space, reference, &mut ancestry).await
                    }
                    CatalogDisclosure::Space(scope) => {
                        if !ctx.auth().spaces().contains_key(&scope.space_id) {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let space = load_space_record(tx, &scope.space_id).await?;
                        space.scope.check(&scope)?;
                        space_content(ctx.auth(), &space)
                    }
                }
            })
        })
        .await
}

pub(super) async fn folder_disclosures(
    store: &CanonicalStore,
    ctx: AccountContext,
    folders: Vec<FolderRef>,
) -> Result<Vec<CanonicalMetadataContent>, PortError> {
    if folders.is_empty() {
        return Ok(Vec::new());
    }
    let budget = ctx.budget.clone();
    store
        .with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                let mut spaces = std::collections::BTreeMap::<SpaceId, SpaceRecord>::new();
                let mut ancestry = FolderAncestryCache::default();
                let mut out = Vec::with_capacity(folders.len());
                for reference in folders {
                    if !ctx.auth().spaces().contains_key(&reference.space_id) {
                        continue;
                    }
                    let space = if let Some(cached) = spaces.get(&reference.space_id) {
                        cached
                    } else {
                        match load_space_record(tx, &reference.space_id).await {
                            Ok(record) => {
                                spaces.insert(reference.space_id.clone(), record);
                                spaces.get(&reference.space_id).expect("inserted space")
                            }
                            Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                            Err(error) => return Err(error),
                        }
                    };
                    match folder_content(tx, ctx.auth(), space, reference, &mut ancestry).await {
                        Ok(proof) => out.push(proof),
                        Err(PortError::Domain(
                            DomainError::ResourceNotFound | DomainError::AccessDenied,
                        )) => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(out)
            })
        })
        .await
}

async fn folder_content(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    reference: FolderRef,
    ancestry_cache: &mut FolderAncestryCache,
) -> Result<CanonicalMetadataContent, PortError> {
    if reference.space_id != space.space.id {
        return Err(DomainError::ResourceNotFound.into());
    }
    let row = load_folder_head_row(tx, &reference.space_id, &reference.folder_id).await?;
    ancestry_cache.insert_preloaded_row(space.space.id.clone(), row.clone());
    let ancestry = ancestry_cache
        .load_ancestry_tx(tx, &reference.space_id, &reference.folder_id, true)
        .await?;
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
