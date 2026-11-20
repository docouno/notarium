//! linear phase clients; the worker owns every actual DB/file handle.
use super::{failure, session::Session, worker::Command};
use notarium_core::{error::PortError, ports::*};
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::{mpsc, oneshot};

pub(crate) struct Client {
    pub(crate) session: Arc<Session>,
    pub(crate) commands: mpsc::Sender<Command>,
}
impl Clone for Client {
    fn clone(&self) -> Self {
        Self {
            session: self.session.clone(),
            commands: self.commands.clone(),
        }
    }
}
/// Drop of an in-flight future cancels independently of command queue capacity.
struct Operation {
    session: Arc<Session>,
    complete: bool,
}
impl Operation {
    fn complete(mut self) {
        self.complete = true;
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if !self.complete {
            self.session.cancel();
        }
    }
}
impl Client {
    async fn request<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<Result<T, PortError>>) -> Command,
    ) -> Result<T, PortError> {
        let operation = Operation {
            session: self.session.clone(),
            complete: false,
        };
        let result = async {
            self.session.check()?;
            let (tx, rx) = oneshot::channel();
            self.commands.try_send(command(tx)).map_err(|_| failure())?;
            self.session
                .operation
                .run(
                    async { rx.await.map_err(|_| failure())? },
                    notarium_core::error::CommitEffect::NotCommitted,
                )
                .await
        }
        .await;
        match result {
            Ok(value) => {
                operation.complete();
                Ok(value)
            }
            Err(error) => {
                self.session.cancel();
                self.session.closed().await?;
                Err(error)
            }
        }
    }
    async fn close(&self) -> Result<(), PortError> {
        self.session.cancel();
        self.session.closed().await
    }
}
pub(crate) struct Prepared {
    pub(crate) client: Client,
    pub(crate) witness: BackupWitness,
    pub(crate) owns: bool,
    pub(crate) hold_acquired: bool,
}
struct Hold {
    witness: BackupWitness,
}
struct Paused {
    client: Client,
    owns: bool,
    opened: bool,
}
struct Snapshot {
    client: Client,
    witness: BackupWitness,
    owns: bool,
    spooled: bool,
}
impl Drop for Prepared {
    fn drop(&mut self) {
        if self.owns {
            self.client.session.cancel();
        }
    }
}
impl Drop for Paused {
    fn drop(&mut self) {
        if self.owns {
            self.client.session.cancel();
        }
    }
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        if self.owns {
            self.client.session.cancel();
        }
    }
}
impl PreparedBackup for Prepared {
    fn abort(mut self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            if self.owns {
                self.client.close().await?;
                self.owns = false;
            }
            Ok(())
        })
    }

    fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
        Box::pin(async move {
            if !self.owns || self.hold_acquired {
                return Err(failure());
            }
            self.client.session.check()?;
            self.hold_acquired = true;
            // Control owns no CAS references. This hold is only validated metadata;
            // releasing it cannot release another phase's writer lock or source cut.
            Ok(Box::new(Hold {
                witness: self.witness.clone(),
            }) as Box<dyn BackupHold>)
        })
    }
    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
        Box::pin(async move {
            if !self.owns || !self.hold_acquired {
                return Err(failure());
            }
            self.client.request(Command::Pause).await?;
            self.owns = false;
            Ok(Box::new(Paused {
                client: self.client.clone(),
                owns: true,
                opened: false,
            }) as Box<dyn PausedBackup>)
        })
    }
}
impl BackupHold for Hold {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }
    fn release(self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async { Ok(()) })
    }
}
impl PausedBackup for Paused {
    fn open_cut(&mut self) -> PortFuture<'_, Box<dyn BackupSnapshot>> {
        Box::pin(async move {
            if !self.owns || self.opened {
                return Err(failure());
            }
            let witness = self.client.request(Command::Pin).await?;
            self.opened = true;
            Ok(Box::new(Snapshot {
                client: self.client.clone(),
                witness,
                owns: true,
                spooled: false,
            }) as Box<dyn BackupSnapshot>)
        })
    }
    fn resume(mut self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            self.client.request(Command::Resume).await?;
            self.owns = false;
            Ok(())
        })
    }
}
impl BackupSnapshot for Snapshot {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }
    fn spool(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, BackupSpool> {
        Box::pin(async move {
            if !self.owns || self.spooled {
                return Err(failure());
            }
            // Keep this outer guard through receipt acceptance: an ACK left unread in a
            // oneshot is not ownership transfer to the caller.
            let operation = Operation {
                session: self.client.session.clone(),
                complete: false,
            };
            let receipt = self
                .client
                .request(|reply| Command::Spool {
                    budget,
                    cancellation,
                    reply,
                })
                .await?;
            // The worker races this CAS with abort. It may remove an unclaimed artifact
            // only after winning Pending->Aborted; acceptance can never return a deleted
            // artifact. Durable file+manifest completion precedes this transfer.
            self.client.session.check()?;
            self.client
                .session
                .receipt
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| failure())?;
            self.client.session.wake();
            self.spooled = true;
            self.owns = false;
            operation.complete();
            Ok(receipt)
        })
    }
    fn spool_temporary(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, TemporaryBackupSpool> {
        Box::pin(async move {
            if !self.owns || self.spooled {
                return Err(failure());
            }
            let spool = self
                .client
                .request(|reply| Command::SpoolTemporary {
                    budget,
                    cancellation,
                    reply,
                })
                .await?;
            self.spooled = true;
            self.owns = false;
            Ok(spool)
        })
    }
    fn close(mut self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            if self.spooled {
                self.client.session.closed().await?;
            } else {
                self.client.close().await?;
            }
            self.owns = false;
            Ok(())
        })
    }
}
