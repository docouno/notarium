//! Background archive jobs and installation maintenance.

mod archive_jobs;
mod artifacts;
mod backup;
mod backup_format;
mod db_integrity;
mod download;
mod export;
mod fsck;
mod import;
mod maintenance;
mod range_source;
mod request_deadline;
mod restore;
mod sqlite_process;
#[allow(unsafe_code)]
mod sqlite_range;
mod worker;
mod zip_layout;

pub use archive_jobs::ArchiveJobs;
pub use artifacts::ArchiveStorage;
pub use backup::{BackupArchive, BackupOptions, PairedPause, run_backup};
pub use download::{ArchiveDownload, ArchiveDownloadMetadata};
pub use fsck::{ArchiveInput, FsckInput, FsckReport, run_fsck};
pub use import::ImportLimits;
pub use restore::{CloudRestoreTarget, RestoreKeyring, RestoreReport, RestoreTarget, run_restore};
pub use sqlite_process::{SQLITE_VERIFIER_ARGUMENT, SqliteVerifier, run_sqlite_verifier};
pub use worker::{ArchiveOperation, ArchiveRunner, JobExecution, JobWorkerConfig};
