//! Desktop filesystem materialization and the loopback sidecar boundary.

pub mod carrier;
pub mod filesystem;
pub mod materials;
pub mod sidecar;
pub mod sync;

mod journal;
mod paths;
mod publication;
mod watch;

pub use journal::{ConflictReason, DiskConflict};
