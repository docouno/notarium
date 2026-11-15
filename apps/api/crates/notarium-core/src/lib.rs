#![forbid(unsafe_code)]

//! Pure domain contracts. Runtime owners supply authority, entropy and observations.
//!
//! Identifiers are deliberately not interchangeable:
//! ```compile_fail
//! use notarium_core::ids::{FolderId, NoteId};
//! fn folder(_: FolderId) {}
//! folder(NoteId::from_bytes([1; 16]));
//! ```

pub mod auth;
pub mod classes;
pub mod document;
pub mod epoch;
pub mod error;
pub mod ids;
pub mod model;
pub mod patch;
pub mod ports;
pub mod query;
pub mod receipt;
pub mod span;
pub mod value;

pub use error::{DomainError, DomainResult};
