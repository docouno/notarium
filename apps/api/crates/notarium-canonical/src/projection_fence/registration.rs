//! Installation-local projection cleanup. Portable snapshots only carry domain state.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::Path,
};

use super::*;
use crate::{
    codec::{internal_not_committed, unknown_commit_outcome},
    config::SqlBackendConfig,
    runtime::pg_read_error,
    sql_exec::BackendConn,
};

/// Prepared before the projector builds or serves any derived data.
pub struct ProjectionCleanupRegistration(CanonicalStore);

/// Trusted administrative attestation that a persistent derived deployment has
/// been stopped and its derived storage volume destroyed out of band.
/// Has no transport decoder.
pub struct StoppedProjectionDeployment {
    deployment_id: String,
}

impl StoppedProjectionDeployment {
    pub fn attest(deployment_id: impl Into<String>) -> notarium_core::DomainResult<Self> {
        let deployment_id = deployment_id.into();
        if deployment_id.len() != 32 || !deployment_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(DomainError::validation(ValidationReason::InvalidState));
        }
        Ok(Self { deployment_id })
    }

    pub fn deployment_id(&self) -> &str {
        &self.deployment_id
    }
}

impl ProjectionCleanupRegistration {
    pub fn attach(self, cleanup: Arc<dyn ProjectionVisibilityCleanup>) {
        *self
            .0
            .inner
            .live_visibility
            .cleanup
            .write()
            .expect("projection cleanup registry") = Some(cleanup);
        self.0.resume_deferred_projection_purges();
    }
}

impl CanonicalStore {
    /// Explicitly decommissions a previously registered persistent derived
    /// deployment after operator-attested destruction of its volume.
    ///
    /// Never silently confirms incomplete `pending_purges` or undrained erasure
    /// debt, and refuses while a local projection cleanup callback is attached.
    pub async fn confirm_projection_cleanup_decommissioned(
        &self,
        ctx: &MaintenanceContext,
        witness: StoppedProjectionDeployment,
    ) -> Result<(), PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        self.ensure_open()?;
        let fence = &self.inner.live_visibility;
        if fence.has_cleanup() {
            return Err(not_ready());
        }
        if !fence
            .cleanup_debt
            .lock()
            .expect("projection cleanup debt")
            .is_empty()
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let deployment_id = witness.deployment_id;
        match &self.inner.config.sql {
            SqlBackendConfig::Sqlite { data_root, .. } => {
                let has_pending: bool = self
                    .with_read_tx_budget(Some(&ctx.budget), |tx| {
                        Box::pin(async move {
                            let BackendConn::Sqlite(conn) = tx else {
                                unreachable!()
                            };
                            sqlx::query_scalar(
                                "SELECT EXISTS(SELECT 1 FROM pending_purges WHERE phase < 'completed' OR phase > 'completed')",
                            )
                            .fetch_one(&mut **conn)
                            .await
                            .map_err(|e| {
                                internal_not_committed(
                                    "sqlite_decommission_pending_purges",
                                    e.to_string(),
                                )
                            })
                        })
                    })
                    .await?;
                if has_pending {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                let path = data_root.canonical().with_file_name("projection_cleanup");
                tokio::task::spawn_blocking(move || {
                    decommission_local_cache(&path, &deployment_id)
                })
                .await
                .map_err(|err| {
                    internal_not_committed("projection_cleanup_decommission", err.to_string())
                })??;
            }
            SqlBackendConfig::Postgres { .. } => {
                self.with_write_tx(move |tx| {
                    Box::pin(async move {
                        let BackendConn::Postgres(conn) = tx else {
                            unreachable!()
                        };
                        let has_pending: bool = sqlx::query_scalar(
                            "SELECT EXISTS(SELECT 1 FROM pending_purges WHERE phase < 'completed' OR phase > 'completed')",
                        )
                        .fetch_one(&mut **conn)
                        .await
                        .map_err(|e| {
                            internal_not_committed(
                                "pg_decommission_pending_purges",
                                e.to_string(),
                            )
                        })?;
                        if has_pending {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidState).into(),
                            );
                        }
                        let existing: Option<String> = sqlx::query_scalar(
                            "SELECT deployment_id FROM projection_cleanup_registration WHERE singleton = TRUE FOR UPDATE",
                        )
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|e| {
                            internal_not_committed(
                                "pg_decommission_read_registration",
                                e.to_string(),
                            )
                        })?;
                        match existing {
                            None => Ok(()),
                            Some(current) if current == deployment_id => {
                                sqlx::query(
                                    "DELETE FROM projection_cleanup_registration WHERE singleton = TRUE AND deployment_id = $1",
                                )
                                .bind(deployment_id)
                                .execute(&mut **conn)
                                .await
                                .map_err(|e| {
                                    internal_not_committed(
                                        "pg_decommission_delete_registration",
                                        e.to_string(),
                                    )
                                })?;
                                Ok(())
                            }
                            Some(_) => Err(DomainError::validation(ValidationReason::InvalidState).into()),
                        }
                    })
                })
                .await?;
            }
        }
        Ok(())
    }

    pub async fn prepare_projection_visibility_cleanup(
        &self,
        ctx: &MaintenanceContext,
        deployment_id: &str,
    ) -> Result<ProjectionCleanupRegistration, PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        if deployment_id.len() != 32 || !deployment_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        match &self.inner.config.sql {
            SqlBackendConfig::Sqlite { data_root, .. } => {
                let path = data_root.canonical().with_file_name("projection_cleanup");
                let cache_identity = deployment_id.to_owned();
                tokio::task::spawn_blocking(move || bind_local_cache(&path, &cache_identity))
                    .await
                    .map_err(|err| {
                        internal_not_committed("projection_cleanup_registration", err.to_string())
                    })??;
            }
            SqlBackendConfig::Postgres { .. } => {
                let deployment_id = deployment_id.to_owned();
                self.with_write_tx(move |tx| {
                    Box::pin(async move {
                        let BackendConn::Postgres(conn) = tx else {
                            unreachable!()
                        };
                        // ON CONFLICT serializes simultaneous first registrations. A different
                        // derived installation cannot replace the original cleanup target.
                        let bound: Option<bool> = sqlx::query_scalar(
                            "INSERT INTO projection_cleanup_registration(singleton, deployment_id) VALUES (TRUE,$1)
                             ON CONFLICT(singleton) DO UPDATE SET deployment_id=EXCLUDED.deployment_id
                             WHERE projection_cleanup_registration.deployment_id=EXCLUDED.deployment_id RETURNING singleton",
                        ).bind(deployment_id).fetch_optional(&mut **conn).await
                          .map_err(|e| internal_not_committed("pg_projection_cleanup_registration", e.to_string()))?;
                        if bound != Some(true) { return Err(DomainError::validation(ValidationReason::InvalidState).into()); }
                        Ok(())
                    })
                })
                .await?;
            }
        }
        Ok(ProjectionCleanupRegistration(self.clone()))
    }

    pub(crate) async fn projection_cleanup_missing(
        &self,
        budget: &CallBudget,
    ) -> Result<bool, PortError> {
        let fence = &self.inner.live_visibility;
        if fence.has_cleanup() {
            return Ok(false);
        }
        let registered = match &self.inner.config.sql {
            SqlBackendConfig::Sqlite { data_root, .. } => {
                let path = data_root.canonical().with_file_name("projection_cleanup");
                match tokio::fs::symlink_metadata(path).await {
                    Ok(_) => true,
                    Err(error) if error.kind() == ErrorKind::NotFound => false,
                    Err(error) => {
                        return Err(internal_not_committed(
                            "projection_cleanup_registration",
                            error.to_string(),
                        ));
                    }
                }
            }
            SqlBackendConfig::Postgres { .. } => {
                // Another live canonical process may have registered the first projector.
                self.with_read_tx_budget(Some(budget), |tx| {
                    Box::pin(async move {
                        let BackendConn::Postgres(conn) = tx else {
                            unreachable!()
                        };
                        sqlx::query_scalar(
                            "SELECT EXISTS(SELECT 1 FROM projection_cleanup_registration)",
                        )
                        .fetch_one(&mut **conn)
                        .await
                        .map_err(|e| pg_read_error("pg_projection_cleanup_registration", e))
                    })
                })
                .await?
            }
        };
        Ok(registered && !fence.has_cleanup())
    }

    pub(super) async fn projection_cleanup_for_erasure(
        &self,
        budget: &CallBudget,
    ) -> Result<Option<Arc<dyn ProjectionVisibilityCleanup>>, PortError> {
        if self
            .projection_cleanup_missing(budget)
            .await
            .map_err(|e| unknown_commit_outcome("projection_cleanup_registration", e.to_string()))?
        {
            return Err(unknown_commit_outcome(
                "projection_cleanup_detached",
                "the registered projection cleanup is not attached",
            ));
        }
        Ok(self.inner.live_visibility.cleanup())
    }
}

fn read_local_cache_id(path: &Path) -> Result<String, PortError> {
    let io_error = |e: std::io::Error| {
        internal_not_committed("projection_cleanup_registration", e.to_string())
    };
    let invalid = || DomainError::validation(ValidationReason::InvalidState);
    if !fs::symlink_metadata(path).map_err(io_error)?.is_file() {
        return Err(invalid().into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use rustix::fs::OFlags;
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags((OFlags::NOFOLLOW | OFlags::NONBLOCK).bits() as i32);
    }
    let mut file = options.open(path).map_err(io_error)?;
    let meta = file.metadata().map_err(io_error)?;
    if !meta.is_file() || meta.len() != 32 {
        return Err(invalid().into());
    }
    let mut bytes = [0; 32];
    file.read_exact(&mut bytes).map_err(io_error)?;
    let id = String::from_utf8(bytes.to_vec()).map_err(|_| invalid())?;
    Ok(id)
}

fn decommission_local_cache(path: &Path, expected_identity: &str) -> Result<(), PortError> {
    let io_error = |e: std::io::Error| {
        internal_not_committed("projection_cleanup_decommission", e.to_string())
    };
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
        Ok(_) => {}
    }
    let current = read_local_cache_id(path)?;
    if current != expected_identity {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    #[cfg(unix)]
    fs::File::open(path.parent().expect("canonical database directory"))
        .and_then(|dir| dir.sync_all())
        .map_err(io_error)?;
    Ok(())
}

fn bind_local_cache(path: &Path, cache_identity: &str) -> Result<(), PortError> {
    let io_error = |e: std::io::Error| {
        internal_not_committed("projection_cleanup_registration", e.to_string())
    };
    let check = || -> Result<(), PortError> {
        let invalid = || DomainError::validation(ValidationReason::InvalidState);
        if read_local_cache_id(path)? != cache_identity {
            return Err(invalid().into());
        }
        #[cfg(unix)]
        fs::File::open(path.parent().expect("canonical database directory"))
            .and_then(|dir| dir.sync_all())
            .map_err(io_error)?;
        Ok(())
    };
    match fs::symlink_metadata(path) {
        Ok(_) => return check(),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    let temp = path.with_file_name(crate::codec::new_prefixed_hex_id(".projection-cleanup-")?);
    let mut create_opts = OpenOptions::new();
    create_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        create_opts.mode(0o600);
    }
    let mut file = create_opts.open(&temp).map_err(io_error)?;
    let publish = (|| -> std::io::Result<()> {
        file.write_all(cache_identity.as_bytes())?;
        file.sync_all()?;
        match fs::hard_link(&temp, path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) if is_hardlink_unsupported(&error) => {
                // Fallback for filesystems without hard links (e.g. exFAT/FAT32/FUSE):
                // atomically create the target exclusively without clobbering an existing file.
                let mut direct_opts = OpenOptions::new();
                direct_opts.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    direct_opts.mode(0o600);
                }
                match direct_opts.open(path) {
                    Ok(mut direct) => {
                        direct.write_all(cache_identity.as_bytes())?;
                        direct.sync_all()?;
                    }
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e),
                }
            }
            Err(error) => return Err(error),
        }
        Ok(())
    })();
    drop(file);
    let _ = fs::remove_file(&temp);
    publish.map_err(io_error)?;
    check()
}

fn is_hardlink_unsupported(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        ErrorKind::Unsupported | ErrorKind::PermissionDenied
    ) {
        return true;
    }
    #[cfg(unix)]
    {
        if matches!(error.raw_os_error(), Some(1 | 18 | 38 | 45 | 95)) {
            return true;
        }
    }
    false
}
