//! The immutable revision selected by the reader must belong to the retained head.
use super::*;
use notarium_canonical::codec::ability_kind_to_db;
use notarium_core::{
    ids::{AgentRunId, PrincipalId, RevisionId},
    model::Lifecycle,
};

fn invalid_history() -> PortError {
    invalid(ValidationReason::InvalidArchive)
}

pub(super) fn metadata(
    kind: &str,
    owner: &str,
    raw: &[u8],
) -> Result<RevisionMetadataPayload, PortError> {
    use RevisionMetadataPayload::*;
    let value = RevisionMetadataEnvelope::decode(raw)
        .map_err(|_| invalid_history())?
        .payload;
    let matches = match (&value, kind) {
        (Folder(f), "folder") => {
            f.folder_id.as_str() == owner
                && f.is_root == f.parent_folder_id.is_none()
                && (!f.is_root || f.lifecycle == Lifecycle::Active)
                && f.parent_folder_id.as_ref() != Some(&f.folder_id)
        }
        (Note(n), "note") => n.note_id.as_str() == owner,
        (Thread(t), "thread") => t.thread_id.as_str() == owner,
        (Ability(a), "ability") => a.ability_id.as_str() == owner,
        (Rank(r), "rank") => {
            owner == format!("{}:{}:{}", r.view_note_id, r.view_key, r.target_note_id)
        }
        (AgentRun(r), "agent_run") => r.run_id.as_str() == owner,
        _ => false,
    };
    if !matches {
        return Err(invalid_history());
    }
    Ok(value)
}

// Current parents drive live reads. Immutable parents drive seed and historical access.
fn head_link(value: &RevisionMetadataPayload) -> Option<&str> {
    use RevisionMetadataPayload::*;
    match value {
        Folder(f) => f.parent_folder_id.as_ref().map(|p| p.as_str()),
        Note(n) => Some(n.parent_folder_id.as_str()),
        Thread(t) => t.project_folder_id.as_ref().map(|p| p.as_str()),
        Ability(a) => Some(a.entrypoint_note_id.as_str()),
        AgentRun(_) | Rank(_) => None,
    }
}

fn stored_ids(
    rev: &str,
    actor: &str,
    run: Option<&str>,
    restored: Option<&str>,
) -> Result<(), PortError> {
    RevisionId::parse(rev).map_err(|_| invalid_history())?;
    PrincipalId::parse(actor).map_err(|_| invalid_history())?;
    if let Some(id) = run {
        AgentRunId::parse(id).map_err(|_| invalid_history())?;
    }
    if let Some(id) = restored {
        RevisionId::parse(id).map_err(|_| invalid_history())?;
    }
    Ok(())
}

pub(super) fn sqlite(db: &Connection, cancellation: &Cancellation) -> Result<(), PortError> {
    let bad: bool = db.query_row(
        "SELECT EXISTS (SELECT 1 FROM note_heads n WHERE
           (n.lifecycle_state='purged')<>EXISTS(SELECT 1 FROM revision_purge_fences p
             WHERE p.space_id=n.space_id AND p.note_id=n.note_id))
           OR EXISTS (SELECT 1 FROM revision_purge_fences p WHERE NOT EXISTS(
             SELECT 1 FROM note_heads n WHERE n.space_id=p.space_id AND n.note_id=p.note_id AND n.lifecycle_state='purged'))
           OR EXISTS (SELECT 1 FROM ability_packages a WHERE a.lifecycle_state='active' AND NOT EXISTS (
             SELECT 1 FROM note_heads n WHERE n.space_id=a.space_id AND n.note_id=a.entrypoint_note_id
               AND n.ability_id=a.ability_id AND n.doc_class='skill' AND n.lifecycle_state='active'))",
        [], |r| r.get(0)).map_err(sql_error)?;
    if bad {
        return Err(invalid_history());
    }

    let mut resources = db
        .prepare(
            "SELECT resource_key,content_blake3 FROM blob_references
          WHERE owner_kind='ability_resource' AND space_id=?1 AND owner_id=?2 AND owner_rev_id=?3",
        )
        .map_err(sql_error)?;
    let mut entrypoint = db
        .prepare(
            "SELECT rev_id,content_blake3,metadata_msgpack,visibility_seq,space_seq FROM revisions
         WHERE space_id=?1 AND entity_type='note' AND entity_key=?2 AND visibility_seq<=?3
         ORDER BY visibility_seq DESC,space_seq DESC LIMIT 2",
        )
        .map_err(sql_error)?;
    let mut all = db.prepare(
        "SELECT r.entity_type,r.entity_key,r.rev_id,r.metadata_msgpack,r.actor_id,r.agent_run_id,r.restored_from_rev_id,
                s.last_seq>=r.visibility_seq AND s.history_incarnation=r.history_incarnation,
                r.space_id,r.content_blake3,c.raw_size,s.root_folder_id,
                CASE r.entity_type
                 WHEN 'folder' THEN EXISTS(SELECT 1 FROM folder_heads f WHERE f.space_id=r.space_id AND f.folder_id=r.entity_key)
                 WHEN 'note' THEN EXISTS(SELECT 1 FROM note_heads n WHERE n.space_id=r.space_id AND n.note_id=r.entity_key)
                 WHEN 'thread' THEN EXISTS(SELECT 1 FROM chat_threads t WHERE t.space_id=r.space_id AND t.thread_id=r.entity_key)
                 WHEN 'ability' THEN EXISTS(SELECT 1 FROM ability_packages a WHERE a.space_id=r.space_id AND a.ability_id=r.entity_key)
                 WHEN 'agent_run' THEN EXISTS(SELECT 1 FROM agent_run_heads a WHERE a.space_id=r.space_id AND a.run_id=r.entity_key)
                 ELSE 1 END, r.visibility_seq,
                 CASE WHEN r.entity_type='ability' THEN
                     (SELECT a.entrypoint_note_id FROM ability_packages a WHERE a.space_id=r.space_id AND a.ability_id=r.entity_key) END,
                 CASE WHEN r.entity_type='ability' THEN
                     (SELECT a.kind FROM ability_packages a WHERE a.space_id=r.space_id AND a.ability_id=r.entity_key AND a.manifest_rev_id=r.rev_id) END
         FROM revisions r LEFT JOIN spaces s ON s.space_id=r.space_id
         LEFT JOIN blob_catalog c ON r.entity_type='note' AND c.space_id=r.space_id AND c.content_blake3=r.content_blake3",
    ).map_err(sql_error)?;
    let mut rows = all.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        check_cancelled(cancellation)?;
        if row.get::<_, Option<bool>>(7).map_err(sql_error)? != Some(true)
            || !row.get::<_, bool>(12).map_err(sql_error)?
        {
            return Err(invalid_history());
        }
        let rev: String = row.get(2).map_err(sql_error)?;
        let actor: String = row.get(4).map_err(sql_error)?;
        stored_ids(
            &rev,
            &actor,
            row.get::<_, Option<String>>(5)
                .map_err(sql_error)?
                .as_deref(),
            row.get::<_, Option<String>>(6)
                .map_err(sql_error)?
                .as_deref(),
        )?;
        let kind: String = row.get(0).map_err(sql_error)?;
        let owner: String = row.get(1).map_err(sql_error)?;
        let raw = row
            .get_ref(3)
            .map_err(sql_error)?
            .as_blob()
            .map_err(|_| invalid_history())?;
        let value = metadata(&kind, &owner, raw)?;
        match value {
            RevisionMetadataPayload::Note(_) => {
                let digest: Option<Vec<u8>> = row.get(9).map_err(sql_error)?;
                if note_size(&value, digest.as_deref())?
                    != row.get::<_, Option<i64>>(10).map_err(sql_error)?
                {
                    return Err(invalid(ValidationReason::InvalidDigest));
                }
            }
            RevisionMetadataPayload::Ability(a) => {
                let space: String = row.get(8).map_err(sql_error)?;
                let listed_kind: Option<String> = row.get(15).map_err(sql_error)?;
                if a.entrypoint_note_id.as_str() != row.get::<_, String>(14).map_err(sql_error)?
                    || listed_kind.is_some_and(|kind| kind != ability_kind_to_db(a.kind))
                {
                    return Err(invalid_history());
                }
                let stored: Option<Vec<u8>> = row.get(9).map_err(sql_error)?;
                ability::sqlite(
                    &mut entrypoint,
                    &space,
                    row.get(13).map_err(sql_error)?,
                    &a,
                    stored.as_deref(),
                )?;
                let mut expected = a.resources;
                let mut refs = resources
                    .query(params![space, owner, rev])
                    .map_err(sql_error)?;
                while let Some(r) = refs.next().map_err(sql_error)? {
                    let path: String = r.get(0).map_err(sql_error)?;
                    let digest: Vec<u8> = r.get(1).map_err(sql_error)?;
                    if expected
                        .remove(&path)
                        .is_none_or(|hash| hash.as_bytes() != digest.as_slice())
                    {
                        return Err(invalid(ValidationReason::InvalidDigest));
                    }
                }
                if !expected.is_empty() {
                    return Err(invalid(ValidationReason::InvalidDigest));
                }
            }
            RevisionMetadataPayload::Folder(folder)
                if folder.is_root
                    != (folder.folder_id.as_str()
                        == row.get::<_, String>(11).map_err(sql_error)?) =>
            {
                return Err(invalid_history());
            }
            _ => {}
        }
    }
    if db
        .query_row(
            "SELECT 1 FROM blob_references r WHERE r.owner_kind='ability_resource' AND NOT EXISTS(
           SELECT 1 FROM revisions v WHERE v.space_id=r.space_id AND v.rev_id=r.owner_rev_id
              AND v.entity_type='ability' AND v.entity_key=r.owner_id) LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(sql_error)?
        .is_some()
    {
        return Err(invalid(ValidationReason::InvalidDigest));
    }

    let mut heads = db.prepare(
        "SELECT space_id,'folder',folder_id,head_rev_id,parent_folder_id FROM folder_heads
         UNION ALL SELECT space_id,'note',note_id,head_rev_id,parent_folder_id FROM note_heads WHERE lifecycle_state<>'purged'
         UNION ALL SELECT space_id,'thread',thread_id,head_rev_id,project_folder_id FROM chat_threads
         UNION ALL SELECT space_id,'ability',ability_id,manifest_rev_id,entrypoint_note_id FROM ability_packages WHERE lifecycle_state<>'purged'
         UNION ALL SELECT space_id,'rank',view_note_id||':'||view_key||':'||target_note_id,rank_rev_id,NULL FROM view_rank_overlays
         UNION ALL SELECT space_id,'agent_run',run_id,run_revision,NULL FROM agent_run_heads",
    ).map_err(sql_error)?;
    let mut latest = db
        .prepare(
            "SELECT rev_id,metadata_msgpack,visibility_seq,space_seq FROM revisions
         WHERE space_id=?1 AND entity_type=?2 AND entity_key=?3
         ORDER BY visibility_seq DESC,space_seq DESC LIMIT 2",
        )
        .map_err(sql_error)?;
    let mut roots = db.prepare(
        "SELECT 1 FROM revisions WHERE space_id=?1 AND entity_type='folder' AND entity_key=?2 AND visibility_seq=0 AND space_seq=0",
    ).map_err(sql_error)?;
    let mut rows = heads.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        check_cancelled(cancellation)?;
        let space: String = row.get(0).map_err(sql_error)?;
        let kind: String = row.get(1).map_err(sql_error)?;
        let owner: String = row.get(2).map_err(sql_error)?;
        let expected: String = row.get(3).map_err(sql_error)?;
        let link: Option<String> = row.get(4).map_err(sql_error)?;
        let mut versions = latest
            .query(params![space, kind, owner])
            .map_err(sql_error)?;
        let current = versions
            .next()
            .map_err(sql_error)?
            .ok_or_else(invalid_history)?;
        let rev: String = current.get(0).map_err(sql_error)?;
        let payload = metadata(
            &kind,
            &owner,
            current
                .get_ref(1)
                .map_err(sql_error)?
                .as_blob()
                .map_err(|_| invalid_history())?,
        )?;
        let order = (
            current.get::<_, i64>(2).map_err(sql_error)?,
            current.get::<_, i64>(3).map_err(sql_error)?,
        );
        if rev != expected || head_link(&payload) != link.as_deref() {
            return Err(invalid_history());
        }
        if let Some(second) = versions.next().map_err(sql_error)?
            && (
                second.get::<_, i64>(2).map_err(sql_error)?,
                second.get::<_, i64>(3).map_err(sql_error)?,
            ) == order
        {
            return Err(invalid_history());
        }
        if kind == "folder"
            && link.is_none()
            && !roots.exists(params![space, owner]).map_err(sql_error)?
        {
            return Err(invalid_history());
        }
    }
    Ok(())
}

type Key = [u8; 32];

pub(super) fn key(fields: &[&str]) -> Key {
    let mut hash = blake3::Hasher::new();
    for s in fields {
        scalar(&mut hash, b't', s.as_bytes());
    }
    *hash.finalize().as_bytes()
}

#[derive(Default)]
struct Entity {
    head: Option<Key>,
    latest: Option<((i64, i64), Key)>,
    tie: bool,
    at_zero: bool,
    root: bool,
    folder_is_root: Option<bool>,
    needs_owner: bool,
    has_owner: bool,
}

#[derive(Default)]
pub(super) struct Histories {
    entities: BTreeMap<Key, Entity>,
    // Partition by (space, incarnation), so witnesses and maximum revision
    // visibility meet without copying every Space into each partition.
    cuts: BTreeMap<Key, (Option<i64>, i64)>,
    pub(super) publications: super::ability::Publications,
}

impl Histories {
    pub(super) fn len(&self) -> usize {
        self.entities.len() + self.cuts.len() + self.publications.len()
    }
}

fn string(value: &PostgresSpoolValue) -> Result<&str, PortError> {
    match value {
        PostgresSpoolValue::Text(s) => Ok(s),
        _ => Err(invalid_history()),
    }
}
fn optional(value: &PostgresSpoolValue) -> Result<Option<&str>, PortError> {
    match value {
        PostgresSpoolValue::Null => Ok(None),
        _ => string(value).map(Some),
    }
}
fn int(value: &PostgresSpoolValue) -> Result<i64, PortError> {
    match value {
        PostgresSpoolValue::Int(n) => Ok(*n),
        _ => Err(invalid_history()),
    }
}
fn bytes(value: &PostgresSpoolValue) -> Result<&[u8], PortError> {
    match value {
        PostgresSpoolValue::Bytes(b) => Ok(b),
        _ => Err(invalid_history()),
    }
}

impl Partition<'_> {
    pub(super) fn includes(&self, key: &Key) -> bool {
        !self.full
            && (self.bits == 0
                || u16::from_be_bytes([key[0], key[1]]) >> (16 - self.bits) == self.prefix)
    }

    pub(super) fn history_row(
        &mut self,
        table: &str,
        row: &[PostgresSpoolValue],
    ) -> Result<Option<RevisionMetadataPayload>, PortError> {
        if self.full {
            return Ok(None);
        }
        if table == "spaces" || table == "revisions" {
            let space = string(&row[0])?;
            let mut hash = blake3::Hasher::new();
            scalar(&mut hash, b's', space.as_bytes());
            scalar(&mut hash, b'i', bytes(&row[1])?);
            let scope = *hash.finalize().as_bytes();
            if self.includes(&scope) {
                let (cut, used) = self.history.cuts.entry(scope).or_default();
                if table == "spaces" {
                    *cut = Some(int(&row[9])?);
                } else {
                    *used = (*used).max(int(&row[6])?);
                }
            }
        }
        if table == "revisions" {
            let (space, rev, kind, owner) = (
                string(&row[0])?,
                string(&row[2])?,
                string(&row[3])?,
                string(&row[4])?,
            );
            let id = key(&[space, kind, owner]);
            if self.includes(&id) {
                stored_ids(
                    rev,
                    string(&row[13])?,
                    optional(&row[15])?,
                    optional(&row[9])?,
                )?;
                let value = metadata(kind, owner, bytes(&row[11])?)?;
                if let RevisionMetadataPayload::Ability(a) = &value {
                    self.record_domain_key(
                        "package_note",
                        &[space, owner, a.entrypoint_note_id.as_str()],
                        &[],
                        REQUIRED,
                        0,
                        0,
                    );
                }
                let state = self.history.entities.entry(id).or_default();
                state.needs_owner = kind != "rank";
                if let RevisionMetadataPayload::Folder(f) = &value
                    && state
                        .folder_is_root
                        .replace(f.is_root)
                        .is_some_and(|previous| previous != f.is_root)
                {
                    return Err(invalid_history());
                }
                let order = (int(&row[6])?, int(&row[5])?);
                if order == (0, 0)
                    && matches!(value, RevisionMetadataPayload::Folder(ref f) if f.is_root)
                {
                    state.at_zero = true;
                }
                let package_kind = match &value {
                    RevisionMetadataPayload::Ability(manifest) => ability_kind_to_db(manifest.kind),
                    _ => "",
                };
                let witness = key(&[rev, head_link(&value).unwrap_or(""), package_kind]);
                match state.latest {
                    Some((old, _)) if old == order => state.tie = true,
                    Some((old, _)) if old > order => {}
                    _ => {
                        state.latest = Some((order, witness));
                        state.tie = false;
                    }
                }
                return Ok(Some(value));
            }
            return Ok(None);
        }
        let (kind, owner, rev, link): (&str, std::borrow::Cow<'_, str>, &str, Option<&str>) =
            match table {
                "folder_heads" => (
                    "folder",
                    string(&row[1])?.into(),
                    string(&row[15])?,
                    optional(&row[2])?,
                ),
                "note_heads" => (
                    "note",
                    string(&row[1])?.into(),
                    string(&row[9])?,
                    Some(string(&row[2])?),
                ),
                "chat_threads" => (
                    "thread",
                    string(&row[2])?.into(),
                    string(&row[8])?,
                    optional(&row[5])?,
                ),
                "ability_packages" => (
                    "ability",
                    string(&row[1])?.into(),
                    string(&row[5])?,
                    Some(string(&row[4])?),
                ),
                "view_rank_overlays" => (
                    "rank",
                    format!(
                        "{}:{}:{}",
                        string(&row[1])?,
                        string(&row[2])?,
                        string(&row[3])?
                    )
                    .into(),
                    string(&row[7])?,
                    None,
                ),
                "agent_run_heads" => ("agent_run", string(&row[2])?.into(), string(&row[3])?, None),
                _ => return Ok(None),
            };
        let space = string(&row[0])?;
        let id = key(&[space, kind, &owner]);
        if self.includes(&id) {
            if table == "ability_packages" {
                self.record_domain_key(
                    "package_note",
                    &[space, &owner, string(&row[4])?],
                    &[],
                    PRESENT,
                    0,
                    0,
                );
            }
            let state = self.history.entities.entry(id).or_default();
            state.has_owner = true;
            if (table == "note_heads" && string(&row[12])? == "purged")
                || (table == "ability_packages" && string(&row[7])? == "purged")
            {
                return Ok(None);
            }
            let listed_kind = if table == "ability_packages" {
                string(&row[2])?
            } else {
                ""
            };
            state.head = Some(key(&[rev, link.unwrap_or(""), listed_kind]));
            state.root = kind == "folder" && link.is_none();
        }
        Ok(None)
    }

    pub(super) fn check_histories(&self) -> Result<(), PortError> {
        if self
            .history
            .cuts
            .values()
            .any(|(cut, used)| cut.is_none_or(|last| last < *used))
            || self.history.entities.values().any(|e| {
                e.needs_owner && !e.has_owner
                    || e.head.is_some()
                        && (e.tie || e.head != e.latest.map(|(_, rev)| rev) || e.root && !e.at_zero)
            })
        {
            return Err(invalid_history());
        }
        Ok(())
    }
}
