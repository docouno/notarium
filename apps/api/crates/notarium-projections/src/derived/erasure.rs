use std::{collections::BTreeSet, sync::Arc, time::Duration};

use notarium_canonical::{CanonicalStore, ProjectionErasures};
use notarium_core::{
    epoch::DataRoot,
    error::{PortError, RetryAdvice},
    ids::ProjectionGeneration,
};
use sqlx::PgPool;

use super::{
    DerivedStore, GenerationControl, GenerationFiles, internal, invalid_row,
    maintenance::reclaim_postgres_schema,
    not_ready, parse_generation,
    schema::{MetadataState, SCHEMA_VERSION, metadata_state},
    sql::{Database, Kind, SqlColumn, SqlTransaction, sqlite_main_present},
    write::{EraseStep, erase_committed_step},
};

/// Lives with the canonical writer. It owns connection routing and can run
/// after a local projector stops, without holding a generation or its files.
#[derive(Clone)]
pub(crate) struct PostgresEraser {
    pool: PgPool,
    prefix: String,
    control: GenerationControl,
}

#[derive(Default)]
pub(crate) struct CheckpointErasures {
    pub(crate) reconciled: Vec<ProjectionGeneration>,
    pub(crate) retired: Vec<ProjectionGeneration>,
    pub(crate) unreconciled: Vec<ProjectionGeneration>,
}

impl DerivedStore {
    /// Erasure must never initialize a missing database or create metadata to
    /// claim ownership of a directory left by another generation.
    pub(crate) async fn erase_existing_sqlite(
        root: &DataRoot,
        generation: ProjectionGeneration,
        resident: Option<&Self>,
        maintenance: Arc<tokio::sync::OwnedMutexGuard<()>>,
        canonical: &CanonicalStore,
        erasures: &ProjectionErasures,
    ) -> Result<ErasureOutcome, PortError> {
        let path = root.derived(generation);
        let probe = path.clone();
        if !tokio::task::spawn_blocking(move || sqlite_main_present(&probe))
            .await
            .map_err(|_| internal("projection_generation_inventory"))??
        {
            return Ok(ErasureOutcome::Empty);
        }
        let lease = GenerationFiles::hold(root, generation).await?;
        let db = match resident {
            Some(store) if store.database.owns_sqlite_file(&path) => Arc::clone(&store.database),
            _ => Arc::new(Database::open_existing_sqlite(path).await?),
        };
        let mut verified_guard = None;
        for _ in 0..4 {
            let erasures_tx = erasures.clone();
            let lease_tx = Arc::clone(&lease);
            let maintenance_tx = Arc::clone(&maintenance);
            let step = db
                .write_adaptive((lease_tx, maintenance_tx), move |mut tx| {
                    Box::pin(async move {
                        let outcome = erase_generation_step(
                            &mut tx,
                            generation,
                            &erasures_tx,
                            verified_guard,
                        )
                        .await?;
                        let scrub = matches!(
                            outcome,
                            GenerationEraseStep::Outcome(ErasureOutcome::Reconciled)
                        );
                        Ok((outcome, scrub))
                    })
                })
                .await?;
            match step {
                GenerationEraseStep::Outcome(outcome) => return Ok(outcome),
                GenerationEraseStep::NeedCanonicalCheck(observed) => {
                    if canonical.read_space(&erasures.scope.space_id).await?.scope != erasures.scope
                    {
                        return Err(not_ready());
                    }
                    verified_guard = Some(observed);
                }
            }
        }
        Err(not_ready())
    }

    pub(crate) fn postgres_eraser(
        &self,
        control: &GenerationControl,
    ) -> Result<Option<PostgresEraser>, PortError> {
        let Some((pool, schema)) = self.database.postgres_config() else {
            return Ok(None);
        };
        let (prefix, _) = schema.rsplit_once("_g").ok_or_else(invalid_row)?;
        Ok(Some(PostgresEraser {
            pool,
            prefix: prefix.to_owned(),
            control: control.clone(),
        }))
    }
}

impl PostgresEraser {
    pub(crate) async fn erase(
        &self,
        root: &DataRoot,
        canonical: &CanonicalStore,
        erasures: &ProjectionErasures,
    ) -> Result<CheckpointErasures, PortError> {
        let mut affected = CheckpointErasures::default();
        for generation in postgres_generation_inventory(&self.pool, &self.prefix).await? {
            let schema = format!("{}_g{}", self.prefix, generation.get());
            let mut verified_guard = None;
            let mut outcome = None;
            let mut resolved = false;
            let mut guard_checks = 0usize;
            let mut lock_retries = 0usize;
            while guard_checks < 4 {
                let erasures_tx = erasures.clone();
                let step =
                    match Database::write_existing_postgres(&self.pool, &schema, move |mut tx| {
                        Box::pin(async move {
                            erase_generation_step(&mut tx, generation, &erasures_tx, verified_guard)
                                .await
                        })
                    })
                    .await
                    {
                        Ok(step) => step,
                        Err(PortError::Unavailable(ref failure))
                            if lock_retries < 8
                                && matches!(failure.retry(), RetryAdvice::After(_)) =>
                        {
                            let delay = match failure.retry() {
                                RetryAdvice::After(delay) => delay.min(Duration::from_millis(50)),
                                _ => Duration::from_millis(20),
                            };
                            lock_retries += 1;
                            tokio::time::sleep(delay).await;
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                match step {
                    None => {
                        outcome = None;
                        resolved = true;
                        break;
                    }
                    Some(GenerationEraseStep::Outcome(done)) => {
                        outcome = Some(done);
                        resolved = true;
                        break;
                    }
                    Some(GenerationEraseStep::NeedCanonicalCheck(observed)) => {
                        if canonical.read_space(&erasures.scope.space_id).await?.scope
                            != erasures.scope
                        {
                            return Err(not_ready());
                        }
                        verified_guard = Some(observed);
                        guard_checks += 1;
                    }
                }
            }
            if !resolved {
                return Err(not_ready());
            }
            match outcome {
                Some(ErasureOutcome::Reconciled) => {
                    affected.reconciled.push(generation);
                }
                Some(ErasureOutcome::Obsolete) => {
                    self.remove_closed_generation(root, generation).await?;
                }
                Some(ErasureOutcome::Empty) | None => {}
            }
        }
        if !erasures.purged.is_empty() {
            let reconciled: BTreeSet<_> = affected.reconciled.iter().copied().collect();
            // A peer can reclaim shared SQL while this owner still has
            // file-only lookup leases. The local inventory is independent.
            for generation in GenerationFiles::inventory(root).await? {
                if reconciled.contains(&generation) {
                    continue;
                }
                if self.control.generation_reclaimable(generation).await? {
                    affected.retired.push(generation);
                } else {
                    affected.unreconciled.push(generation);
                }
            }
        }
        Ok(affected)
    }

    async fn remove_closed_generation(
        &self,
        root: &DataRoot,
        generation: ProjectionGeneration,
    ) -> Result<(), PortError> {
        if !self.control.generation_reclaimable(generation).await? {
            return Err(not_ready());
        }
        let lease = GenerationFiles::for_reclamation(root, generation)
            .await?
            .ok_or_else(not_ready)?;
        if !reclaim_postgres_schema(&self.pool, &self.prefix, generation).await? {
            return Err(not_ready());
        }
        GenerationFiles::remove(root, generation, true, lease).await
    }
}

pub(crate) enum ErasureOutcome {
    Empty,
    Reconciled,
    Obsolete,
}

enum GenerationEraseStep {
    Outcome(ErasureOutcome),
    NeedCanonicalCheck(Option<notarium_core::ids::HistoryIncarnation>),
}

async fn erase_generation_step(
    tx: &mut SqlTransaction<'_>,
    generation: ProjectionGeneration,
    erasures: &ProjectionErasures,
    verified_guard: Option<Option<notarium_core::ids::HistoryIncarnation>>,
) -> Result<GenerationEraseStep, PortError> {
    match erasure_layout(tx, generation).await? {
        Some(SCHEMA_VERSION) => match erase_committed_step(tx, erasures, verified_guard).await? {
            EraseStep::Reconciled => Ok(GenerationEraseStep::Outcome(ErasureOutcome::Reconciled)),
            EraseStep::NeedCanonicalCheck(observed) => {
                Ok(GenerationEraseStep::NeedCanonicalCheck(observed))
            }
        },
        Some(_) => Ok(GenerationEraseStep::Outcome(ErasureOutcome::Obsolete)),
        None => Ok(GenerationEraseStep::Outcome(ErasureOutcome::Empty)),
    }
}

async fn erasure_layout(
    tx: &mut SqlTransaction<'_>,
    generation: ProjectionGeneration,
) -> Result<Option<i64>, PortError> {
    // Creation can provision the namespace before the schema transaction.
    // Serialize with initialization to distinguish that empty namespace from
    // a damaged or incompatible durable cache.
    let relations = if tx.postgres() {
        tx.batch("SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 272014))")
            .await?;
        "SELECT c.relname::TEXT FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'm', 'f')
         ORDER BY (c.relname = 'derived_schema_meta') DESC LIMIT 1"
    } else {
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY (name = 'derived_schema_meta') DESC LIMIT 1"
    };
    let relations = tx.select(relations, Vec::new(), &[Kind::Text]).await?;
    let Some(name) = relations.into_iter().next().and_then(|mut row| row.pop()) else {
        return Ok(None);
    };
    if String::read(name)? != "derived_schema_meta" {
        return Err(invalid_row());
    }
    match metadata_state(tx, "derived_schema_meta", generation).await? {
        MetadataState::Current => return Ok(Some(SCHEMA_VERSION)),
        MetadataState::Empty => return Err(invalid_row()),
        MetadataState::Obsolete => {}
    }
    let rows = tx
        .select(
            "SELECT generation, schema_version FROM derived_schema_meta LIMIT 2",
            Vec::new(),
            &[Kind::Integer, Kind::Integer],
        )
        .await?;
    let [row] = rows.as_slice() else {
        return Err(invalid_row());
    };
    let [stored, version] = row.as_slice() else {
        return Err(invalid_row());
    };
    if ProjectionGeneration::read(stored.clone())? != generation {
        return Err(invalid_row());
    }
    // This callback only interprets SQL. Mmap or Unicode metadata can be
    // obsolete while the row and guard layout remains erasable.
    let version = i64::read(version.clone())?;
    if !(0..=SCHEMA_VERSION).contains(&version) {
        return Err(invalid_row());
    }
    Ok(Some(version))
}

pub(super) async fn postgres_generation_inventory(
    pool: &PgPool,
    prefix: &str,
) -> Result<Vec<ProjectionGeneration>, PortError> {
    let prefix = format!("{prefix}_g");
    let schemas: Vec<String> = sqlx::query_scalar(
        "SELECT nspname::TEXT FROM pg_catalog.pg_namespace
         WHERE left(nspname::TEXT, length($1)) = $1 ORDER BY nspname",
    )
    .bind(&prefix)
    .fetch_all(pool)
    .await
    .map_err(|_| internal("projection_generation_inventory"))?;
    let mut generations = schemas
        .iter()
        .filter_map(|schema| parse_generation(&prefix, schema))
        .collect::<Vec<_>>();
    generations.sort_unstable();
    Ok(generations)
}
