use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, ProjectionGeneration},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

mod peers;

pub use peers::{
    GenerationLease, PeerAcknowledgement, PeerCandidate, PeerProposal, SpaceGenerationWitness,
};

use super::{
    internal, invalid_row,
    records::{decode, encode},
    sql::{Database, Kind, SqlColumn, SqlTransaction, value},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GenerationDescriptor {
    pub generation: ProjectionGeneration,
    pub publication_epoch: u64,
    /// Binds the selection to the compared catalog and Space command ends.
    pub cut_fingerprint: ContentDigest,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct DescriptorState {
    active: Option<GenerationDescriptor>,
    candidate: Option<GenerationDescriptor>,
}

enum ControlBackend {
    Local(PathBuf),
    Postgres(Arc<Database>),
}

/// Serializes candidate selection and durable activation independently from
/// databases and checkpoint files that belong to individual generations.
#[derive(Clone)]
pub struct GenerationControl(Arc<ControlBackend>);

impl GenerationControl {
    pub async fn open_sqlite(root: &DataRoot) -> Result<Self, PortError> {
        let path = root.active_projection_generation();
        let directory = path.parent().ok_or_else(invalid_row)?.to_owned();
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&directory).map_err(|_| internal("projection_control_directory"))
        })
        .await
        .map_err(|_| internal("projection_control_worker"))??;
        let control = Self(Arc::new(ControlBackend::Local(path)));
        control.active().await?;
        Ok(control)
    }

    pub async fn open_postgres(pool: PgPool, schema_prefix: &str) -> Result<Self, PortError> {
        let schema = format!("{schema_prefix}_ctrl");
        let database = Arc::new(Database::open_postgres(pool, &schema).await?);
        database
            .write(false, |mut tx| {
                Box::pin(async move {
                    tx.batch(
                        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 272014));
                 CREATE TABLE IF NOT EXISTS projection_generation_control (
                     row_id BIGINT PRIMARY KEY CHECK (row_id = 1),
                     descriptor BYTEA NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS projection_generation_peer_handoff (
                     row_id BIGINT PRIMARY KEY CHECK (row_id = 1),
                     state BYTEA NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS projection_generation_read_leases (
                     generation BIGINT NOT NULL,
                     lease_id BYTEA NOT NULL,
                     participant TEXT NOT NULL,
                     PRIMARY KEY (generation, lease_id)
                 );",
                    )
                    .await?;
                    tx.execute(
                "INSERT INTO projection_generation_control (row_id, descriptor) VALUES (1, ?)
                 ON CONFLICT (row_id) DO NOTHING",
                vec![value(&encode(&DescriptorState::default())?)],
            ).await?;
                    Ok(())
                })
            })
            .await?;
        let control = Self(Arc::new(ControlBackend::Postgres(database)));
        control.active().await?;
        Ok(control)
    }

    pub async fn active(&self) -> Result<Option<GenerationDescriptor>, PortError> {
        Ok(self.read().await?.active)
    }

    pub async fn candidate(&self) -> Result<Option<GenerationDescriptor>, PortError> {
        Ok(self.read().await?.candidate)
    }

    /// Called after admission to the sole local cache owner. A process that
    /// failed before the swap leaves a disposable reservation and candidate.
    pub(crate) async fn clear_interrupted_local_rotation(&self) -> Result<(), PortError> {
        if self.is_distributed() {
            return Ok(());
        }
        let Some(candidate) = self.candidate().await? else {
            return Ok(());
        };
        match self.cancel_candidate(&candidate).await {
            Ok(_) => Ok(()),
            Err(error) => {
                if self.local_rotation_witness().await?.candidate.is_none() {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
    }

    /// A CAS whose rename may have succeeded is inspected after taking the
    /// same lock as the writer. Retry the directory sync to establish
    /// durability if its first attempt lost the result.
    pub(crate) async fn local_rotation_witness(&self) -> Result<LocalRotationWitness, PortError> {
        let ControlBackend::Local(path) = self.0.as_ref() else {
            return Err(invalid_row());
        };
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            let _lock = lock_local(&path)?;
            let state = read_local(&path)?;
            let durable = sync_descriptor_directory(&path).is_ok();
            Ok(LocalRotationWitness {
                active: state.active,
                candidate: state.candidate,
                durable,
            })
        })
        .await
        .map_err(|_| internal("projection_control_worker"))?
    }

    pub async fn reserve_candidate(
        &self,
        expected: Option<&GenerationDescriptor>,
        next: &GenerationDescriptor,
    ) -> Result<bool, PortError> {
        validate_transition(expected, next)?;
        let expected = expected.cloned();
        let next = next.clone();
        self.update(move |state| {
            if state.active != expected {
                return false;
            }
            match state.candidate.as_ref() {
                Some(candidate) => candidate == &next,
                None => {
                    state.candidate = Some(next);
                    true
                }
            }
        })
        .await
    }

    pub async fn compare_and_swap(
        &self,
        expected: Option<&GenerationDescriptor>,
        next: &GenerationDescriptor,
    ) -> Result<bool, PortError> {
        if self.is_distributed() && expected.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        validate_transition(expected, next)?;
        let expected = expected.cloned();
        let next = next.clone();
        self.update(move |state| {
            if state.active != expected
                || state.candidate.as_ref().is_some_and(|candidate| {
                    candidate.generation != next.generation
                        || candidate.publication_epoch != next.publication_epoch
                })
            {
                return false;
            }
            state.active = Some(next);
            state.candidate = None;
            true
        })
        .await
    }

    pub async fn cancel_candidate(
        &self,
        expected: &GenerationDescriptor,
    ) -> Result<bool, PortError> {
        let expected = expected.clone();
        self.update(move |state| {
            if state.candidate.as_ref() != Some(&expected) {
                return false;
            }
            state.candidate = None;
            true
        })
        .await
    }

    async fn read(&self) -> Result<DescriptorState, PortError> {
        match &*self.0 {
            ControlBackend::Local(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || read_local(&path))
                    .await
                    .map_err(|_| internal("projection_control_worker"))?
            }
            ControlBackend::Postgres(database) => {
                database
                    .read(|mut tx| Box::pin(async move { read_postgres(&mut tx, false).await }))
                    .await
            }
        }
    }

    async fn update(
        &self,
        operation: impl FnOnce(&mut DescriptorState) -> bool + Send + 'static,
    ) -> Result<bool, PortError> {
        match &*self.0 {
            ControlBackend::Local(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || {
                    let _lock = lock_local(&path)?;
                    let mut state = read_local(&path)?;
                    if !operation(&mut state) {
                        return Ok(false);
                    }
                    write_local(&path, &state)?;
                    Ok(true)
                })
                .await
                .map_err(|_| internal("projection_control_worker"))?
            }
            ControlBackend::Postgres(database) => {
                database
                    .write(false, move |mut tx| {
                        Box::pin(async move {
                            let mut state = read_postgres(&mut tx, true).await?;
                            let candidate = state.candidate.clone();
                            if !operation(&mut state) {
                                return Ok(false);
                            }
                            if candidate != state.candidate {
                                if let Some(next) = &state.candidate {
                                    peers::begin_attempt(&mut tx, next).await?;
                                } else {
                                    peers::clear_attempt(&mut tx).await?;
                                }
                            }
                            tx.execute(
                        "UPDATE projection_generation_control SET descriptor = ? WHERE row_id = 1",
                        vec![value(&encode(&state)?)],
                    ).await?;
                            Ok(true)
                        })
                    })
                    .await
            }
        }
    }
}

pub(crate) struct LocalRotationWitness {
    pub active: Option<GenerationDescriptor>,
    pub candidate: Option<GenerationDescriptor>,
    pub durable: bool,
}

fn validate_transition(
    expected: Option<&GenerationDescriptor>,
    next: &GenerationDescriptor,
) -> Result<(), PortError> {
    let valid = match expected {
        None => next.publication_epoch == 1,
        Some(previous) => {
            next.generation > previous.generation
                && previous.publication_epoch.checked_add(1) == Some(next.publication_epoch)
        }
    };
    if !valid || next.publication_epoch > i64::MAX as u64 {
        return Err(DomainError::validation(ValidationReason::GenerationMismatch).into());
    }
    Ok(())
}

fn validate_state(state: DescriptorState) -> Result<DescriptorState, PortError> {
    if state
        .active
        .as_ref()
        .is_some_and(|active| active.publication_epoch == 0)
    {
        return Err(invalid_row());
    }
    if let Some(candidate) = &state.candidate {
        validate_transition(state.active.as_ref(), candidate)?;
    }
    Ok(state)
}

fn read_local(path: &Path) -> Result<DescriptorState, PortError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DescriptorState::default());
        }
        Err(_) => return Err(internal("projection_control_read")),
    };
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| internal("projection_control_read"))?;
    if bytes.len() > 4096 {
        return Err(invalid_row());
    }
    validate_state(serde_json::from_slice(&bytes).map_err(|_| invalid_row())?)
}

fn lock_local(path: &Path) -> Result<File, PortError> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(|_| internal("projection_control_lock_open"))?;
    file.lock()
        .map_err(|_| internal("projection_control_lock"))?;
    Ok(file)
}

fn write_local(path: &Path, state: &DescriptorState) -> Result<(), PortError> {
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).map_err(|_| internal("projection_control_entropy"))?;
    let temporary = path.with_extension(format!("{:032x}.tmp", u128::from_le_bytes(nonce)));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| internal("projection_control_temp"))?;
        let body = serde_json::to_vec(state).map_err(|_| invalid_row())?;
        file.write_all(&body)
            .map_err(|_| internal("projection_control_write"))?;
        file.sync_all()
            .map_err(|_| internal("projection_control_sync"))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| internal("projection_control_rename"))?;
        sync_descriptor_directory(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sync_descriptor_directory(path: &Path) -> Result<(), PortError> {
    #[cfg(unix)]
    File::open(path.parent().ok_or_else(invalid_row)?)
        .and_then(|file| file.sync_all())
        .map_err(|_| {
            PortError::Internal(super::failure(
                "projection_control_commit_unknown",
                notarium_core::error::CommitEffect::Unknown,
            ))
        })?;
    let _ = path;
    Ok(())
}

async fn read_postgres(
    tx: &mut SqlTransaction<'_>,
    lock: bool,
) -> Result<DescriptorState, PortError> {
    let sql = if lock {
        "SELECT descriptor FROM projection_generation_control WHERE row_id = 1 FOR UPDATE"
    } else {
        "SELECT descriptor FROM projection_generation_control WHERE row_id = 1"
    };
    let bytes = tx
        .select(sql, Vec::new(), &[Kind::Bytes])
        .await?
        .pop()
        .and_then(|mut row| row.pop())
        .ok_or_else(invalid_row)?;
    validate_state(decode(&Vec::<u8>::read(bytes)?)?)
}

async fn read_postgres_shared(tx: &mut SqlTransaction<'_>) -> Result<DescriptorState, PortError> {
    let bytes = tx
        .select(
            "SELECT descriptor FROM projection_generation_control WHERE row_id = 1 FOR SHARE",
            Vec::new(),
            &[Kind::Bytes],
        )
        .await?
        .pop()
        .and_then(|mut row| row.pop())
        .ok_or_else(invalid_row)?;
    validate_state(decode(&Vec::<u8>::read(bytes)?)?)
}
