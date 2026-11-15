//! Native encrypted values and confined, operation-scoped keyring access.
mod crypto;
mod facade;
mod fresh;
mod reader;
pub use crypto::EnvelopeAddress;
pub use facade::{Keyring, KeyringLocation, KeyringWitness, SealedValue};
pub use fresh::FreshLocalInitializer;

use notarium_core::ids::KeyId;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Witness {
    pub key: KeyId,
    pub hash: String,
    pub generation: u64,
    pub active: bool,
    pub canary: String,
}
