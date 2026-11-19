//! Native encrypted values and confined, operation-scoped keyring access.
mod crypto;
mod facade;
mod fresh;
mod reader;
pub use crypto::EnvelopeAddress;
pub use facade::{Keyring, KeyringLocation, KeyringWitness, SealedValue};
pub use fresh::FreshLocalInitializer;

use notarium_core::ids::KeyId;

/// Non-secret metadata from a verified control database image or logical spool.
#[derive(serde::Deserialize, serde::Serialize)]
pub struct BackupKeyRow {
    pub key_id: String,
    pub key_hash: String,
    pub generation: i64,
    pub state: String,
    pub canary: String,
}

/// Check existing key files against archived metadata without modifying or
/// populating the keyring. The returned canaries contain no key file bytes.
pub fn verify_backup_keys(
    path: &std::path::Path,
    rows: Vec<BackupKeyRow>,
    budget: notarium_core::ports::CallBudget,
) -> Result<Vec<notarium_core::ports::KeyCanary>, notarium_core::error::PortError> {
    let failure = crypto::failure;
    let mut keys = Vec::with_capacity(rows.len().min(reader::MAX_KEYS));
    let mut last = 0i64;
    if rows.len() > reader::MAX_KEYS {
        return Err(failure());
    }
    for row in rows {
        if row.generation <= last
            || row.key_hash.len() > 256
            || row.canary.len() > 1024
            || !matches!(row.state.as_str(), "active" | "readable")
        {
            return Err(failure());
        }
        last = row.generation;
        keys.push(Witness {
            key: KeyId::parse(&row.key_id).map_err(|_| failure())?,
            hash: row.key_hash,
            generation: row.generation as u64,
            active: row.state == "active",
            canary: row.canary,
        });
    }
    let operation = crate::store::lease::OperationBudget::new(budget);
    let _verified = reader::load_many(path, &keys, &[], true, &operation)?;
    Ok(keys
        .iter()
        .map(KeyringWitness::from)
        .map(|witness| witness.backup_canary())
        .collect())
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Witness {
    pub key: KeyId,
    pub hash: String,
    pub generation: u64,
    pub active: bool,
    pub canary: String,
}
