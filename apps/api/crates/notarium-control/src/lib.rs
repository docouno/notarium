//! Durable account authority and control state. Transport composition is external.
#![forbid(unsafe_code)]

#[cfg(test)]
extern crate self as notarium_control;
#[cfg(test)]
#[allow(dead_code)]
#[path = "../tests/support/mod.rs"]
mod test_support;

// Isolate fixtures that share process-wide KDF and outbound admission budgets.
// Concurrent calls within each scenario still exercise the production limiters.
#[cfg(test)]
pub(crate) static TEST_RESOURCE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub mod auth;
pub mod backup;
mod error;
pub mod keyring;
pub mod outbound;
pub mod service;
pub mod store;
