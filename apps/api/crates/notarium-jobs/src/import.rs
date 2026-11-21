use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek},
    path::Path,
};

use notarium_canonical::codec;
use notarium_core::{
    DomainError,
    classes::DocClass,
    document::{LinkNavigation, WikiTargetKind},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, JobId, NoteId},
    model::HistoryScope,
    ports::{Cancellation, ImportDiagnostic},
    value::YamlValue,
};
use notarium_syntax::{
    encrypted, extract, frontmatter, markdown,
    unicode::{PortableFilename, lookup_key},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};

use crate::zip_layout::{ZipLimits, open_zip};

mod plan;
pub(crate) use plan::{ImportBatch, bind_paths, read_batch, validate_plan};

const MIB: u64 = 1024 * 1024;
const PLAN_VERSION: u32 = 1;
const INSERT_FOLDER: &str = "INSERT INTO entries(key, path, parent, slug, id)
    VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(key) DO NOTHING";

#[derive(Clone, Copy, Debug)]
pub struct ImportLimits {
    pub compressed_bytes: u64,
    pub expanded_bytes: u64,
    pub entries: usize,
    pub depth: usize,
    pub carrier_bytes: u64,
    pub max_ratio: u32,
}

impl Default for ImportLimits {
    fn default() -> Self {
        Self {
            compressed_bytes: 2048 * MIB,
            expanded_bytes: 8192 * MIB,
            entries: 100_000,
            depth: ImportDiagnostic::MAX_PATH_DEPTH,
            carrier_bytes: 16 * MIB,
            max_ratio: 200,
        }
    }
}

impl ImportLimits {
    pub(crate) fn check(self) -> Result<(), PortError> {
        let hard = Self::default();
        if self.compressed_bytes == 0
            || self.compressed_bytes > hard.compressed_bytes
            || self.expanded_bytes == 0
            || self.expanded_bytes > hard.expanded_bytes
            || self.entries == 0
            || self.entries > hard.entries
            || self.depth == 0
            || self.depth > hard.depth
            || self.carrier_bytes == 0
            || self.carrier_bytes > hard.carrier_bytes
            || self.max_ratio == 0
            || self.max_ratio > hard.max_ratio
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct PreflightError {
    error: PortError,
    path: Option<String>,
}

impl From<PortError> for PreflightError {
    fn from(error: PortError) -> Self {
        Self { error, path: None }
    }
}

impl From<DomainError> for PreflightError {
    fn from(error: DomainError) -> Self {
        PortError::from(error).into()
    }
}

impl PreflightError {
    fn at(error: PortError, path: &str) -> Self {
        let path =
            notarium_syntax::unicode::portable_archive_path(path, ImportDiagnostic::MAX_PATH_DEPTH)
                .ok();
        Self { error, path }
    }

    fn for_entry<T>(path: &str, work: impl FnOnce() -> Result<T, PortError>) -> Result<T, Self> {
        work().map_err(|error| Self::at(error, path))
    }

    pub(crate) fn outcome(self) -> Result<notarium_canonical::JobCompletionOutcome, PortError> {
        let reason = match self.error {
            PortError::Domain(DomainError::ValidationFailed { diagnostic }) => diagnostic.reason,
            PortError::Domain(DomainError::PathConflict { .. }) => {
                ValidationReason::ArchivePathConflict
            }
            PortError::Domain(DomainError::UnsafePlaintextOutsideAgeFence) => {
                ValidationReason::InvalidAgeCarrier
            }
            PortError::Domain(
                DomainError::SpaceReadOnly
                | DomainError::AccessDenied
                | DomainError::AbilityWriteForbidden,
            ) => ValidationReason::InvalidAuthority,
            other => return Err(other),
        };
        Ok(notarium_canonical::JobCompletionOutcome::ImportRejected(
            ImportDiagnostic {
                reason,
                path: self.path,
            },
        ))
    }
}

/// A private staging index. Canonical path checks and sealing happen after
/// archive preflight, so a rejected archive cannot allocate canonical IDs.
pub(crate) fn prepare_import(
    source: impl Read + Seek,
    path: &Path,
    scope: &HistoryScope,
    job: &JobId,
    source_digest: ContentDigest,
    limits: ImportLimits,
    cancellation: &Cancellation,
) -> Result<(), PreflightError> {
    limits.check()?;
    check_cancelled(cancellation)?;
    let (mut zip, _) = open_zip(
        source,
        ZipLimits {
            bytes: limits.compressed_bytes,
            metadata_bytes: 32 * MIB,
            entries: limits.entries,
        },
    )?;
    let mut plan = create_plan(path, scope, job, source_digest)?;
    let tx = plan.transaction().map_err(plan_error)?;
    let mut expanded = 0_u64;
    let mut remaining_entries = limits.entries;
    for index in 0..zip.len() {
        check_cancelled(cancellation)?;
        let mut entry = zip
            .by_index(index)
            .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| invalid(ValidationReason::InvalidUtf8))?;
        if entry
            .name()
            .map_err(|_| invalid(ValidationReason::InvalidArchive))?
            .as_ref()
            != name
        {
            return Err(invalid(ValidationReason::InvalidArchive).into());
        }
        let directory = name.ends_with('/');
        let name = name.strip_suffix('/').unwrap_or(name).to_owned();
        let components = valid_path(&name, limits.depth)?;
        PreflightError::for_entry(&name, || {
            let unix_type = entry.unix_mode().unwrap_or(0) & 0o170000;
            if (unix_type != 0 && unix_type != if directory { 0o040000 } else { 0o100000 })
                || entry.is_symlink()
                || (entry.external_attributes() & 0x08 != 0)
            {
                return Err(invalid(ValidationReason::UnsupportedArchiveEntry));
            }
            if lookup_key(components[0]) == ".notarium" {
                return Err(invalid(ValidationReason::UnsupportedArchiveEntry));
            }
            let (parent, leaf) = if directory {
                (components.as_slice(), None)
            } else {
                let (leaf, parent) = components.split_last().expect("validated nonempty path");
                (parent, Some(*leaf))
            };
            let parent_key = insert_directories(&tx, parent, &mut remaining_entries)?;
            if directory && entry.size() != 0 {
                return Err(invalid(ValidationReason::InvalidArchive));
            }
            let allowed = entry
                .compressed_size()
                .saturating_mul(u64::from(limits.max_ratio))
                .min(limits.carrier_bytes)
                .min(limits.expanded_bytes.saturating_sub(expanded));
            let stored_expanded = entry.size();
            if stored_expanded > allowed {
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
            let carrier = read_carrier(&mut entry, stored_expanded, allowed, cancellation)?;
            expanded += stored_expanded;
            if let Some(filename) = leaf {
                insert_note(
                    &tx,
                    index,
                    &name,
                    &parent_key,
                    filename,
                    carrier,
                    &mut remaining_entries,
                )?;
            }
            Ok(())
        })?;
    }
    rebind_links(&tx, expanded, limits, cancellation)?;
    tx.execute(
        "INSERT INTO plan_order(ordinal, key) SELECT row_number() OVER (ORDER BY key), key FROM entries",
        [],
    ).map_err(plan_error)?;
    tx.commit().map_err(plan_error)?;
    plan.close().map_err(|(_, error)| plan_error(error))?;
    Ok(sync_plan(path)?)
}

fn create_plan(
    path: &Path,
    scope: &HistoryScope,
    job: &JobId,
    digest: ContentDigest,
) -> Result<Connection, PortError> {
    let mut file = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        file.mode(0o600);
    }
    file.write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    let plan =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(plan_error)?;
    plan.pragma_update(None, "user_version", PLAN_VERSION)
        .map_err(plan_error)?;
    plan.execute_batch(
        "PRAGMA journal_mode=DELETE;
         PRAGMA synchronous=FULL;
         PRAGMA cache_size=-4096;
         CREATE TABLE plan (
            singleton INTEGER PRIMARY KEY CHECK (singleton=1),
            space TEXT NOT NULL,
            history BLOB NOT NULL,
            job TEXT NOT NULL,
            source_digest BLOB NOT NULL
         );
         CREATE TABLE entries (
            key TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            parent TEXT NOT NULL,
            slug TEXT NOT NULL,
            id TEXT NOT NULL UNIQUE,
            resolved_folder TEXT,
            archive_entry INTEGER UNIQUE,
            class TEXT,
            title_key TEXT,
            slug_key TEXT,
            raw_digest BLOB,
            final_digest BLOB,
            carrier TEXT
         ) WITHOUT ROWID;
         CREATE TABLE plan_order (
            ordinal INTEGER PRIMARY KEY,
            key TEXT NOT NULL UNIQUE REFERENCES entries(key)
         );
         CREATE INDEX by_title ON entries(title_key) WHERE title_key IS NOT NULL;
         CREATE INDEX by_slug ON entries(slug_key) WHERE slug_key IS NOT NULL;",
    )
    .map_err(plan_error)?;
    plan.execute(
        "INSERT INTO plan VALUES (1, ?1, ?2, ?3, ?4)",
        params![
            scope.space_id.as_str(),
            scope.incarnation.as_bytes().as_slice(),
            job.as_str(),
            digest.as_bytes().as_slice(),
        ],
    )
    .map_err(plan_error)?;
    Ok(plan)
}

fn valid_path(path: &str, max_depth: usize) -> Result<Vec<&str>, PortError> {
    let mut components = Vec::new();
    for part in path.split('/') {
        PortableFilename::parse(part)?;
        if components.len() == max_depth {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        components.push(part);
    }
    Ok(components)
}

fn insert_directories(
    tx: &Transaction<'_>,
    components: &[&str],
    remaining_entries: &mut usize,
) -> Result<String, PortError> {
    let mut parent = String::new();
    let mut path = String::new();
    for component in components {
        push_component(&mut path, component);
        let mut key = parent.clone();
        push_component(&mut key, &lookup_key(component));
        let existing: Option<(String, bool)> = tx
            .query_row(
                "SELECT path, archive_entry IS NULL FROM entries WHERE key=?1",
                [&key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(plan_error)?;
        if let Some((existing_path, directory)) = existing {
            if existing_path != path || !directory {
                return Err(invalid(ValidationReason::ArchivePathConflict));
            }
        } else {
            use_entry(remaining_entries)?;
            let id = FolderId::from_bytes(codec::ordered_id_16()?);
            tx.execute(
                INSERT_FOLDER,
                params![key, path, parent, component, id.as_str()],
            )
            .map_err(plan_error)?;
        }
        parent = key;
    }
    Ok(parent)
}

fn insert_note(
    tx: &Transaction<'_>,
    index: usize,
    path: &str,
    parent: &str,
    filename: &str,
    carrier: String,
    remaining_entries: &mut usize,
) -> Result<(), PortError> {
    let (slug, extension) = filename
        .rsplit_once('.')
        .ok_or_else(|| invalid(ValidationReason::UnsupportedArchiveEntry))?;
    if !extension.eq_ignore_ascii_case("md") {
        return Err(invalid(ValidationReason::UnsupportedArchiveEntry));
    }
    PortableFilename::note_slug(slug)?;
    let class = frontmatter::declared_class(&carrier)?;
    if class == DocClass::Skill {
        return Err(invalid(ValidationReason::UnsupportedArchiveEntry));
    }
    let title = if class == DocClass::EncryptedNote {
        encrypted::validate(&carrier)?;
        slug.to_owned()
    } else {
        let head = frontmatter::analyze(&carrier, class)?;
        if let Some(diagnostic) = head.diagnostic {
            return Err(invalid(diagnostic));
        }
        let parsed = markdown::analyze(&carrier, head.carrier.body)?;
        let title_field = head
            .fields
            .as_ref()
            .and_then(|fields| match fields.get("title") {
                Some(YamlValue::String(title)) => Some(title.as_str()),
                _ => None,
            });
        title_field
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .or_else(|| {
                parsed
                    .headings
                    .iter()
                    .find(|heading| heading.level == 1)
                    .map(|heading| heading.title.trim())
                    .filter(|title| !title.is_empty())
            })
            .unwrap_or(slug)
            .to_owned()
    };
    let id = NoteId::from_bytes(codec::ordered_id_16()?);
    let digest = notarium_syntax::content_digest(&carrier);
    let key = lookup_key(path);
    use_entry(remaining_entries)?;
    let inserted = tx.execute(
        "INSERT INTO entries(key, path, parent, slug, id, archive_entry, class, title_key, slug_key, raw_digest, final_digest, carrier)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
         ON CONFLICT(key) DO NOTHING",
        params![
            key, path, parent, slug, id.as_str(), index as i64, codec::doc_class_to_db(class),
            lookup_key(&title), lookup_key(slug), digest.as_bytes().as_slice(), carrier,
        ],
    ).map_err(plan_error)?;
    if inserted == 0 {
        return Err(invalid(ValidationReason::ArchivePathConflict));
    }
    Ok(())
}

fn use_entry(remaining: &mut usize) -> Result<(), PortError> {
    *remaining = remaining
        .checked_sub(1)
        .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
    Ok(())
}

fn read_carrier(
    reader: &mut impl Read,
    declared: u64,
    limit: u64,
    cancellation: &Cancellation,
) -> Result<String, PortError> {
    let mut bytes = Vec::with_capacity(declared.min(64 * 1024) as usize);
    let mut buffer = [0; 64 * 1024];
    loop {
        check_cancelled(cancellation)?;
        let max_read =
            ((limit + 1).saturating_sub(bytes.len() as u64)).min(buffer.len() as u64) as usize;
        let read = reader
            .read(&mut buffer[..max_read])
            .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
        if read == 0 {
            break;
        }
        if bytes.len() as u64 + read as u64 > declared {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() as u64 != declared {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    String::from_utf8(bytes).map_err(|_| invalid(ValidationReason::InvalidUtf8))
}

fn rebind_links(
    tx: &Transaction<'_>,
    mut expanded: u64,
    limits: ImportLimits,
    cancellation: &Cancellation,
) -> Result<(), PreflightError> {
    let mut next = tx
        .prepare(
            "SELECT key, path, parent, carrier FROM entries
         WHERE key>?1 AND class IS NOT NULL AND class<>'encrypted-note' ORDER BY key LIMIT 1",
        )
        .map_err(plan_error)?;
    let mut cursor = String::new();
    while let Some((key, path, parent, carrier)) = next
        .query_row([&cursor], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .optional()
        .map_err(plan_error)?
    {
        check_cancelled(cancellation)?;
        PreflightError::for_entry(&path, || {
            let header = notarium_syntax::carrier::Carrier::scan(&carrier)?;
            let parsed = markdown::analyze(&carrier, header.body)?;
            let links = extract::wikilinks(&carrier, &parsed)?;
            let mut output = None::<String>;
            let mut copied = 0;
            let mut final_len = carrier.len();
            for link in links {
                let WikiTargetKind::NamePath {
                    absolute,
                    directory,
                    leaf_key,
                } = link.target
                else {
                    continue;
                };
                if link.raw.contains(':') || link.raw.starts_with("//") || leaf_key.is_empty() {
                    continue;
                }
                let Some(id) = resolve_link(tx, &parent, absolute, &directory, &leaf_key)? else {
                    continue;
                };
                let source = link.span.slice(&carrier)?;
                let inside = &source[2..source.len() - 2];
                let target = inside.split_once('|').map_or(inside, |(target, _)| target);
                let start = link.span.start() + 2 + (target.len() - target.trim_start().len());
                let end = start + target.trim().len();
                final_len = final_len - (end - start) + id.len();
                if final_len as u64 > limits.carrier_bytes {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                let output = output.get_or_insert_with(|| String::with_capacity(carrier.len()));
                output.push_str(&carrier[copied..start]);
                output.push_str(&id);
                copied = end;
            }
            if let Some(mut output) = output {
                output.push_str(&carrier[copied..]);
                expanded = expanded - carrier.len() as u64 + output.len() as u64;
                if expanded > limits.expanded_bytes {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                let digest = notarium_syntax::content_digest(&output);
                tx.execute(
                    "UPDATE entries SET carrier=?1, final_digest=?2 WHERE key=?3",
                    params![output, digest.as_bytes().as_slice(), key],
                )
                .map_err(plan_error)?;
            }
            Ok(())
        })?;
        cursor = key;
    }
    Ok(())
}

fn resolve_link(
    tx: &Transaction<'_>,
    parent: &str,
    absolute: bool,
    dirs: &[LinkNavigation],
    leaf: &str,
) -> Result<Option<String>, PortError> {
    let mut parts = Vec::new();
    if !absolute && !parent.is_empty() {
        parts.extend(parent.split('/'));
    }
    for dir in dirs {
        match dir {
            LinkNavigation::Current => {}
            LinkNavigation::Parent => {
                if parts.pop().is_none() {
                    return Ok(None);
                }
            }
            LinkNavigation::Named(part) => parts.push(part),
        }
    }
    let mut key = parts.join("/");
    let filename = if leaf.ends_with(".md") {
        leaf.to_owned()
    } else {
        format!("{leaf}.md")
    };
    push_component(&mut key, &filename);
    let by_path = tx
        .query_row(
            "SELECT id FROM entries WHERE key=?1 AND class IS NOT NULL",
            [&key],
            |r| r.get(0),
        )
        .optional()
        .map_err(plan_error)?;
    if by_path.is_some() || absolute || !dirs.is_empty() {
        return Ok(by_path);
    }
    let slug = leaf.strip_suffix(".md").unwrap_or(leaf);
    let mut query = tx
        .prepare_cached("SELECT id FROM entries WHERE title_key=?1 OR slug_key=?2 LIMIT 2")
        .map_err(plan_error)?;
    let mut matches = query.query(params![leaf, slug]).map_err(plan_error)?;
    let result = matches
        .next()
        .map_err(plan_error)?
        .map(|row| row.get(0))
        .transpose()
        .map_err(plan_error)?;
    if matches.next().map_err(plan_error)?.is_some() {
        return Err(invalid(ValidationReason::ArchivePathConflict));
    }
    Ok(result)
}

fn push_component(path: &mut String, component: &str) {
    if !path.is_empty() {
        path.push('/');
    }
    path.push_str(component);
}

pub(crate) fn sync_plan(path: &Path) -> Result<(), PortError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(io_error)?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid(ValidationReason::InvalidPathComponent))?;
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(io_error)
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

pub(crate) fn check_cancelled(cancellation: &Cancellation) -> Result<(), PortError> {
    if cancellation.is_cancelled() {
        return Err(codec::cancelled_not_committed(
            "archive_cancelled",
            "archive operation cancelled",
        ));
    }
    Ok(())
}

fn plan_error(error: rusqlite::Error) -> PortError {
    codec::internal_not_committed("archive_plan", error.to_string())
}

fn io_error(error: std::io::Error) -> PortError {
    codec::internal_not_committed("archive_plan_io", error.kind().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::ids::{HistoryIncarnation, SpaceId};
    use std::{
        fs,
        io::{Cursor, Write},
        path::PathBuf,
    };
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(codec::new_prefixed_hex_id("archive_test_").unwrap());
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (&(name, body), method) in entries.iter().zip(
            [
                CompressionMethod::Stored,
                CompressionMethod::Deflated,
                CompressionMethod::Zstd,
            ]
            .into_iter()
            .cycle(),
        ) {
            zip.start_file(
                name,
                SimpleFileOptions::default()
                    .compression_method(method)
                    .large_file(true),
            )
            .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn prepare(bytes: Vec<u8>, plan: &Path) -> Result<(), PortError> {
        let digest = ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes());
        prepare_import(
            Cursor::new(bytes),
            plan,
            &HistoryScope {
                space_id: SpaceId::from_bytes([1; 16]),
                incarnation: HistoryIncarnation::from_bytes([2; 16]),
            },
            &JobId::from_bytes([3; 16]),
            digest,
            ImportLimits::default(),
            &Cancellation::default(),
        )
        .map_err(|failure| failure.error)
    }

    #[test]
    fn plans_links_against_minted_ids_without_touching_code_or_labels() {
        let scratch = Scratch::new();
        let plan = scratch.0.join("plan.sqlite");
        prepare(
            zip(&[
                (
                    "A/Start.md",
                    "# Start\r\n\r\n[[  ../End | label ]] and `[[End]]`\r\n",
                ),
                ("End.md", "# End\n"),
                ("Other.md", "# Other\n\n[[A/Start]]\n"),
            ]),
            &plan,
        )
        .unwrap();
        let db = Connection::open_with_flags(plan, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let end: String = db
            .query_row("SELECT id FROM entries WHERE path='End.md'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let (carrier, raw, final_digest): (String, Vec<u8>, Vec<u8>) = db
            .query_row(
                "SELECT carrier, raw_digest, final_digest FROM entries WHERE path='A/Start.md'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            carrier,
            format!("# Start\r\n\r\n[[  {end} | label ]] and `[[End]]`\r\n")
        );
        assert_ne!(raw, final_digest);
        assert_eq!(
            final_digest,
            notarium_syntax::content_digest(&carrier).as_bytes()
        );
    }

    #[test]
    fn rejects_late_plaintext_and_rolls_back_the_plan() {
        let scratch = Scratch::new();
        let plan = scratch.0.join("plan.sqlite");
        let err = prepare(
            zip(&[
                ("first.md", "# First\n"),
                (
                    "last.md",
                    "---\nclass: encrypted-note\n---\n# Title\n\nUnsafe body\n",
                ),
            ]),
            &plan,
        )
        .unwrap_err();
        assert_eq!(
            err,
            PortError::Domain(DomainError::UnsafePlaintextOutsideAgeFence)
        );
        let db = Connection::open_with_flags(plan, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let entries: i64 = db
            .query_row("SELECT count(*) FROM entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(entries, 0);
    }

    #[test]
    fn rejects_portable_collisions_corruption_and_operational_entries() {
        let scratch = Scratch::new();
        assert_eq!(
            prepare(
                zip(&[("Straße/first.md", "# A"), ("STRASSE/second.md", "# B")]),
                &scratch.0.join("fold.sqlite")
            )
            .unwrap_err(),
            invalid(ValidationReason::ArchivePathConflict),
        );
        assert_eq!(
            prepare(
                zip(&[("first.md", "# A"), (".notarium/fields/schema.yaml", "{}")]),
                &scratch.0.join("metadata.sqlite")
            )
            .unwrap_err(),
            invalid(ValidationReason::UnsupportedArchiveEntry),
        );
        for (name, bytes) in [
            ("header", {
                let mut bytes = zip(&[("first.md", "# A")]);
                bytes[30] ^= 1;
                bytes
            }),
            ("crc", {
                let mut bytes = zip(&[("first.md", "# A")]);
                let data_at = 30
                    + usize::from(u16::from_le_bytes(bytes[26..28].try_into().unwrap()))
                    + usize::from(u16::from_le_bytes(bytes[28..30].try_into().unwrap()));
                bytes[data_at] ^= 1;
                bytes
            }),
        ] {
            assert_eq!(
                prepare(bytes, &scratch.0.join(name)).unwrap_err(),
                invalid(ValidationReason::InvalidArchive)
            );
        }
    }
}
