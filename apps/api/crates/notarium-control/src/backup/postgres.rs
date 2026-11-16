//! dedicated private pool owns cancellation and actual close ACK.
use super::{failure, session::Session, spool::SpoolWriter};
use crate::{
    error::database,
    keyring::KeyringWitness,
    store::{
        BACKUP_LOCK, Transaction,
        target::{self, SecretKeyringRow, TARGET_SCHEMA_VERSION, TargetTable},
    },
};
use notarium_core::{
    error::{CommitEffect, PortError},
    ids::InstallationId,
    ports::BackupWitness,
};
use sqlx::{PgPool, Postgres, pool::PoolConnection, postgres::PgPoolOptions};
use std::{io::Write, time::Duration};
const CLEANUP_GRACE: Duration = Duration::from_secs(5);
pub(crate) struct PostgresCut {
    pool: PgPool,
    lock: Option<PoolConnection<Postgres>>,
    source: Option<PoolConnection<Postgres>>,
    tx: Option<Transaction>,
    locked: bool,
}
impl PostgresCut {
    pub(crate) async fn prepare(parent: &PgPool, session: &Session) -> Result<Self, PortError> {
        // Never return a session-level advisory lock or backup-specific timeouts to
        // the ordinary request pool. Closing this private pool also waits for SQLx
        // owners created by cancellation of BEGIN to relinquish their connections.
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(5))
            .connect_lazy_with(parent.connect_options().as_ref().clone());
        let mut value = Self {
            pool,
            lock: None,
            source: None,
            tx: None,
            locked: false,
        };
        let result = value.prepare_connections(session).await;
        if let Err(error) = result {
            value.close().await?;
            return Err(error);
        }
        Ok(value)
    }
    async fn prepare_connections(&mut self, session: &Session) -> Result<(), PortError> {
        self.lock = Some(
            session
                .operation
                .run(
                    async { self.pool.acquire().await.map_err(database) },
                    CommitEffect::NotCommitted,
                )
                .await?,
        );
        self.source = Some(
            session
                .operation
                .run(
                    async { self.pool.acquire().await.map_err(database) },
                    CommitEffect::NotCommitted,
                )
                .await?,
        );
        for connection in [&mut self.lock, &mut self.source] {
            let connection = connection.as_mut().ok_or_else(failure)?;
            connection.close_on_drop();
            session.operation.run(async{
    sqlx::query("SET search_path TO v1_control,pg_catalog").execute(&mut **connection).await.map_err(database)?;
    // A server-side fallback also bounds an orphaned session after process loss.
    sqlx::query("SELECT set_config('statement_timeout',$1,false),set_config('idle_in_transaction_session_timeout',$1,false),set_config('idle_session_timeout',$1,false)")
      .bind(format!("{}ms",session.remaining().as_millis().saturating_add(1000).clamp(1,i32::MAX as u128)))
      .execute(&mut **connection).await.map_err(database)?;
    Ok(())
   },CommitEffect::NotCommitted).await?;
        }
        // Prepare and warm source metadata outside the measured pause. This is an
        // ordinary autocommit read; no source transaction exists yet.
        session.operation.run(async{
   sqlx::query("SELECT epoch_version,state,installation_id FROM v1_control.v1_storage_epoch WHERE singleton=1").fetch_optional(&mut **self.source.as_mut().ok_or_else(failure)?).await.map_err(database)?;
   Ok(())
  },CommitEffect::NotCommitted).await
    }
    pub(crate) async fn pause(&mut self, session: &Session) -> Result<(), PortError> {
        session.check()?;
        let connection = self.lock.as_mut().ok_or_else(failure)?;
        session
            .operation
            .run(
                async {
                    sqlx::query("SELECT pg_advisory_lock($1)")
                        .bind(BACKUP_LOCK)
                        .execute(&mut **connection)
                        .await
                        .map_err(database)?;
                    Ok(())
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        self.locked = true;
        session.check()
    }
    pub(crate) async fn pin(
        &mut self,
        expected: &BackupWitness,
        keys: &[KeyringWitness],
        session: &Session,
    ) -> Result<BackupWitness, PortError> {
        if !self.locked || self.tx.is_some() {
            return Err(failure());
        }
        let source = self.source.take().ok_or_else(failure)?;
        self.tx = Some(Transaction::Postgres(
            session
                .operation
                .run(
                    async {
                        sqlx::Transaction::begin(
                            source,
                            Some(sqlx::SqlStr::from_static(
                                "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
                            )),
                        )
                        .await
                        .map_err(database)
                    },
                    CommitEffect::NotCommitted,
                )
                .await?,
        ));
        let Transaction::Postgres(tx) = self.tx.as_mut().ok_or_else(failure)? else {
            return Err(failure());
        };
        // Start age conservatively before the real pin request, not when its reply
        // reaches the caller. No SELECT 1 or lock acquisition substitutes for this read.
        session.mark_pinned()?;
        let (version,state,installation):(i64,String,String)=session.operation.run(async{sqlx::query_as("SELECT epoch_version,state,installation_id FROM v1_control.v1_storage_epoch WHERE singleton=1").fetch_one(&mut **tx).await.map_err(database)},CommitEffect::NotCommitted).await?;
        if version != i64::from(TARGET_SCHEMA_VERSION)
            || state != "ready"
            || InstallationId::parse(&installation)? != expected.installation
        {
            return Err(failure());
        }
        let rows:Vec<SecretKeyringRow>=session.operation.run(async{sqlx::query_as("SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM v1_control.secret_keyring WHERE retired_at IS NULL ORDER BY generation LIMIT 4097").fetch_all(&mut **tx).await.map_err(database)},CommitEffect::NotCommitted).await?;
        if rows.len() != keys.len() || !rows.iter().zip(keys).all(|(row, key)| key.matches(row)) {
            return Err(failure());
        }
        session.check()?;
        Ok(expected.clone())
    }
    pub(crate) async fn resume(&mut self) -> Result<(), PortError> {
        let Some(mut connection) = self.lock.take() else {
            return Err(failure());
        };
        let result = tokio::time::timeout(CLEANUP_GRACE, async {
            let unlocked = sqlx::query_scalar::<_, bool>("SELECT pg_advisory_unlock($1)")
                .bind(BACKUP_LOCK)
                .fetch_one(&mut *connection)
                .await
                .map_err(database);
            let closed = connection.close().await.map_err(database);
            closed?;
            if !unlocked? {
                return Err(failure());
            }
            Ok(())
        })
        .await
        .unwrap_or_else(|_| Err(failure()));
        self.locked = false;
        result
    }
    pub(crate) async fn spool<W: Write>(
        &mut self,
        writer: W,
        witness: BackupWitness,
        session: &Session,
    ) -> Result<W, PortError> {
        if self.locked {
            return Err(failure());
        }
        let tx = self.tx.as_mut().ok_or_else(failure)?;
        let mut stream = SpoolWriter::new(writer, witness)?;
        for &table in TargetTable::ALL {
            stream.begin_table(table)?;
            let mut after = None;
            loop {
                session.check()?;
                let page = session
                    .operation
                    .run(
                        target::read_page(tx, table, after, 200),
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                for record in page.records {
                    stream.row(record)?;
                    session.check()?;
                }
                after = page.continuation;
                if after.is_none() {
                    break;
                }
            }
            stream.end_table()?;
        }
        session.check()?;
        stream.finish()
    }
    pub(crate) async fn close(mut self) -> Result<(), PortError> {
        let outcome = tokio::time::timeout(CLEANUP_GRACE, self.release())
            .await
            .unwrap_or_else(|_| Err(failure()));
        // Timeout drops owned query/rollback futures. Any remaining handles are
        // close-on-drop and stay accounted in the private pool until SQLx closes
        // their sockets (its pinned close-on-drop grace is also five seconds).
        drop(self.tx.take());
        drop(self.lock.take());
        drop(self.source.take());
        self.pool.close().await;
        outcome
    }
    async fn release(&mut self) -> Result<(), PortError> {
        let mut outcome = Ok(());
        if let Some(tx) = self.tx.take() {
            let rollback = match tx {
                Transaction::Postgres(tx) => tx.rollback().await.map_err(database),
                Transaction::Sqlite(_) => Err(failure()),
            };
            if rollback.is_err() {
                outcome = rollback;
            }
        }
        if let Some(mut lock) = self.lock.take() {
            if self.locked {
                let unlock = sqlx::query("SELECT pg_advisory_unlock($1)")
                    .bind(BACKUP_LOCK)
                    .execute(&mut *lock)
                    .await
                    .map_err(database);
                if unlock.is_err() {
                    outcome = unlock.map(|_| ());
                }
            }
            let closed = lock.close().await.map_err(database);
            if closed.is_err() {
                outcome = closed;
            }
        }
        if let Some(source) = self.source.take() {
            let closed = source.close().await.map_err(database);
            if closed.is_err() {
                outcome = closed;
            }
        }
        outcome
    }
}
