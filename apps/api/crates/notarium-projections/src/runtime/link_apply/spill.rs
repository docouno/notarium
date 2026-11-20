//! Ordered, command-private lookup keys. The durable output still goes through
//! CommandSink. A large seed or command spills its lookup keys and unresolved
//! inputs to a delete-on-close SQLite temporary database with a bounded pager.
use std::{
    collections::BTreeMap,
    ops::Bound::{Excluded, Included},
    sync::Mutex,
};

use notarium_core::error::PortError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

use crate::{
    derived::{CandidateLookupKey, ProjectedNoteAlias},
    links::{AliasKey, CandidatePosition, CandidateQuery, NoteAliasPosition, ResolutionIndex},
};
use notarium_core::ids::{FolderId, NoteId, SpaceId};

const MEMORY_BYTES: usize = 4 * 1024 * 1024;
const RAW_PAGE_BYTES: usize = 1024 * 1024;

pub(super) const SOURCE: u8 = 1;
pub(super) const LEAF: u8 = 2;
pub(super) const SEEN: u8 = 3;
pub(super) const CANDIDATES_REPLACED: u8 = 4;
pub(super) const SLOTS_REPLACED: u8 = 5;
pub(super) const WATCHED: u8 = 6;
pub(super) const RAW: u8 = 7;
pub(super) const COLD_LINK: u8 = 8;
const CANDIDATE: u8 = 9;
const ALIAS_SLUG: u8 = 10;
const ALIAS_TITLE: u8 = 11;
const SLOT: u8 = 12;
pub(super) const SOURCE_CANDIDATE: u8 = 13;

/// Numeric and text fields preserve Rust's tuple ordering under byte comparison.
#[derive(Clone)]
pub(super) struct Key(Vec<u8>);

impl Key {
    pub(super) fn new(table: u8) -> Self {
        Self(vec![table])
    }

    pub(super) fn number(mut self, value: u32) -> Self {
        self.0.extend(value.to_be_bytes());
        self
    }

    fn long(mut self, value: u64) -> Self {
        self.0.extend(value.to_be_bytes());
        self
    }

    fn signed(self, value: i64) -> Self {
        self.long((value as u64) ^ (1 << 63))
    }

    pub(super) fn text(mut self, value: &str) -> Self {
        for byte in value.bytes() {
            self.0.push(byte);
            if byte == 0 {
                self.0.push(255);
            }
        }
        self.0.extend([0, 0]);
        self
    }

    fn end(&self) -> Vec<u8> {
        let mut end = self.0.clone();
        while let Some(last) = end.pop() {
            if last != 255 {
                end.push(last + 1);
                break;
            }
        }
        end
    }
}

enum Backing {
    Memory {
        rows: BTreeMap<Vec<u8>, Vec<u8>>,
        bytes: usize,
    },
    File(Connection),
}

pub(super) struct Scratch(Mutex<Backing>);

impl Default for Scratch {
    fn default() -> Self {
        Self(Mutex::new(Backing::Memory {
            rows: BTreeMap::new(),
            bytes: 0,
        }))
    }
}

fn error(error: impl std::fmt::Display) -> PortError {
    notarium_canonical::codec::internal_not_committed("projection_link_scratch", error.to_string())
}

impl Scratch {
    pub(super) fn put(&mut self, key: Key, value: &impl Serialize) -> Result<(), PortError> {
        let encoded = rmp_serde::to_vec(value).map_err(error)?;
        let backing = self.0.get_mut().map_err(error)?;
        if let Backing::Memory { rows, bytes } = backing {
            let size = if let Some(old) = rows.get(&key.0) {
                bytes
                    .saturating_sub(old.capacity())
                    .saturating_add(encoded.capacity())
            } else {
                bytes.saturating_add(key.0.capacity() + encoded.capacity() + 112)
            };
            if size <= MEMORY_BYTES {
                *bytes = size;
                rows.insert(key.0, encoded);
                return Ok(());
            }
            // SQLite owns the temporary filename and its deletion, including
            // unwinding or process exit. This database has no recovery role.
            let db = Connection::open("").map_err(error)?;
            db.execute_batch(
                "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
                PRAGMA mmap_size=0; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;
                CREATE TABLE work(k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID; BEGIN",
            )
            .map_err(error)?;
            {
                let mut insert = db
                    .prepare_cached("INSERT INTO work VALUES(?,?)")
                    .map_err(error)?;
                for (k, v) in std::mem::take(rows) {
                    insert.execute(params![k, v]).map_err(error)?;
                }
            }
            *backing = Backing::File(db);
        }
        if let Backing::File(db) = backing {
            db.prepare_cached("INSERT OR REPLACE INTO work VALUES(?,?)")
                .map_err(error)?
                .execute(params![key.0, encoded])
                .map_err(error)?;
        }
        Ok(())
    }

    pub(super) fn get<T: DeserializeOwned>(&self, key: Key) -> Result<Option<T>, PortError> {
        let backing = self.0.lock().map_err(error)?;
        match &*backing {
            Backing::Memory { rows, .. } => rows
                .get(&key.0)
                .map(|b| rmp_serde::from_slice(b).map_err(error))
                .transpose(),
            Backing::File(db) => {
                let value: Option<Vec<u8>> = db
                    .prepare_cached("SELECT v FROM work WHERE k=?")
                    .map_err(error)?
                    .query_row([key.0], |r| r.get(0))
                    .optional()
                    .map_err(error)?;
                value
                    .map(|b| rmp_serde::from_slice(&b).map_err(error))
                    .transpose()
            }
        }
    }

    pub(super) fn contains(&self, key: Key) -> Result<bool, PortError> {
        let backing = self.0.lock().map_err(error)?;
        match &*backing {
            Backing::Memory { rows, .. } => Ok(rows.contains_key(&key.0)),
            Backing::File(db) => db
                .prepare_cached("SELECT 1 FROM work WHERE k=?")
                .map_err(error)?
                .exists([key.0])
                .map_err(error),
        }
    }

    pub(super) fn insert_marker(&mut self, key: Key) -> Result<bool, PortError> {
        if self.contains(key.clone())? {
            return Ok(false);
        }
        self.put(key, &())?;
        Ok(true)
    }

    fn range<T: DeserializeOwned>(
        &self,
        start: Vec<u8>,
        end: Vec<u8>,
        limit: u16,
        max_bytes: usize,
    ) -> Result<Vec<(Key, T)>, PortError> {
        let backing = self.0.lock().map_err(error)?;
        let mut result = Vec::new();
        let mut bytes = 0usize;
        let mut accept = |k: &[u8], v: &[u8]| -> Result<bool, PortError> {
            bytes = bytes.saturating_add(k.len()).saturating_add(v.len());
            if bytes > max_bytes && !result.is_empty() {
                return Ok(false);
            }
            result.push((Key(k.to_vec()), rmp_serde::from_slice(v).map_err(error)?));
            Ok(true)
        };
        match &*backing {
            Backing::Memory { rows, .. } => {
                for (k, v) in rows
                    .range((Included(start), Excluded(end)))
                    .take(usize::from(limit))
                {
                    if !accept(k, v)? {
                        break;
                    }
                }
            }
            Backing::File(db) => {
                let mut stmt = db
                    .prepare_cached("SELECT k,v FROM work WHERE k>=? AND k<? ORDER BY k LIMIT ?")
                    .map_err(error)?;
                let mut rows = stmt.query(params![start, end, limit]).map_err(error)?;
                while let Some(row) = rows.next().map_err(error)? {
                    let bytes = row.get_ref(1).map_err(error)?.as_blob().map_err(error)?;
                    let key = row.get_ref(0).map_err(error)?.as_blob().map_err(error)?;
                    if !accept(key, bytes)? {
                        break;
                    }
                }
            }
        }
        Ok(result)
    }

    pub(super) fn page<T: DeserializeOwned>(
        &self,
        prefix: Key,
        after: Option<&Key>,
        limit: u16,
    ) -> Result<Vec<(Key, T)>, PortError> {
        let start = after.map_or_else(
            || prefix.0.clone(),
            |key| {
                let mut k = key.0.clone();
                k.push(0);
                k
            },
        );
        // A raw target can be as large as the source note. Keep one oversized
        // input readable without retaining a whole page of such inputs.
        let max_bytes = if matches!(prefix.0[0], RAW | COLD_LINK) {
            RAW_PAGE_BYTES
        } else {
            usize::MAX
        };
        self.range(start, prefix.end(), limit, max_bytes)
    }

    pub(super) fn candidate(&mut self, row: &CandidateLookupKey) -> Result<(), PortError> {
        let key = Key::new(CANDIDATE)
            .signed(row.scope_folder_dense_id)
            .text(&row.leaf_norm_key)
            .number(row.tier)
            .signed(row.created_at_sec)
            .number(row.created_at_nsec)
            .text(row.target_note_id.as_str());
        self.put(key, row)
    }

    pub(super) fn alias(&mut self, row: &ProjectedNoteAlias) -> Result<(), PortError> {
        for (table, leaf) in [
            (ALIAS_SLUG, &row.old_slug_fold),
            (ALIAS_TITLE, &row.old_title_norm),
        ] {
            let key = Key::new(table)
                .text(leaf)
                .text(row.old_parent_folder_id.as_str())
                .text(&row.old_slug_fold)
                .long(row.created_seq.get())
                .text(row.target_note_id.as_str());
            self.put(key, row)?;
        }
        Ok(())
    }

    pub(super) fn slot(
        &mut self,
        parent: &FolderId,
        slug: &str,
        note: &NoteId,
    ) -> Result<(), PortError> {
        self.put(Key::new(SLOT).text(parent.as_str()).text(slug), note)
    }
}

impl ResolutionIndex for Scratch {
    async fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> Result<Vec<CandidateLookupKey>, PortError> {
        let prefix = Key::new(CANDIDATE).signed(query.folder).text(query.leaf);
        let mut start = prefix.clone().number(query.min_tier).0;
        if let Some(pos) = after {
            let mut continuation = prefix
                .clone()
                .number(pos.tier)
                .signed(pos.created_at_sec)
                .number(pos.created_at_nsec)
                .text(pos.note.as_str())
                .0;
            continuation.push(0);
            start = start.max(continuation);
        }
        let end = prefix.number(query.max_tier).end();
        let mut result = Vec::new();
        while start < end && result.len() < usize::from(limit) {
            let page = self.range::<CandidateLookupKey>(start, end.clone(), limit, usize::MAX)?;
            if page.is_empty() {
                break;
            }
            let done = page.len() < usize::from(limit);
            start = page.last().expect("nonempty page").0.0.clone();
            start.push(0);
            for (_, row) in page {
                if row.space_id == *query.space
                    && query
                        .exact_note
                        .is_none_or(|id| id == row.target_note_id.as_str())
                {
                    result.push(row);
                    if result.len() == usize::from(limit) {
                        break;
                    }
                }
            }
            if done {
                break;
            }
        }
        Ok(result)
    }

    async fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        let table = match selector {
            AliasKey::Slug => ALIAS_SLUG,
            AliasKey::Title => ALIAS_TITLE,
        };
        let prefix = Key::new(table).text(leaf);
        let after = after.map(|pos| {
            prefix
                .clone()
                .text(pos.parent.as_str())
                .text(&pos.slug)
                .long(pos.seq.get())
                .text(pos.note.as_str())
        });
        Ok(self
            .page::<ProjectedNoteAlias>(prefix, after.as_ref(), limit)?
            .into_iter()
            .map(|(_, row)| row)
            .filter(|row| row.space_id == *space)
            .collect())
    }

    async fn slot_occupant(
        &self,
        _space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> Result<Option<NoteId>, PortError> {
        self.get(Key::new(SLOT).text(parent.as_str()).text(slug))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        derived::DerivedMutation,
        links::{FolderTopology, LinkFolder},
        runtime::link_apply::{ColdLinks, PAGE},
    };

    #[tokio::test]
    async fn spilled_seed_keeps_order_and_drains_at_most_one_link_page() {
        let space = SpaceId::from_bytes([1; 16]);
        let root = FolderId::from_bytes([2; 16]);
        let folders = FolderTopology::build(
            root.clone(),
            [LinkFolder {
                id: root.clone(),
                dense_id: 0,
                parent: None,
                slug_fold: String::new(),
                active: true,
            }],
            [],
        )
        .unwrap();
        let mut cold = ColdLinks::default();
        const TOTAL: u32 = 650;
        let target = "x".repeat(16_384);
        for ordinal in (0..TOTAL).rev() {
            let dense = 1u32;
            cold.index
                .put(
                    Key::new(COLD_LINK).number(dense).number(ordinal),
                    &(dense, &root, false, ordinal, &target),
                )
                .unwrap();
        }
        {
            let locked = cold.index.0.lock().unwrap();
            let Backing::File(db) = &*locked else {
                panic!("seed exceeded scratch memory budget");
            };
            let cache: i64 = db.query_row("PRAGMA cache_size", [], |r| r.get(0)).unwrap();
            assert_eq!(cache, -4096);
            let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
            let page_size: i64 = db.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
            assert!(pages * page_size > MEMORY_BYTES as i64);
        }
        let mut read = 0;
        loop {
            let rows = cold.resolve_page(&space, &folders).await.unwrap();
            if rows.is_empty() {
                break;
            }
            assert!(rows.len() <= usize::from(PAGE));
            assert!(rows.len() * target.len() <= RAW_PAGE_BYTES);
            for row in rows {
                let DerivedMutation::UpsertLink(link) = row else {
                    panic!("expected a link");
                };
                assert_eq!(link.link_ord, read);
                assert_eq!(link.raw_target, target);
                read += 1;
            }
        }
        assert_eq!(read, TOTAL);
    }

    #[test]
    fn repeated_keys_do_not_exhaust_the_in_memory_budget() {
        let mut scratch = Scratch::default();
        let value = "s".repeat(16_384);
        for _ in 0..512 {
            scratch.put(Key::new(LEAF).text(&value), &value).unwrap();
        }
        assert!(matches!(*scratch.0.lock().unwrap(), Backing::Memory { .. }));
        assert!(
            scratch
                .insert_marker(Key::new(WATCHED).number(1).number(1))
                .unwrap()
        );
        assert!(
            !scratch
                .insert_marker(Key::new(WATCHED).number(1).number(1))
                .unwrap()
        );
    }
}
