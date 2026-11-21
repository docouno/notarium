use std::{
    collections::BTreeMap,
    fs::{self, File, TryLockError},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use notarium_core::{epoch::DataRoot, error::PortError, ids::ProjectionGeneration};
use sqlx::{AssertSqlSafe, PgPool};

use super::{
    DerivedStore, internal, invalid_row, not_ready, parse_generation,
    schema::{MetadataState, generation_mismatch, metadata_state},
    sql::{Kind, SqlColumn, SqlTransaction, sqlite_main_present, validate_identifier, value},
};

/// In-process pin preventing `reclaim_postgres_schema` from dropping a
/// PostgreSQL generation schema while a live `DerivedStore` handle holds it.
#[derive(Debug)]
pub(super) struct PostgresSchemaLease;

static OPEN_POSTGRES_SCHEMAS: Mutex<BTreeMap<String, Weak<PostgresSchemaLease>>> =
    Mutex::new(BTreeMap::new());

impl PostgresSchemaLease {
    pub(super) fn acquire(schema: &str) -> Arc<Self> {
        let mut schemas = OPEN_POSTGRES_SCHEMAS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = schemas.get(schema).and_then(Weak::upgrade) {
            return existing;
        }
        schemas.retain(|_, value| value.strong_count() != 0);
        let lease = Arc::new(Self);
        schemas.insert(schema.to_owned(), Arc::downgrade(&lease));
        lease
    }

    pub(super) fn is_held(schema: &str) -> bool {
        let mut schemas = OPEN_POSTGRES_SCHEMAS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        schemas.retain(|_, value| value.strong_count() != 0);
        schemas
            .get(schema)
            .is_some_and(|weak| weak.strong_count() > 0)
    }
}

pub(crate) struct GenerationFiles;

/// The root lease covers file mutations that can outlive a runtime or SQL
/// generation, including the final unlink from a retained checkpoint.
#[derive(Debug)]
pub(crate) struct PostgresCacheOwner {
    pub(crate) cache_identity: OnceLock<String>,
    active_runtime: AtomicBool,
    root: DataRoot,
    _lease: File,
}

/// Exclusive in-process guard ensuring only one `ProjectionEngine` operates on a
/// given `PostgresCacheOwner` root at a time while retained cleanup callbacks
/// may still hold `Arc<PostgresCacheOwner>`.
#[derive(Debug)]
pub(crate) struct PostgresRuntimeGuard {
    owner: Arc<PostgresCacheOwner>,
}

impl Drop for PostgresRuntimeGuard {
    fn drop(&mut self) {
        self.owner.active_runtime.store(false, Ordering::Release);
    }
}

#[cfg(unix)]
type CacheRootKey = (u64, u64);
#[cfg(not(unix))]
type CacheRootKey = PathBuf;

impl PostgresCacheOwner {
    pub(crate) async fn acquire(root: DataRoot) -> Result<Arc<Self>, PortError> {
        tokio::task::spawn_blocking(move || {
            static OWNERS: Mutex<BTreeMap<CacheRootKey, Weak<PostgresCacheOwner>>> =
                Mutex::new(BTreeMap::new());
            let error = |_| internal("projection_cache_directory");
            fs::create_dir_all(root.root()).map_err(error)?;
            let path = fs::canonicalize(root.root()).map_err(error)?;
            #[cfg(unix)]
            let key = {
                use std::os::unix::fs::MetadataExt;
                let metadata = fs::metadata(&path).map_err(error)?;
                (metadata.dev(), metadata.ino())
            };
            #[cfg(not(unix))]
            let key = path.clone();
            let mut owners = OWNERS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            owners.retain(|_, owner| owner.strong_count() != 0);
            // A detached callback still owns the original volume at this path.
            if owners.iter().any(|(pinned, owner)| {
                pinned != &key
                    && owner
                        .upgrade()
                        .is_some_and(|owner| owner.root.root() == path)
            }) {
                return Err(not_ready());
            }
            if let Some(owner) = owners.get(&key).and_then(Weak::upgrade) {
                return Ok(owner);
            }
            let lease = try_exclusive(&path.join("v1/projection_checkpoint.lock"))?
                .ok_or_else(not_ready)?;
            let owner = Arc::new(Self {
                cache_identity: OnceLock::new(),
                active_runtime: AtomicBool::new(false),
                root: DataRoot::new(path),
                _lease: lease,
            });
            owners.insert(key, Arc::downgrade(&owner));
            Ok(owner)
        })
        .await
        .map_err(|_| internal("projection_generation_worker"))?
    }

    pub(crate) fn claim_runtime(self: &Arc<Self>) -> Result<PostgresRuntimeGuard, PortError> {
        self.active_runtime
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| not_ready())?;
        Ok(PostgresRuntimeGuard {
            owner: Arc::clone(self),
        })
    }

    pub(crate) fn root(&self) -> &DataRoot {
        &self.root
    }
}

impl GenerationFiles {
    fn lock_path(root: &DataRoot, generation: ProjectionGeneration) -> PathBuf {
        root.root()
            .join("v1")
            .join(format!("projection_gen_{}.lock", generation.get()))
    }

    pub(crate) async fn hold(
        root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Arc<File>, PortError> {
        let path = Self::lock_path(root, generation);
        tokio::task::spawn_blocking(move || {
            let lease = open_lock(&path)?;
            match lease.try_lock_shared() {
                Ok(()) => Ok(Arc::new(lease)),
                Err(TryLockError::WouldBlock) => Err(not_ready()),
                Err(TryLockError::Error(_)) => Err(internal("projection_generation_file_lock")),
            }
        })
        .await
        .map_err(|_| internal("projection_generation_worker"))?
    }

    pub(crate) async fn owner(root: &DataRoot) -> Result<Arc<File>, PortError> {
        exclusive(root.root().join("v1/projection_runtime.lock"))
            .await?
            .map(Arc::new)
            .ok_or_else(not_ready)
    }

    pub(crate) async fn for_reclamation(
        root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<Option<File>, PortError> {
        exclusive(Self::lock_path(root, generation)).await
    }

    pub(crate) async fn remove_obsolete_sqlite(
        root: &DataRoot,
        generation: ProjectionGeneration,
        lease: File,
    ) -> Result<(), PortError> {
        let path = root.derived(generation);
        let runtime = tokio::runtime::Handle::current();
        let status = tokio::task::spawn_blocking(move || {
            if !sqlite_main_present(&path)? {
                return Err(generation_mismatch());
            }
            let mut conn = rusqlite::Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(|_| internal("projection_generation_file_witness"))?;
            runtime.block_on(metadata_state(
                &mut SqlTransaction::Sqlite(&mut conn),
                "derived_schema_meta",
                generation,
            ))
        })
        .await
        .map_err(|_| internal("projection_generation_worker"))??;
        match status {
            MetadataState::Obsolete => Self::remove(root, generation, false, lease).await,
            MetadataState::Current => Ok(()),
            MetadataState::Empty => Err(generation_mismatch()),
        }
    }

    async fn with_reclamation_lease<T: Send + 'static>(
        lease: File,
        operation: impl FnOnce() -> Result<T, PortError> + Send + 'static,
    ) -> Result<T, PortError> {
        tokio::task::spawn_blocking(move || {
            // Cancelling the join future cannot release the file lease before unlink finishes.
            let _lease = lease;
            operation()
        })
        .await
        .map_err(|_| internal("projection_generation_worker"))?
    }

    pub(crate) async fn remove(
        root: &DataRoot,
        generation: ProjectionGeneration,
        postgres: bool,
        lease: File,
    ) -> Result<(), PortError> {
        let path = root
            .derived(generation)
            .parent()
            .ok_or_else(invalid_row)?
            .to_owned();
        Self::with_reclamation_lease(lease, move || {
            let error = || internal("projection_generation_remove_files");
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(_) => return Err(error()),
            };
            if !meta.is_dir() || !inside_cache(&path)? {
                return Err(error());
            }
            if postgres {
                #[cfg(windows)]
                clear_readonly(&path).map_err(|_| error())?;
                fs::remove_dir_all(&path).map_err(|_| error())?;
            } else {
                let first = fs::read_dir(&path)
                    .map_err(|_| error())?
                    .next()
                    .transpose()
                    .map_err(|_| error())?;
                if first.is_some() {
                    let db_path = path.join("derived.sqlite");
                    check_sqlite_witness(&db_path, generation)?;
                    #[cfg(windows)]
                    clear_readonly(&path).map_err(|_| error())?;
                    // Remove every non-SQLite artifact first while keeping the
                    // witness database and its WAL/journal intact for crash retries.
                    for entry in fs::read_dir(&path).map_err(|_| error())? {
                        let entry = entry.map_err(|_| error())?;
                        let name = entry.file_name();
                        if name == "derived.sqlite"
                            || name == "derived.sqlite-wal"
                            || name == "derived.sqlite-shm"
                            || name == "derived.sqlite-journal"
                        {
                            continue;
                        }
                        if entry.file_type().map_err(|_| error())?.is_dir() {
                            fs::remove_dir_all(entry.path()).map_err(|_| error())?;
                        } else {
                            fs::remove_file(entry.path()).map_err(|_| error())?;
                        }
                    }
                    // Flush WAL frames into derived.sqlite before removing -wal so
                    // derived_schema_meta remains durable in the main file if a
                    // crash interrupts removal between unlinking -wal and derived.sqlite.
                    let wal_path = path.join("derived.sqlite-wal");
                    if fs::symlink_metadata(&wal_path).is_ok() {
                        let conn = rusqlite::Connection::open_with_flags(
                            &db_path,
                            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
                        )
                        .map_err(|_| error())?;
                        let (busy, log, checkpointed): (i64, i64, i64) = conn
                            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                            })
                            .map_err(|_| error())?;
                        if busy != 0 || (log != -1 && log != checkpointed) {
                            return Err(error());
                        }
                        drop(conn);
                    }
                    for sidecar in [
                        "derived.sqlite-shm",
                        "derived.sqlite-wal",
                        "derived.sqlite-journal",
                    ] {
                        match fs::remove_file(path.join(sidecar)) {
                            Ok(()) => {}
                            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                            Err(_) => return Err(error()),
                        }
                    }
                    fs::remove_file(&db_path).map_err(|_| error())?;
                }
                fs::remove_dir(&path).map_err(|_| error())?;
            }
            #[cfg(unix)]
            File::open(path.parent().ok_or_else(error)?)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| error())?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn inventory(root: &DataRoot) -> Result<Vec<ProjectionGeneration>, PortError> {
        let parent = root.root().join("v1");
        tokio::task::spawn_blocking(move || {
            let mut generations = Vec::new();
            for entry in
                fs::read_dir(parent).map_err(|_| internal("projection_generation_directory"))?
            {
                let entry = entry.map_err(|_| internal("projection_generation_directory"))?;
                if entry
                    .file_type()
                    .map_err(|_| internal("projection_generation_directory"))?
                    .is_dir()
                    && let Some(id) = entry
                        .file_name()
                        .to_str()
                        .and_then(|name| parse_generation("derived_gen_", name))
                {
                    generations.push(id);
                }
            }
            Ok(generations)
        })
        .await
        .map_err(|_| internal("projection_generation_worker"))?
    }
}

async fn exclusive(path: PathBuf) -> Result<Option<File>, PortError> {
    tokio::task::spawn_blocking(move || try_exclusive(&path))
        .await
        .map_err(|_| internal("projection_generation_worker"))?
}

fn try_exclusive(path: &Path) -> Result<Option<File>, PortError> {
    let lease = open_lock(path)?;
    match lease.try_lock() {
        Ok(()) => Ok(Some(lease)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(_)) => Err(internal("projection_generation_file_lock")),
    }
}

#[cfg(test)]
#[tokio::test]
async fn canceled_reclamation_keeps_its_file_lease_until_the_work_stops() {
    let mut suffix = [0; 16];
    getrandom::fill(&mut suffix).unwrap();
    let root = DataRoot::new(
        std::env::temp_dir().join(format!("notarium-reclamation-{}", hex::encode(suffix))),
    );
    let generation = ProjectionGeneration::new(1).unwrap();
    let cleanup_root = root.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    let cleanup = tokio::spawn(async move {
        let lease = GenerationFiles::for_reclamation(&cleanup_root, generation)
            .await?
            .ok_or_else(not_ready)?;
        GenerationFiles::with_reclamation_lease(lease, move || {
            entered.send(()).unwrap();
            held.recv().unwrap();
            Ok(())
        })
        .await
    });
    ready.await.unwrap();
    cleanup.abort();
    assert!(cleanup.await.unwrap_err().is_cancelled());
    assert!(GenerationFiles::hold(&root, generation).await.is_err());
    release.send(()).unwrap();

    let reopened = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Ok(lease) = GenerationFiles::hold(&root, generation).await {
                break lease;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(reopened);
    fs::remove_dir_all(root.root()).unwrap();
}

fn open_lock(path: &Path) -> Result<File, PortError> {
    let parent = path.parent().ok_or_else(invalid_row)?;
    let error = || internal("projection_generation_file_lock");
    fs::create_dir_all(parent).map_err(|_| error())?;
    if fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(error());
    }
    #[cfg(unix)]
    let file = {
        use rustix::fs::{Mode, OFlags, open};
        File::from(
            open(
                path,
                OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|_| error())?,
        )
    };
    #[cfg(not(unix))]
    let file = {
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            options.custom_flags(OPEN_REPARSE_POINT);
        }
        options.open(path).map_err(|_| error())?
    };
    let metadata = file.metadata().map_err(|_| error())?;
    if !metadata.is_file() {
        return Err(error());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != rustix::process::geteuid().as_raw() {
            return Err(error());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(error());
        }
    }
    Ok(file)
}

fn inside_cache(path: &Path) -> Result<bool, PortError> {
    let error = || internal("projection_generation_directory");
    let parent = path.parent().ok_or_else(error)?;
    let resolved = fs::canonicalize(path).map_err(|_| error())?;
    let parent = fs::canonicalize(parent).map_err(|_| error())?;
    Ok(resolved.parent() == Some(parent.as_path()))
}

fn check_sqlite_witness(path: &Path, generation: ProjectionGeneration) -> Result<(), PortError> {
    let error = |_| internal("projection_generation_file_witness");
    if !sqlite_main_present(path)? {
        return Err(invalid_row());
    }
    let db = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(error)?;
    let mut query = db
        .prepare("SELECT generation FROM derived_schema_meta LIMIT 2")
        .map_err(error)?;
    let mut results = query.query([]).map_err(error)?;
    let Some(row) = results.next().map_err(error)? else {
        return Err(invalid_row());
    };
    if row.get::<_, i64>(0).map_err(error)? != generation.get() as i64
        || results.next().map_err(error)?.is_some()
    {
        return Err(invalid_row());
    }
    Ok(())
}

#[cfg(windows)]
fn clear_readonly(path: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            clear_readonly(&entry.path())?;
        } else if kind.is_file() {
            let mut permissions = entry.metadata()?.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                fs::set_permissions(entry.path(), permissions)?;
            }
        }
    }
    Ok(())
}

impl DerivedStore {
    pub(crate) async fn reclaim_postgres_schema(
        &self,
        generation: ProjectionGeneration,
    ) -> Result<bool, PortError> {
        let Some((pool, active_schema)) = self.database.postgres_config() else {
            return Ok(true);
        };
        let (prefix, _) = active_schema.rsplit_once("_g").ok_or_else(invalid_row)?;
        reclaim_postgres_schema(&pool, prefix, generation).await
    }
}

pub(super) async fn reclaim_postgres_schema(
    pool: &PgPool,
    prefix: &str,
    generation: ProjectionGeneration,
) -> Result<bool, PortError> {
    let schema = format!("{prefix}_g{}", generation.get());
    let schema = validate_identifier(&schema)?;
    if PostgresSchemaLease::is_held(schema) {
        return Ok(false);
    }
    let error = |_| internal("projection_generation_remove_schema");
    let mut tx = pool.begin().await.map_err(error)?;
    if !super::control::lock_reclaimable_postgres(
        &mut SqlTransaction::Postgres(&mut tx),
        prefix,
        generation,
    )
    .await?
    {
        return Ok(false);
    }
    let taken: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 251850))")
            .bind(schema)
            .fetch_one(&mut *tx)
            .await
            .map_err(error)?;
    if !taken {
        return Ok(false);
    }
    if PostgresSchemaLease::is_held(schema) {
        return Ok(false);
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1)",
    )
    .bind(schema)
    .fetch_one(&mut *tx)
    .await
    .map_err(error)?;
    if !exists {
        return Ok(true);
    }
    let first_relation: Option<String> = sqlx::query_scalar(
        "SELECT c.relname::TEXT FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'm', 'f')
         ORDER BY (c.relname = 'derived_schema_meta') DESC LIMIT 1",
    )
    .bind(schema)
    .fetch_optional(&mut *tx)
    .await
    .map_err(error)?;
    if let Some(first_relation) = first_relation {
        if first_relation != "derived_schema_meta" {
            return Err(invalid_row());
        }
        let witness = format!("SELECT generation FROM \"{schema}\".derived_schema_meta LIMIT 2");
        let found: Vec<i64> = sqlx::query_scalar(AssertSqlSafe(witness.as_str()))
            .fetch_all(&mut *tx)
            .await
            .map_err(error)?;
        if found.as_slice() != [generation.get() as i64] {
            return Err(invalid_row());
        }
        sqlx::query("SET LOCAL lock_timeout = '225ms'")
            .execute(&mut *tx)
            .await
            .map_err(error)?;
        match drop_postgres_tables(&mut SqlTransaction::Postgres(&mut tx), schema).await {
            Ok(()) => {}
            Err(PortError::Unavailable(_)) => return Ok(false),
            Err(err) => return Err(err),
        }
    } else {
        sqlx::query("SET LOCAL lock_timeout = '225ms'")
            .execute(&mut *tx)
            .await
            .map_err(error)?;
    }
    let drop_schema = format!("DROP SCHEMA \"{schema}\" RESTRICT");
    if let Err(err) = sqlx::query(AssertSqlSafe(drop_schema.as_str()))
        .execute(&mut *tx)
        .await
    {
        if err
            .as_database_error()
            .and_then(sqlx::error::DatabaseError::code)
            .as_deref()
            == Some("55P03")
        {
            return Ok(false);
        }
        return Err(error(err));
    }
    tx.commit().await.map_err(error)?;
    Ok(true)
}

/// Called while the control transaction excludes candidate admission.
pub(super) async fn reset_obsolete_postgres(
    tx: &mut SqlTransaction<'_>,
    schema: &str,
    generation: ProjectionGeneration,
) -> Result<(), PortError> {
    let schema = validate_identifier(schema)?;
    tx.batch("SET LOCAL lock_timeout = '225ms'").await?;
    // Share the generation lifetime lock and the format initializer lock.
    let schema_name = schema.to_owned();
    for key in [251850_i64, 272014] {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(?, ?))",
            vec![value(&schema_name), value(&key)],
        )
        .await?;
    }
    let relation = format!("\"{schema}\".derived_schema_meta");
    let exists = tx
        .select(
            "SELECT CAST(1 AS BIGINT) WHERE to_regclass(?) IS NOT NULL",
            vec![value(&relation)],
            &[Kind::Integer],
        )
        .await?;
    if exists.is_empty() {
        // Another founder may have already cleared the obsolete tables.
        return Ok(());
    }
    if metadata_state(tx, &relation, generation).await? == MetadataState::Obsolete {
        // Keep the namespace stable for ordinary openers and let the
        // schema initializer populate it under its own transaction.
        drop_postgres_tables(tx, schema).await?;
    }
    Ok(())
}

async fn drop_postgres_tables(tx: &mut SqlTransaction<'_>, schema: &str) -> Result<(), PortError> {
    let relations = tx
        .select(
            "SELECT c.relname::TEXT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
             ON c.relnamespace = n.oid WHERE n.nspname = ? AND c.relkind = 'r' ORDER BY c.relname",
            vec![value(&schema.to_owned())],
            &[Kind::Text],
        )
        .await?;
    if relations.is_empty() {
        return Ok(());
    }
    // Delete all ordinary relations together to permit dependencies within
    // the generation. RESTRICT keeps any unexpected outside dependencies.
    let mut qualified = Vec::with_capacity(relations.len());
    for mut row in relations {
        let relation = String::read(row.pop().ok_or_else(invalid_row)?)?;
        qualified.push(format!(
            "\"{schema}\".\"{}\"",
            validate_identifier(&relation)?
        ));
    }
    let drop_tables = format!("DROP TABLE {} RESTRICT", qualified.join(", "));
    tx.batch(&drop_tables).await
}
