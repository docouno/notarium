//! Bounded canonical chat reads backed by normalized `chat_entry_note_refs`.
use crate::{
    CanonicalStore, ProjectionRedactedEntry,
    changes::list_thread_keys_at_or_below_cutoff_tx,
    codec::{RevisionMetadataPayload, internal_not_committed},
    projection_read::ProjectionPage,
    runtime::{
        is_note_purge_fenced_tx, pg_read_error, read_immutable_revision_tx,
        validate_snapshot_cutoff_tx,
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
use std::collections::{BTreeMap, BTreeSet};

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

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
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
    target_note: String,
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
                let mut heads = Vec::with_capacity(keys.len());
                for key in keys {
                    heads.push(
                        read_head(tx, &scope, cutoff, &key)
                            .await?
                            .ok_or_else(stale)?,
                    );
                }
                Ok(heads)
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
                const CHECK_REF: &str = "SELECT EXISTS(
                    SELECT 1 FROM chat_entry_note_refs
                    WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3
                      AND ref_ordinal=$4 AND target_space_id=$5 AND target_note_id=$6
                )";
                let exists: bool = chat_fetch_scalar!(
                    tx,
                    CHECK_REF,
                    locator.source.space_id.as_str(),
                    locator.entry.thread.as_str(),
                    locator.entry.seq.get() as i64,
                    i64::from(locator.ref_ordinal),
                    target.space_id.as_str(),
                    target.note_id.as_str(),
                );
                Ok(exists)
            })
        })
        .await
    }
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

// Determine visibility by one exact probe per visited occurrence. Keeping the
// predicate in the scalar projection preserves raw keys for the continuation.
macro_rules! ref_columns {
    ($index:literal, $cut:literal) => {
        concat!(
            "SELECT r.thread_id, r.entry_seq, r.ref_ordinal, r.target_space_id, r.target_note_id,
            (SELECT e.revision_id FROM chat_entries e",
            $index,
            " WHERE e.space_id=r.space_id AND e.thread_id=r.thread_id AND e.entry_seq=r.entry_seq
              AND e.created_space_seq<=",
            $cut,
            " AND e.kind <> 'redacted' AND e.redacted_at_seq IS NULL AND e.checkpoint_stale=0)
            FROM chat_entry_note_refs r WHERE r.space_id=$1 AND "
        )
    };
}

macro_rules! ref_pages {
    ($all:ident, $target:ident, $index:literal) => {
        const $all: &str = concat!(ref_columns!($index, "$2"),
            "(r.thread_id,r.entry_seq,r.ref_ordinal)>($3,$4,$5)
             ORDER BY r.thread_id,r.entry_seq,r.ref_ordinal LIMIT $6");
        const $target: &str = concat!(ref_columns!($index, "$3"),
            "r.target_space_id=$2 AND (r.target_note_id,r.thread_id,r.entry_seq,r.ref_ordinal)>($4,$5,$6,$7)
             ORDER BY r.target_note_id,r.thread_id,r.entry_seq,r.ref_ordinal LIMIT $8");
    };
}
ref_pages!(
    SQLITE_ALL_REFS,
    SQLITE_TARGET_REFS,
    " INDEXED BY idx_chat_entries_projection"
);
ref_pages!(PG_ALL_REFS, PG_TARGET_REFS, "");

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
    // Keep ineligible keys in the raw page. Each call examines at most
    // limit + 1 occurrences even when every entry was created after the cut.
    let raw_rows: Vec<(String, i64, i64, String, String, Option<String>)> =
        match &position.selection {
            RefSelection::All => {
                let (after_thread, after_entry, after_ord) =
                    position.after.as_ref().map_or(("", 0_i64, -1_i64), |c| {
                        (c.thread.as_str(), c.entry_seq, c.ref_ordinal)
                    });
                chat_fetch_all!(
                    tx,
                    all_refs,
                    space,
                    cut,
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
                let after_ord = position.after.as_ref().map_or(-1_i64, |c| c.ref_ordinal);
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
                rows.into_iter()
                    .map(|(t, s, o, ts, tn)| (t, s, o, ts, tn, Some(rev.clone())))
                    .collect()
            }
            RefSelection::Target(target) => {
                let (after_note, after_thread, after_entry, after_ord) = position
                    .after
                    .as_ref()
                    .map_or(("", "", 0_i64, -1_i64), |c| {
                        (
                            c.target_note.as_str(),
                            c.thread.as_str(),
                            c.entry_seq,
                            c.ref_ordinal,
                        )
                    });
                chat_fetch_all!(
                    tx,
                    target_refs,
                    space,
                    target.space_id.as_str(),
                    cut,
                    after_note,
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
        .map(|(thread, seq, ord, _, target_note, _)| RefCursorKey {
            target_note: target_note.clone(),
            thread: thread.clone(),
            entry_seq: *seq,
            ref_ordinal: *ord,
        });

    let mut scopes = BTreeMap::<SpaceId, Option<HistoryScope>>::new();
    scopes.insert(
        position.scope.space_id.clone(),
        Some(position.scope.clone()),
    );
    if let RefSelection::Target(target) = &position.selection {
        scopes.insert(target.space_id.clone(), Some(target.clone()));
    }

    let mut refs = Vec::with_capacity(rows.len());
    for (thread, seq, ord, target_space_raw, target_note_raw, revision) in rows {
        let Some(revision) = revision else { continue };
        let target_space_id = SpaceId::parse(&target_space_raw)?;
        let target_note_id = NoteId::parse(&target_note_raw)?;
        let resolved_scope = if let Some(cached) = scopes.get(&target_space_id) {
            cached.clone()
        } else {
            let loaded = target_scope(tx, &target_space_id).await?;
            scopes.insert(target_space_id.clone(), loaded.clone());
            loaded
        };
        let Some(resolved_scope) = resolved_scope else {
            continue;
        };
        if is_note_purge_fenced_tx(tx, &target_space_id, target_note_id.as_str()).await? {
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
    refs_json: &str,
) -> Result<(), PortError> {
    if refs_json == "[]" {
        return Ok(());
    }
    let refs: Vec<NoteRef> = serde_json::from_str(refs_json)
        .map_err(|error| internal_not_committed("parse_chat_note_refs", error.to_string()))?;
    write_chat_note_refs_tx(tx, space_id, thread_id, entry_seq, &refs).await
}

pub(crate) async fn write_chat_note_refs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &str,
    thread_id: &str,
    entry_seq: i64,
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
             (space_id, thread_id, entry_seq, ref_ordinal, target_space_id, target_note_id) VALUES ",
        );
        let postgres = matches!(tx, BackendConn::Postgres(_));
        for (idx, _) in chunk.iter().enumerate() {
            if idx > 0 {
                sql.push_str(", ");
            }
            if postgres {
                let base = idx * 6;
                use std::fmt::Write;
                let _ = write!(
                    sql,
                    "(${}, ${}, ${}, ${}, ${}, ${})",
                    base + 1,
                    base + 2,
                    base + 3,
                    base + 4,
                    base + 5,
                    base + 6
                );
            } else {
                sql.push_str("(?, ?, ?, ?, ?, ?)");
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
                        .bind(item.note_id.as_str());
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
                        .bind(item.note_id.as_str());
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
                SELECT 's','t',i,0,'s','n' FROM seq"
                ),
                params![previous, size],
            )
            .unwrap();
            previous = size;
            db.execute_batch("ANALYZE").unwrap();
            for (query, args) in [
                (
                    SQLITE_ALL_REFS,
                    named_params! {"$1":"s", "$2":2, "$3":"", "$4":0, "$5":-1, "$6":2},
                ),
                (
                    SQLITE_TARGET_REFS,
                    named_params! {"$1":"s", "$2":"s", "$3":2, "$4":"", "$5":"", "$6":0, "$7":-1, "$8":2},
                ),
            ] {
                let mut stmt = db.prepare(query).unwrap();
                let revisions = stmt
                    .query_map(args, |row| row.get::<_, Option<String>>(5))
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                assert_eq!(revisions, [None, None]);
                assert!(
                    stmt.get_status(StatementStatus::VmStep) < 250,
                    "{size} later entries"
                );
            }
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
