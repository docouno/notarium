//! Object-safe ports. Runtime composition and implementations belong to their owners.
use crate::error::PortError;
use std::{future::Future, pin::Pin};
pub mod authentication;
pub mod catalog;
pub mod context;
pub mod control;
pub mod engine;
pub mod infrastructure;
pub mod oauth;
pub mod oidc;
pub mod provider;
pub mod types;

pub type PortFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, PortError>> + Send + 'a>>;
pub trait PortStream<T>: Send {
    fn next(&mut self) -> PortFuture<'_, Option<T>>;
}

pub use authentication::*;
pub use catalog::*;
pub use context::*;
pub use control::ControlPort;
pub use engine::*;
pub use infrastructure::*;
pub use oauth::*;
pub use oidc::*;
pub use provider::*;
pub use types::*;
