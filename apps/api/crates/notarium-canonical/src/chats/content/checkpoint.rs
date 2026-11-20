//! Reduce immutable chat edges to their live non-chat dependencies. Any redaction
//! discards the cached proof of every later entry in the same thread.
use std::collections::{BTreeMap, btree_map::Entry};

use notarium_core::{
    model::FolderRef,
    ports::{MAX_PROVIDER_ORIGINS, MAX_PROVIDER_SECONDARY_PROJECTS},
};

use super::*;
use crate::domain::common::CommandDeadline;

#[derive(Default)]
struct Sources {
    pending: BTreeMap<ThreadEntrySeq, ContentDigest>,
    retained: BTreeMap<String, ProviderOrigin>,
    retained_bytes: usize,
    projects: BTreeMap<(SpaceId, FolderId), FolderRef>,
}

impl Sources {
    fn add(
        &mut self,
        proof: &ChatProvenance,
        space: &SpaceId,
        thread: &ThreadHeadRow,
        before: Option<ThreadEntrySeq>,
    ) -> Result<bool, PortError> {
        for origin in &proof.origins {
            match origin {
                ProviderOrigin::Chat {
                    space: id,
                    thread: source,
                    entry,
                    digest,
                    project,
                } => {
                    if id != space
                        || source != &thread.thread_id
                        || project != &thread.project_folder
                        || before.is_some_and(|limit| *entry >= limit)
                    {
                        return Ok(false);
                    }
                    match self.pending.entry(*entry) {
                        Entry::Occupied(known) if known.get() != digest => return Ok(false),
                        Entry::Vacant(vacant) => {
                            vacant.insert(*digest);
                        }
                        _ => {}
                    }
                }
                _ => {
                    let key = serde_json::to_string(origin)
                        .map_err(|e| internal_not_committed("encode_chat_source", e.to_string()))?;
                    if let Entry::Vacant(vacant) = self.retained.entry(key) {
                        self.retained_bytes += vacant.key().len();
                        if self.retained_bytes > ChatProvenance::MAX_BYTES {
                            return Ok(false);
                        }
                        vacant.insert(origin.clone());
                    }
                }
            }
            if self.pending.len() + self.retained.len() > MAX_PROVIDER_ORIGINS {
                return Ok(false);
            }
        }
        for project in &proof.projects {
            self.projects.insert(
                (project.space_id.clone(), project.folder_id.clone()),
                project.clone(),
            );
        }
        Ok(self.projects.len() <= MAX_PROVIDER_SECONDARY_PROJECTS)
    }
}

// Project by ordinal: a graph walk only needs the immutable body digest,
// taint and outgoing edges. Full transcript metadata is unnecessary here.
type SourceRow = (
    i64,
    String,
    Option<String>,
    Option<Vec<u8>>,
    i32,
    Option<String>,
);

/// Old proofs may be thousands of links long. Fetch a bounded neighborhood and
/// consume it in descending order as dependencies are discovered. A requested
/// row is always included. Large proofs outside that row are loaded only if
/// referenced, bounding speculative reads to 63 * 4096 Unicode scalars.
pub(super) enum PageReader<'a, 'db> {
    Pinned(&'a mut BackendConn<'db>),
    Snapshots(&'a CanonicalStore, &'a CallBudget, CommandDeadline),
    PrepareAppend(&'a CanonicalStore, &'a CallBudget, CommandDeadline),
}

impl PageReader<'_, '_> {
    async fn read(
        &mut self,
        scope: &HistoryScope,
        thread: &ThreadHeadRow,
        end: ThreadEntrySeq,
        span: u64,
    ) -> Result<Option<Vec<SourceRow>>, PortError> {
        let preparing_append = matches!(self, Self::PrepareAppend(..));
        match self {
            Self::Pinned(tx) => {
                load_page(tx, scope, &thread.thread_id, &thread.head_rev_id, end, span)
                    .await
                    .map(Some)
            }
            Self::Snapshots(store, budget, deadline)
            | Self::PrepareAppend(store, budget, deadline) => {
                let mut remaining = (*budget).clone();
                remaining.remaining = deadline.remaining(budget)?;
                let scope = scope.clone();
                let thread_id = thread.thread_id.clone();
                let revision = thread.head_rev_id.clone();
                store
                    .with_read_tx_budget(Some(&remaining), move |tx| {
                        Box::pin(async move {
                            let rows =
                                load_page(tx, &scope, &thread_id, &revision, end, span).await?;
                            if rows.is_empty() && preparing_append {
                                // Only a lost revision cut makes this optimization optional.
                                // A missing source on the same cut remains a read error.
                                let space = load_space_record(tx, &scope.space_id).await?;
                                scope.check(&space.scope)?;
                                let head =
                                    load_thread_head_tx(tx, &scope.space_id, &thread_id).await?;
                                if head.head_rev_id != revision {
                                    return Ok(None);
                                }
                            }
                            Ok(Some(rows))
                        })
                    })
                    .await
            }
        }
    }
}

async fn load_page(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    thread: &ChatThreadId,
    revision: &RevisionId,
    end: ThreadEntrySeq,
    span: u64,
) -> Result<Vec<SourceRow>, PortError> {
    let sql = "SELECT entry_seq, CASE WHEN checkpoint_stale<>0 THEN 'redacted' ELSE kind END,
        inline_text, payload_blake3, CAST(ext_space_tainted AS INTEGER), provenance_json
        FROM chat_entries WHERE space_id=$1 AND thread_id=$2 AND entry_seq>$3 AND entry_seq<=$4
        AND (entry_seq=$4 OR provenance_json IS NULL OR length(provenance_json)<=4096)
        AND EXISTS (SELECT 1 FROM chat_threads t JOIN spaces s ON s.space_id=t.space_id
            WHERE t.space_id=$1 AND t.thread_id=$2 AND t.head_rev_id=$5 AND s.history_incarnation=$6)
        ORDER BY entry_seq";
    macro_rules! fetch {
        ($conn:expr) => {
            sqlx::query_as::<_, SourceRow>(sql)
                .bind(scope.space_id.as_str())
                .bind(thread.as_str())
                .bind(end.get().saturating_sub(span) as i64)
                .bind(end.get() as i64)
                .bind(revision.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .fetch_all(&mut **$conn)
                .await
        };
    }
    match tx {
        BackendConn::Sqlite(conn) => fetch!(conn),
        BackendConn::Postgres(conn) => fetch!(conn),
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_proof_page", error))
}

/// A chat edge carries the same live Space, thread and project checks as the
/// derived entry. Its digest is immutable until redaction. Other origins retain
/// their full identity and are admitted against current policy at every dispatch.
pub(super) async fn fold(
    mut reader: PageReader<'_, '_>,
    scope: &HistoryScope,
    thread: &ThreadHeadRow,
    parent: ThreadEntrySeq,
    tainted: bool,
    proof: &ChatProvenance,
) -> Result<Option<ChatProvenance>, PortError> {
    if !proof
        .origins
        .iter()
        .any(|origin| matches!(origin, ProviderOrigin::Chat { .. }))
    {
        return Ok(None);
    }
    let space = &scope.space_id;
    let mut sources = Sources::default();
    if !sources.add(proof, space, thread, None)? {
        return Ok(None);
    }
    // All edges point backwards. Visiting the greatest sequence first allows
    // us to forget discharged entries and bounds memory by the active frontier.

    let mut page: Vec<SourceRow> = Vec::new();
    const PAGE_ROWS: u64 = 64;
    let mut span = if sources.pending.len() == 1 {
        1
    } else {
        PAGE_ROWS
    };
    while let Some((entry, digest)) = sources.pending.pop_last() {
        if entry > parent {
            return Ok(None);
        }
        while page.last().is_some_and(|row| row.0 > entry.get() as i64) {
            page.pop();
        }
        if page.last().is_none_or(|row| row.0 != entry.get() as i64) {
            let Some(rows) = reader.read(scope, thread, entry, span).await? else {
                return Ok(None);
            };
            page = rows;
            if page.is_empty() {
                // A changed head or incarnation invalidates the entire walk.
                return Err(DomainError::ResourceNotFound.into());
            }
            span = PAGE_ROWS;
        }
        let Some((seq, kind, inline, blob, source_taint, proof)) = page.pop() else {
            return Ok(None);
        };
        if seq != entry.get() as i64 || kind == "redacted" || (source_taint != 0 && !tainted) {
            return Ok(None);
        }
        let matches = match blob {
            Some(bytes) => bytes.as_slice() == digest.as_bytes(),
            None => inline
                .is_some_and(|text| blake3::hash(text.as_bytes()).as_bytes() == digest.as_bytes()),
        };
        if !matches {
            return Ok(None);
        }
        match decode_proof(proof.as_deref())? {
            Some(child) => {
                if !sources.add(&child, space, thread, Some(entry))? {
                    return Ok(None);
                }
            }
            None if kind != "human" => return Ok(None),
            None => {}
        }
    }
    let folded = ChatProvenance {
        origins: sources.retained.into_values().collect(),
        projects: sources.projects.into_values().collect(),
        compacts_through: proof.compacts_through,
    };
    let bytes = serde_json::to_vec(&folded)
        .map_err(|e| internal_not_committed("encode_checkpoint_proof", e.to_string()))?;
    Ok((bytes.len() <= ChatProvenance::MAX_BYTES).then_some(folded))
}
