//! Ordered, command-private lookup keys. The durable output still goes through
//! CommandSink. A large seed or command spills its lookup keys and unresolved
//! inputs to a private delete-on-close SQLite file inside the projection cache
//! scratch directory, keeping blocking disk I/O off Tokio worker threads.
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io,
    ops::Bound::{Excluded, Included},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use notarium_core::{
    epoch::DataRoot,
    error::PortError,
    ids::{FolderId, NoteId, SpaceId},
    ports::Cancellation,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

use crate::{
    derived::{CandidateLookupKey, ProjectedNoteAlias},
    links::{AliasKey, CandidatePosition, CandidateQuery, NoteAliasPosition, ResolutionIndex},
    runtime::apply::check_stop,
};

const MEMORY_BYTES: usize = 4 * 1024 * 1024;
const RAW_PAGE_BYTES: usize = 1024 * 1024;
const SPILL_PREFIX: &str = "link_spill_";

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

struct SpillFile {
    db: Option<Connection>,
    path: PathBuf,
}

impl SpillFile {
    fn open_in(scratch_dir: &Path) -> Result<Self, PortError> {
        ensure_private_scratch_dir(scratch_dir).map_err(error)?;
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(error)?;
        let path = scratch_dir.join(format!("{SPILL_PREFIX}{}.sqlite", hex_lower(&nonce)));

        // Exclusively create the spill file with 0600 permissions and O_NOFOLLOW
        // before handing it to SQLite so no pre-existing file or symlink is opened.
        {
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options
                    .mode(0o600)
                    .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
            }
            let _created = options.open(&path).map_err(error)?;
        }

        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let db = match Connection::open_with_flags(&path, flags) {
            Ok(db) => db,
            Err(err) => {
                let _ = remove_spill_paths(&path);
                return Err(error(err));
            }
        };
        let setup = db.execute_batch(
            "PRAGMA journal_mode=OFF;
             PRAGMA synchronous=OFF;
             PRAGMA secure_delete=ON;
             PRAGMA mmap_size=0;
             PRAGMA cache_size=-4096;
             PRAGMA temp_store=MEMORY;
             CREATE TABLE work(k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID;
             BEGIN;",
        );
        if let Err(err) = setup {
            drop(db);
            let _ = remove_spill_paths(&path);
            return Err(error(err));
        }
        Ok(Self { db: Some(db), path })
    }

    fn db(&self) -> Result<&Connection, PortError> {
        self.db
            .as_ref()
            .ok_or_else(|| error("spill database closed"))
    }
}

impl Drop for SpillFile {
    fn drop(&mut self) {
        self.db.take();
        let _ = remove_spill_paths(&self.path);
    }
}

fn remove_spill_paths(path: &Path) -> io::Result<()> {
    let mut first_err = None;
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let target = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            let mut os = path.as_os_str().to_os_string();
            os.push(suffix);
            PathBuf::from(os)
        };
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) if first_err.is_none() => first_err = Some(err),
            Err(_) => {}
        }
    }
    first_err.map_or(Ok(()), Err)
}

fn ensure_private_scratch_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "projection scratch directory is aliased",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "projection scratch directory is aliased",
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "projection scratch directory has a different owner",
            ));
        }
        if meta.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
            let rechecked = fs::symlink_metadata(dir)?;
            if !rechecked.is_dir()
                || rechecked.uid() != rustix::process::geteuid().as_raw()
                || rechecked.permissions().mode() & 0o077 != 0
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "projection scratch directory is not private",
                ));
            }
        }
    }
    Ok(())
}

/// Removes orphaned `link_spill_*` scratch files left behind after a crash.
pub(crate) fn sweep_scratch_dir(root: &DataRoot) -> io::Result<()> {
    let dir = root.projection_scratch_dir();
    let meta = match fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    if !meta.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != rustix::process::geteuid().as_raw() {
            return Ok(());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(());
        }
    }
    for entry in fs::read_dir(&dir)? {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(SPILL_PREFIX) {
            continue;
        }
        let path = entry.path();
        if fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

enum Backing {
    Memory {
        rows: BTreeMap<Vec<u8>, Vec<u8>>,
        bytes: usize,
    },
    File(SpillFile),
}

impl Backing {
    fn put_entries(
        &mut self,
        scratch_dir: &Path,
        spilled: &AtomicBool,
        stop: &Cancellation,
        entries: Vec<(Key, Vec<u8>)>,
    ) -> Result<(), PortError> {
        let mut iter = entries.into_iter().peekable();
        if let Backing::Memory { rows, bytes } = self {
            while let Some((key, encoded)) = iter.peek() {
                let size = if let Some(old) = rows.get(&key.0) {
                    bytes
                        .saturating_sub(old.capacity())
                        .saturating_add(encoded.capacity())
                } else {
                    bytes.saturating_add(key.0.capacity() + encoded.capacity() + 112)
                };
                if size <= MEMORY_BYTES {
                    *bytes = size;
                    let (key, encoded) = iter.next().expect("peeked entry");
                    rows.insert(key.0, encoded);
                } else {
                    let spill = SpillFile::open_in(scratch_dir)?;
                    {
                        let db = spill.db()?;
                        let mut insert = db
                            .prepare_cached("INSERT INTO work VALUES(?,?)")
                            .map_err(error)?;
                        for (idx, (k, v)) in std::mem::take(rows).into_iter().enumerate() {
                            if idx & 255 == 0 {
                                check_stop(stop)?;
                            }
                            insert.execute(params![k, v]).map_err(error)?;
                        }
                    }
                    *self = Backing::File(spill);
                    spilled.store(true, Ordering::Release);
                    break;
                }
            }
        }
        if let Backing::File(spill) = self {
            let db = spill.db()?;
            let mut stmt = db
                .prepare_cached("INSERT OR REPLACE INTO work VALUES(?,?)")
                .map_err(error)?;
            for (idx, (key, encoded)) in iter.enumerate() {
                if idx & 255 == 0 {
                    check_stop(stop)?;
                }
                stmt.execute(params![key.0, encoded]).map_err(error)?;
            }
        }
        Ok(())
    }

    fn get<T: DeserializeOwned>(&self, key: &Key) -> Result<Option<T>, PortError> {
        match self {
            Backing::Memory { rows, .. } => rows
                .get(&key.0)
                .map(|b| rmp_serde::from_slice(b).map_err(error))
                .transpose(),
            Backing::File(spill) => {
                let value: Option<Vec<u8>> = spill
                    .db()?
                    .prepare_cached("SELECT v FROM work WHERE k=?")
                    .map_err(error)?
                    .query_row([&key.0], |r| r.get(0))
                    .optional()
                    .map_err(error)?;
                value
                    .map(|b| rmp_serde::from_slice(&b).map_err(error))
                    .transpose()
            }
        }
    }

    fn range<T: DeserializeOwned>(
        &self,
        start: Vec<u8>,
        end: Vec<u8>,
        limit: u16,
        max_bytes: usize,
    ) -> Result<Vec<(Key, T)>, PortError> {
        match self {
            Backing::Memory { rows, .. } => range_memory(rows, start, end, limit, max_bytes),
            Backing::File(spill) => {
                let mut result = Vec::new();
                let mut bytes = 0usize;
                let mut stmt = spill
                    .db()?
                    .prepare_cached("SELECT k,v FROM work WHERE k>=? AND k<? ORDER BY k LIMIT ?")
                    .map_err(error)?;
                let mut rows = stmt.query(params![start, end, limit]).map_err(error)?;
                while let Some(row) = rows.next().map_err(error)? {
                    let val_bytes = row.get_ref(1).map_err(error)?.as_blob().map_err(error)?;
                    let key_bytes = row.get_ref(0).map_err(error)?.as_blob().map_err(error)?;
                    bytes = bytes
                        .saturating_add(key_bytes.len())
                        .saturating_add(val_bytes.len());
                    if bytes > max_bytes && !result.is_empty() {
                        break;
                    }
                    result.push((
                        Key(key_bytes.to_vec()),
                        rmp_serde::from_slice(val_bytes).map_err(error)?,
                    ));
                }
                Ok(result)
            }
        }
    }

    fn page<T: DeserializeOwned>(
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
        let max_bytes = if matches!(prefix.0[0], RAW | COLD_LINK) {
            RAW_PAGE_BYTES
        } else {
            usize::MAX
        };
        self.range(start, prefix.end(), limit, max_bytes)
    }
}

pub(super) struct SyncScratch<'a> {
    backing: &'a Mutex<Backing>,
    stop: &'a Cancellation,
}

impl SyncScratch<'_> {
    pub(super) fn page<T: DeserializeOwned>(
        &self,
        prefix: Key,
        after: Option<&Key>,
        limit: u16,
    ) -> Result<Vec<(Key, T)>, PortError> {
        check_stop(self.stop)?;
        let guard = self.backing.lock().map_err(error)?;
        guard.page(prefix, after, limit)
    }
}

impl ResolutionIndex for SyncScratch<'_> {
    fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> impl std::future::Future<Output = Result<Vec<CandidateLookupKey>, PortError>> + Send {
        let out = (|| {
            check_stop(self.stop)?;
            let guard = self.backing.lock().map_err(error)?;
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
                let page =
                    guard.range::<CandidateLookupKey>(start, end.clone(), limit, usize::MAX)?;
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
        })();
        std::future::ready(out)
    }

    fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> impl std::future::Future<Output = Result<Vec<ProjectedNoteAlias>, PortError>> + Send {
        let out = (|| {
            check_stop(self.stop)?;
            let guard = self.backing.lock().map_err(error)?;
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
            Ok(guard
                .page::<ProjectedNoteAlias>(prefix, after.as_ref(), limit)?
                .into_iter()
                .map(|(_, row)| row)
                .filter(|row| row.space_id == *space)
                .collect())
        })();
        std::future::ready(out)
    }

    fn slot_occupant(
        &self,
        _space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> impl std::future::Future<Output = Result<Option<NoteId>, PortError>> + Send {
        let out = (|| {
            check_stop(self.stop)?;
            let guard = self.backing.lock().map_err(error)?;
            guard.get(&Key::new(SLOT).text(parent.as_str()).text(slug))
        })();
        std::future::ready(out)
    }
}

pub(super) struct Scratch {
    backing: Option<Arc<Mutex<Backing>>>,
    spilled: Arc<AtomicBool>,
    scratch_dir: PathBuf,
    owns_dir: bool,
    stop: Cancellation,
}

#[cfg(test)]
impl Default for Scratch {
    fn default() -> Self {
        let mut nonce = [0u8; 8];
        let _ = getrandom::fill(&mut nonce);
        let scratch_dir =
            std::env::temp_dir().join(format!("notarium-link-spill-test-{}", hex_lower(&nonce)));
        Self {
            backing: Some(Arc::new(Mutex::new(Backing::Memory {
                rows: BTreeMap::new(),
                bytes: 0,
            }))),
            spilled: Arc::new(AtomicBool::new(false)),
            scratch_dir,
            owns_dir: true,
            stop: Cancellation::default(),
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let Some(backing) = self.backing.take() else {
            return;
        };
        let owns_dir = self.owns_dir;
        let dir = self.scratch_dir.clone();
        if self.spilled.load(Ordering::Acquire)
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            handle.spawn_blocking(move || {
                drop(backing);
                if owns_dir {
                    let _ = fs::remove_dir(&dir);
                }
            });
        } else {
            drop(backing);
            if owns_dir {
                let _ = fs::remove_dir(&dir);
            }
        }
    }
}

fn error(error: impl std::fmt::Display) -> PortError {
    notarium_canonical::codec::internal_not_committed("projection_link_scratch", error.to_string())
}

fn join_error(err: tokio::task::JoinError) -> PortError {
    error(err)
}

impl Scratch {
    pub(super) fn new(scratch_dir: PathBuf, stop: Cancellation) -> Self {
        Self {
            backing: Some(Arc::new(Mutex::new(Backing::Memory {
                rows: BTreeMap::new(),
                bytes: 0,
            }))),
            spilled: Arc::new(AtomicBool::new(false)),
            scratch_dir,
            owns_dir: false,
            stop,
        }
    }

    fn backing(&self) -> Result<&Arc<Mutex<Backing>>, PortError> {
        self.backing
            .as_ref()
            .ok_or_else(|| error("scratch already closed"))
    }

    #[cfg(test)]
    pub(super) async fn close(mut self) {
        let Some(backing) = self.backing.take() else {
            return;
        };
        let owns_dir = self.owns_dir;
        let dir = self.scratch_dir.clone();
        let _ = tokio::task::spawn_blocking(move || {
            drop(backing);
            if owns_dir {
                let _ = fs::remove_dir(&dir);
            }
        })
        .await;
    }

    pub(super) fn encode_value(value: &impl Serialize) -> Result<Vec<u8>, PortError> {
        rmp_serde::to_vec(value).map_err(error)
    }

    pub(super) fn candidate_key(row: &CandidateLookupKey) -> Key {
        Key::new(CANDIDATE)
            .signed(row.scope_folder_dense_id)
            .text(&row.leaf_norm_key)
            .number(row.tier)
            .signed(row.created_at_sec)
            .number(row.created_at_nsec)
            .text(row.target_note_id.as_str())
    }

    pub(super) fn slot_key(parent: &FolderId, slug: &str) -> Key {
        Key::new(SLOT).text(parent.as_str()).text(slug)
    }

    pub(super) async fn put_batch_async(
        &mut self,
        entries: Vec<(Key, Vec<u8>)>,
    ) -> Result<(), PortError> {
        if entries.is_empty() {
            return Ok(());
        }
        check_stop(&self.stop)?;
        let backing = Arc::clone(self.backing()?);
        let mut remaining = entries;
        if !self.spilled.load(Ordering::Acquire) {
            let mut guard = backing.lock().map_err(error)?;
            if let Backing::Memory { rows, bytes } = &mut *guard {
                let mut iter = remaining.into_iter().peekable();
                while let Some((key, encoded)) = iter.peek() {
                    let size = if let Some(old) = rows.get(&key.0) {
                        bytes
                            .saturating_sub(old.capacity())
                            .saturating_add(encoded.capacity())
                    } else {
                        bytes.saturating_add(key.0.capacity() + encoded.capacity() + 112)
                    };
                    if size > MEMORY_BYTES {
                        break;
                    }
                    *bytes = size;
                    let (key, encoded) = iter.next().expect("peeked entry");
                    rows.insert(key.0, encoded);
                }
                remaining = iter.collect();
                if remaining.is_empty() {
                    return Ok(());
                }
            }
        }
        let spilled = Arc::clone(&self.spilled);
        let scratch_dir = self.scratch_dir.clone();
        let stop = self.stop.clone();
        tokio::task::spawn_blocking(move || {
            check_stop(&stop)?;
            let mut guard = backing.lock().map_err(error)?;
            guard.put_entries(&scratch_dir, &spilled, &stop, remaining)
        })
        .await
        .map_err(join_error)?
    }

    pub(super) async fn with_sync_read<R, F>(&self, op: F) -> Result<R, PortError>
    where
        R: Send + 'static,
        F: FnOnce(&SyncScratch<'_>) -> Result<R, PortError> + Send + 'static,
    {
        check_stop(&self.stop)?;
        let backing = Arc::clone(self.backing()?);
        if !self.spilled.load(Ordering::Acquire) {
            return op(&SyncScratch {
                backing: &backing,
                stop: &self.stop,
            });
        }
        let stop = self.stop.clone();
        tokio::task::spawn_blocking(move || {
            check_stop(&stop)?;
            op(&SyncScratch {
                backing: &backing,
                stop: &stop,
            })
        })
        .await
        .map_err(join_error)?
    }

    pub(super) async fn put_async(
        &mut self,
        key: Key,
        value: &(impl Serialize + Sync),
    ) -> Result<(), PortError> {
        let encoded = rmp_serde::to_vec(value).map_err(error)?;
        self.put_encoded_async(key, encoded).await
    }

    async fn put_encoded_async(&mut self, key: Key, encoded: Vec<u8>) -> Result<(), PortError> {
        self.put_batch_async(vec![(key, encoded)]).await
    }

    pub(super) async fn get_async<T: DeserializeOwned + Send + 'static>(
        &self,
        key: Key,
    ) -> Result<Option<T>, PortError> {
        check_stop(&self.stop)?;
        let backing = Arc::clone(self.backing()?);
        if !self.spilled.load(Ordering::Acquire) {
            let guard = backing.lock().map_err(error)?;
            if let Backing::Memory { rows, .. } = &*guard {
                return rows
                    .get(&key.0)
                    .map(|b| rmp_serde::from_slice(b).map_err(error))
                    .transpose();
            }
        }
        let stop = self.stop.clone();
        tokio::task::spawn_blocking(move || {
            check_stop(&stop)?;
            let guard = backing.lock().map_err(error)?;
            match &*guard {
                Backing::Memory { rows, .. } => rows
                    .get(&key.0)
                    .map(|b| rmp_serde::from_slice(b).map_err(error))
                    .transpose(),
                Backing::File(spill) => {
                    let value: Option<Vec<u8>> = spill
                        .db()?
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
        })
        .await
        .map_err(join_error)?
    }

    pub(super) async fn contains_async(&self, key: Key) -> Result<bool, PortError> {
        check_stop(&self.stop)?;
        let backing = Arc::clone(self.backing()?);
        if !self.spilled.load(Ordering::Acquire) {
            let guard = backing.lock().map_err(error)?;
            if let Backing::Memory { rows, .. } = &*guard {
                return Ok(rows.contains_key(&key.0));
            }
        }
        let stop = self.stop.clone();
        tokio::task::spawn_blocking(move || {
            check_stop(&stop)?;
            let guard = backing.lock().map_err(error)?;
            match &*guard {
                Backing::Memory { rows, .. } => Ok(rows.contains_key(&key.0)),
                Backing::File(spill) => spill
                    .db()?
                    .prepare_cached("SELECT 1 FROM work WHERE k=?")
                    .map_err(error)?
                    .exists([key.0])
                    .map_err(error),
            }
        })
        .await
        .map_err(join_error)?
    }

    pub(super) async fn insert_marker_async(&mut self, key: Key) -> Result<bool, PortError> {
        if self.contains_async(key.clone()).await? {
            return Ok(false);
        }
        self.put_async(key, &()).await?;
        Ok(true)
    }

    async fn range_async<T: DeserializeOwned + Send + 'static>(
        &self,
        start: Vec<u8>,
        end: Vec<u8>,
        limit: u16,
        max_bytes: usize,
    ) -> Result<Vec<(Key, T)>, PortError> {
        check_stop(&self.stop)?;
        let backing = Arc::clone(self.backing()?);
        if !self.spilled.load(Ordering::Acquire) {
            let guard = backing.lock().map_err(error)?;
            if let Backing::Memory { rows, .. } = &*guard {
                return range_memory(rows, start, end, limit, max_bytes);
            }
        }
        let stop = self.stop.clone();
        tokio::task::spawn_blocking(move || {
            check_stop(&stop)?;
            let guard = backing.lock().map_err(error)?;
            match &*guard {
                Backing::Memory { rows, .. } => range_memory(rows, start, end, limit, max_bytes),
                Backing::File(spill) => {
                    let mut result = Vec::new();
                    let mut bytes = 0usize;
                    let mut stmt = spill
                        .db()?
                        .prepare_cached(
                            "SELECT k,v FROM work WHERE k>=? AND k<? ORDER BY k LIMIT ?",
                        )
                        .map_err(error)?;
                    let mut rows = stmt.query(params![start, end, limit]).map_err(error)?;
                    while let Some(row) = rows.next().map_err(error)? {
                        let val_bytes = row.get_ref(1).map_err(error)?.as_blob().map_err(error)?;
                        let key_bytes = row.get_ref(0).map_err(error)?.as_blob().map_err(error)?;
                        bytes = bytes
                            .saturating_add(key_bytes.len())
                            .saturating_add(val_bytes.len());
                        if bytes > max_bytes && !result.is_empty() {
                            break;
                        }
                        result.push((
                            Key(key_bytes.to_vec()),
                            rmp_serde::from_slice(val_bytes).map_err(error)?,
                        ));
                    }
                    Ok(result)
                }
            }
        })
        .await
        .map_err(join_error)?
    }

    pub(super) async fn page_async<T: DeserializeOwned + Send + 'static>(
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
        self.range_async(start, prefix.end(), limit, max_bytes)
            .await
    }

    pub(super) async fn candidate_async(
        &mut self,
        row: &CandidateLookupKey,
    ) -> Result<(), PortError> {
        let key = Key::new(CANDIDATE)
            .signed(row.scope_folder_dense_id)
            .text(&row.leaf_norm_key)
            .number(row.tier)
            .signed(row.created_at_sec)
            .number(row.created_at_nsec)
            .text(row.target_note_id.as_str());
        self.put_async(key, row).await
    }

    pub(super) async fn alias_async(&mut self, row: &ProjectedNoteAlias) -> Result<(), PortError> {
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
            self.put_async(key, row).await?;
        }
        Ok(())
    }

    pub(super) async fn slot_async(
        &mut self,
        parent: &FolderId,
        slug: &str,
        note: &NoteId,
    ) -> Result<(), PortError> {
        self.put_async(Key::new(SLOT).text(parent.as_str()).text(slug), note)
            .await
    }
}

fn range_memory<T: DeserializeOwned>(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    start: Vec<u8>,
    end: Vec<u8>,
    limit: u16,
    max_bytes: usize,
) -> Result<Vec<(Key, T)>, PortError> {
    let mut result = Vec::new();
    let mut bytes = 0usize;
    for (k, v) in rows
        .range((Included(start), Excluded(end)))
        .take(usize::from(limit))
    {
        bytes = bytes.saturating_add(k.len()).saturating_add(v.len());
        if bytes > max_bytes && !result.is_empty() {
            break;
        }
        result.push((Key(k.to_vec()), rmp_serde::from_slice(v).map_err(error)?));
    }
    Ok(result)
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
            let page = self
                .range_async::<CandidateLookupKey>(start, end.clone(), limit, usize::MAX)
                .await?;
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
            .page_async::<ProjectedNoteAlias>(prefix, after.as_ref(), limit)
            .await?
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
        self.get_async(Key::new(SLOT).text(parent.as_str()).text(slug))
            .await
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
        let folders = Arc::new(
            FolderTopology::build(
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
            .unwrap(),
        );
        let mut cold = ColdLinks::default();
        const TOTAL: u32 = 650;
        let target = "x".repeat(16_384);
        for ordinal in (0..TOTAL).rev() {
            let dense = 1u32;
            cold.index
                .put_async(
                    Key::new(COLD_LINK).number(dense).number(ordinal),
                    &(dense, &root, false, ordinal, &target),
                )
                .await
                .unwrap();
        }
        let spill_path = {
            let backing = cold.index.backing().unwrap();
            let locked = backing.lock().unwrap();
            let Backing::File(spill) = &*locked else {
                panic!("seed exceeded scratch memory budget");
            };
            let db = spill.db().unwrap();
            let cache: i64 = db.query_row("PRAGMA cache_size", [], |r| r.get(0)).unwrap();
            assert_eq!(cache, -4096);
            let secure_delete: i64 = db
                .query_row("PRAGMA secure_delete", [], |r| r.get(0))
                .unwrap();
            assert_eq!(secure_delete, 1);
            let temp_store: i64 = db.query_row("PRAGMA temp_store", [], |r| r.get(0)).unwrap();
            assert_eq!(temp_store, 2);
            let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
            let page_size: i64 = db.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
            assert!(pages * page_size > MEMORY_BYTES as i64);
            assert!(spill.path.starts_with(&cold.index.scratch_dir));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let dir_mode = fs::symlink_metadata(&cold.index.scratch_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777;
                assert_eq!(dir_mode, 0o700);
                let file_mode = fs::symlink_metadata(&spill.path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777;
                assert_eq!(file_mode, 0o600);
            }
            spill.path.clone()
        };
        assert!(spill_path.exists());
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
        cold.index.close().await;
        assert!(!spill_path.exists(), "spill file must be unlinked on close");
    }

    #[tokio::test]
    async fn repeated_keys_do_not_exhaust_the_in_memory_budget() {
        let mut scratch = Scratch::default();
        let value = "s".repeat(16_384);
        for _ in 0..512 {
            scratch
                .put_async(Key::new(LEAF).text(&value), &value)
                .await
                .unwrap();
        }
        assert!(matches!(
            *scratch.backing().unwrap().lock().unwrap(),
            Backing::Memory { .. }
        ));
        assert!(
            scratch
                .insert_marker_async(Key::new(WATCHED).number(1).number(1))
                .await
                .unwrap()
        );
        assert!(
            !scratch
                .insert_marker_async(Key::new(WATCHED).number(1).number(1))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn cancelled_scratch_stops_spilled_operations() {
        let stop = Cancellation::default();
        let mut nonce = [0u8; 8];
        let _ = getrandom::fill(&mut nonce);
        let dir =
            std::env::temp_dir().join(format!("notarium-link-spill-cancel-{}", hex_lower(&nonce)));
        let mut scratch = Scratch::new(dir.clone(), stop.clone());
        stop.cancel();
        let err = scratch
            .put_async(Key::new(LEAF).text("a"), &"a")
            .await
            .unwrap_err();
        assert!(matches!(err, PortError::Cancelled(_)));
        let _ = fs::remove_dir_all(&dir);
    }
}
