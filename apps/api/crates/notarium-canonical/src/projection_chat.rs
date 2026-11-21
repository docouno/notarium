//! Bounded canonical chat reads backed by normalized `chat_entry_note_refs`.
use crate::{
    CanonicalStore, ProjectionRedactedEntry,
    changes::list_thread_keys_at_or_below_cutoff_tx,
    codec::{RevisionMetadataEnvelope, RevisionMetadataPayload, internal_not_committed},
    projection_read::ProjectionPage,
    runtime::{
        is_note_purge_fenced_tx, pg_read_error, purge_fenced_note_ids_tx,
        read_immutable_revision_tx, validate_snapshot_cutoff_tx,
    },
    sql_exec::BackendConn,
};
use notarium_core::{
    DomainError, DomainResult,
    error::{PortError, ValidationReason},
    ids::{
        ChatThreadId, HistoryIncarnation, NoteId, RevisionId, SpaceId, SpaceSeq, ThreadEntrySeq,
    },
    model::{HistoryScope, NoteRef},
    ports::{ChatThread, MaintenanceContext, PageLimit},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const REF_INSERT_CHUNK: usize = 100;

macro_rules! chat_fetch_all {
    ($tx:expr, $sql:expr $(, $bind:expr)* $(,)?) => {{
        match $tx {
            BackendConn::Sqlite(conn) => sqlx::query_as($sql)
                $(.bind($bind))*
                .fetch_all(&mut **conn)
                .await
                .map_err(sqlite_read_error)?,
            BackendConn::Postgres(conn) => sqlx::query_as($sql)
                $(.bind($bind))*
                .fetch_all(&mut **conn)
                .await
                .map_err(pg_chat_read_error)?,
        }
    }};
}

macro_rules! chat_fetch_optional {
    ($tx:expr, $sql:expr $(, $bind:expr)* $(,)?) => {{
        match $tx {
            BackendConn::Sqlite(conn) => sqlx::query_as($sql)
                $(.bind($bind))*
                .fetch_optional(&mut **conn)
                .await
                .map_err(sqlite_read_error)?,
            BackendConn::Postgres(conn) => sqlx::query_as($sql)
                $(.bind($bind))*
                .fetch_optional(&mut **conn)
                .await
                .map_err(pg_chat_read_error)?,
        }
    }};
}

macro_rules! chat_fetch_scalar {
    ($tx:expr, $sql:expr $(, $bind:expr)* $(,)?) => {{
        match $tx {
            BackendConn::Sqlite(conn) => sqlx::query_scalar($sql)
                $(.bind($bind))*
                .fetch_one(&mut **conn)
                .await
                .map_err(sqlite_read_error)?,
            BackendConn::Postgres(conn) => sqlx::query_scalar($sql)
                $(.bind($bind))*
                .fetch_one(&mut **conn)
                .await
                .map_err(pg_chat_read_error)?,
        }
    }};
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionChatHead {
    pub thread: ChatThread,
    pub title: String,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct ProjectionChatEntryKey {
    pub thread: ChatThreadId,
    pub seq: ThreadEntrySeq,
}

/// Identifies one exact canonical chat reference occurrence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectionChatRefLocator {
    pub source: HistoryScope,
    pub entry: ProjectionChatEntryKey,
    pub revision: RevisionId,
    pub ref_ordinal: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectionChatRef {
    pub locator: ProjectionChatRefLocator,
    pub target: NoteRef,
    pub target_scope: HistoryScope,
}

#[derive(Clone, Copy, Debug)]
pub struct ProjectionChatRefLimits {
    refs: PageLimit,
}

impl ProjectionChatRefLimits {
    pub fn new(refs: PageLimit) -> DomainResult<Self> {
        Ok(Self { refs })
    }
}

impl Default for ProjectionChatRefLimits {
    fn default() -> Self {
        Self {
            refs: PageLimit::new(128).expect("fixed reference limit"),
        }
    }
}

/// An opaque continuation tied to a source history, cutoff, and selection.
#[derive(Clone, Debug)]
pub struct ProjectionChatPosition {
    scope: HistoryScope,
    cutoff: SpaceSeq,
    selection: RefSelection,
    after: Option<RefCursorKey>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RefSelection {
    All,
    Entry(ProjectionChatEntryKey),
    Target(HistoryScope),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RefCursorKey {
    created_space_seq: i64,
    thread: String,
    entry_seq: i64,
    ref_ordinal: i64,
}

#[derive(Clone, Debug)]
pub struct ProjectionChatPage {
    pub refs: Vec<ProjectionChatRef>,
    pub next: Option<ProjectionChatPosition>,
}

#[derive(Clone, Debug)]
pub struct ProjectionChatChange {
    pub at: SpaceSeq,
    pub entry: ProjectionChatEntryKey,
    pub removed: bool,
}

#[derive(Clone, Debug)]
pub struct ProjectionChatChangePosition {
    scope: HistoryScope,
    after: SpaceSeq,
    through: SpaceSeq,
    change_seq: SpaceSeq,
    entry: ProjectionChatEntryKey,
}

#[derive(Clone, Debug)]
pub struct ProjectionChatChangePage {
    pub changes: Vec<ProjectionChatChange>,
    pub next: Option<ProjectionChatChangePosition>,
}

/// An exclusive position in a fixed redaction inventory.
#[derive(Clone, Debug)]
pub struct ProjectionChatRedactionPosition {
    scope: HistoryScope,
    cutoff: SpaceSeq,
    at: SpaceSeq,
    entry: ProjectionChatEntryKey,
}

#[derive(Clone, Copy, Debug)]
pub struct ProjectionErasureHead {
    pub at: SpaceSeq,
    pub has_purges: bool,
    pub has_chat_redactions: bool,
}

impl CanonicalStore {
    pub async fn read_projection_chat_heads_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        after: Option<&ChatThreadId>,
        limit: PageLimit,
    ) -> Result<Vec<ProjectionChatHead>, PortError> {
        let scope = scope.clone();
        let after = after.cloned();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                validate_snapshot_cutoff_tx(tx, &scope, Some(cutoff)).await?;
                let keys = list_thread_keys_at_or_below_cutoff_tx(
                    tx,
                    &scope,
                    cutoff,
                    after.as_ref().map(ChatThreadId::as_str),
                    i64::from(limit.get()),
                )
                .await?;
                let mut map = read_heads_batch(tx, &scope, cutoff, &keys).await?;
                let mut heads = Vec::with_capacity(keys.len());
                for key in keys {
                    heads.push(map.remove(&key).ok_or_else(stale)?);
                }
                Ok(heads)
            })
        })
        .await
    }

    /// Reads a batch of chat thread heads in a single canonical read transaction.
    pub async fn read_projection_chat_heads(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: Option<SpaceSeq>,
        threads: &[ChatThreadId],
    ) -> Result<BTreeMap<ChatThreadId, ProjectionChatHead>, PortError> {
        if threads.is_empty() {
            return Ok(BTreeMap::new());
        }
        let scope = scope.clone();
        let keys: Vec<String> = threads
            .iter()
            .map(|id| id.as_str().to_owned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                let cutoff = validate_snapshot_cutoff_tx(tx, &scope, cutoff).await?;
                let map = read_heads_batch(tx, &scope, cutoff, &keys).await?;
                let mut out = BTreeMap::new();
                for (_, head) in map {
                    out.insert(head.thread.id.clone(), head);
                }
                Ok(out)
            })
        })
        .await
    }

    pub async fn read_projection_chat_head(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: Option<SpaceSeq>,
        thread: &ChatThreadId,
    ) -> Result<Option<ProjectionChatHead>, PortError> {
        let scope = scope.clone();
        let thread = thread.clone();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                let cutoff = validate_snapshot_cutoff_tx(tx, &scope, cutoff).await?;
                read_head(tx, &scope, cutoff, thread.as_str()).await
            })
        })
        .await
    }

    pub async fn read_projection_chat_refs_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        position: Option<ProjectionChatPosition>,
        limits: ProjectionChatRefLimits,
    ) -> Result<ProjectionChatPage, PortError> {
        self.read_chat_refs(ctx, scope, cutoff, RefSelection::All, position, limits)
            .await
    }

    pub async fn read_projection_chat_entry_refs_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        entry: &ProjectionChatEntryKey,
        position: Option<ProjectionChatPosition>,
        limits: ProjectionChatRefLimits,
    ) -> Result<ProjectionChatPage, PortError> {
        self.read_chat_refs(
            ctx,
            scope,
            cutoff,
            RefSelection::Entry(entry.clone()),
            position,
            limits,
        )
        .await
    }

    /// Streams references to the current target history from one source cut.
    pub async fn read_projection_incoming_chat_refs_page(
        &self,
        ctx: &MaintenanceContext,
        source: &HistoryScope,
        cutoff: SpaceSeq,
        target: &HistoryScope,
        position: Option<ProjectionChatPosition>,
        limits: ProjectionChatRefLimits,
    ) -> Result<ProjectionChatPage, PortError> {
        self.read_chat_refs(
            ctx,
            source,
            cutoff,
            RefSelection::Target(target.clone()),
            position,
            limits,
        )
        .await
    }

    async fn read_chat_refs(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        selection: RefSelection,
        position: Option<ProjectionChatPosition>,
        limits: ProjectionChatRefLimits,
    ) -> Result<ProjectionChatPage, PortError> {
        let position = match position {
            Some(position)
                if &position.scope == scope
                    && position.cutoff == cutoff
                    && position.selection == selection =>
            {
                position
            }
            Some(_) => return Err(stale()),
            None => ProjectionChatPosition {
                scope: scope.clone(),
                cutoff,
                selection,
                after: None,
            },
        };
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                validate_snapshot_cutoff_tx(tx, &position.scope, Some(cutoff)).await?;
                if matches!(position.selection, RefSelection::All)
                    && redacted_after(tx, &position.scope.space_id, cutoff).await?
                {
                    return Err(stale());
                }
                if let RefSelection::Target(target) = &position.selection {
                    let current = target_scope(tx, &target.space_id)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    target.check(&current)?;
                }
                read_page(tx, position, limits).await
            })
        })
        .await
    }

    pub async fn read_projection_chat_changes_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        after: SpaceSeq,
        through: SpaceSeq,
        position: Option<&ProjectionChatChangePosition>,
        limit: PageLimit,
    ) -> Result<ProjectionChatChangePage, PortError> {
        if after > through {
            return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
        }
        if position.is_some_and(|p| &p.scope != scope || p.after != after || p.through != through) {
            return Err(stale());
        }
        let scope = scope.clone();
        let position = position.cloned();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                validate_snapshot_cutoff_tx(tx, &scope, Some(after)).await?;
                validate_snapshot_cutoff_tx(tx, &scope, Some(through)).await?;
                read_changes(tx, scope, after, through, position.as_ref(), limit).await
            })
        })
        .await
    }

    pub async fn read_projection_erasure_head(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
    ) -> Result<ProjectionErasureHead, PortError> {
        let scope = scope.clone();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                const HEAD: &str = "SELECT s.history_incarnation, s.last_seq,
                    EXISTS (SELECT 1 FROM revision_purge_fences p
                        WHERE p.space_id=s.space_id AND p.history_incarnation=s.history_incarnation),
                    EXISTS (SELECT 1 FROM chat_entries e WHERE e.space_id=s.space_id
                        AND e.redacted_at_seq IS NOT NULL)
                    FROM spaces s WHERE s.space_id=$1";
                let record: Option<(Vec<u8>, i64, bool, bool)> =
                    chat_fetch_optional!(tx, HEAD, scope.space_id.as_str());
                let (incarnation, at, has_purges, has_chat_redactions) =
                    record.ok_or(DomainError::ResourceNotFound)?;
                scope.check(&HistoryScope {
                    space_id: scope.space_id.clone(),
                    incarnation: HistoryIncarnation::from_bytes(
                        incarnation
                            .try_into()
                            .map_err(|_| corrupt("invalid Space incarnation"))?,
                    ),
                })?;
                Ok(ProjectionErasureHead {
                    at: SpaceSeq::new(stored_sequence(at)?)?,
                    has_purges,
                    has_chat_redactions,
                })
            })
        })
        .await
    }

    pub async fn read_projection_chat_redactions_page(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        after: Option<ProjectionChatRedactionPosition>,
        limit: PageLimit,
    ) -> Result<ProjectionPage<ProjectionRedactedEntry, ProjectionChatRedactionPosition>, PortError>
    {
        if after
            .as_ref()
            .is_some_and(|cursor| &cursor.scope != scope || cursor.cutoff != cutoff)
        {
            return Err(stale());
        }
        let scope = scope.clone();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                validate_snapshot_cutoff_tx(tx, &scope, Some(cutoff)).await?;
                let (at, thread, entry) = after.as_ref().map_or((0, "", 0), |cursor| {
                    (
                        cursor.at.get() as i64,
                        cursor.entry.thread.as_str(),
                        cursor.entry.seq.get() as i64,
                    )
                });
                const PAGE: &str = "SELECT redacted_at_seq, thread_id, entry_seq
                    FROM chat_entries
                    WHERE space_id=$1 AND redacted_at_seq IS NOT NULL AND redacted_at_seq <= $2
                      AND (redacted_at_seq,thread_id,entry_seq)>($3,$4,$5)
                    ORDER BY redacted_at_seq,thread_id,entry_seq LIMIT $6";
                let cut = cutoff.get() as i64;
                let page_size = i64::from(limit.get()) + 1;
                let mut records: Vec<(i64, String, i64)> = chat_fetch_all!(
                    tx,
                    PAGE,
                    scope.space_id.as_str(),
                    cut,
                    at,
                    thread,
                    entry,
                    page_size
                );
                let more = records.len() > usize::from(limit.get());
                records.truncate(usize::from(limit.get()));
                let rows: Vec<ProjectionRedactedEntry> = records
                    .into_iter()
                    .map(|(redacted_at, thread, entry)| {
                        Ok(ProjectionRedactedEntry {
                            thread: ChatThreadId::parse(&thread)?,
                            entry: ThreadEntrySeq::new(stored_sequence(entry)?)?,
                            redacted_at: SpaceSeq::new(stored_sequence(redacted_at)?)?,
                        })
                    })
                    .collect::<Result<_, PortError>>()?;
                let next =
                    rows.last()
                        .filter(|_| more)
                        .map(|last| ProjectionChatRedactionPosition {
                            scope,
                            cutoff,
                            at: last.redacted_at,
                            entry: ProjectionChatEntryKey {
                                thread: last.thread.clone(),
                                seq: last.entry,
                            },
                        });
                Ok(ProjectionPage { rows, next })
            })
        })
        .await
    }

    /// Batched equivalent of `verify_projection_chat_ref` for backlink verification.
    /// Returns a vector of booleans aligned 1-to-1 with `references`.
    pub async fn verify_projection_chat_refs(
        &self,
        ctx: &MaintenanceContext,
        references: &[ProjectionChatRef],
    ) -> Result<Vec<bool>, PortError> {
        if references.is_empty() {
            return Ok(Vec::new());
        }
        let references = references.to_vec();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                let mut results = vec![false; references.len()];
                let mut all_spaces = BTreeSet::new();
                for reference in &references {
                    all_spaces.insert(reference.locator.source.space_id.clone());
                    all_spaces.insert(reference.target.space_id.clone());
                }
                let space_vec: Vec<SpaceId> = all_spaces.into_iter().collect();
                let scopes = target_scopes_batch(tx, &space_vec).await?;

                // Group candidate targets for batched purge-fence checks.
                let mut target_notes_by_space: BTreeMap<SpaceId, BTreeSet<NoteId>> =
                    BTreeMap::new();
                let mut scope_ok_indices = Vec::with_capacity(references.len());
                for (idx, reference) in references.iter().enumerate() {
                    if reference.target.space_id != reference.target_scope.space_id {
                        continue;
                    }
                    if scopes.get(&reference.locator.source.space_id)
                        != Some(&reference.locator.source)
                    {
                        continue;
                    }
                    if scopes.get(&reference.target.space_id) != Some(&reference.target_scope) {
                        continue;
                    }
                    target_notes_by_space
                        .entry(reference.target.space_id.clone())
                        .or_default()
                        .insert(reference.target.note_id.clone());
                    scope_ok_indices.push(idx);
                }
                let mut fenced_by_space: HashMap<SpaceId, HashSet<NoteId>> = HashMap::new();
                for (space_id, notes) in target_notes_by_space {
                    let note_vec: Vec<NoteId> = notes.into_iter().collect();
                    let fenced = purge_fenced_note_ids_tx(tx, &space_id, &note_vec).await?;
                    fenced_by_space.insert(space_id, fenced);
                }

                // Group entry lookups by source Space.
                let mut entries_by_space: BTreeMap<SpaceId, BTreeSet<ProjectionChatEntryKey>> =
                    BTreeMap::new();
                let mut live_indices = Vec::with_capacity(scope_ok_indices.len());
                for idx in scope_ok_indices {
                    let reference = &references[idx];
                    if fenced_by_space
                        .get(&reference.target.space_id)
                        .is_some_and(|set| set.contains(&reference.target.note_id))
                    {
                        continue;
                    }
                    entries_by_space
                        .entry(reference.locator.source.space_id.clone())
                        .or_default()
                        .insert(reference.locator.entry.clone());
                    live_indices.push(idx);
                }
                let mut entry_heads: HashMap<(SpaceId, ProjectionChatEntryKey), EntryHead> =
                    HashMap::new();
                for (space_id, entries) in entries_by_space {
                    let entry_vec: Vec<ProjectionChatEntryKey> = entries.into_iter().collect();
                    let batch = exact_entries_batch(tx, &space_id, &entry_vec).await?;
                    for (key, head) in batch {
                        entry_heads.insert((space_id.clone(), key), head);
                    }
                }

                // Batch verify exact chat_entry_note_refs rows per source Space.
                type RefCheckTuple = (String, i64, i64, String, String, i64);
                let mut checks_by_space: BTreeMap<SpaceId, Vec<(usize, RefCheckTuple)>> =
                    BTreeMap::new();
                for idx in live_indices {
                    let reference = &references[idx];
                    let Some(head) = entry_heads.get(&(
                        reference.locator.source.space_id.clone(),
                        reference.locator.entry.clone(),
                    )) else {
                        continue;
                    };
                    if head.revision != reference.locator.revision || !head.current_visible() {
                        continue;
                    }
                    checks_by_space
                        .entry(reference.locator.source.space_id.clone())
                        .or_default()
                        .push((
                            idx,
                            (
                                reference.locator.entry.thread.as_str().to_owned(),
                                reference.locator.entry.seq.get() as i64,
                                i64::from(reference.locator.ref_ordinal),
                                reference.target.space_id.as_str().to_owned(),
                                reference.target.note_id.as_str().to_owned(),
                                head.created_seq.get() as i64,
                            ),
                        ));
                }
                for (space_id, checks) in checks_by_space {
                    let found = existing_chat_refs_batch(tx, &space_id, &checks).await?;
                    for (idx, key) in checks {
                        if found.contains(&key) {
                            results[idx] = true;
                        }
                    }
                }
                Ok(results)
            })
        })
        .await
    }

    /// Rechecks the exact stored occurrence before granting a backlink.
    pub async fn verify_projection_chat_ref(
        &self,
        ctx: &MaintenanceContext,
        reference: &ProjectionChatRef,
    ) -> Result<bool, PortError> {
        let reference = reference.clone();
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                let ProjectionChatRef {
                    locator,
                    target,
                    target_scope: expected,
                } = reference;
                if target_scope(tx, &locator.source.space_id).await?.as_ref()
                    != Some(&locator.source)
                    || target.space_id != expected.space_id
                    || (expected != locator.source
                        && target_scope(tx, &target.space_id).await?.as_ref() != Some(&expected))
                {
                    return Ok(false);
                }
                let Some(head) = exact_entry(tx, &locator.source.space_id, &locator.entry).await?
                else {
                    return Ok(false);
                };
                if head.revision != locator.revision
                    || !head.current_visible()
                    || is_note_purge_fenced_tx(tx, &target.space_id, target.note_id.as_str())
                        .await?
                {
                    return Ok(false);
                }
                // Every occurrence index can seek to a single key when the source
                // creation sequence from the verified parent is also constrained.
                const CHECK_REF: &str = include_str!("projection_chat/verify_ref.sql");
                let exists: bool = chat_fetch_scalar!(
                    tx,
                    CHECK_REF,
                    locator.source.space_id.as_str(),
                    locator.entry.thread.as_str(),
                    locator.entry.seq.get() as i64,
                    i64::from(locator.ref_ordinal),
                    target.space_id.as_str(),
                    target.note_id.as_str(),
                    head.created_seq.get() as i64,
                );
                Ok(exists)
            })
        })
        .await
    }
}

pub(crate) async fn read_heads_batch(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    keys: &[String],
) -> Result<HashMap<String, ProjectionChatHead>, PortError> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let space = scope.space_id.as_str();
    let incarnation = scope.incarnation.as_bytes().as_slice();
    let cut = cutoff.get() as i64;
    let rows: Vec<(String, String, Vec<u8>)> = match tx {
        BackendConn::Postgres(conn) => {
            let key_refs: Vec<&str> = keys.iter().map(String::as_str).collect();
            sqlx::query_as(
                "SELECT DISTINCT ON (entity_key) entity_key, rev_id, metadata_msgpack
                 FROM revisions
                 WHERE space_id = $1 AND history_incarnation = $2 AND entity_type = 'thread'
                   AND entity_key = ANY($3) AND visibility_seq <= $4
                 ORDER BY entity_key, visibility_seq DESC, space_seq DESC",
            )
            .bind(space)
            .bind(incarnation)
            .bind(&key_refs)
            .bind(cut)
            .fetch_all(&mut **conn)
            .await
            .map_err(pg_chat_read_error)?
        }
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(keys.len());
            for chunk in keys.chunks(200) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT entity_key, rev_id, metadata_msgpack FROM (
                        SELECT entity_key, rev_id, metadata_msgpack,
                               ROW_NUMBER() OVER (PARTITION BY entity_key ORDER BY visibility_seq DESC, space_seq DESC) AS rn
                        FROM revisions
                        WHERE space_id = ",
                );
                qb.push_bind(space)
                    .push(" AND history_incarnation = ")
                    .push_bind(incarnation)
                    .push(" AND entity_type = 'thread' AND entity_key IN (");
                let mut sep = qb.separated(", ");
                for key in chunk {
                    sep.push_bind(key.as_str());
                }
                sep.push_unseparated(") AND visibility_seq <= ");
                qb.push_bind(cut).push(") WHERE rn = 1");
                let part: Vec<(String, String, Vec<u8>)> = qb
                    .build_query_as()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(sqlite_read_error)?;
                acc.extend(part);
            }
            acc
        }
    };
    let mut out = HashMap::with_capacity(rows.len());
    for (entity_key, rev_id, meta_bytes) in rows {
        let RevisionMetadataPayload::Thread(meta) =
            RevisionMetadataEnvelope::decode(&meta_bytes)?.payload
        else {
            return Err(corrupt("non-thread payload in a thread revision"));
        };
        out.insert(
            entity_key,
            ProjectionChatHead {
                thread: ChatThread {
                    id: meta.thread_id,
                    space: scope.space_id.clone(),
                    kind: meta.kind,
                    owner: meta.owner_id,
                    project_folder: meta.project_folder_id,
                    head: meta.head_leaf_seq,
                    revision: RevisionId::parse(&rev_id)?,
                    tainted: meta.tainted,
                },
                title: meta.title,
            },
        );
    }
    Ok(out)
}

pub(crate) async fn read_head(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    key: &str,
) -> Result<Option<ProjectionChatHead>, PortError> {
    let Some(revision) = read_immutable_revision_tx(tx, scope, "thread", key, cutoff).await? else {
        return Ok(None);
    };
    let RevisionMetadataPayload::Thread(meta) = revision.metadata.payload else {
        return Err(corrupt("non-thread payload in a thread revision"));
    };
    Ok(Some(ProjectionChatHead {
        thread: ChatThread {
            id: meta.thread_id,
            space: scope.space_id.clone(),
            kind: meta.kind,
            owner: meta.owner_id,
            project_folder: meta.project_folder_id,
            head: meta.head_leaf_seq,
            revision: revision.revision_id,
            tainted: meta.tainted,
        },
        title: meta.title,
    }))
}

struct EntryHead {
    revision: RevisionId,
    created_seq: SpaceSeq,
    redacted_at_seq: Option<SpaceSeq>,
    kind: String,
    checkpoint_stale: bool,
}

impl EntryHead {
    fn current_visible(&self) -> bool {
        self.kind != "redacted" && self.redacted_at_seq.is_none() && !self.checkpoint_stale
    }

    fn visible_at(&self, cutoff: SpaceSeq) -> Result<bool, PortError> {
        if self.created_seq > cutoff {
            return Ok(false);
        }
        if let Some(redacted) = self.redacted_at_seq {
            if redacted > cutoff {
                return Err(stale());
            }
            return Ok(false);
        }
        Ok(self.kind != "redacted" && !self.checkpoint_stale)
    }
}

macro_rules! exact_entry_query {
    ($index:literal) => {
        concat!(
            "SELECT revision_id, created_space_seq, redacted_at_seq, kind,
            CAST(checkpoint_stale AS BIGINT) FROM chat_entries",
            $index,
            " WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3"
        )
    };
}
const SQLITE_EXACT_ENTRY: &str = exact_entry_query!(" INDEXED BY idx_chat_entries_projection");
const PG_EXACT_ENTRY: &str = exact_entry_query!("");

async fn exact_entry(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    key: &ProjectionChatEntryKey,
) -> Result<Option<EntryHead>, PortError> {
    macro_rules! fetch {
        ($conn:expr, $query:ident) => {
            sqlx::query_as($query)
                .bind(space.as_str())
                .bind(key.thread.as_str())
                .bind(key.seq.get() as i64)
                .fetch_optional(&mut **$conn)
                .await
        };
    }
    let row: Option<(String, i64, Option<i64>, String, i64)> = match tx {
        BackendConn::Sqlite(conn) => fetch!(conn, SQLITE_EXACT_ENTRY).map_err(sqlite_read_error)?,
        BackendConn::Postgres(conn) => fetch!(conn, PG_EXACT_ENTRY).map_err(pg_chat_read_error)?,
    };
    let Some((revision, created, redacted, kind, stale_flag)) = row else {
        return Ok(None);
    };
    Ok(Some(EntryHead {
        revision: RevisionId::parse(&revision)?,
        created_seq: SpaceSeq::new(stored_sequence(created)?)?,
        redacted_at_seq: redacted
            .map(|value| Ok::<_, PortError>(SpaceSeq::new(stored_sequence(value)?)?))
            .transpose()?,
        kind,
        checkpoint_stale: stale_flag != 0,
    }))
}

// The range on the immutable creation sequence bounds both ends of a fixed-cut
// traversal. Check current visibility with one parent lookup per visited key.
macro_rules! ref_columns {
    ($index:literal) => {
        concat!(
            "SELECT r.thread_id, r.entry_seq, r.ref_ordinal, r.target_space_id, r.target_note_id,
            r.created_space_seq, (SELECT e.revision_id FROM chat_entries e",
            $index,
            " WHERE e.space_id=r.space_id AND e.thread_id=r.thread_id AND e.entry_seq=r.entry_seq
              AND e.kind <> 'redacted' AND e.redacted_at_seq IS NULL AND e.checkpoint_stale=0)
            FROM chat_entry_note_refs r WHERE r.space_id=$1 AND "
        )
    };
}

macro_rules! ref_pages {
    ($all:ident, $target:ident, $index:literal) => {
        const $all: &str = concat!(ref_columns!($index),
            "r.created_space_seq<=$2 AND (r.created_space_seq,r.thread_id,r.entry_seq,r.ref_ordinal)>($3,$4,$5,$6)
             ORDER BY r.created_space_seq,r.thread_id,r.entry_seq,r.ref_ordinal LIMIT $7");
        // Both bounds share a target. Order by the complete target index so a
        // deep continuation can seek past neighbors in other target Spaces.
        const $target: &str = concat!(
            ref_columns!($index),
            include_str!("projection_chat/target_ref_range.sql")
        );
    };
}
ref_pages!(
    SQLITE_ALL_REFS,
    SQLITE_TARGET_REFS,
    " INDEXED BY idx_chat_entries_projection"
);
ref_pages!(PG_ALL_REFS, PG_TARGET_REFS, "");

// Ordered columns shared by the all-occurrence, target and single-entry reads.
type RawOccurrence = (String, i64, i64, String, String, i64, Option<String>);

async fn read_page(
    tx: &mut BackendConn<'_>,
    position: ProjectionChatPosition,
    limits: ProjectionChatRefLimits,
) -> Result<ProjectionChatPage, PortError> {
    let limit = usize::from(limits.refs.get());
    let fetch_limit = i64::try_from(limit + 1).expect("page limit fits i64");
    let cut = position.cutoff.get() as i64;
    let space = position.scope.space_id.as_str();

    let (all_refs, target_refs) = match tx {
        BackendConn::Sqlite(_) => (SQLITE_ALL_REFS, SQLITE_TARGET_REFS),
        BackendConn::Postgres(_) => (PG_ALL_REFS, PG_TARGET_REFS),
    };
    let (after_created, after_thread, after_entry, after_ord) =
        position.after.as_ref().map_or((0, "", 0, -1), |key| {
            (
                key.created_space_seq,
                key.thread.as_str(),
                key.entry_seq,
                key.ref_ordinal,
            )
        });
    let raw_rows: Vec<RawOccurrence> = match &position.selection {
        RefSelection::All => {
            chat_fetch_all!(
                tx,
                all_refs,
                space,
                cut,
                after_created,
                after_thread,
                after_entry,
                after_ord,
                fetch_limit
            )
        }
        RefSelection::Entry(entry) => {
            let Some(head) = exact_entry(tx, &position.scope.space_id, entry).await? else {
                return Ok(ProjectionChatPage {
                    refs: Vec::new(),
                    next: None,
                });
            };
            if !head.visible_at(position.cutoff)? {
                return Ok(ProjectionChatPage {
                    refs: Vec::new(),
                    next: None,
                });
            }
            const ENTRY_REFS: &str = "SELECT thread_id, entry_seq, ref_ordinal,
                    target_space_id, target_note_id
                FROM chat_entry_note_refs
                WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3 AND ref_ordinal>$4
                ORDER BY ref_ordinal
                LIMIT $5";
            let rows: Vec<(String, i64, i64, String, String)> = chat_fetch_all!(
                tx,
                ENTRY_REFS,
                space,
                entry.thread.as_str(),
                entry.seq.get() as i64,
                after_ord,
                fetch_limit
            );
            let rev = head.revision.as_str().to_owned();
            let created = head.created_seq.get() as i64;
            rows.into_iter()
                .map(|(t, s, o, ts, tn)| (t, s, o, ts, tn, created, Some(rev.clone())))
                .collect()
        }
        RefSelection::Target(target) => {
            chat_fetch_all!(
                tx,
                target_refs,
                space,
                target.space_id.as_str(),
                cut,
                after_created,
                after_thread,
                after_entry,
                after_ord,
                fetch_limit
            )
        }
    };

    let has_more = raw_rows.len() > limit;
    let mut rows = raw_rows;
    rows.truncate(limit);

    let last_cursor = rows
        .last()
        .map(|(thread, seq, ord, _, _, created, _)| RefCursorKey {
            created_space_seq: *created,
            thread: thread.clone(),
            entry_seq: *seq,
            ref_ordinal: *ord,
        });

    let mut scopes = BTreeMap::<SpaceId, HistoryScope>::new();
    scopes.insert(position.scope.space_id.clone(), position.scope.clone());
    if let RefSelection::Target(target) = &position.selection {
        scopes.insert(target.space_id.clone(), target.clone());
    }

    let mut parsed_rows = Vec::with_capacity(rows.len());
    let mut missing_spaces = BTreeSet::new();
    let mut notes_by_space: BTreeMap<SpaceId, BTreeSet<NoteId>> = BTreeMap::new();
    for (thread, seq, ord, target_space_raw, target_note_raw, _, revision) in rows {
        let Some(revision) = revision else { continue };
        let target_space_id = SpaceId::parse(&target_space_raw)?;
        let target_note_id = NoteId::parse(&target_note_raw)?;
        if !scopes.contains_key(&target_space_id) {
            missing_spaces.insert(target_space_id.clone());
        }
        notes_by_space
            .entry(target_space_id.clone())
            .or_default()
            .insert(target_note_id.clone());
        parsed_rows.push((thread, seq, ord, target_space_id, target_note_id, revision));
    }

    if !missing_spaces.is_empty() {
        let missing_vec: Vec<SpaceId> = missing_spaces.into_iter().collect();
        let loaded = target_scopes_batch(tx, &missing_vec).await?;
        scopes.extend(loaded);
    }
    let mut fenced_by_space: HashMap<SpaceId, HashSet<NoteId>> = HashMap::new();
    for (space_id, notes) in notes_by_space {
        if !scopes.contains_key(&space_id) {
            continue;
        }
        let note_vec: Vec<NoteId> = notes.into_iter().collect();
        let fenced = purge_fenced_note_ids_tx(tx, &space_id, &note_vec).await?;
        fenced_by_space.insert(space_id, fenced);
    }

    let mut refs = Vec::with_capacity(parsed_rows.len());
    for (thread, seq, ord, target_space_id, target_note_id, revision) in parsed_rows {
        let Some(resolved_scope) = scopes.get(&target_space_id).cloned() else {
            continue;
        };
        if fenced_by_space
            .get(&target_space_id)
            .is_some_and(|set| set.contains(&target_note_id))
        {
            continue;
        }
        let ref_ordinal =
            u32::try_from(ord).map_err(|_| corrupt("chat ref ordinal out of range"))?;
        refs.push(ProjectionChatRef {
            locator: ProjectionChatRefLocator {
                source: position.scope.clone(),
                entry: ProjectionChatEntryKey {
                    thread: ChatThreadId::parse(&thread)?,
                    seq: ThreadEntrySeq::new(stored_sequence(seq)?)?,
                },
                revision: RevisionId::parse(&revision)?,
                ref_ordinal,
            },
            target: NoteRef {
                space_id: target_space_id,
                note_id: target_note_id,
            },
            target_scope: resolved_scope,
        });
    }

    let next = if has_more {
        last_cursor.map(|after| ProjectionChatPosition {
            scope: position.scope,
            cutoff: position.cutoff,
            selection: position.selection,
            after: Some(after),
        })
    } else {
        None
    };
    Ok(ProjectionChatPage { refs, next })
}

async fn read_changes(
    tx: &mut BackendConn<'_>,
    scope: HistoryScope,
    after: SpaceSeq,
    through: SpaceSeq,
    position: Option<&ProjectionChatChangePosition>,
    limit: PageLimit,
) -> Result<ProjectionChatChangePage, PortError> {
    const QUERY: &str = "WITH created AS (
            SELECT created_space_seq AS at,thread_id,entry_seq,CAST(0 AS BIGINT) AS removed
            FROM chat_entries WHERE space_id=$1 AND created_space_seq<=$2
              AND (created_space_seq,thread_id,entry_seq)>($3,$4,$5)
            ORDER BY created_space_seq,thread_id,entry_seq LIMIT $6
        ), redacted AS (
            SELECT redacted_at_seq AS at,thread_id,entry_seq,CAST(1 AS BIGINT) AS removed
            FROM chat_entries WHERE space_id=$1 AND redacted_at_seq IS NOT NULL AND redacted_at_seq<=$2
              AND (redacted_at_seq,thread_id,entry_seq)>($3,$4,$5)
            ORDER BY redacted_at_seq,thread_id,entry_seq LIMIT $6
        )
        SELECT at,thread_id,entry_seq,removed FROM created
        UNION ALL SELECT at,thread_id,entry_seq,removed FROM redacted
        ORDER BY at,thread_id,entry_seq LIMIT $6";
    let initial = after.checked_next().ok();
    if through == after || (position.is_none() && initial.is_none()) {
        return Ok(ProjectionChatChangePage {
            changes: Vec::new(),
            next: None,
        });
    }
    let (seq, thread, entry) = position.map_or_else(
        || (initial.unwrap_or(through), "", 0),
        |p| {
            (
                p.change_seq,
                p.entry.thread.as_str(),
                p.entry.seq.get() as i64,
            )
        },
    );
    let limit_raw = i64::from(limit.get());
    let rows: Vec<(i64, String, i64, i64)> = chat_fetch_all!(
        tx,
        QUERY,
        scope.space_id.as_str(),
        through.get() as i64,
        seq.get() as i64,
        thread,
        entry,
        limit_raw
    );
    let mut changes = Vec::with_capacity(rows.len());
    for (seq, thread, entry, removed) in rows {
        changes.push(ProjectionChatChange {
            at: SpaceSeq::new(stored_sequence(seq)?)?,
            entry: ProjectionChatEntryKey {
                thread: ChatThreadId::parse(&thread)?,
                seq: ThreadEntrySeq::new(stored_sequence(entry)?)?,
            },
            removed: removed != 0,
        });
    }
    let next = changes
        .last()
        .filter(|_| changes.len() == usize::from(limit.get()))
        .map(|last| ProjectionChatChangePosition {
            scope,
            after,
            through,
            change_seq: last.at,
            entry: last.entry.clone(),
        });
    Ok(ProjectionChatChangePage { changes, next })
}

async fn redacted_after(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    cutoff: SpaceSeq,
) -> Result<bool, PortError> {
    const QUERY: &str = "SELECT EXISTS(
        SELECT 1 FROM chat_entries
        WHERE space_id=$1 AND redacted_at_seq IS NOT NULL AND redacted_at_seq>$2
    )";
    Ok(chat_fetch_scalar!(
        tx,
        QUERY,
        space.as_str(),
        cutoff.get() as i64
    ))
}

async fn target_scopes_batch(
    tx: &mut BackendConn<'_>,
    spaces: &[SpaceId],
) -> Result<BTreeMap<SpaceId, HistoryScope>, PortError> {
    let mut out = BTreeMap::new();
    if spaces.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, Vec<u8>)> = match tx {
        BackendConn::Postgres(conn) => {
            let ids: Vec<&str> = spaces.iter().map(SpaceId::as_str).collect();
            sqlx::query_as(
                "SELECT space_id, history_incarnation FROM spaces WHERE space_id = ANY($1)",
            )
            .bind(&ids)
            .fetch_all(&mut **conn)
            .await
            .map_err(pg_chat_read_error)?
        }
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(spaces.len());
            for chunk in spaces.chunks(200) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT space_id, history_incarnation FROM spaces WHERE space_id IN (",
                );
                let mut sep = qb.separated(", ");
                for space in chunk {
                    sep.push_bind(space.as_str());
                }
                sep.push_unseparated(")");
                let part: Vec<(String, Vec<u8>)> = qb
                    .build_query_as()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(sqlite_read_error)?;
                acc.extend(part);
            }
            acc
        }
    };
    for (id_raw, bytes) in rows {
        let space_id = SpaceId::parse(&id_raw)?;
        let raw: [u8; 16] = bytes
            .try_into()
            .map_err(|_| corrupt("invalid target Space incarnation"))?;
        out.insert(
            space_id.clone(),
            HistoryScope {
                space_id,
                incarnation: HistoryIncarnation::from_bytes(raw),
            },
        );
    }
    Ok(out)
}

async fn exact_entries_batch(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    keys: &[ProjectionChatEntryKey],
) -> Result<HashMap<ProjectionChatEntryKey, EntryHead>, PortError> {
    let mut out = HashMap::new();
    if keys.is_empty() {
        return Ok(out);
    }
    type EntryRow = (String, i64, String, i64, Option<i64>, String, i64);
    let rows: Vec<EntryRow> = match tx {
        BackendConn::Postgres(conn) => {
            let threads: Vec<&str> = keys.iter().map(|k| k.thread.as_str()).collect();
            let seqs: Vec<i64> = keys.iter().map(|k| k.seq.get() as i64).collect();
            sqlx::query_as(
                "SELECT e.thread_id, e.entry_seq, e.revision_id, e.created_space_seq,
                        e.redacted_at_seq, e.kind, CAST(e.checkpoint_stale AS BIGINT)
                 FROM UNNEST($2::text[], $3::bigint[]) AS k(t, s)
                 JOIN chat_entries e
                   ON e.space_id = $1 AND e.thread_id = k.t AND e.entry_seq = k.s",
            )
            .bind(space.as_str())
            .bind(&threads)
            .bind(&seqs)
            .fetch_all(&mut **conn)
            .await
            .map_err(pg_chat_read_error)?
        }
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(keys.len());
            for chunk in keys.chunks(150) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new("WITH keys(t, s) AS (VALUES ");
                let mut sep = qb.separated(", ");
                for k in chunk {
                    sep.push("(");
                    sep.push_bind_unseparated(k.thread.as_str());
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(k.seq.get() as i64);
                    sep.push_unseparated(")");
                }
                qb.push(
                    ") SELECT e.thread_id, e.entry_seq, e.revision_id, e.created_space_seq,
                             e.redacted_at_seq, e.kind, CAST(e.checkpoint_stale AS BIGINT)
                      FROM keys
                      JOIN chat_entries e INDEXED BY idx_chat_entries_projection
                        ON e.space_id = ",
                );
                qb.push_bind(space.as_str())
                    .push(" AND e.thread_id = keys.t AND e.entry_seq = keys.s");
                let part: Vec<EntryRow> = qb
                    .build_query_as()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(sqlite_read_error)?;
                acc.extend(part);
            }
            acc
        }
    };
    for (thread, seq, revision, created, redacted, kind, stale_flag) in rows {
        let key = ProjectionChatEntryKey {
            thread: ChatThreadId::parse(&thread)?,
            seq: ThreadEntrySeq::new(stored_sequence(seq)?)?,
        };
        out.insert(
            key,
            EntryHead {
                revision: RevisionId::parse(&revision)?,
                created_seq: SpaceSeq::new(stored_sequence(created)?)?,
                redacted_at_seq: redacted
                    .map(|value| Ok::<_, PortError>(SpaceSeq::new(stored_sequence(value)?)?))
                    .transpose()?,
                kind,
                checkpoint_stale: stale_flag != 0,
            },
        );
    }
    Ok(out)
}

type ChatRefRow = (String, i64, i64, String, String, i64);

async fn existing_chat_refs_batch(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    checks: &[(usize, ChatRefRow)],
) -> Result<HashSet<ChatRefRow>, PortError> {
    let mut out = HashSet::new();
    if checks.is_empty() {
        return Ok(out);
    }
    let rows: Vec<ChatRefRow> = match tx {
        BackendConn::Postgres(conn) => {
            let threads: Vec<&str> = checks.iter().map(|(_, c)| c.0.as_str()).collect();
            let seqs: Vec<i64> = checks.iter().map(|(_, c)| c.1).collect();
            let ords: Vec<i64> = checks.iter().map(|(_, c)| c.2).collect();
            let target_spaces: Vec<&str> = checks.iter().map(|(_, c)| c.3.as_str()).collect();
            let target_notes: Vec<&str> = checks.iter().map(|(_, c)| c.4.as_str()).collect();
            let created_seqs: Vec<i64> = checks.iter().map(|(_, c)| c.5).collect();
            sqlx::query_as(
                "SELECT r.thread_id, r.entry_seq, r.ref_ordinal,
                        r.target_space_id, r.target_note_id, r.created_space_seq
                 FROM UNNEST($2::text[], $3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::bigint[])
                      AS k(t, s, o, ts, tn, cs)
                 JOIN chat_entry_note_refs r
                   ON r.space_id = $1 AND r.thread_id = k.t AND r.entry_seq = k.s
                  AND r.ref_ordinal = k.o AND r.target_space_id = k.ts
                  AND r.target_note_id = k.tn AND r.created_space_seq = k.cs",
            )
            .bind(space.as_str())
            .bind(&threads)
            .bind(&seqs)
            .bind(&ords)
            .bind(&target_spaces)
            .bind(&target_notes)
            .bind(&created_seqs)
            .fetch_all(&mut **conn)
            .await
            .map_err(pg_chat_read_error)?
        }
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(checks.len());
            for chunk in checks.chunks(100) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "WITH keys(t, s, o, ts, tn, cs) AS (VALUES ",
                );
                let mut sep = qb.separated(", ");
                for (_, c) in chunk {
                    sep.push("(");
                    sep.push_bind_unseparated(c.0.as_str());
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(c.1);
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(c.2);
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(c.3.as_str());
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(c.4.as_str());
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(c.5);
                    sep.push_unseparated(")");
                }
                qb.push(
                    ") SELECT r.thread_id, r.entry_seq, r.ref_ordinal,
                             r.target_space_id, r.target_note_id, r.created_space_seq
                      FROM keys
                      JOIN chat_entry_note_refs r
                        ON r.space_id = ",
                );
                qb.push_bind(space.as_str()).push(
                    " AND r.thread_id = keys.t AND r.entry_seq = keys.s
                      AND r.ref_ordinal = keys.o AND r.target_space_id = keys.ts
                      AND r.target_note_id = keys.tn AND r.created_space_seq = keys.cs",
                );
                let part: Vec<ChatRefRow> = qb
                    .build_query_as()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(sqlite_read_error)?;
                acc.extend(part);
            }
            acc
        }
    };
    out.extend(rows);
    Ok(out)
}

async fn target_scope(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
) -> Result<Option<HistoryScope>, PortError> {
    const QUERY: &str = "SELECT history_incarnation FROM spaces WHERE space_id=$1";
    let row: Option<(Vec<u8>,)> = chat_fetch_optional!(tx, QUERY, space.as_str());
    let Some((bytes,)) = row else {
        return Ok(None);
    };
    let raw: [u8; 16] = bytes
        .try_into()
        .map_err(|_| corrupt("invalid target Space incarnation"))?;
    Ok(Some(HistoryScope {
        space_id: space.clone(),
        incarnation: HistoryIncarnation::from_bytes(raw),
    }))
}

pub(crate) async fn write_chat_note_refs_json_tx(
    tx: &mut BackendConn<'_>,
    space_id: &str,
    thread_id: &str,
    entry_seq: i64,
    created_space_seq: i64,
    refs_json: &str,
) -> Result<(), PortError> {
    if refs_json == "[]" {
        return Ok(());
    }
    let refs: Vec<NoteRef> = serde_json::from_str(refs_json)
        .map_err(|error| internal_not_committed("parse_chat_note_refs", error.to_string()))?;
    write_chat_note_refs_tx(tx, space_id, thread_id, entry_seq, created_space_seq, &refs).await
}

pub(crate) async fn write_chat_note_refs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &str,
    thread_id: &str,
    entry_seq: i64,
    created_space_seq: i64,
    refs: &[NoteRef],
) -> Result<(), PortError> {
    if refs.is_empty() {
        return Ok(());
    }
    let mut seen = BTreeSet::new();
    let mut unique = Vec::new();
    for (ordinal, item) in refs.iter().enumerate() {
        if seen.insert((item.space_id.as_str(), item.note_id.as_str())) {
            let ordinal = i64::try_from(ordinal)
                .map_err(|_| DomainError::validation(ValidationReason::SequenceOverflow))?;
            unique.push((ordinal, item));
        }
    }
    for chunk in unique.chunks(REF_INSERT_CHUNK) {
        let mut sql = String::from(
            "INSERT INTO chat_entry_note_refs \
             (space_id, thread_id, entry_seq, ref_ordinal, target_space_id, target_note_id, created_space_seq) VALUES ",
        );
        let postgres = matches!(tx, BackendConn::Postgres(_));
        for (idx, _) in chunk.iter().enumerate() {
            if idx > 0 {
                sql.push_str(", ");
            }
            if postgres {
                let base = idx * 7;
                use std::fmt::Write;
                let _ = write!(
                    sql,
                    "(${}, ${}, ${}, ${}, ${}, ${}, ${})",
                    base + 1,
                    base + 2,
                    base + 3,
                    base + 4,
                    base + 5,
                    base + 6,
                    base + 7
                );
            } else {
                sql.push_str("(?, ?, ?, ?, ?, ?, ?)");
            }
        }
        match tx {
            BackendConn::Sqlite(conn) => {
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
                for (ordinal, item) in chunk {
                    query = query
                        .bind(space_id)
                        .bind(thread_id)
                        .bind(entry_seq)
                        .bind(*ordinal)
                        .bind(item.space_id.as_str())
                        .bind(item.note_id.as_str())
                        .bind(created_space_seq);
                }
                query.execute(&mut **conn).await.map_err(|err| {
                    internal_not_committed("write_chat_note_refs", err.to_string())
                })?;
            }
            BackendConn::Postgres(conn) => {
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).persistent(false);
                for (ordinal, item) in chunk {
                    query = query
                        .bind(space_id)
                        .bind(thread_id)
                        .bind(entry_seq)
                        .bind(*ordinal)
                        .bind(item.space_id.as_str())
                        .bind(item.note_id.as_str())
                        .bind(created_space_seq);
                }
                query.execute(&mut **conn).await.map_err(|err| {
                    internal_not_committed("write_chat_note_refs", err.to_string())
                })?;
            }
        }
    }
    Ok(())
}

pub(crate) async fn clear_chat_note_refs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    entry_seq: i64,
) -> Result<(), PortError> {
    const QUERY: &str = "DELETE FROM chat_entry_note_refs
        WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(QUERY)
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .bind(entry_seq)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(QUERY)
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .bind(entry_seq)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(|err| internal_not_committed("clear_chat_note_refs", err.to_string()))
}

fn stored_sequence(value: i64) -> Result<u64, PortError> {
    u64::try_from(value).map_err(|_| corrupt("negative sequence in chat projection"))
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

fn corrupt(detail: &str) -> PortError {
    internal_not_committed("corrupt_chat_projection", detail)
}

fn sqlite_read_error(error: sqlx::Error) -> PortError {
    internal_not_committed("sqlite_projection_chat_read", error.to_string())
}

fn pg_chat_read_error(error: sqlx::Error) -> PortError {
    pg_read_error("pg_projection_chat_read", error)
}

#[cfg(test)]
mod sqlite_access_tests {
    use super::{SQLITE_ALL_REFS, SQLITE_EXACT_ENTRY, SQLITE_TARGET_REFS};
    use rusqlite::{Connection, StatementStatus, named_params, params};

    #[test]
    fn chat_ref_pages_bound_examined_keys_at_an_old_cut() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        db.pragma_update(None, "foreign_keys", false).unwrap();
        let mut previous = 0;
        for size in [64, 2048, 20_000] {
            let range =
                "WITH RECURSIVE seq(i) AS (SELECT ?1+1 UNION ALL SELECT i+1 FROM seq WHERE i<?2)";
            db.execute(&format!("{range} INSERT INTO chat_entries
                (space_id, thread_id, entry_seq, revision_id, kind, author_id, inline_text, referenced_notes_json,
                 ext_space_tainted, is_chain_node, branch_depth, created_space_seq)
                SELECT 's','t',i,'r','human','a','hi','[]',0,1,0,i+2 FROM seq"), params![previous, size]).unwrap();
            db.execute(
                &format!(
                    "{range} INSERT INTO chat_entry_note_refs
                SELECT 's','t',i,0,CASE WHEN i=?2 THEN 's' ELSE 'other' END,'n',i+2 FROM seq"
                ),
                params![previous, size],
            )
            .unwrap();
            previous = size;
            db.execute_batch("ANALYZE").unwrap();
            for (query, args) in [
                (
                    SQLITE_ALL_REFS,
                    named_params! {"$1":"s", "$2":2, "$3":0, "$4":"", "$5":0, "$6":-1, "$7":2},
                ),
                (
                    SQLITE_TARGET_REFS,
                    named_params! {"$1":"s", "$2":"s", "$3":2, "$4":0, "$5":"", "$6":0, "$7":-1, "$8":2},
                ),
            ] {
                let mut stmt = db.prepare(query).unwrap();
                let revisions = stmt
                    .query_map(args, |row| row.get::<_, Option<String>>(6))
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                assert!(revisions.is_empty());
                assert!(
                    stmt.get_status(StatementStatus::VmStep) < 250,
                    "{size} later entries"
                );
            }
            // Only the last entry in this interval addresses s. Seeking by the
            // target and cursor must bypass all eligible unrelated occurrences.
            let mut target = db.prepare(SQLITE_TARGET_REFS).unwrap();
            let matched = target
                .query_map(
                    named_params! {
                        "$1":"s", "$2":"s", "$3":size+2, "$4":size/2+2,
                        "$5":"t", "$6":size/2, "$7":0, "$8":2
                    },
                    |row| row.get::<_, i64>(1),
                )
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert_eq!(matched, [size]);
            assert!(
                target.get_status(StatementStatus::VmStep) < 250,
                "{size} entries"
            );
        }
    }

    #[test]
    fn exact_entry_reads_only_its_covering_index() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        let root: i64 = db.query_row(
            "SELECT rootpage FROM sqlite_schema WHERE type='index' AND name='idx_chat_entries_projection'",
            [], |row| row.get(0)).unwrap();
        let opened = db
            .prepare(&format!("EXPLAIN {SQLITE_EXACT_ENTRY}"))
            .unwrap()
            .query_map(params!["s", "t", 1], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, i64>(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .into_iter()
            .filter_map(|(opcode, page)| (opcode == "OpenRead").then_some(page))
            .collect::<Vec<_>>();
        assert_eq!(
            opened,
            [root],
            "the exact entry probe must never open the overflow-bearing table"
        );
    }
}
