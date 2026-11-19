//! Bounded canonical chat reads for rebuilding and repairing backlinks.
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
use std::collections::BTreeMap;

pub(crate) const REF_BLOCK_BYTES: usize = 4096;
const MAX_PAGE_BYTES: usize = 16 * REF_BLOCK_BYTES;
// SpaceId and NoteId use at most 35 ASCII bytes each and need no JSON
// escapes. Their two fixed keys and punctuation fit well within this bound.
const MAX_REF_BYTES: usize = 128;

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

/// Identifies one exact canonical occurrence. Byte positions are half-open
/// offsets into the original canonical UTF-8 reference array.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectionChatRefLocator {
    pub source: HistoryScope,
    pub entry: ProjectionChatEntryKey,
    pub revision: RevisionId,
    pub ref_ordinal: u32,
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProjectionChatRef {
    pub locator: ProjectionChatRefLocator,
    pub target: NoteRef,
    pub target_scope: HistoryScope,
}

#[derive(Clone, Copy, Debug)]
pub struct ProjectionChatRefLimits {
    entries: PageLimit,
    refs: PageLimit,
    bytes: usize,
}

impl ProjectionChatRefLimits {
    pub fn new(entries: PageLimit, refs: PageLimit, bytes: usize) -> DomainResult<Self> {
        if !(REF_BLOCK_BYTES..=MAX_PAGE_BYTES).contains(&bytes) {
            return Err(DomainError::validation(ValidationReason::InvalidLimit));
        }
        Ok(Self {
            entries,
            refs,
            bytes,
        })
    }
}

impl Default for ProjectionChatRefLimits {
    fn default() -> Self {
        Self {
            entries: PageLimit::new(32).expect("fixed entry limit"),
            refs: PageLimit::new(128).expect("fixed reference limit"),
            bytes: 16 * 1024,
        }
    }
}

/// An opaque continuation, tied to a source history, cutoff, and selection.
#[derive(Clone, Debug)]
pub struct ProjectionChatPosition {
    scope: HistoryScope,
    cutoff: SpaceSeq,
    selection: RefSelection,
    after: Option<ProjectionChatEntryKey>,
    partial: Option<PartialEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RefSelection {
    All,
    Entry(ProjectionChatEntryKey),
    Target(HistoryScope),
}

#[derive(Clone, Debug)]
pub struct ProjectionChatPage {
    pub refs: Vec<ProjectionChatRef>,
    pub next: Option<ProjectionChatPosition>,
    /// Number of entry headers fetched from the covering key index.
    pub entries_examined: u16,
    /// UTF-8 bytes loaded from the inline witness or block table.
    pub payload_bytes_read: usize,
    /// Exact primary-key block reads.
    pub payload_blocks_read: u16,
    /// Reads of the original JSON for confirmed inline entries.
    pub inline_values_read: u16,
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
    /// The bounded scan also finds occurrences a previous target purge hid.
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
                partial: None,
            },
        };
        self.with_projection_read(ctx, move |tx| {
            Box::pin(async move {
                validate_snapshot_cutoff_tx(tx, &position.scope, Some(cutoff)).await?;
                // A redaction erases an old array and can invalidate an entry
                // already read in this scan. The partial index bounds this
                // check even for an otherwise empty page.
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

    /// Returns append and redaction positions without scanning an entire
    /// thread. The caller replaces or clears those exact entry positions.
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

    /// Binds recovery to the current history and checks both marker inventories.
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
                let record: Option<(Vec<u8>, i64, bool, bool)> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_as(HEAD)
                        .bind(scope.space_id.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(sqlite_read_error)?,
                    BackendConn::Postgres(conn) => sqlx::query_as(HEAD)
                        .bind(scope.space_id.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(pg_chat_read_error)?,
                };
                let (incarnation, at, has_purges, has_chat_redactions) =
                    record.ok_or(DomainError::ResourceNotFound)?;
                scope.check(&HistoryScope {
                    space_id: scope.space_id.clone(),
                    incarnation: HistoryIncarnation::from_bytes(
                        incarnation.try_into().map_err(|_| corrupt("invalid Space incarnation"))?,
                    ),
                })?;
                Ok(ProjectionErasureHead {
                    at: SpaceSeq::new(stored_sequence(at)?)?,
                    has_purges,
                    has_chat_redactions,
                })
            })
        }).await
    }

    /// Reads only redacted and invalidated entry identities at a command cut.
    /// The seek uses the redaction index even in threads with large live bodies.
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
                let mut records: Vec<(i64, String, i64)> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_as(PAGE)
                        .bind(scope.space_id.as_str())
                        .bind(cut)
                        .bind(at)
                        .bind(thread)
                        .bind(entry)
                        .bind(page_size)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(sqlite_read_error)?,
                    BackendConn::Postgres(conn) => sqlx::query_as(PAGE)
                        .bind(scope.space_id.as_str())
                        .bind(cut)
                        .bind(at)
                        .bind(thread)
                        .bind(entry)
                        .bind(page_size)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(pg_chat_read_error)?,
                };
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
    /// The caller must retain the current source and target owner permits
    /// through delivery of the authorized result.
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
                verify_occurrence(tx, &locator, &target).await
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

#[derive(Clone, Debug)]
struct PartialEntry {
    key: ProjectionChatEntryKey,
    revision: RevisionId,
    blocked: bool,
    next_offset: u64,
    ref_ordinal: u32,
    decoder: RefDecoder,
}

#[derive(Clone, Debug, Default)]
enum RefDecoder {
    #[default]
    Array,
    First,
    Next,
    Object {
        start: u64,
        bytes: [u8; MAX_REF_BYTES],
        len: usize,
    },
    Boundary {
        start: u64,
        target: NoteRef,
    },
    Done,
}

struct DecodedRef {
    start: u64,
    end: u64,
    target: NoteRef,
}

impl RefDecoder {
    fn accept(&mut self, byte: u8, offset: u64) -> Result<Option<DecodedRef>, PortError> {
        match self {
            Self::Array if byte == b'[' => *self = Self::First,
            Self::First if byte == b']' => *self = Self::Done,
            Self::First | Self::Next if byte == b'{' => {
                let mut bytes = [0; MAX_REF_BYTES];
                bytes[0] = byte;
                *self = Self::Object {
                    start: offset,
                    bytes,
                    len: 1,
                };
            }
            Self::Object { start, bytes, len } if *len < MAX_REF_BYTES => {
                bytes[*len] = byte;
                *len += 1;
                if byte == b'}' {
                    let target = serde_json::from_slice(&bytes[..*len])
                        .map_err(|_| corrupt("invalid canonical chat note reference"))?;
                    *self = Self::Boundary {
                        start: *start,
                        target,
                    };
                }
            }
            Self::Boundary { .. } if matches!(byte, b',' | b']') => {
                let next = if byte == b',' { Self::Next } else { Self::Done };
                let Self::Boundary { start, target } = std::mem::replace(self, next) else {
                    return Err(corrupt("invalid chat reference decoder transition"));
                };
                return Ok(Some(DecodedRef {
                    start,
                    end: offset,
                    target,
                }));
            }
            _ => return Err(corrupt("invalid canonical chat reference array")),
        }
        Ok(None)
    }
}

async fn read_page(
    tx: &mut BackendConn<'_>,
    mut position: ProjectionChatPosition,
    limits: ProjectionChatRefLimits,
) -> Result<ProjectionChatPage, PortError> {
    let max_entries = usize::from(limits.entries.get());
    let selected_entry = match &position.selection {
        RefSelection::Entry(entry) => Some(entry),
        _ => None,
    };
    let key = position.partial.as_ref().map(|p| &p.key).or(selected_entry);
    let first = match key {
        Some(key) => exact_entry(tx, &position.scope.space_id, key).await?,
        None => None,
    };
    if position.partial.is_some() && first.is_none() {
        return Err(stale());
    }
    let mut headers = Vec::with_capacity(max_entries);
    headers.extend(first);
    let more = if selected_entry.is_none() {
        let capacity = max_entries - headers.len();
        let after = headers.last().map(|h| &h.key).or(position.after.as_ref());
        let page = entry_page(tx, &position.scope.space_id, after, capacity as i64).await?;
        headers.extend(page);
        headers.len() == max_entries
    } else {
        false
    };

    let mut result = ProjectionChatPage {
        refs: Vec::new(),
        next: None,
        entries_examined: headers.len() as u16,
        payload_bytes_read: 0,
        payload_blocks_read: 0,
        inline_values_read: 0,
    };
    let mut targets = BTreeMap::<SpaceId, Option<HistoryScope>>::new();
    let mut purge_checks = BTreeMap::<(SpaceId, NoteId), bool>::new();
    let mut refs_examined = 0;
    let max_refs = usize::from(limits.refs.get());
    // Target repair copies current references up to the chosen source head.
    // A concurrent erasure cannot invalidate earlier pages: its marker also
    // fences already copied rows. Skip its erased array and keep advancing.
    let repairing = matches!(position.selection, RefSelection::Target(_));
    for head in headers {
        let resumed = position.partial.take();
        if let Some(p) = &resumed
            && (p.revision != head.revision
                || p.key != head.key
                || (!repairing && !head.current_visible()))
        {
            return Err(stale());
        }
        if head.created > position.cutoff {
            position.after = Some(head.key);
            continue;
        }
        if !repairing && head.redacted.is_some_and(|seq| seq > position.cutoff) {
            return Err(stale());
        }
        if !head.current_visible() {
            position.after = Some(head.key);
            continue;
        }
        let mut partial = match resumed {
            Some(partial) => partial,
            None => PartialEntry {
                blocked: has_blocks(tx, &position.scope.space_id, &head.key).await?,
                key: head.key.clone(),
                revision: head.revision,
                next_offset: 0,
                ref_ordinal: 0,
                decoder: RefDecoder::Array,
            },
        };
        while !matches!(partial.decoder, RefDecoder::Done) {
            if limits.bytes - result.payload_bytes_read < REF_BLOCK_BYTES
                || refs_examined >= max_refs
            {
                position.partial = Some(partial);
                result.next = Some(position);
                return Ok(result);
            }
            let block_no = partial.next_offset / REF_BLOCK_BYTES as u64;
            let payload = if partial.blocked {
                result.payload_blocks_read += 1;
                block(tx, &position.scope.space_id, &partial.key, block_no)
                    .await?
                    .ok_or_else(|| corrupt("missing chat reference block"))?
            } else {
                result.inline_values_read += 1;
                inline_payload(tx, &position.scope.space_id, &partial.key).await?
            };
            result.payload_bytes_read += payload.len();
            let start_in_block = (partial.next_offset % REF_BLOCK_BYTES as u64) as usize;
            if start_in_block >= payload.len() {
                return Err(corrupt("chat reference position outside a block"));
            }
            for byte in &payload[start_in_block..] {
                let decoded = partial.decoder.accept(*byte, partial.next_offset)?;
                partial.next_offset += 1;
                if let Some(decoded) = decoded {
                    refs_examined += 1;
                    let ordinal = partial.ref_ordinal;
                    partial.ref_ordinal = partial
                        .ref_ordinal
                        .checked_add(1)
                        .ok_or_else(|| corrupt("chat reference ordinal overflow"))?;
                    let target_space = &decoded.target.space_id;
                    let target_history = match &position.selection {
                        RefSelection::Target(target) => {
                            (&target.space_id == target_space).then_some(target)
                        }
                        _ => match targets.entry(target_space.clone()) {
                            std::collections::btree_map::Entry::Occupied(entry) => {
                                entry.into_mut().as_ref()
                            }
                            std::collections::btree_map::Entry::Vacant(entry) => {
                                entry.insert(target_scope(tx, target_space).await?).as_ref()
                            }
                        },
                    };
                    if let Some(target_history) = target_history
                        && !check_purge(tx, &mut purge_checks, &decoded.target).await?
                    {
                        result.refs.push(ProjectionChatRef {
                            locator: ProjectionChatRefLocator {
                                source: position.scope.clone(),
                                entry: partial.key.clone(),
                                revision: partial.revision.clone(),
                                ref_ordinal: ordinal,
                                start: decoded.start,
                                end: decoded.end,
                            },
                            target: decoded.target,
                            target_scope: target_history.clone(),
                        });
                    }
                }
                let consumed = (partial.next_offset - block_no * REF_BLOCK_BYTES as u64) as usize;
                if matches!(partial.decoder, RefDecoder::Done) {
                    if consumed != payload.len() {
                        return Err(corrupt(
                            "trailing bytes after canonical chat reference array",
                        ));
                    }
                    if partial.blocked
                        && payload.len() == REF_BLOCK_BYTES
                        && block_exists(tx, &position.scope.space_id, &partial.key, block_no + 1)
                            .await?
                    {
                        return Err(corrupt("trailing canonical chat reference block"));
                    }
                    break;
                }
                if refs_examined >= max_refs {
                    position.partial = Some(partial);
                    result.next = Some(position);
                    return Ok(result);
                }
            }
            if !matches!(partial.decoder, RefDecoder::Done)
                && (!partial.blocked || payload.len() != REF_BLOCK_BYTES)
            {
                return Err(corrupt("truncated canonical chat reference array"));
            }
        }
        position.after = Some(head.key);
    }
    if more {
        result.next = Some(position);
    }
    Ok(result)
}

async fn check_purge(
    tx: &mut BackendConn<'_>,
    cache: &mut BTreeMap<(SpaceId, NoteId), bool>,
    target: &NoteRef,
) -> Result<bool, PortError> {
    use std::collections::btree_map::Entry;
    let key = (target.space_id.clone(), target.note_id.clone());
    match cache.entry(key) {
        Entry::Occupied(entry) => Ok(*entry.get()),
        Entry::Vacant(entry) => Ok(*entry
            .insert(is_note_purge_fenced_tx(tx, &target.space_id, target.note_id.as_str()).await?)),
    }
}

#[derive(Debug)]
struct EntryHead {
    key: ProjectionChatEntryKey,
    revision: RevisionId,
    created: SpaceSeq,
    redacted: Option<SpaceSeq>,
    kind: String,
    checkpoint_stale: bool,
}

impl EntryHead {
    fn current_visible(&self) -> bool {
        self.redacted.is_none() && self.kind != "redacted" && !self.checkpoint_stale
    }
}

type RawEntryHead = (String, i64, String, i64, Option<i64>, String, i64);

impl TryFrom<RawEntryHead> for EntryHead {
    type Error = PortError;

    fn try_from(
        (thread, seq, revision, created, redacted, kind, checkpoint_stale): RawEntryHead,
    ) -> Result<Self, PortError> {
        Ok(Self {
            key: ProjectionChatEntryKey {
                thread: ChatThreadId::parse(&thread)?,
                seq: ThreadEntrySeq::new(stored_sequence(seq)?)?,
            },
            revision: RevisionId::parse(&revision)?,
            created: SpaceSeq::new(stored_sequence(created)?)?,
            redacted: redacted
                .map(stored_sequence)
                .transpose()?
                .map(SpaceSeq::new)
                .transpose()?,
            kind,
            checkpoint_stale: checkpoint_stale != 0,
        })
    }
}

macro_rules! entry_header {
    () => {
        "SELECT thread_id, entry_seq, revision_id, created_space_seq, redacted_at_seq,
                kind, CAST(checkpoint_stale AS BIGINT) FROM chat_entries"
    };
}

async fn entry_page(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    after: Option<&ProjectionChatEntryKey>,
    limit: i64,
) -> Result<Vec<EntryHead>, PortError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let (thread, seq) = after.map_or(("", 0), |p| (p.thread.as_str(), p.seq.get() as i64));
    let rows: Vec<RawEntryHead> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(concat!(
            entry_header!(),
            " INDEXED BY idx_chat_entries_projection",
            " WHERE space_id=$1 AND (thread_id,entry_seq)>($2,$3) ORDER BY thread_id,entry_seq LIMIT $4",
        ))
        .bind(space.as_str())
        .bind(thread)
        .bind(seq)
        .bind(limit)
        .fetch_all(&mut **conn)
        .await
        .map_err(sqlite_read_error)?,
        BackendConn::Postgres(conn) => sqlx::query_as(concat!(
            entry_header!(),
            " WHERE space_id=$1 AND (thread_id,entry_seq)>($2,$3) ORDER BY thread_id,entry_seq LIMIT $4",
        ))
        .bind(space.as_str())
        .bind(thread)
        .bind(seq)
        .bind(limit)
        .fetch_all(&mut **conn)
        .await
        .map_err(pg_chat_read_error)?,
    };
    rows.into_iter().map(EntryHead::try_from).collect()
}

async fn exact_entry(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    key: &ProjectionChatEntryKey,
) -> Result<Option<EntryHead>, PortError> {
    let seq = key.seq.get() as i64;
    let row: Option<RawEntryHead> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(concat!(
            entry_header!(),
            " INDEXED BY idx_chat_entries_projection",
            " WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3",
        ))
        .bind(space.as_str())
        .bind(key.thread.as_str())
        .bind(seq)
        .fetch_optional(&mut **conn)
        .await
        .map_err(sqlite_read_error)?,
        BackendConn::Postgres(conn) => sqlx::query_as(concat!(
            entry_header!(),
            " WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3",
        ))
        .bind(space.as_str())
        .bind(key.thread.as_str())
        .bind(seq)
        .fetch_optional(&mut **conn)
        .await
        .map_err(pg_chat_read_error)?,
    };
    row.map(EntryHead::try_from).transpose()
}

async fn redacted_after(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    cutoff: SpaceSeq,
) -> Result<bool, PortError> {
    const QUERY: &str = "SELECT EXISTS(SELECT 1 FROM chat_entries
        WHERE space_id=$1 AND redacted_at_seq>$2)";
    let seq = cutoff.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(seq)
            .fetch_one(&mut **conn)
            .await
            .map_err(sqlite_read_error),
        BackendConn::Postgres(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(seq)
            .fetch_one(&mut **conn)
            .await
            .map_err(pg_chat_read_error),
    }
}

async fn has_blocks(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    key: &ProjectionChatEntryKey,
) -> Result<bool, PortError> {
    block_exists(tx, space, key, 0).await
}

async fn block_exists(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    key: &ProjectionChatEntryKey,
    block_no: u64,
) -> Result<bool, PortError> {
    const QUERY: &str = "SELECT EXISTS(SELECT 1 FROM chat_entry_ref_blocks
        WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3 AND block_no=$4)";
    let seq = key.seq.get() as i64;
    let block_no = i64::try_from(block_no).map_err(|_| corrupt("chat reference block overflow"))?;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(key.thread.as_str())
            .bind(seq)
            .bind(block_no)
            .fetch_one(&mut **conn)
            .await
            .map_err(sqlite_read_error),
        BackendConn::Postgres(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(key.thread.as_str())
            .bind(seq)
            .bind(block_no)
            .fetch_one(&mut **conn)
            .await
            .map_err(pg_chat_read_error),
    }
}

async fn block(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    key: &ProjectionChatEntryKey,
    block_no: u64,
) -> Result<Option<Vec<u8>>, PortError> {
    const QUERY: &str = "SELECT payload FROM chat_entry_ref_blocks
        WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3 AND block_no=$4";
    let seq = key.seq.get() as i64;
    let block_no = i64::try_from(block_no).map_err(|_| corrupt("chat reference block overflow"))?;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(key.thread.as_str())
            .bind(seq)
            .bind(block_no)
            .fetch_optional(&mut **conn)
            .await
            .map_err(sqlite_read_error),
        BackendConn::Postgres(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(key.thread.as_str())
            .bind(seq)
            .bind(block_no)
            .fetch_optional(&mut **conn)
            .await
            .map_err(pg_chat_read_error),
    }
}

async fn inline_payload(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    key: &ProjectionChatEntryKey,
) -> Result<Vec<u8>, PortError> {
    // An oversized TEXT without block 0 is an inconsistent database. The
    // length check uses stored byte length on both engines and bounds the
    // value returned to sqlx even in that case.
    const QUERY: &str = "SELECT CASE WHEN octet_length(referenced_notes_json)<=4096
                               THEN referenced_notes_json END
        FROM chat_entries WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3";
    let seq = key.seq.get() as i64;
    let json: Option<String> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(key.thread.as_str())
            .bind(seq)
            .fetch_one(&mut **conn)
            .await
            .map_err(sqlite_read_error)?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .bind(key.thread.as_str())
            .bind(seq)
            .fetch_one(&mut **conn)
            .await
            .map_err(pg_chat_read_error)?,
    };
    json.map(String::into_bytes)
        .ok_or_else(|| corrupt("missing blocks for oversized chat reference array"))
}

async fn target_scope(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
) -> Result<Option<HistoryScope>, PortError> {
    const QUERY: &str = "SELECT history_incarnation FROM spaces WHERE space_id=$1";
    let raw: Option<Vec<u8>> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(sqlite_read_error)?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(QUERY)
            .bind(space.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(pg_chat_read_error)?,
    };
    raw.map(|bytes| {
        let incarnation = HistoryIncarnation::from_bytes(
            bytes
                .try_into()
                .map_err(|_| corrupt("invalid chat reference history incarnation"))?,
        );
        Ok(HistoryScope {
            space_id: space.clone(),
            incarnation,
        })
    })
    .transpose()
}

async fn verify_occurrence(
    tx: &mut BackendConn<'_>,
    locator: &ProjectionChatRefLocator,
    target: &NoteRef,
) -> Result<bool, PortError> {
    let (Some(first), Some(length)) = (
        locator.start.checked_sub(1),
        locator.end.checked_sub(locator.start),
    ) else {
        return Ok(false);
    };
    if !(2..=MAX_REF_BYTES as u64).contains(&length) {
        return Ok(false);
    }
    let Some(end) = locator.end.checked_add(1) else {
        return Ok(false);
    };
    let space = &locator.source.space_id;
    let key = &locator.entry;
    let mut bytes = Vec::with_capacity(length as usize + 2);
    if has_blocks(tx, space, key).await? {
        let block_size = REF_BLOCK_BYTES as u64;
        for block_no in first / block_size..=(end - 1) / block_size {
            let Some(block) = block(tx, space, key, block_no).await? else {
                return Ok(false);
            };
            let offset = block_no * block_size;
            let low = first.saturating_sub(offset) as usize;
            let high = (end - offset).min(block_size) as usize;
            let Some(slice) = block.get(low..high) else {
                return Ok(false);
            };
            bytes.extend_from_slice(slice);
        }
    } else {
        let payload = inline_payload(tx, space, key).await?;
        if end > payload.len() as u64 {
            return Ok(false);
        }
        bytes.extend_from_slice(&payload[first as usize..end as usize]);
    }
    let valid_left = if locator.ref_ordinal == 0 { b'[' } else { b',' };
    let Some((&left, middle)) = bytes.split_first() else {
        return Ok(false);
    };
    let Some((&right, object)) = middle.split_last() else {
        return Ok(false);
    };
    if left != valid_left
        || !matches!(right, b',' | b']')
        || object.first() != Some(&b'{')
        || object.last() != Some(&b'}')
    {
        return Ok(false);
    }
    Ok(serde_json::from_slice::<NoteRef>(object).is_ok_and(|actual| &actual == target))
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
    // A null position skips every row at the exclusive lower bound. Thread IDs
    // are ASCII and nonempty, so the sequence predicate is sufficient first.
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
    let rows: Vec<(i64, String, i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(QUERY)
            .bind(scope.space_id.as_str())
            .bind(through.get() as i64)
            .bind(seq.get() as i64)
            .bind(thread)
            .bind(entry)
            .bind(limit_raw)
            .fetch_all(&mut **conn)
            .await
            .map_err(sqlite_read_error)?,
        BackendConn::Postgres(conn) => sqlx::query_as(QUERY)
            .bind(scope.space_id.as_str())
            .bind(through.get() as i64)
            .bind(seq.get() as i64)
            .bind(thread)
            .bind(entry)
            .bind(limit_raw)
            .fetch_all(&mut **conn)
            .await
            .map_err(pg_chat_read_error)?,
    };

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

/// Append and redaction update these rows inside the same canonical transaction
/// as the original JSON. Short references leave no auxiliary rows.
pub(crate) async fn write_chat_ref_blocks_tx(
    tx: &mut BackendConn<'_>,
    space: &str,
    thread: &str,
    seq: i64,
    original: &[u8],
) -> Result<(), PortError> {
    if original.len() <= REF_BLOCK_BYTES {
        return Ok(());
    }
    const QUERY: &str =
        "INSERT INTO chat_entry_ref_blocks(space_id,thread_id,entry_seq,block_no,payload)
        VALUES($1,$2,$3,$4,$5)";
    for (index, bytes) in original.chunks(REF_BLOCK_BYTES).enumerate() {
        match tx {
            BackendConn::Sqlite(conn) => sqlx::query(QUERY)
                .bind(space)
                .bind(thread)
                .bind(seq)
                .bind(index as i64)
                .bind(bytes)
                .execute(&mut **conn)
                .await
                .map(|_| ()),
            BackendConn::Postgres(conn) => sqlx::query(QUERY)
                .bind(space)
                .bind(thread)
                .bind(seq)
                .bind(index as i64)
                .bind(bytes)
                .execute(&mut **conn)
                .await
                .map(|_| ()),
        }
        .map_err(|err| internal_not_committed("write_chat_reference_block", err.to_string()))?;
    }
    Ok(())
}

pub(crate) async fn clear_chat_ref_blocks_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    seq: i64,
) -> Result<(), PortError> {
    const QUERY: &str = "DELETE FROM chat_entry_ref_blocks
        WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(QUERY)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(seq)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(QUERY)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(seq)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(|err| internal_not_committed("clear_chat_reference_blocks", err.to_string()))
}

fn stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

fn corrupt(reason: &'static str) -> PortError {
    internal_not_committed("corrupt_chat_reference_storage", reason)
}

fn stored_sequence(value: i64) -> Result<u64, PortError> {
    u64::try_from(value).map_err(|_| corrupt("negative canonical chat sequence"))
}

fn sqlite_read_error(error: sqlx::Error) -> PortError {
    internal_not_committed("sqlite_projection_chat_read", error.to_string())
}

fn pg_chat_read_error(error: sqlx::Error) -> PortError {
    pg_read_error("pg_projection_chat_read", error)
}
