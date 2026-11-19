//! Check the schema and references using trusted storage definitions. Logical
//! spools cannot prove a foreign key by presenting only a self-authored header.

use std::collections::{BTreeMap, BTreeSet};

use notarium_canonical::{
    backup::{PostgresSpoolValue, spool_tables},
    codec::{RevisionMetadataEnvelope, RevisionMetadataPayload},
    schema::{
        POSTGRES_BASELINE_DDL, SQLITE_BASELINE_DDL,
        manifest::{CANONICAL_SCHEMA_VERSION, LogicalColKind, TableSpec},
        sqlite_archive_privacy_ddl, sqlite_archive_versions_ddl,
    },
};
use notarium_control::store::{SQLITE_TARGET_DDL, TargetRecord};
use notarium_core::{
    error::{PortError, ValidationReason},
    ids::ContentDigest,
    ports::Cancellation,
};
use rusqlite::{Connection, OptionalExtension, ToSql, params, params_from_iter, types::Null};

use crate::{backup_format::invalid, import::check_cancelled, sqlite_range::sql_error};

const MAX_KEYS_PER_PARTITION: usize = 128 * 1024;
const MAX_PARTITION_BITS: u8 = 16;
const REQUIRED: u8 = 1;
const PRESENT: u8 = 2;
const EXACT: u8 = 4;
const UNIQUE: u8 = 8;
const DUPLICATE: u8 = 16;

#[derive(Debug, Eq, PartialEq, Ord, PartialOrd)]
struct ForeignKey {
    target: String,
    columns: Vec<String>,
    target_columns: Vec<String>,
}

fn foreign_keys(db: &Connection, table: &str) -> Result<Vec<ForeignKey>, PortError> {
    let mut query = db.prepare(
        "SELECT id, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?1) ORDER BY id,seq",
    ).map_err(sql_error)?;
    let mut rows = query.query([table]).map_err(sql_error)?;
    let mut keys: BTreeMap<i64, ForeignKey> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        let key = keys
            .entry(row.get(0).map_err(sql_error)?)
            .or_insert(ForeignKey {
                target: row.get(1).map_err(sql_error)?,
                columns: Vec::new(),
                target_columns: Vec::new(),
            });
        key.columns.push(row.get(2).map_err(sql_error)?);
        key.target_columns.push(row.get(3).map_err(sql_error)?);
    }
    let mut result = keys.into_values().collect::<Vec<_>>();
    result.sort_unstable();
    Ok(result)
}

fn trusted(ddl: &str) -> Result<Connection, PortError> {
    let db = Connection::open_in_memory().map_err(sql_error)?;
    db.execute_batch(ddl).map_err(sql_error)?;
    Ok(db)
}

fn tables(db: &Connection) -> Result<BTreeSet<String>, PortError> {
    let mut names = db.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' LIMIT 257",
    ).map_err(sql_error)?;
    names
        .query_map([], |row| row.get(0))
        .map_err(sql_error)?
        .collect::<Result<_, _>>()
        .map_err(sql_error)
}

fn definitions(db: &Connection, kind: &str) -> Result<BTreeMap<String, String>, PortError> {
    let mut schema = db.prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type=?1 AND sql IS NOT NULL AND name<>'_sqlx_migrations' LIMIT 1025",
    ).map_err(sql_error)?;
    let mut rows = schema.query([kind]).map_err(sql_error)?;
    let mut result = BTreeMap::new();
    let mut bytes = 0;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let name: String = row.get(0).map_err(sql_error)?;
        let ddl = row
            .get_ref(1)
            .map_err(sql_error)?
            .as_str()
            .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
        bytes += name.len() + ddl.len();
        if bytes > 512 * 1024 || result.len() >= 1024 {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        result.insert(name, ddl.to_owned());
    }
    Ok(result)
}

pub(crate) fn check_sqlite_control(db: &Connection) -> Result<(), PortError> {
    let expected = trusted(SQLITE_TARGET_DDL)?;
    for kind in ["table", "index", "trigger", "view"] {
        if definitions(db, kind)? != definitions(&expected, kind)? {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
    }
    Ok(())
}

pub(crate) fn check_sqlite_canonical(db: &Connection, version: u32) -> Result<(), PortError> {
    let expected = trusted(SQLITE_BASELINE_DDL)?;
    let specs = spool_tables(version);
    let actual_tables = tables(db)?;
    if actual_tables
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != specs
            .clone()
            .map(|table| table.name)
            .collect::<BTreeSet<_>>()
        || !definitions(db, "view")?.is_empty()
    {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    if version >= CANONICAL_SCHEMA_VERSION {
        for sql in sqlite_archive_privacy_ddl().chain(sqlite_archive_versions_ddl()) {
            expected.execute_batch(&sql).map_err(sql_error)?;
        }
    }
    if definitions(db, "trigger")? != definitions(&expected, "trigger")? {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    let actual_indexes = definitions(db, "index")?;
    let trusted_indexes = definitions(&expected, "index")?;
    if actual_indexes
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != specs
            .clone()
            .flat_map(|table| table.indexes.iter().copied())
            .collect::<BTreeSet<_>>()
    {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    if version >= CANONICAL_SCHEMA_VERSION {
        if actual_indexes.iter().any(|(name, sql)| {
            trusted_indexes
                .get(name)
                .is_none_or(|trusted| normalize_ddl(sql) != normalize_ddl(trusted))
        }) {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
        let actual = definitions(db, "table")?;
        let expected = definitions(&expected, "table")?;
        for (table, trusted) in expected {
            let sql = actual
                .get(&table)
                .ok_or_else(|| invalid(ValidationReason::InvalidArchive))?;
            if table_clauses(sql)? != table_clauses(&trusted)? {
                return Err(invalid(ValidationReason::InvalidArchive));
            }
        }
    }
    let mut column_query = db.prepare("SELECT name,type,\"notnull\",pk,hidden FROM pragma_table_xinfo(?1) ORDER BY cid LIMIT 257")
        .map_err(sql_error)?;
    for spec in specs {
        if foreign_keys(db, spec.name)? != foreign_keys(&expected, spec.name)? {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
        let mut actual = column_query.query([spec.name]).map_err(sql_error)?;
        for column in spec.columns {
            let row = actual
                .next()
                .map_err(sql_error)?
                .ok_or_else(|| invalid(ValidationReason::InvalidArchive))?;
            let name = row.get::<_, String>(0).map_err(sql_error)?;
            let declared_type = row.get::<_, String>(1).map_err(sql_error)?;
            let pk = row.get::<_, i64>(3).map_err(sql_error)?;
            let nullable = row.get::<_, i64>(2).map_err(sql_error)? == 0 && pk == 0;
            let hidden = row.get::<_, i64>(4).map_err(sql_error)?;
            let expected_type = match column.kind {
                LogicalColKind::Int => "INTEGER",
                LogicalColKind::Text => "TEXT",
                LogicalColKind::Bytes => "BLOB",
            };
            let expected_pk = spec
                .primary_key
                .iter()
                .position(|key| *key == column.name)
                .map_or(0, |i| i as i64 + 1);
            if name != column.name
                || declared_type != expected_type
                || pk != expected_pk
                || nullable != column.nullable
                || hidden != 0
            {
                return Err(invalid(ValidationReason::InvalidArchive));
            }
        }
        if actual.next().map_err(sql_error)?.is_some() {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
    }
    Ok(())
}

fn normalize_ddl(sql: &str) -> String {
    let mut quoted = false;
    sql.chars()
        .filter_map(|ch| match ch {
            '\'' => {
                quoted = !quoted;
                Some(ch)
            }
            ch if quoted => Some(ch),
            '"' => None,
            ch if ch.is_ascii_whitespace() => None,
            ch => Some(ch.to_ascii_lowercase()),
        })
        .collect()
}

fn table_clauses(sql: &str) -> Result<(Vec<String>, String), PortError> {
    let start = sql
        .find('(')
        .ok_or_else(|| invalid(ValidationReason::InvalidArchive))?;
    let tail = matching_paren(&sql[start..])? + start;
    let body = &sql[start + 1..tail];
    let mut clauses = Vec::new();
    let mut from = 0;
    let mut depth = 0;
    let mut quoted = false;
    for (index, ch) in body.char_indices() {
        match ch {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth -= 1,
            ',' if !quoted && depth == 0 => {
                clauses.push(normalize_ddl(&body[from..index]));
                from = index + 1;
            }
            _ => {}
        }
    }
    clauses.push(normalize_ddl(&body[from..]));
    clauses.sort_unstable();
    Ok((clauses, normalize_ddl(&sql[tail + 1..])))
}

fn matching_paren(sql: &str) -> Result<usize, PortError> {
    let mut depth = 0;
    let mut quoted = false;
    for (index, ch) in sql.char_indices() {
        match ch {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Ok(index);
                }
            }
            _ => {}
        }
    }
    Err(invalid(ValidationReason::InvalidArchive))
}

/// Evaluate the repository's trusted row constraints against typed spool
/// values. The in-memory connection evaluates expressions only.
pub(crate) struct PgRowChecks {
    db: Connection,
    sqlite: BTreeMap<String, String>,
    statements: BTreeMap<&'static str, String>,
    narrow: BTreeMap<&'static str, Vec<usize>>,
    unique_indexes: BTreeMap<String, Vec<UniqueIndex>>,
}

struct UniqueIndex {
    name: String,
    columns: Vec<String>,
    predicate: String,
}

impl PgRowChecks {
    pub(crate) fn new() -> Result<Self, PortError> {
        let db = trusted(SQLITE_BASELINE_DDL)?;
        let sqlite = definitions(&db, "table")?;
        let mut unique_indexes: BTreeMap<String, Vec<UniqueIndex>> = BTreeMap::new();
        for (name, definition) in definitions(&db, "index")? {
            if !definition.starts_with("CREATE UNIQUE INDEX ") {
                continue;
            }
            let (_, target) = definition
                .split_once(" ON ")
                .or_else(|| definition.split_once("    ON "))
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let start = target
                .find('(')
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let end = start + matching_paren(&target[start..])?;
            let columns = target[start + 1..end]
                .split(',')
                .map(|column| column.trim().to_owned())
                .collect();
            let predicate = target[end + 1..]
                .trim()
                .strip_prefix("WHERE ")
                .unwrap_or("1")
                .to_owned();
            unique_indexes
                .entry(target[..start].trim().to_owned())
                .or_default()
                .push(UniqueIndex {
                    name,
                    columns,
                    predicate,
                });
        }
        Ok(Self {
            db,
            sqlite,
            statements: BTreeMap::new(),
            narrow: BTreeMap::new(),
            unique_indexes,
        })
    }

    pub(crate) fn check(
        &mut self,
        table: TableSpec,
        row: &[PostgresSpoolValue],
        partition: Option<&mut Partition<'_>>,
    ) -> Result<(), PortError> {
        if partition.is_some() && !self.unique_indexes.contains_key(table.name) {
            return Ok(());
        }
        if !self.statements.contains_key(table.name) {
            let mut input = self
                .sqlite
                .get(table.name)
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?
                .as_str();
            let mut checks = Vec::new();
            while let Some(start) = input.find("CHECK") {
                let expression = input[start + "CHECK".len()..].trim_start();
                let tail = matching_paren(expression)?;
                checks.push(format!("COALESCE({},1)", &expression[..=tail]));
                input = &expression[tail + 1..];
            }
            let mut parameters = table
                .columns
                .iter()
                .enumerate()
                .map(|(index, column)| format!("?{} AS \"{}\"", index + 1, column.name))
                .collect::<Vec<_>>();
            let mut defaults = self
                .db
                .prepare("SELECT name, dflt_value FROM pragma_table_info(?1)")
                .map_err(sql_error)?;
            for column in defaults
                .query_map([table.name], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(sql_error)?
            {
                let (name, default) = column.map_err(sql_error)?;
                if !table.columns.iter().any(|column| column.name == name) {
                    parameters.push(format!(
                        "{} AS \"{name}\"",
                        default.as_deref().unwrap_or("NULL")
                    ));
                }
            }
            let predicate = if checks.is_empty() {
                "1".to_owned()
            } else {
                checks.join(" AND ")
            };
            let mut selected = vec![predicate];
            for index in self.unique_indexes.get(table.name).into_iter().flatten() {
                selected.push(format!("COALESCE(({}),0)", index.predicate));
            }
            self.statements.insert(
                table.name,
                format!(
                    "SELECT {} FROM (SELECT {})",
                    selected.join(","),
                    parameters.join(",")
                ),
            );
            let pg_start = format!("CREATE TABLE IF NOT EXISTS {} (", table.name);
            let (_, rest) = POSTGRES_BASELINE_DDL
                .split_once(&pg_start)
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let (body, _) = rest
                .split_once("\n);")
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let integers = body
                .lines()
                .filter_map(|line| {
                    let mut words = line.trim().split_ascii_whitespace();
                    let name = words.next()?;
                    (words.next()?.trim_end_matches(',') == "INTEGER").then_some(name)
                })
                .collect::<BTreeSet<_>>();
            self.narrow.insert(
                table.name,
                table
                    .columns
                    .iter()
                    .enumerate()
                    .filter_map(|(index, col)| integers.contains(col.name).then_some(index))
                    .collect(),
            );
        }
        let narrow = &self.narrow[table.name];
        for (index, value) in row.iter().enumerate() {
            if matches!(value, PostgresSpoolValue::Text(value) if value.contains('\0'))
                || (narrow.contains(&index)
                    && matches!(value, PostgresSpoolValue::Int(value) if i32::try_from(*value).is_err()))
            {
                return Err(invalid(ValidationReason::InvalidArchive));
            }
        }
        let mut query = self
            .db
            .prepare_cached(&self.statements[table.name])
            .map_err(sql_error)?;
        let mut evaluated = query
            .query(params_from_iter(row.iter().map(|value| -> &dyn ToSql {
                match value {
                    PostgresSpoolValue::Null => &Null,
                    PostgresSpoolValue::Text(v) => v,
                    PostgresSpoolValue::Bytes(v) => v,
                    PostgresSpoolValue::Int(v) => v,
                }
            })))
            .map_err(sql_error)?;
        let fields = evaluated
            .next()
            .map_err(sql_error)?
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        if !fields.get::<_, bool>(0).map_err(sql_error)? {
            return Err(invalid(ValidationReason::InvalidArchive));
        }
        if let Some(partition) = partition {
            for (offset, index) in self
                .unique_indexes
                .get(table.name)
                .into_iter()
                .flatten()
                .enumerate()
            {
                if fields.get::<_, bool>(offset + 1).map_err(sql_error)? {
                    partition.note_unique(index, table, row)?;
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn check_sqlite_blob_owners(db: &Connection) -> Result<(), PortError> {
    const OWNERS: &str = "
        SELECT space_id,'note_revision' AS kind,entity_key AS owner,rev_id AS rev,'carrier' AS resource,content_blake3 AS digest
          FROM revisions WHERE entity_type='note' AND content_blake3 IS NOT NULL
        UNION ALL
        SELECT space_id,'chat_entry',thread_id||':'||entry_seq,revision_id,'body',payload_blake3
          FROM chat_entries WHERE payload_blake3 IS NOT NULL
        UNION ALL
        SELECT space_id,'chat_pending_input',thread_id||':'||input_id,CAST(enqueued_seq AS TEXT),'body',payload_blake3
          FROM chat_pending_inputs WHERE status='pending' AND payload_blake3 IS NOT NULL";
    let owners = format!(
        "WITH owners AS ({OWNERS})
         SELECT EXISTS(SELECT 1 FROM owners o WHERE NOT EXISTS (
           SELECT 1 FROM blob_references r WHERE r.space_id=o.space_id AND r.owner_kind=o.kind
             AND r.owner_id=o.owner AND r.resource_key=o.resource AND r.content_blake3=o.digest
             AND CASE WHEN o.kind='chat_pending_input' THEN CAST(r.created_seq AS TEXT) ELSE r.owner_rev_id END=o.rev
         ))"
    );
    // Inlining the trusted CTE keeps verification on the database's indexes
    // instead of materializing all retained revisions in a temp table.
    let owners = owners.replacen("owners AS (", "owners AS NOT MATERIALIZED (", 1);
    let bad: bool = db
        .query_row(&owners, [], |row| row.get(0))
        .map_err(sql_error)?;
    if bad || db.query_row(
        "SELECT EXISTS(SELECT 1 FROM note_heads h WHERE h.content_blake3 IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM revisions r WHERE r.space_id=h.space_id AND r.rev_id=h.head_rev_id
                 AND r.entity_type='note' AND r.entity_key=h.note_id AND r.content_blake3=h.content_blake3))",
        [], |row| row.get::<_, bool>(0),
    ).map_err(sql_error)? {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    if db.query_row(
        "SELECT EXISTS(SELECT 1 FROM blob_references r WHERE
            (r.owner_kind='note_revision' AND (r.resource_key<>'carrier' OR NOT EXISTS(
                SELECT 1 FROM revisions n WHERE n.space_id=r.space_id AND n.rev_id=r.owner_rev_id
                    AND n.entity_type='note' AND n.entity_key=r.owner_id AND n.content_blake3=r.content_blake3)))
            OR (r.owner_kind='chat_entry' AND (r.resource_key<>'body' OR NOT EXISTS(
                SELECT 1 FROM chat_entries c WHERE c.space_id=r.space_id
                    AND c.thread_id=substr(r.owner_id,1,instr(r.owner_id,':')-1)
                    AND c.entry_seq=CAST(substr(r.owner_id,instr(r.owner_id,':')+1) AS INTEGER)
                    AND c.thread_id||':'||c.entry_seq=r.owner_id
                    AND c.revision_id=r.owner_rev_id AND c.payload_blake3=r.content_blake3)))
            OR (r.owner_kind='chat_pending_input' AND (r.resource_key<>'body' OR NOT EXISTS(
                SELECT 1 FROM chat_pending_inputs c WHERE c.space_id=r.space_id
                    AND c.thread_id=substr(r.owner_id,1,instr(r.owner_id,':')-1)
                    AND c.input_id=substr(r.owner_id,instr(r.owner_id,':')+1)
                    AND c.status='pending' AND c.enqueued_seq=r.created_seq
                    AND c.payload_blake3=r.content_blake3))))",
        [], |row| row.get::<_, bool>(0),
    ).map_err(sql_error)? {
        return Err(invalid(ValidationReason::InvalidDigest));
    }
    check_sqlite_ability_resources(db)?;
    let mut snapshots = db
        .prepare("SELECT yrs_snapshot_blake3,yrs_snapshot_blob FROM collab_sessions")
        .map_err(sql_error)?;
    let mut rows = snapshots.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let hash: Option<Vec<u8>> = row.get(0).map_err(sql_error)?;
        let snapshot: Option<Vec<u8>> = row.get(1).map_err(sql_error)?;
        check_inline_snapshot(hash.as_deref(), snapshot.as_deref())?;
    }
    Ok(())
}

fn check_sqlite_ability_resources(db: &Connection) -> Result<(), PortError> {
    let mut revisions = db.prepare("SELECT space_id,entity_key,rev_id,metadata_msgpack FROM revisions WHERE entity_type='ability'")
        .map_err(sql_error)?;
    let mut resources = db
        .prepare(
            "SELECT resource_key,content_blake3 FROM blob_references
         WHERE owner_kind='ability_resource' AND space_id=?1 AND owner_id=?2 AND owner_rev_id=?3",
        )
        .map_err(sql_error)?;
    let mut rows = revisions.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let space: String = row.get(0).map_err(sql_error)?;
        let owner: String = row.get(1).map_err(sql_error)?;
        let rev: String = row.get(2).map_err(sql_error)?;
        let metadata = row
            .get_ref(3)
            .map_err(sql_error)?
            .as_blob()
            .map_err(|_| invalid(ValidationReason::InvalidArchive))?;
        let mut expected = ability_resources(&owner, metadata)?;
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
    Ok(())
}

fn ability_resources(
    owner: &str,
    metadata: &[u8],
) -> Result<BTreeMap<String, ContentDigest>, PortError> {
    let RevisionMetadataPayload::Ability(value) =
        RevisionMetadataEnvelope::decode(metadata)?.payload
    else {
        return Err(invalid(ValidationReason::InvalidArchive));
    };
    if value.ability_id.as_str() != owner {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    Ok(value.resources)
}

fn check_inline_snapshot(digest: Option<&[u8]>, snapshot: Option<&[u8]>) -> Result<(), PortError> {
    match (digest, snapshot) {
        (None, None) => Ok(()),
        (Some(digest), Some(bytes)) if blake3::hash(bytes).as_bytes() == digest => Ok(()),
        _ => Err(invalid(ValidationReason::InvalidDigest)),
    }
}

#[derive(Default)]
struct ProjectionSet {
    candidates: Vec<(usize, Vec<String>)>,
    references: Vec<(usize, Vec<String>)>,
}

pub(crate) struct Relations(BTreeMap<String, ProjectionSet>);

impl Relations {
    pub(crate) fn new(canonical: bool) -> Result<Self, PortError> {
        let db = trusted(if canonical {
            SQLITE_BASELINE_DDL
        } else {
            SQLITE_TARGET_DDL
        })?;
        let mut targets = BTreeMap::new();
        let mut projections: BTreeMap<String, ProjectionSet> = BTreeMap::new();
        let mut add = |table: &String, key: ForeignKey| {
            let next = targets.len();
            let index = *targets
                .entry((key.target.clone(), key.target_columns.clone()))
                .or_insert(next);
            if next == index {
                projections
                    .entry(key.target)
                    .or_default()
                    .candidates
                    .push((index, key.target_columns));
            }
            projections
                .entry(table.clone())
                .or_default()
                .references
                .push((index, key.columns));
        };
        for table in tables(&db)? {
            for key in foreign_keys(&db, &table)? {
                add(&table, key);
            }
        }
        if canonical {
            // Logical CAS references and the Space's root are validated even
            // where storage uses owner checks in place of a SQL constraint.
            for (table, target, columns, target_columns) in [
                (
                    "blob_references",
                    "blob_publications",
                    ["space_id", "publication_id"],
                    ["space_id", "publication_id"],
                ),
                (
                    "blob_catalog",
                    "blob_publications",
                    ["space_id", "current_publication_id"],
                    ["space_id", "publication_id"],
                ),
                (
                    "spaces",
                    "folder_heads",
                    ["space_id", "root_folder_id"],
                    ["space_id", "folder_id"],
                ),
            ] {
                add(
                    &table.to_owned(),
                    ForeignKey {
                        target: target.to_owned(),
                        columns: columns.map(str::to_owned).into(),
                        target_columns: target_columns.map(str::to_owned).into(),
                    },
                );
            }
        }
        Ok(Self(projections))
    }

    pub(crate) fn verify(
        &self,
        cancellation: &Cancellation,
        mut scan: impl FnMut(&mut Partition<'_>) -> Result<(), PortError>,
    ) -> Result<(), PortError> {
        let mut pending = vec![(0, 0)];
        while let Some((bits, prefix)) = pending.pop() {
            check_cancelled(cancellation)?;
            let mut partition = Partition {
                relations: self,
                bits,
                prefix,
                keys: BTreeMap::new(),
                full: false,
                parts: None,
            };
            scan(&mut partition)?;
            partition.finish_parts();
            if partition.full {
                if bits >= MAX_PARTITION_BITS {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                pending.extend([(bits + 1, prefix * 2), (bits + 1, prefix * 2 + 1)]);
            } else if partition.keys.values().any(|flags| {
                flags & DUPLICATE != 0
                    || (flags & REQUIRED != 0 && flags & PRESENT == 0)
                    || (flags & EXACT != 0 && flags & REQUIRED == 0)
            }) {
                return Err(invalid(ValidationReason::InvalidArchive));
            }
        }
        Ok(())
    }
}

pub(crate) struct Partition<'a> {
    relations: &'a Relations,
    bits: u8,
    prefix: u16,
    keys: BTreeMap<[u8; 32], u8>,
    full: bool,
    parts: Option<PublicationParts>,
}

#[derive(Default)]
struct PublicationParts {
    space: String,
    publication: String,
    count: i64,
    raw: i64,
    compressed: i64,
    invalid: bool,
}

impl Partition<'_> {
    fn note_unique(
        &mut self,
        index: &UniqueIndex,
        table: TableSpec,
        row: &[PostgresSpoolValue],
    ) -> Result<(), PortError> {
        if self.full {
            return Ok(());
        }
        let mut hasher = blake3::Hasher::new();
        scalar(&mut hasher, b'u', index.name.as_bytes());
        for name in &index.columns {
            let position = table
                .columns
                .iter()
                .position(|column| column.name == name)
                .ok_or_else(|| invalid(ValidationReason::InvalidArchive))?;
            if !canonical_scalar(&row[position], &mut hasher) {
                return Ok(());
            }
        }
        self.full = Self::record_key(
            &mut self.keys,
            self.bits,
            self.prefix,
            *hasher.finalize().as_bytes(),
            UNIQUE,
        );
        Ok(())
    }

    pub(crate) fn canonical(
        &mut self,
        table: TableSpec,
        row: &[PostgresSpoolValue],
    ) -> Result<(), PortError> {
        self.record(table.name, |name, digest| {
            let index = table
                .columns
                .iter()
                .position(|column| column.name == name)
                .ok_or_else(|| invalid(ValidationReason::InvalidArchive))?;
            Ok(canonical_scalar(&row[index], digest))
        })?;
        if table.name != "blob_parts" {
            self.finish_parts();
        }
        self.record_blob_owners(table.name, row)
    }

    fn record_blob_owners(
        &mut self,
        table: &str,
        row: &[PostgresSpoolValue],
    ) -> Result<(), PortError> {
        use PostgresSpoolValue::{Bytes, Int, Null, Text};
        match (table, row) {
            ("revisions", [Text(space), _, Text(rev), Text(kind), Text(owner), ..])
                if kind == "note" =>
            {
                if let Bytes(hash) = &row[10] {
                    self.domain_key("note_revision", &[space, owner, rev, "carrier"], hash, 5);
                    self.domain_key("head_revision", &[space, owner, rev], hash, 2);
                }
            }
            ("revisions", [Text(space), _, Text(rev), Text(kind), Text(owner), ..])
                if kind == "ability" =>
            {
                let Bytes(metadata) = &row[11] else {
                    return Err(invalid(ValidationReason::InvalidArchive));
                };
                for (path, hash) in ability_resources(owner, metadata)? {
                    self.domain_key(
                        "ability_resource",
                        &[space, owner, rev, &path],
                        hash.as_bytes(),
                        5,
                    );
                }
            }
            ("note_heads", [Text(space), Text(note), ..]) => {
                if let (Text(rev), Bytes(hash)) = (&row[9], &row[10]) {
                    self.domain_key("head_revision", &[space, note, rev], hash, 1);
                }
            }
            ("chat_entries", [Text(space), Text(thread), Int(entry_seq), _, Text(rev), ..]) => {
                if let Bytes(hash) = &row[10] {
                    let owner = format!("{thread}:{entry_seq}");
                    self.domain_key("chat_entry", &[space, &owner, rev, "body"], hash, 5);
                }
            }
            ("chat_pending_inputs", [Text(space), Text(thread), Text(id), ..]) => {
                if let (Bytes(hash), Text(status), Int(seq)) = (&row[6], &row[10], &row[11])
                    && status == "pending"
                {
                    let owner = format!("{thread}:{id}");
                    self.domain_key(
                        "chat_pending_input",
                        &[space, &owner, &seq.to_string(), "body"],
                        hash,
                        5,
                    );
                }
            }
            ("collab_sessions", [Text(_), Text(_), ..]) => match (&row[5], &row[9]) {
                (Null, Null) => {}
                (Bytes(hash), Bytes(snapshot)) => {
                    check_inline_snapshot(Some(hash), Some(snapshot))?
                }
                _ => return Err(invalid(ValidationReason::InvalidDigest)),
            },
            (
                "blob_references",
                [
                    Text(space),
                    Text(kind),
                    Text(owner),
                    Text(rev),
                    Text(resource),
                    Bytes(hash),
                    Text(publication),
                    Int(seq),
                ],
            ) => {
                match kind.as_str() {
                    "note_revision" | "ability_resource" | "chat_entry" => {
                        self.domain_key(kind, &[space, owner, rev, resource], hash, 6);
                    }
                    "chat_pending_input" => {
                        self.domain_key(kind, &[space, owner, &seq.to_string(), resource], hash, 6);
                    }
                    // Staged chat rows are themselves the transient owner.
                    "staged_chat" | "collab_snapshot" => {}
                    _ => return Err(invalid(ValidationReason::InvalidArchive)),
                }
                self.domain_key("active_publication", &[space, publication], hash, 1);
                self.domain_key("current_publication", &[space, publication], hash, 1);
            }
            (
                "blob_publications",
                [
                    Text(space),
                    Text(publication),
                    Bytes(hash),
                    _,
                    Text(storage),
                    Text(state),
                    Int(sealed),
                    Int(count),
                    Int(raw),
                    Int(compressed),
                    ..,
                ],
            ) if state == "active" && *sealed == 1 => {
                self.domain_key("active_publication", &[space, publication], hash, 2);
                self.domain_key(
                    "publication_size",
                    &[space, publication, &raw.to_string()],
                    hash,
                    2,
                );
                if storage != "s3_chunked_v1"
                    || u64::try_from(*raw).ok().map(|raw| {
                        raw.div_ceil(notarium_canonical::blobs::S3_MAX_RAW_CHUNK_BYTES as u64)
                            .max(1)
                    }) != u64::try_from(*count).ok()
                {
                    return Err(invalid(ValidationReason::InvalidDigest));
                }
                self.part_witness(space, publication, *count, *raw, *compressed, REQUIRED);
            }
            (
                "blob_parts",
                [
                    Text(space),
                    Text(publication),
                    Int(index),
                    Int(raw),
                    Int(compressed),
                    _,
                    Text(key),
                    _,
                    Int(confirmed),
                ],
            ) => {
                if self
                    .parts
                    .as_ref()
                    .is_some_and(|group| group.space != *space || group.publication != *publication)
                {
                    self.finish_parts();
                }
                let group = self.parts.get_or_insert_with(|| PublicationParts {
                    space: space.clone(),
                    publication: publication.clone(),
                    ..Default::default()
                });
                group.invalid |= *index != group.count
                    || *confirmed != 1
                    || !key.ends_with(&format!("spaces/{space}/cas-v1/{publication}/{index}"));
                group.count += 1;
                group.raw = group
                    .raw
                    .checked_add(*raw)
                    .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?;
                group.compressed = group
                    .compressed
                    .checked_add(*compressed)
                    .ok_or_else(|| invalid(ValidationReason::InvalidDigest))?;
            }
            (
                "blob_catalog",
                [
                    Text(space),
                    Bytes(hash),
                    Int(raw),
                    _,
                    Int(count),
                    publication,
                    ..,
                ],
            ) if *count > 0 => {
                let Text(publication) = publication else {
                    return Err(invalid(ValidationReason::InvalidDigest));
                };
                self.domain_key(
                    "publication_size",
                    &[space, publication, &raw.to_string()],
                    hash,
                    1,
                );
                self.domain_key("current_publication", &[space, publication], hash, 2);
            }
            _ => {}
        }
        Ok(())
    }

    fn finish_parts(&mut self) {
        if let Some(parts) = self.parts.take()
            && !parts.invalid
        {
            self.part_witness(
                &parts.space,
                &parts.publication,
                parts.count,
                parts.raw,
                parts.compressed,
                PRESENT,
            );
        }
    }

    fn part_witness(
        &mut self,
        space: &str,
        publication: &str,
        count: i64,
        raw: i64,
        compressed: i64,
        flag: u8,
    ) {
        self.domain_key(
            "sealed_parts",
            &[
                space,
                publication,
                &count.to_string(),
                &raw.to_string(),
                &compressed.to_string(),
            ],
            &[],
            flag,
        );
    }

    fn domain_key(&mut self, relation: &str, values: &[&str], hash: &[u8], flag: u8) {
        if self.full {
            return;
        }
        let mut hasher = blake3::Hasher::new();
        scalar(&mut hasher, b'd', relation.as_bytes());
        for value in values {
            scalar(&mut hasher, b't', value.as_bytes());
        }
        scalar(&mut hasher, b'b', hash);
        self.full = Self::record_key(
            &mut self.keys,
            self.bits,
            self.prefix,
            *hasher.finalize().as_bytes(),
            flag,
        );
    }

    pub(crate) fn control(&mut self, row: &TargetRecord) -> Result<(), PortError> {
        self.record(row.table().name(), |name, digest| {
            Ok(match row.relational_value(name)? {
                serde_json::Value::Null => false,
                serde_json::Value::String(value) => scalar(digest, b't', value.as_bytes()),
                serde_json::Value::Number(value) => scalar(
                    digest,
                    b'i',
                    &value
                        .as_i64()
                        .ok_or_else(|| invalid(ValidationReason::InvalidArchive))?
                        .to_be_bytes(),
                ),
                _ => return Err(invalid(ValidationReason::InvalidArchive)),
            })
        })
    }

    fn record(
        &mut self,
        table: &str,
        mut column: impl FnMut(&str, &mut blake3::Hasher) -> Result<bool, PortError>,
    ) -> Result<(), PortError> {
        let Some(relation) = self.relations.0.get(table) else {
            return Ok(());
        };
        for (projections, flag) in [(&relation.references, 1), (&relation.candidates, 2)] {
            for (target, names) in projections {
                if self.full {
                    return Ok(());
                }
                let mut hasher = blake3::Hasher::new();
                hasher.update(&(*target as u64).to_be_bytes());
                let mut nonnull = true;
                for name in names {
                    if !column(name, &mut hasher)? {
                        nonnull = false;
                        break;
                    }
                }
                if !nonnull {
                    continue;
                }
                self.full = Self::record_key(
                    &mut self.keys,
                    self.bits,
                    self.prefix,
                    *hasher.finalize().as_bytes(),
                    flag,
                );
            }
        }
        Ok(())
    }

    fn record_key(
        keys: &mut BTreeMap<[u8; 32], u8>,
        bits: u8,
        prefix: u16,
        digest: [u8; 32],
        flag: u8,
    ) -> bool {
        let top = u16::from_be_bytes([digest[0], digest[1]]);
        if bits == 0 || top >> (16 - bits) == prefix {
            let previous = keys.entry(digest).or_insert(0);
            if *previous & flag & UNIQUE != 0 {
                *previous |= DUPLICATE;
            }
            *previous |= flag;
        }
        keys.len() > MAX_KEYS_PER_PARTITION
    }
}

fn scalar(digest: &mut blake3::Hasher, kind: u8, bytes: &[u8]) -> bool {
    digest.update(&[kind]);
    digest.update(&(bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
    true
}

fn canonical_scalar(value: &PostgresSpoolValue, digest: &mut blake3::Hasher) -> bool {
    match value {
        PostgresSpoolValue::Null => false,
        PostgresSpoolValue::Text(value) => scalar(digest, b't', value.as_bytes()),
        PostgresSpoolValue::Bytes(value) => scalar(digest, b'b', value),
        PostgresSpoolValue::Int(value) => scalar(digest, b'i', &value.to_be_bytes()),
    }
}
