use std::time::{SystemTime, UNIX_EPOCH};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{HistoryIncarnation, ProjectionGeneration, SpaceId, SpaceSeq},
    model::HistoryScope,
};
use notarium_syntax::unicode::{CASEFOLD_UNICODE_VERSION, NORMALIZATION_UNICODE_VERSION};

use super::{
    records::*,
    sql::{Kind, SqlColumn, SqlRecord, SqlTransaction, SqlValue, value},
};

pub(super) const SCHEMA_VERSION: i64 = 2;
const MMAP_VERSION: i64 = crate::mmap::FORMAT_VERSION as i64;

pub(super) async fn initialize(
    tx: &mut SqlTransaction<'_>,
    generation: ProjectionGeneration,
) -> Result<bool, PortError> {
    if tx.postgres() {
        tx.batch("SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 272014));")
            .await?;
    }
    tx.batch(
        "CREATE TABLE IF NOT EXISTS derived_schema_meta (
            generation BIGINT PRIMARY KEY,
            schema_version BIGINT NOT NULL,
            unicode_casefold_ver TEXT NOT NULL,
            unicode_norm_ver TEXT NOT NULL,
            mmap_format_ver BIGINT NOT NULL,
            created_at_ms BIGINT NOT NULL
        );",
    )
    .await?;
    match metadata_state(tx, "derived_schema_meta", generation).await? {
        MetadataState::Obsolete => return Ok(false),
        MetadataState::Current => {}
        MetadataState::Empty => {
            let existing = if tx.postgres() {
                "SELECT COUNT(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
                 ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')"
            } else {
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            };
            let count = tx.select(existing, Vec::new(), &[Kind::Integer]).await?;
            if count.as_slice() != [vec![value(&1_i64)]] {
                return Err(generation_mismatch());
            }
            let mut values = expected_metadata(generation);
            values.push(value(&now_ms()));
            tx.execute(
                "INSERT INTO derived_schema_meta
                    (generation, schema_version, unicode_casefold_ver, unicode_norm_ver, mmap_format_ver, created_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?)",
                values,
            )
            .await?;
        }
    }

    let postgres = tx.postgres();
    let mut ddl = String::new();
    define::<WatermarkRecord>(&mut ddl, postgres, "");
    define::<SchemaRecord>(&mut ddl, postgres, "");
    define::<ProjectedFolder>(&mut ddl, postgres, ", UNIQUE (space_id, dense_folder_id)");
    define::<ProjectedFolderAlias>(&mut ddl, postgres, "");
    define::<ProjectedNote>(&mut ddl, postgres, ", UNIQUE (space_id, note_id)");
    define::<ProjectedViewDescriptor>(&mut ddl, postgres, "");
    define::<ProjectedViewRank>(&mut ddl, postgres, "");
    define::<CandidateLookupKey>(&mut ddl, postgres, "");
    define::<ProjectedLink>(&mut ddl, postgres, "");
    define::<ProjectedNoteAlias>(&mut ddl, postgres, "");
    define::<ProjectedChatThread>(&mut ddl, postgres, "");
    define::<ProjectedChatRef>(
        &mut ddl,
        postgres,
        ", UNIQUE (target_space_id, target_note_id, thread_space_id, thread_id, entry_seq)",
    );
    define::<ProjectedCluster>(&mut ddl, postgres, "");
    define::<TrustedCheckpoint>(&mut ddl, postgres, "");
    ddl.push_str(INDEXES);
    let guard = if postgres {
        GUARDS.replace(" BLOB", " BYTEA")
    } else {
        GUARDS.to_owned()
    };
    ddl.push_str(&guard);
    if postgres {
        ddl.push_str(
            &super::link_stage::DDL
                .replace(" BLOB", " BYTEA")
                .replace(" TEXT", " TEXT COLLATE \"C\""),
        );
    } else {
        ddl.push_str(super::link_stage::DDL);
    }
    tx.batch(&ddl).await?;
    Ok(true)
}

#[derive(PartialEq, Eq)]
pub(super) enum MetadataState {
    Empty,
    Current,
    Obsolete,
}

pub(super) async fn metadata_state(
    tx: &mut SqlTransaction<'_>,
    relation: &str,
    generation: ProjectionGeneration,
) -> Result<MetadataState, PortError> {
    let query = format!(
        "SELECT generation, schema_version, unicode_casefold_ver, unicode_norm_ver, mmap_format_ver
         FROM {relation} LIMIT 2"
    );
    let rows = tx
        .select(
            &query,
            Vec::new(),
            &[
                Kind::Integer,
                Kind::Integer,
                Kind::Text,
                Kind::Text,
                Kind::Integer,
            ],
        )
        .await?;
    let row = match rows.as_slice() {
        [] => return Ok(MetadataState::Empty),
        [row] => row,
        _ => return Err(generation_mismatch()),
    };
    if *row == expected_metadata(generation) {
        return Ok(MetadataState::Current);
    }
    // Interpret only the stable metadata envelope. Unknown newer formats,
    // other generation identities and malformed witnesses fail closed.
    let [stored_gen, schema, stored_fold, stored_norm, mmap] = row.as_slice() else {
        return Err(generation_mismatch());
    };
    let schema = i64::read(schema.clone())?;
    let mmap = i64::read(mmap.clone())?;
    let normalization = unicode_version(&normalization_version())?;
    if ProjectionGeneration::read(stored_gen.clone())? != generation
        || !(0..=SCHEMA_VERSION).contains(&schema)
        || !(0..=MMAP_VERSION).contains(&mmap)
        || unicode_version(String::read(stored_fold.clone())?.as_str())? > CASEFOLD_UNICODE_VERSION
        || unicode_version(String::read(stored_norm.clone())?.as_str())? > normalization
    {
        return Err(generation_mismatch());
    }
    Ok(MetadataState::Obsolete)
}

fn expected_metadata(generation: ProjectionGeneration) -> Vec<SqlValue> {
    let (major, minor, patch) = CASEFOLD_UNICODE_VERSION;
    vec![
        value(&generation),
        value(&SCHEMA_VERSION),
        value(&format!("{major}.{minor}.{patch}")),
        value(&normalization_version()),
        value(&MMAP_VERSION),
    ]
}

fn normalization_version() -> String {
    let (major, minor, patch) = NORMALIZATION_UNICODE_VERSION;
    format!("{major}.{minor}.{patch}")
}

fn unicode_version(value: &str) -> Result<(u64, u64, u64), PortError> {
    let mut parts = value.split('.');
    let mut next = || {
        parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(generation_mismatch)
    };
    let version = (next()?, next()?, next()?);
    if parts.next().is_some() {
        return Err(generation_mismatch());
    }
    Ok(version)
}

pub(super) fn generation_mismatch() -> PortError {
    DomainError::validation(ValidationReason::GenerationMismatch).into()
}

fn define<R: SqlRecord>(ddl: &mut String, postgres: bool, extra: &str) {
    use std::fmt::Write;

    let columns = R::COLUMNS
        .iter()
        .map(|column| {
            let not_null = if column.nullable { "" } else { " NOT NULL" };
            format!("{} {}{not_null}", column.name, column.kind.ddl(postgres))
        })
        .collect::<Vec<_>>()
        .join(", ");
    let key = R::KEY.join(", ");
    let begin = if R::TEMPORAL {
        ", begin_seq BIGINT NOT NULL"
    } else {
        ""
    };
    let without_rowid = if postgres || R::TABLE != ProjectedNote::TABLE {
        ""
    } else {
        " WITHOUT ROWID"
    };
    writeln!(
        ddl, "CREATE TABLE IF NOT EXISTS {} ({columns}{begin}, PRIMARY KEY ({key}){extra}){without_rowid};", R::TABLE
    ).expect("writing a String");

    if R::TEMPORAL {
        let table = R::history_table();
        writeln!(
            ddl,
            "CREATE TABLE IF NOT EXISTS {table} (
                {columns}, begin_seq BIGINT NOT NULL, end_seq BIGINT NOT NULL, retained_bytes BIGINT NOT NULL,
                PRIMARY KEY ({key}, begin_seq), CHECK (begin_seq < end_seq)
             );
             CREATE INDEX IF NOT EXISTS {table}_end ON {table} (space_id, end_seq);"
        ).expect("writing a String");
    }
}

const INDEXES: &str = "
    CREATE INDEX IF NOT EXISTS projected_folder_paths ON projected_folders (space_id, norm_path_prefix);
    CREATE INDEX IF NOT EXISTS projected_folder_history_dense ON projected_folders_history (space_id, dense_folder_id, begin_seq, end_seq);
    CREATE INDEX IF NOT EXISTS projected_folder_alias_target ON projected_folder_aliases (space_id, target_folder_id);
    CREATE INDEX IF NOT EXISTS projected_note_parents ON projected_notes (space_id, parent_folder_id, slug_fold, lifecycle);
    CREATE INDEX IF NOT EXISTS projected_note_history_id ON projected_notes_history (space_id, note_id, begin_seq, end_seq);
    CREATE INDEX IF NOT EXISTS projected_view_group_order ON projected_view_ranks
        (space_id, view_note_id, view_key, group_key_hex, sort_rank_lexo, target_note_id);
    CREATE INDEX IF NOT EXISTS candidate_scope_leaf_tier ON candidate_lookup_keys
        (space_id, scope_folder_dense_id, leaf_norm_key, tier, created_at_sec, created_at_nsec, target_note_id);
    CREATE INDEX IF NOT EXISTS candidate_target_dense ON candidate_lookup_keys (space_id, target_dense_id);
    CREATE INDEX IF NOT EXISTS projected_link_qualified ON projected_note_links (space_id, dir_norm_prefix, src_dense_id, link_ord);
    CREATE INDEX IF NOT EXISTS projected_link_leaf ON projected_note_links (space_id, leaf_norm_key, src_dense_id, link_ord);
    CREATE INDEX IF NOT EXISTS projected_link_resolved ON projected_note_links (space_id, resolved_dense_id, src_dense_id, link_ord);
    CREATE INDEX IF NOT EXISTS projected_link_relative ON projected_note_links (space_id, uses_relative_prefix, src_folder_id, src_dense_id, link_ord);
    CREATE INDEX IF NOT EXISTS projected_note_alias_slug ON projected_note_aliases (space_id, old_slug_fold, old_parent_folder_id, created_seq, target_note_id);
    CREATE INDEX IF NOT EXISTS projected_note_alias_title ON projected_note_aliases (space_id, old_title_norm, old_parent_folder_id, old_slug_fold, created_seq, target_note_id);
    CREATE INDEX IF NOT EXISTS projected_note_alias_target ON projected_note_aliases (space_id, target_note_id, old_parent_folder_id, old_slug_fold, created_seq);
    CREATE INDEX IF NOT EXISTS chat_ref_source_entry ON chat_note_refs (thread_space_id, thread_id, entry_seq);
";

const GUARDS: &str = "
    CREATE TABLE IF NOT EXISTS projection_space_guard (
        space_id TEXT PRIMARY KEY,
        history_incarnation BLOB NOT NULL,
        minimum_checkpoint_seq BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projected_purge_markers (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        note_id TEXT NOT NULL,
        PRIMARY KEY (space_id, history_incarnation, note_id)
    );
    CREATE TABLE IF NOT EXISTS projected_redaction_markers (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        thread_id TEXT NOT NULL,
        entry_seq BIGINT NOT NULL,
        PRIMARY KEY (space_id, history_incarnation, thread_id, entry_seq)
    );
    CREATE TABLE IF NOT EXISTS projection_apply_pages (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        first_seq BIGINT NOT NULL,
        last_seq BIGINT NOT NULL,
        page_no BIGINT NOT NULL,
        destructive BIGINT NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (space_id, history_incarnation, first_seq, last_seq, page_no)
    );
    CREATE TABLE IF NOT EXISTS projection_apply_page_fragments (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        first_seq BIGINT NOT NULL,
        last_seq BIGINT NOT NULL,
        page_no BIGINT NOT NULL,
        fragment_no BIGINT NOT NULL CHECK (fragment_no >= 0),
        payload BLOB NOT NULL CHECK (length(payload) BETWEEN 1 AND 16777216),
        PRIMARY KEY (space_id, history_incarnation, first_seq, last_seq, page_no, fragment_no),
        FOREIGN KEY (space_id, history_incarnation, first_seq, last_seq, page_no)
            REFERENCES projection_apply_pages (space_id, history_incarnation, first_seq, last_seq, page_no)
            ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS projection_apply_chat_refs (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        first_seq BIGINT NOT NULL,
        last_seq BIGINT NOT NULL,
        page_no BIGINT NOT NULL,
        target_space_id TEXT NOT NULL,
        target_incarnation BLOB NOT NULL,
        target_note_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        entry_seq BIGINT NOT NULL,
        PRIMARY KEY (space_id, history_incarnation, first_seq, last_seq, page_no,
                     target_space_id, target_incarnation, target_note_id, thread_id, entry_seq),
        FOREIGN KEY (space_id, history_incarnation, first_seq, last_seq, page_no)
            REFERENCES projection_apply_pages (space_id, history_incarnation, first_seq, last_seq, page_no)
            ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS projection_apply_target_guard ON projection_apply_chat_refs
        (target_space_id, target_incarnation, target_note_id);
    CREATE INDEX IF NOT EXISTS projection_apply_source_guard ON projection_apply_chat_refs
        (space_id, history_incarnation, thread_id, entry_seq);
    CREATE TABLE IF NOT EXISTS projection_index_replay (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        after_seq BIGINT NOT NULL CHECK (after_seq >= 0),
        through_seq BIGINT NOT NULL CHECK (through_seq > after_seq),
        accumulated_bytes BIGINT NOT NULL CHECK (accumulated_bytes BETWEEN 64 AND 1048576),
        slots BLOB NOT NULL CHECK (length(slots) BETWEEN 20 AND 16404),
        digest BLOB NOT NULL CHECK (length(digest) = 32),
        PRIMARY KEY (space_id, history_incarnation, through_seq)
    );
    CREATE TABLE IF NOT EXISTS projection_cut_leases (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        lease_id BLOB NOT NULL,
        cut BIGINT NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        PRIMARY KEY (space_id, history_incarnation, lease_id)
    );
    CREATE INDEX IF NOT EXISTS projection_cut_lease_cut ON projection_cut_leases (space_id, history_incarnation, cut);
    CREATE TABLE IF NOT EXISTS projection_page_pins (
        space_id TEXT NOT NULL,
        history_incarnation BLOB NOT NULL,
        lease_id BLOB NOT NULL,
        cut BIGINT NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        PRIMARY KEY (space_id, history_incarnation, lease_id)
    );
    CREATE INDEX IF NOT EXISTS projection_page_pin_cut ON projection_page_pins (space_id, history_incarnation, cut);
";

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SpaceGuard {
    pub(super) incarnation: HistoryIncarnation,
    pub(super) minimum_checkpoint_seq: SpaceSeq,
}

pub(super) async fn read_space_guard(
    tx: &mut SqlTransaction<'_>,
    space: &SpaceId,
    lock: bool,
) -> Result<Option<SpaceGuard>, PortError> {
    let sql = if tx.postgres() && lock {
        "SELECT history_incarnation, minimum_checkpoint_seq
         FROM projection_space_guard WHERE space_id = ? FOR UPDATE"
    } else {
        "SELECT history_incarnation, minimum_checkpoint_seq
         FROM projection_space_guard WHERE space_id = ?"
    };
    tx.select(sql, vec![value(space)], &[Kind::Bytes, Kind::Integer])
        .await?
        .pop()
        .map(|row| {
            let [incarnation, floor] = row.try_into().map_err(|_| super::invalid_row())?;
            Ok(SpaceGuard {
                incarnation: HistoryIncarnation::read(incarnation)?,
                minimum_checkpoint_seq: SpaceSeq::read(floor)?,
            })
        })
        .transpose()
}

pub(super) async fn lock_space_guard_with_origin(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
) -> Result<(SpaceGuard, bool), PortError> {
    let inserted = tx
        .execute(
            "INSERT INTO projection_space_guard (space_id, history_incarnation) VALUES (?, ?)
         ON CONFLICT (space_id) DO NOTHING",
            vec![value(&scope.space_id), value(&scope.incarnation)],
        )
        .await?
        != 0;
    let guard = read_space_guard(tx, &scope.space_id, true)
        .await?
        .ok_or_else(super::invalid_row)?;
    Ok((guard, inserted))
}
