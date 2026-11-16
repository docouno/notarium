//! safe native backup with a pinned source owned by one worker.
use super::{failure, session::Session};
use crate::{
    keyring::KeyringWitness,
    store::target::{SecretKeyringRow, TARGET_SCHEMA_VERSION},
};
use notarium_core::{error::PortError, ids::InstallationId, ports::BackupWitness};
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};
use std::{path::Path, time::Duration};
const EPOCH: &str =
    "SELECT epoch_version,state,installation_id FROM v1_storage_epoch WHERE singleton=1";
const KEYS: &str = "SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM secret_keyring WHERE retired_at IS NULL ORDER BY generation LIMIT 4097";
pub(crate) struct SqliteCut {
    source: Connection,
    destination: Option<Connection>,
    barrier: Connection,
    pinned: bool,
}
impl SqliteCut {
    pub(crate) fn prepare(
        source: &Path,
        destination: &Path,
        session: &Session,
    ) -> Result<Self, PortError> {
        session.check()?;
        let barrier = Connection::open_with_flags(
            source,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| failure())?;
        barrier
            .busy_timeout(Duration::from_millis(5))
            .map_err(|_| failure())?;
        barrier
            .execute_batch("PRAGMA journal_size_limit=4194304; PRAGMA trusted_schema=OFF;")
            .map_err(|_| failure())?;
        let _ = barrier.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let source = Connection::open_with_flags(
            source,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| failure())?;
        source
            .busy_timeout(Duration::from_millis(5))
            .map_err(|_| failure())?;
        source
            .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")
            .map_err(|_| failure())?;
        // Prepare and touch known metadata before the measured write pause.
        let _ = source
            .prepare_cached(EPOCH)
            .map_err(|_| failure())?
            .query_row([], |r| r.get::<_, i64>(0))
            .map_err(|_| failure())?;
        let _ = source
            .prepare_cached(KEYS)
            .map_err(|_| failure())?
            .query_row([], |r| r.get::<_, String>(0))
            .map_err(|_| failure())?;
        let destination = Connection::open_with_flags(
            destination,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| failure())?;
        destination
            .busy_timeout(Duration::from_millis(5))
            .map_err(|_| failure())?;
        destination
            .execute_batch(
                "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
            )
            .map_err(|_| failure())?;
        session.interrupts.lock().map_err(|_| failure())?.extend([
            source.get_interrupt_handle(),
            destination.get_interrupt_handle(),
            barrier.get_interrupt_handle(),
        ]);
        session.check()?;
        Ok(Self {
            source,
            destination: Some(destination),
            barrier,
            pinned: false,
        })
    }
    pub(crate) fn pin(
        &mut self,
        expected: &BackupWitness,
        keys: &[KeyringWitness],
        session: &Session,
    ) -> Result<BackupWitness, PortError> {
        session.check()?;
        // Drain a native transaction whose async runtime has already stopped. The
        // cooperative file fence remains exclusive across this barrier and the pin.
        loop {
            session.check()?;
            match self.barrier.execute_batch("BEGIN IMMEDIATE; ROLLBACK;") {
                Ok(()) => break,
                Err(rusqlite::Error::SqliteFailure(code, _))
                    if matches!(
                        code.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) =>
                {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(_) => return Err(failure()),
            }
        }
        self.source
            .execute_batch("BEGIN DEFERRED")
            .map_err(|_| failure())?;
        self.pinned = true;
        session.mark_pinned()?;
        let (schema, state, installation): (u32, String, String) = self
            .source
            .prepare_cached(EPOCH)
            .map_err(|_| failure())?
            .query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|_| failure())?;
        if schema != TARGET_SCHEMA_VERSION
            || state != "ready"
            || InstallationId::parse(&installation)? != expected.installation
        {
            return Err(failure());
        }
        let mut statement = self.source.prepare_cached(KEYS).map_err(|_| failure())?;
        let rows = statement
            .query_map([], |row| {
                Ok(SecretKeyringRow {
                    key_id: row.get(0)?,
                    key_hash: row.get(1)?,
                    generation: row.get(2)?,
                    state: row.get(3)?,
                    canary: row.get(4)?,
                    created_at: row.get(5)?,
                    retired_at: row.get(6)?,
                })
            })
            .map_err(|_| failure())?;
        let mut count = 0;
        for row in rows {
            let row = row.map_err(|_| failure())?;
            let key = keys.get(count).ok_or_else(failure)?;
            if !key.matches(&row) {
                return Err(failure());
            }
            count += 1;
        }
        if count != keys.len() {
            return Err(failure());
        }
        Ok(expected.clone())
    }
    pub(crate) fn spool(&mut self, session: &Session) -> Result<(), PortError> {
        if !self.pinned {
            return Err(failure());
        }
        {
            let backup = Backup::new(&self.source, self.destination.as_mut().ok_or_else(failure)?)
                .map_err(|_| failure())?;
            loop {
                session.check()?;
                match backup.step(128).map_err(|_| failure())? {
                    StepResult::Done => break,
                    StepResult::More => (),
                    StepResult::Busy | StepResult::Locked => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    _ => return Err(failure()),
                }
            }
        }
        session.check()?;
        let destination = self.destination.as_ref().ok_or_else(failure)?;
        destination
            .execute_batch("PRAGMA journal_mode=DELETE;")
            .map_err(|_| failure())?;
        let mut statement = destination
            .prepare("PRAGMA integrity_check(1)")
            .map_err(|_| failure())?;
        let integrity: String = statement
            .query_row([], |row| row.get(0))
            .map_err(|_| failure())?;
        if integrity != "ok" {
            return Err(failure());
        }
        drop(statement);
        self.destination
            .take()
            .ok_or_else(failure)?
            .close()
            .map_err(|_| failure())?;
        session.check()
    }
    pub(crate) fn close(mut self) -> Result<(), PortError> {
        if self.pinned {
            self.source
                .execute_batch("ROLLBACK")
                .map_err(|_| failure())?;
            self.pinned = false;
        }
        self.barrier.close().map_err(|_| failure())?;
        if let Some(destination) = self.destination {
            destination.close().map_err(|_| failure())?;
        }
        self.source.close().map_err(|_| failure())?;
        Ok(())
    }
}
