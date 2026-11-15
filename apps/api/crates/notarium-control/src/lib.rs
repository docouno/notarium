//! Durable account authority and control state. Transport composition is external.
#![forbid(unsafe_code)]

#[cfg(test)]
extern crate self as notarium_control;
#[cfg(test)]
#[allow(dead_code)]
#[path = "../tests/support/mod.rs"]
mod test_support;

pub mod auth;
mod error;
pub mod keyring;
pub mod outbound;
pub mod service;
pub mod store;
