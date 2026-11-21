//! Match each published ability to the entrypoint a reader selects at its cut.
use super::{revisions, scalar};
use crate::{backup_format::invalid, import::check_cancelled, sqlite_range::sql_error};
use notarium_canonical::{
    backup::PostgresSpoolValue,
    codec::{AbilityRevisionMetadata, RevisionMetadataPayload},
    domain::packages::ABILITY_ENTRYPOINT_KEY,
};
use notarium_core::{
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::ContentDigest,
    model::Lifecycle,
    ports::Cancellation,
};
use rusqlite::{Statement, params};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};

fn invalid_manifest() -> PortError {
    invalid(ValidationReason::InvalidArchive)
}

fn published_digest(
    manifest: &AbilityRevisionMetadata,
    sql: Option<&[u8]>,
) -> Result<ContentDigest, PortError> {
    if manifest.lifecycle != Lifecycle::Active {
        return Err(invalid_manifest());
    }
    let digest = manifest
        .resources
        .get(ABILITY_ENTRYPOINT_KEY)
        .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?;
    if Some(digest.as_bytes().as_slice()) != sql {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    Ok(*digest)
}

fn active_skill(owner: &str, raw: &[u8], digest: &[u8]) -> Result<bool, PortError> {
    let value = revisions::metadata("note", owner, raw)?;
    Ok(
        matches!(value, RevisionMetadataPayload::Note(note) if note.lifecycle==Lifecycle::Active
        && note.doc_class==DocClass::Skill && note.content_digest.is_some_and(|d|d.as_bytes()==digest)),
    )
}

pub(super) fn sqlite(
    revisions: &mut Statement<'_>,
    space: &str,
    cutoff: i64,
    manifest: &AbilityRevisionMetadata,
    stored: Option<&[u8]>,
) -> Result<(), PortError> {
    let expected = published_digest(manifest, stored)?;
    let note = manifest.entrypoint_note_id.as_str();
    let mut versions = revisions
        .query(params![space, note, cutoff])
        .map_err(sql_error)?;
    let row = versions
        .next()
        .map_err(sql_error)?
        .ok_or_else(invalid_manifest)?;
    let rev: String = row.get(0).map_err(sql_error)?;
    let sql: Option<Vec<u8>> = row.get(1).map_err(sql_error)?;
    let raw = row
        .get_ref(2)
        .map_err(sql_error)?
        .as_blob()
        .map_err(|_| invalid_manifest())?;
    if rev != manifest.entrypoint_revision.as_str()
        || sql.as_deref() != Some(expected.as_bytes().as_slice())
        || !active_skill(note, raw, expected.as_bytes())?
    {
        return Err(invalid_manifest());
    }
    let order = (
        row.get::<_, i64>(3).map_err(sql_error)?,
        row.get::<_, i64>(4).map_err(sql_error)?,
    );
    if let Some(other) = versions.next().map_err(sql_error)?
        && (
            other.get::<_, i64>(3).map_err(sql_error)?,
            other.get::<_, i64>(4).map_err(sql_error)?,
        ) == order
    {
        return Err(invalid_manifest());
    }
    Ok(())
}

type Key = [u8; 32];
fn pin(note: Key, revision: &str, digest: &[u8]) -> Key {
    let mut h = blake3::Hasher::new();
    scalar(&mut h, b'n', &note);
    scalar(&mut h, b'r', revision.as_bytes());
    scalar(&mut h, b'd', digest);
    *h.finalize().as_bytes()
}

#[derive(Clone, Copy)]
struct Version {
    order: (i64, i64),
    // None also represents an ambiguous winner at the same order.
    pin: Option<Key>,
}

fn select(best: &mut Option<Version>, next: Version) {
    if let Some(current) = best {
        match next.order.cmp(&current.order) {
            Ordering::Less => return,
            Ordering::Equal => {
                current.pin = None;
                return;
            }
            Ordering::Greater => {}
        }
    }
    *best = Some(next);
}

struct Cut {
    expected: Key,
    latest: Option<Version>,
}

#[derive(Default)]
pub(super) struct Publications {
    cuts: BTreeMap<(Key, i64), Cut>,
    pins: BTreeSet<Key>,
}
impl Publications {
    pub(super) fn len(&self) -> usize {
        self.cuts.len() + self.pins.len()
    }

    pub(super) fn require(
        &mut self,
        space: &str,
        cutoff: i64,
        manifest: &AbilityRevisionMetadata,
        sql: Option<&[u8]>,
    ) -> Result<(), PortError> {
        let digest = published_digest(manifest, sql)?;
        let note = revisions::key(&[space, manifest.entrypoint_note_id.as_str()]);
        let expected = pin(
            note,
            manifest.entrypoint_revision.as_str(),
            digest.as_bytes(),
        );
        match self.cuts.entry((note, cutoff)) {
            std::collections::btree_map::Entry::Vacant(slot) => {
                slot.insert(Cut {
                    expected,
                    latest: None,
                });
                self.pins.insert(expected);
            }
            std::collections::btree_map::Entry::Occupied(slot)
                if slot.get().expected != expected =>
            {
                return Err(invalid_manifest());
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn observe(
        &mut self,
        table: &str,
        row: &[PostgresSpoolValue],
    ) -> Result<(), PortError> {
        use PostgresSpoolValue::{Bytes, Int, Text};
        if table != "revisions" {
            return Ok(());
        }
        let [
            Text(space),
            _,
            Text(rev),
            Text(kind),
            Text(owner),
            Int(seq),
            Int(visibility),
            ..,
        ] = row
        else {
            return Err(invalid_manifest());
        };
        if kind != "note" {
            return Ok(());
        }
        let note = revisions::key(&[space, owner]);
        let Some((_, cut)) = self
            .cuts
            .range_mut((note, *visibility)..=(note, i64::MAX))
            .next()
        else {
            return Ok(());
        };
        let order = (*visibility, *seq);
        if cut.latest.is_some_and(|best| best.order > order) {
            return Ok(());
        }
        // Every row can supersede an old pin. Only a pinned version needs its
        // typed metadata decoded in this pass.
        let mut found = None;
        if let (Bytes(digest), Bytes(raw)) = (&row[10], &row[11]) {
            let candidate = pin(note, rev, digest);
            if self.pins.contains(&candidate) && active_skill(owner, raw, digest)? {
                found = Some(candidate);
            }
        }
        select(&mut cut.latest, Version { order, pin: found });
        Ok(())
    }

    pub(super) fn verify(&self, cancellation: &Cancellation) -> Result<(), PortError> {
        let mut previous = None;
        let mut best = None;
        for ((note, _), cut) in &self.cuts {
            check_cancelled(cancellation)?;
            if previous != Some(note) {
                previous = Some(note);
                best = None;
            }
            // Each note revision contributed only to its first eligible cut;
            // the prefix maximum is the reader's choice at each successive cut.
            if let Some(candidate) = cut.latest {
                select(&mut best, candidate);
            }
            if best.and_then(|version| version.pin) != Some(cut.expected) {
                return Err(invalid_manifest());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_canonical::codec::{NoteRevisionMetadata, RevisionMetadataEnvelope};
    use notarium_core::{
        classes::AbilityKind,
        ids::{AbilityId, FolderId, NoteId, RevisionId},
    };

    #[test]
    fn publications_choose_the_latest_visible_note_independently_of_spool_order() {
        use PostgresSpoolValue::{Bytes, Int, Null, Text};
        let digest = ContentDigest::from_bytes([9; 32]);
        let mut checks = Publications::default();
        let expect = |checks: &mut Publications, note: u8, cutoff: i64, revision: u8| {
            let manifest = AbilityRevisionMetadata {
                ability_id: AbilityId::from_bytes([note; 16]),
                kind: AbilityKind::Skill,
                slug_fold: "entry".into(),
                entrypoint_note_id: NoteId::from_bytes([note; 16]),
                entrypoint_revision: RevisionId::from_bytes([revision; 16]),
                lifecycle: Lifecycle::Active,
                resources: BTreeMap::from([(ABILITY_ENTRYPOINT_KEY.to_owned(), digest)]),
                total_bytes: 1,
            };
            checks
                .require("space", cutoff, &manifest, Some(digest.as_bytes()))
                .unwrap();
        };
        for (note, cutoff, rev) in [(1, 4, 1), (1, 6, 1), (1, 8, 2), (1, 10, 2), (2, 4, 3)] {
            expect(&mut checks, note, cutoff, rev);
        }
        let row = |note: u8, rev: u8, visibility: i64, seq: i64| {
            let owner = NoteId::from_bytes([note; 16]);
            let raw =
                RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(NoteRevisionMetadata {
                    note_id: owner.clone(),
                    parent_folder_id: FolderId::from_bytes([8; 16]),
                    is_root_child: true,
                    slug: "s".into(),
                    slug_fold: "s".into(),
                    title: "S".into(),
                    doc_class: DocClass::Skill,
                    ability_id: None,
                    lifecycle: Lifecycle::Active,
                    visibility_mask: 0,
                    byte_size: 1,
                    content_digest: Some(digest),
                    schema_revision: None,
                    raw_fields: None,
                    evaluated_fields: Default::default(),
                    diagnostics: Vec::new(),
                }))
                .encode()
                .unwrap();
            vec![
                Text("space".into()),
                Null,
                Text(RevisionId::from_bytes([rev; 16]).to_string()),
                Text("note".into()),
                Text(owner.to_string()),
                Int(seq),
                Int(visibility),
                Null,
                Null,
                Null,
                Bytes(digest.as_bytes().to_vec()),
                Bytes(raw),
            ]
        };
        for (note, rev, visibility, seq) in [
            (1, 2, 8, 7),
            (2, 3, 1, 1),
            (1, 5, 11, 11),
            (1, 4, 8, 5),
            (1, 1, 2, 2),
        ] {
            checks
                .observe("revisions", &row(note, rev, visibility, seq))
                .unwrap();
        }
        checks.verify(&Cancellation::default()).unwrap();
        checks.observe("revisions", &row(1, 6, 8, 7)).unwrap();
        assert!(checks.verify(&Cancellation::default()).is_err());
    }
}
