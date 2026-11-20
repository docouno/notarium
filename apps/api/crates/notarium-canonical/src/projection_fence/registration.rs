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

fn bind_local_cache(path: &Path, cache_identity: &str) -> Result<(), PortError> {
    let io_error = |e: std::io::Error| {
        internal_not_committed("projection_cleanup_registration", e.to_string())
    };
    let check = || -> Result<(), PortError> {
        let invalid = || DomainError::validation(ValidationReason::InvalidState);
        if !fs::symlink_metadata(path).map_err(io_error)?.is_file() {
            return Err(invalid().into());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(target_os = "linux")]
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
        if bytes != cache_identity.as_bytes() {
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
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(io_error)?;
    let publish = (|| -> std::io::Result<()> {
        file.write_all(cache_identity.as_bytes())?;
        file.sync_all()?;
        match fs::hard_link(&temp, path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        Ok(())
    })();
    drop(file);
    let _ = fs::remove_file(&temp);
    publish.map_err(io_error)?;
    check()
}
