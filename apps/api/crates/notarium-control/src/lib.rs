//! Durable account authority and control state. Transport composition is external.
#![forbid(unsafe_code)]

pub mod auth;
mod error;
pub mod keyring;
pub mod outbound;
pub mod service;
pub mod store;
