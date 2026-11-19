//! The private write-ahead record for filesystem namespace changes.

use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use notarium_canonical::vault::VaultBinding;
use notarium_core::{
    ids::{CommandKey, ContentDigest, NoteId, RevisionId},
    model::HistoryScope,
};
use serde::{Deserialize, Serialize};

use crate::{
    filesystem::{FileStamp, sync_dir},
    paths::digest,
    sync::PendingMint,
};

const MAX_ENTRY_BYTES: u64 = 32 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum PublishPurpose {
    Note,
    ConflictCopy,
    Conversion,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DesiredFile {
    pub note: NoteId,
    pub revision: RevisionId,
    pub carrier_digest: ContentDigest,
    pub disk_digest: ContentDigest,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ConversionName {
    pub published: PathBuf,
    pub canonical: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ArchivedCapture {
    pub operation: ContentDigest,
    pub target: PathBuf,
    pub slot: PathBuf,
    pub expected: FileStamp,
    pub retained_at: PathBuf,
    pub successor: Option<NoteId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PublishAction {
    pub desired: DesiredFile,
    pub purpose: PublishPurpose,
    pub expected: Option<FileStamp>,
    pub staged: Option<FileStamp>,
    pub retire: Option<(PathBuf, FileStamp)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) enum Action {
    Publish(Box<PublishAction>),
    Withdraw { expected: FileStamp },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Intent {
    pub scope: HistoryScope,
    pub generation: ContentDigest,
    pub id: ContentDigest,
    pub target: PathBuf,
    pub action: Action,
}

// Persist only the fingerprints needed to repeat or diagnose publication.
// Never serialize a Markdown body or any ciphertext into this journal.
pub(crate) struct Journal {
    dir: Dir,
    binding: VaultBinding,
}

pub(crate) fn open_or_create(parent: &Dir, name: &str) -> io::Result<Dir> {
    match parent.open_dir_nofollow(name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match parent.create_dir(name) {
                Ok(()) => sync(parent)?,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            parent.open_dir_nofollow(name)
        }
        result => result,
    }
}

pub(crate) fn random_digest() -> io::Result<ContentDigest> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| io::Error::other("system entropy unavailable"))?;
    Ok(ContentDigest::from_bytes(bytes))
}

fn sync(dir: &Dir) -> io::Result<()> {
    sync_dir(dir)
}

impl Journal {
    pub fn open(private: &Dir, binding: &VaultBinding) -> io::Result<Self> {
        let dir = open_or_create(
            private,
            &format!("vault-notes-{}", binding.generation.to_hex()),
        )?;
        Ok(Self {
            dir,
            binding: binding.clone(),
        })
    }

    pub fn intent(&self, target: PathBuf, action: Action) -> io::Result<Intent> {
        let intent = Intent {
            scope: self.binding.scope.clone(),
            generation: self.binding.generation,
            id: random_digest()?,
            target,
            action,
        };
        self.save(&intent)?;
        Ok(intent)
    }

    pub fn save(&self, intent: &Intent) -> io::Result<()> {
        self.check_scope(intent)?;
        self.write(&format!("{}.intent", intent.id.to_hex()), intent)
    }

    pub fn finish(&self, intent: &Intent) -> io::Result<()> {
        self.check_scope(intent)?;
        self.dir
            .remove_file(format!("{}.intent", intent.id.to_hex()))?;
        sync(&self.dir)
    }

    pub fn intents(&self) -> io::Result<Vec<Intent>> {
        let mut intents = Vec::new();
        for (name, intent) in read_records(&self.dir, "intent", MAX_ENTRY_BYTES)? {
            self.check_scope(&intent)?;
            if name != format!("{}.intent", intent.id.to_hex()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "vault intent name mismatch",
                ));
            }
            intents.push(intent);
        }
        Ok(intents)
    }

    pub fn conflict(&self, issue: &DiskConflict) -> io::Result<()> {
        self.write(&entry_name(&issue.path, "conflict"), issue)
    }

    pub fn clear_conflict(&self, path: &str) -> io::Result<()> {
        self.remove(&entry_name(path, "conflict"))
    }

    pub fn conflicts(&self) -> io::Result<Vec<DiskConflict>> {
        read_records(&self.dir, "conflict", MAX_ENTRY_BYTES)
            .map(|entries| entries.into_iter().map(|(_, conflict)| conflict).collect())
    }

    pub fn record_conflict_copy(&self, path: &Path, desired: &DesiredFile) -> io::Result<()> {
        self.write(
            &entry_name(path.to_string_lossy().as_ref(), "copy"),
            desired,
        )
    }

    pub fn has_conflict_copy(&self, path: &Path, desired: &DesiredFile) -> io::Result<bool> {
        let name = entry_name(path.to_string_lossy().as_ref(), "copy");
        match read_record(&self.dir, &name, MAX_ENTRY_BYTES) {
            Ok(record) => Ok(desired == &record),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub fn remember_conversion(&self, note: &NoteId, name: &ConversionName) -> io::Result<()> {
        self.write(&entry_name(note.as_str(), "conversion-name"), name)
    }

    pub fn conversion_name(&self, note: &NoteId) -> io::Result<Option<ConversionName>> {
        let name = entry_name(note.as_str(), "conversion-name");
        match read_record(&self.dir, &name, MAX_ENTRY_BYTES) {
            Ok(record) => Ok(Some(record)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn clear_conversion_name(&self, note: &NoteId) -> io::Result<()> {
        self.remove(&entry_name(note.as_str(), "conversion-name"))
    }

    pub fn save_mint(&self, prepared: &PendingMint) -> io::Result<()> {
        self.write(&entry_name(prepared.key.as_str(), "mint"), prepared)
    }

    pub fn mint(&self, key: &CommandKey) -> io::Result<Option<PendingMint>> {
        let name = entry_name(key.as_str(), "mint");
        match read_record::<PendingMint>(&self.dir, &name, MAX_ENTRY_BYTES) {
            Ok(prepared) if &prepared.key == key => Ok(Some(prepared)),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "vault conversion name mismatch",
            )),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn mints(&self) -> io::Result<Vec<PendingMint>> {
        read_records::<PendingMint>(&self.dir, "mint", MAX_ENTRY_BYTES)?
            .into_iter()
            .map(|(name, prepared)| {
                if name == entry_name(prepared.key.as_str(), "mint") {
                    Ok(prepared)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "vault conversion name mismatch",
                    ))
                }
            })
            .collect()
    }

    pub fn clear_mint(&self, key: &CommandKey) -> io::Result<()> {
        self.remove(&entry_name(key.as_str(), "mint"))
    }

    pub fn folder_attempt(&self, locator: ContentDigest) -> io::Result<ContentDigest> {
        let name = format!("{}.folder", locator.to_hex());
        match read_record(&self.dir, &name, MAX_ENTRY_BYTES) {
            Ok(attempt) => Ok(attempt),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let attempt = random_digest()?;
                self.write(&name, &attempt)?;
                Ok(attempt)
            }
            Err(error) => Err(error),
        }
    }

    pub fn clear_folder_attempt(&self, locator: ContentDigest) -> io::Result<()> {
        self.remove(&format!("{}.folder", locator.to_hex()))
    }

    pub fn archive_capture(&self, capture: &ArchivedCapture) -> io::Result<()> {
        self.write(&format!("{}.capture", capture.operation.to_hex()), capture)
    }

    pub fn clear_capture(&self, operation: ContentDigest) -> io::Result<()> {
        self.remove(&format!("{}.capture", operation.to_hex()))
    }

    pub fn captures(&self) -> io::Result<Vec<ArchivedCapture>> {
        read_records::<ArchivedCapture>(&self.dir, "capture", MAX_ENTRY_BYTES)?
            .into_iter()
            .map(|(name, capture)| {
                if name == format!("{}.capture", capture.operation.to_hex()) {
                    Ok(capture)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "vault capture name mismatch",
                    ))
                }
            })
            .collect()
    }

    pub fn defer(&self, note: &NoteId) -> io::Result<()> {
        self.write(&entry_name(note.as_str(), "deferred"), note)
    }

    pub fn clear_deferred(&self, note: &NoteId) -> io::Result<()> {
        self.remove(&entry_name(note.as_str(), "deferred"))
    }

    pub fn deferred(&self) -> io::Result<Vec<NoteId>> {
        read_records(&self.dir, "deferred", MAX_ENTRY_BYTES)
            .map(|entries| entries.into_iter().map(|(_, note)| note).collect())
    }

    fn remove(&self, name: &str) -> io::Result<()> {
        match self.dir.remove_file(name) {
            Ok(()) => sync(&self.dir),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn check_scope(&self, intent: &Intent) -> io::Result<()> {
        if intent.scope != self.binding.scope || intent.generation != self.binding.generation {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "stale vault publication",
            ));
        }
        Ok(())
    }

    fn write<T: Serialize>(&self, name: &str, record: &T) -> io::Result<()> {
        write_record(&self.dir, name, record)
    }
}

pub(crate) fn write_record(dir: &Dir, name: &str, record: &impl Serialize) -> io::Result<()> {
    let temporary = format!(".{}.tmp", random_digest()?.to_hex());
    let mut settings = OpenOptions::new();
    settings
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = dir.open_with(&temporary, &settings)?;
    let result = (|| {
        serde_json::to_writer(&mut file, record)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        dir.rename(&temporary, dir, name)?;
        sync(dir)
    })();
    if result.is_err() {
        let _ = dir.remove_file(&temporary);
    }
    result
}

pub(crate) fn read_records<T: serde::de::DeserializeOwned>(
    dir: &Dir,
    extension: &str,
    max_entry_bytes: u64,
) -> io::Result<Vec<(String, T)>> {
    let mut records = Vec::new();
    for entry in dir.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        if Path::new(&name).extension().and_then(|s| s.to_str()) != Some(extension) {
            continue;
        }
        let name = name.into_string().map_err(|_| io::ErrorKind::InvalidData)?;
        let record = read_record(dir, &name, max_entry_bytes)?;
        records.push((name, record));
    }
    Ok(records)
}

pub(crate) fn read_record<T: serde::de::DeserializeOwned>(
    dir: &Dir,
    name: &str,
    limit: u64,
) -> io::Result<T> {
    let mut settings = OpenOptions::new();
    settings.read(true).follow(FollowSymlinks::No);
    let file = dir.open_with(name, &settings)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid vault journal entry",
        ));
    }
    Ok(serde_json::from_reader(file.take(limit))?)
}
fn entry_name(key: &str, extension: &str) -> String {
    format!("{}.{}", digest(key.as_bytes()).to_hex(), extension)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiskConflict {
    pub path: String,
    pub reason: ConflictReason,
    pub preserved_path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConflictReason {
    UnsafePath,
    InvalidCarrier,
    ChangedWhilePublishing,
    CaptureUnverified,
    CanonicalDiverged,
    CiphertextConflict,
    NameCollision,
    ClaimedPurgedIdentity,
    UnresolvedPublication,
    ReservedMaterial,
}
