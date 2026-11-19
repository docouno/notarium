//! Check the schema and references using trusted storage definitions. Logical
//! spools cannot prove a foreign key by presenting only a self-authored header.

use std::collections::{BTreeMap, BTreeSet};

use notarium_canonical::{
    backup::{PostgresSpoolValue, spool_tables},
    schema::{
        SQLITE_BASELINE_DDL,
        manifest::{CANONICAL_SCHEMA_VERSION, LogicalColKind, TableSpec},
        sqlite_archive_privacy_ddl, sqlite_archive_versions_ddl,
    },
};
use notarium_control::store::{SQLITE_TARGET_DDL, TargetRecord};
use notarium_core::{
    error::{PortError, ValidationReason},
    ports::Cancellation,
};
use rusqlite::Connection;

use crate::{backup_format::invalid, import::check_cancelled, sqlite_range::sql_error};

const MAX_KEYS_PER_PARTITION: usize = 128 * 1024;
const MAX_PARTITION_BITS: u8 = 16;

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
    schema
        .query_map([kind], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(sql_error)?
        .collect::<Result<_, _>>()
        .map_err(sql_error)
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
    if definitions(db, "index")?
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
            };
            scan(&mut partition)?;
            if partition.full {
                if bits >= MAX_PARTITION_BITS {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                pending.extend([(bits + 1, prefix * 2), (bits + 1, prefix * 2 + 1)]);
            } else if partition.keys.values().any(|flags| *flags == 1) {
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
}

impl Partition<'_> {
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
            Ok(match &row[index] {
                PostgresSpoolValue::Null => false,
                PostgresSpoolValue::Text(value) => scalar(digest, b't', value.as_bytes()),
                PostgresSpoolValue::Bytes(value) => scalar(digest, b'b', value),
                PostgresSpoolValue::Int(value) => scalar(digest, b'i', &value.to_be_bytes()),
            })
        })
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
                let digest = *hasher.finalize().as_bytes();
                let top = u16::from_be_bytes([digest[0], digest[1]]);
                if self.bits != 0 && top >> (16 - self.bits) != self.prefix {
                    continue;
                }
                *self.keys.entry(digest).or_insert(0) |= flag;
                self.full = self.keys.len() > MAX_KEYS_PER_PARTITION;
            }
        }
        Ok(())
    }
}

fn scalar(digest: &mut blake3::Hasher, kind: u8, bytes: &[u8]) -> bool {
    digest.update(&[kind]);
    digest.update(&(bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
    true
}
