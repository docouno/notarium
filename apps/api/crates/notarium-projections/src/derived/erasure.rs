use std::collections::BTreeSet;

use notarium_canonical::ProjectionErasures;
use notarium_core::{
    epoch::DataRoot,
    error::PortError,
    ids::{ProjectionGeneration, SpaceSeq},
    model::HistoryScope,
};
use sqlx::PgPool;

use super::{
    DerivedStore, GenerationControl, GenerationFiles, internal, invalid_row,
    maintenance::reclaim_postgres_schema,
    not_ready, parse_generation,
    schema::SCHEMA_VERSION,
    sql::{Database, Kind, SqlColumn, SqlTransaction},
    write::erase_committed,
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
    pub(crate) reconciled: Vec<(ProjectionGeneration, HistoryScope, SpaceSeq)>,
    pub(crate) retired: Vec<ProjectionGeneration>,
    pub(crate) unreconciled: Vec<ProjectionGeneration>,
}

impl DerivedStore {
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
        erasures: &ProjectionErasures,
    ) -> Result<CheckpointErasures, PortError> {
        let mut affected = CheckpointErasures::default();
        for generation in postgres_generation_inventory(&self.pool, &self.prefix).await? {
            let schema = format!("{}_g{}", self.prefix, generation.get());
            let erasures = erasures.clone();
            let outcome = Database::write_existing_postgres(&self.pool, &schema, move |mut tx| {
                Box::pin(async move {
                    match erasure_layout(&mut tx, generation).await? {
                        Some(SCHEMA_VERSION) => {
                            let (scope, through) = erase_committed(&mut tx, &erasures).await?;
                            Ok(ErasureOutcome::Reconciled(scope, through))
                        }
                        Some(_) => Ok(ErasureOutcome::Obsolete),
                        None => Ok(ErasureOutcome::Empty),
                    }
                })
            })
            .await?;
            match outcome {
                Some(ErasureOutcome::Reconciled(scope, through)) => {
                    affected.reconciled.push((generation, scope, through));
                }
                Some(ErasureOutcome::Obsolete) => {
                    self.remove_closed_generation(root, generation).await?;
                }
                Some(ErasureOutcome::Empty) | None => {}
            }
        }
        if !erasures.purged.is_empty() {
            let reconciled: BTreeSet<_> =
                affected.reconciled.iter().map(|(id, _, _)| *id).collect();
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

enum ErasureOutcome {
    Empty,
    Reconciled(HistoryScope, SpaceSeq),
    Obsolete,
}

async fn erasure_layout(
    tx: &mut SqlTransaction<'_>,
    generation: ProjectionGeneration,
) -> Result<Option<i64>, PortError> {
    // Creation can provision the namespace before the schema transaction.
    // Serialize with initialization to distinguish that empty namespace from
    // a damaged or incompatible durable cache.
    tx.batch("SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 272014))")
        .await?;
    let relations = tx
        .select(
            "SELECT c.relname::TEXT FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'm', 'f')
             ORDER BY (c.relname = 'derived_schema_meta') DESC LIMIT 1",
            Vec::new(),
            &[Kind::Text],
        )
        .await?;
    let Some(name) = relations.into_iter().next().and_then(|mut row| row.pop()) else {
        return Ok(None);
    };
    if String::read(name)? != "derived_schema_meta" {
        return Err(invalid_row());
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
