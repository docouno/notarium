use super::{
    Witness,
    crypto::{Material, canonical_decode, failure, file_hash},
};
use crate::store::lease::OperationBudget;
use cap_fs_ext::OpenOptionsSyncExt;
use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata, OpenOptions},
};
use notarium_core::{
    error::{CommitEffect, PortError},
    ids::KeyId,
};
use serde::{Deserialize, Deserializer};
use std::{io::Read, path::Path};
use zeroize::Zeroizing;

const MAX_FILE: usize = 16 * 1024;
pub(super) const MAX_KEYS: usize = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pointer {
    format: String,
    format_version: u32,
    generation: u64,
    key_id: KeyId,
    key_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyFile {
    format: String,
    format_version: u32,
    key_id: KeyId,
    #[serde(deserialize_with = "secret")]
    secret: Zeroizing<String>,
}
fn secret<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(deserializer).map(Zeroizing::new)
}
fn permissions(metadata: &Metadata) -> Result<(), PortError> {
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o002 != 0 {
            return Err(failure());
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    Ok(())
}
fn file(root: &Dir, path: &str) -> Result<Zeroizing<Vec<u8>>, PortError> {
    let mut options = OpenOptions::new();
    options.read(true).nonblock(true);
    // Confined resolution follows projected-volume relative symlinks without
    // allowing an escape from the opened directory capability.
    let opened = root.open_with(path, &options).map_err(|_| failure())?;
    let metadata = opened.metadata().map_err(|_| failure())?;
    if !metadata.is_file() || metadata.len() > MAX_FILE as u64 {
        return Err(failure());
    }
    permissions(&metadata)?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize + 1));
    opened
        .take(MAX_FILE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure())?;
    if bytes.len() > MAX_FILE || bytes.len() as u64 != metadata.len() {
        return Err(failure());
    }
    Ok(bytes)
}
fn material(root: &Dir, witness: &Witness) -> Result<Material, PortError> {
    let bytes = file(root, &format!("keys/{}.json", witness.key))?;
    if file_hash(&bytes) != witness.hash {
        return Err(failure());
    }
    let key: KeyFile = serde_json::from_slice(&bytes).map_err(|_| failure())?;
    if key.format != "notarium-credential-key"
        || key.format_version != 1
        || key.key_id != witness.key
    {
        return Err(failure());
    }
    let decoded = canonical_decode(&key.secret, 43)?;
    let master: &[u8; 32] = decoded.as_slice().try_into().map_err(|_| failure())?;
    let material = Material::derive(master)?;
    if material.id != witness.key {
        return Err(failure());
    }
    material.check_canary(&witness.canary)?;
    Ok(material)
}
fn attempt(
    root: &Dir,
    bytes: &[u8],
    witnesses: &[Witness],
    requested: &[KeyId],
    all: bool,
    budget: &OperationBudget,
) -> Result<Vec<Material>, PortError> {
    let pointer: Pointer = serde_json::from_slice(bytes).map_err(|_| failure())?;
    if pointer.format != "notarium-credential-key-pointer"
        || pointer.format_version != 1
        || pointer.generation == 0
    {
        return Err(failure());
    }
    let active = witnesses
        .iter()
        .find(|row| row.active)
        .ok_or_else(failure)?;
    if witnesses.iter().filter(|row| row.active).count() != 1
        || active.key != pointer.key_id
        || active.hash != pointer.key_hash
        || active.generation != pointer.generation
    {
        return Err(failure());
    }
    let mut loaded = Vec::new();
    for witness in witnesses {
        budget.check(CommitEffect::NotCommitted)?;
        let needed = all || witness.active || requested.iter().any(|key| key == &witness.key);
        if needed {
            loaded.push(material(root, witness)?);
        }
    }
    if requested.is_empty() {
        if !loaded.iter().any(|item| item.id == active.key) {
            return Err(failure());
        }
    } else if requested
        .iter()
        .any(|key| !loaded.iter().any(|item| &item.id == key))
    {
        return Err(failure());
    }
    Ok(loaded)
}

/// Existing-keyring reads never create, repair, chmod or probe for writability.
/// All blocking I/O must be called from the bounded owned worker in the facade.
pub(super) fn load_many(
    path: &Path,
    witnesses: &[Witness],
    requested: &[KeyId],
    all: bool,
    budget: &OperationBudget,
) -> Result<Vec<Material>, PortError> {
    if witnesses.is_empty() || witnesses.len() > MAX_KEYS {
        return Err(failure());
    }
    let root = Dir::open_ambient_dir(path, ambient_authority()).map_err(|_| failure())?;
    permissions(&root.dir_metadata().map_err(|_| failure())?)?;
    for retry in 0..2 {
        budget.check(CommitEffect::NotCommitted)?;
        let before = file(&root, "active.json")?;
        let result = attempt(&root, &before, witnesses, requested, all, budget);
        budget.check(CommitEffect::NotCommitted)?;
        let after = file(&root, "active.json");
        if after
            .as_ref()
            .is_ok_and(|after| after.as_slice() == before.as_slice())
        {
            return result;
        }
        if retry == 1 {
            return Err(failure());
        }
    }
    Err(failure())
}

#[cfg(test)]
pub(super) fn load(
    path: &Path,
    witnesses: &[Witness],
    requested: Option<&KeyId>,
    all: bool,
    budget: &OperationBudget,
) -> Result<Material, PortError> {
    let keys: Vec<KeyId> = requested.cloned().into_iter().collect();
    let loaded = load_many(path, witnesses, &keys, all, budget)?;
    match requested {
        Some(target) => loaded
            .into_iter()
            .find(|m| &m.id == target)
            .ok_or_else(failure),
        None => {
            let active = witnesses.iter().find(|w| w.active).ok_or_else(failure)?;
            loaded
                .into_iter()
                .find(|m| m.id == active.key)
                .ok_or_else(failure)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::{
        ids::RequestId,
        ports::{CallBudget, Cancellation},
    };
    use std::{
        fs,
        path::PathBuf,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    fn budget() -> OperationBudget {
        OperationBudget::new(CallBudget {
            request: RequestId::from_bytes([1; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(10),
        })
    }
    fn source() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native")
    }
    fn witness() -> Witness {
        let value: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/keyring/vectors.json"))
                .unwrap();
        Witness {
            key: KeyId::parse(value["keyId"].as_str().unwrap()).unwrap(),
            hash: value["keyHash"].as_str().unwrap().into(),
            generation: 1,
            active: true,
            canary: value["canaryEnvelope"].as_str().unwrap().into(),
        }
    }
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").expect("use pinned runner"))
                    .join(format!(
                        "control-tests/keyring-{}-{unique}",
                        std::process::id()
                    ));
            fs::create_dir_all(path.join("keys")).unwrap();
            let name = format!("keys/{}.json", witness().key);
            fs::copy(source().join(&name), path.join(name)).unwrap();
            fs::copy(source().join("active.json"), path.join("active.json")).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn fixture_mount_rejects_writes() {
        let root = source();
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open(root.join("active.json"))
                .is_err(),
            "this qualification requires the pinned read-only source mount"
        );
    }
    #[test]
    fn native_reader_works_on_real_read_only_source_mount() {
        let root = source();
        let expected = witness();
        assert_eq!(
            load(
                &root,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .unwrap()
            .id,
            expected.key
        );
        assert_eq!(fs::read_dir(root.join("keys")).unwrap().count(), 1);
    }
    #[test]
    fn pointer_file_and_database_witnesses_must_agree() {
        let root = Scratch::new();
        let expected = witness();
        let baseline = fs::read(root.0.join("active.json")).unwrap();
        for name in ["format", "formatVersion", "generation", "keyId", "keyHash"] {
            let mut pointer: serde_json::Value = serde_json::from_slice(&baseline).unwrap();
            pointer[name] = match name {
                "formatVersion" | "generation" => serde_json::json!(2),
                _ => serde_json::json!("invalid"),
            };
            fs::write(
                root.0.join("active.json"),
                serde_json::to_vec(&pointer).unwrap(),
            )
            .unwrap();
            assert!(
                load(
                    &root.0,
                    std::slice::from_ref(&expected),
                    None,
                    true,
                    &budget()
                )
                .is_err(),
                "{name}"
            );
        }
        fs::write(root.0.join("active.json"), &baseline).unwrap();
        let mut changed = expected.clone();
        changed.canary = "v1.invalid".into();
        assert!(load(&root.0, &[changed], None, true, &budget()).is_err());
        let mut changed = expected.clone();
        changed.generation = 2;
        assert!(load(&root.0, &[changed], None, true, &budget()).is_err());
        assert!(load(&root.0, &[], None, true, &budget()).is_err());
        assert!(
            load(
                &root.0,
                &[expected.clone(), expected.clone()],
                None,
                true,
                &budget()
            )
            .is_err()
        );
        let key_path = root.0.join(format!("keys/{}.json", expected.key));
        let original = fs::read(&key_path).unwrap();
        // Keep the file hash witness valid to reach the native-format checks.
        for (field, value) in [
            ("format", serde_json::json!("other")),
            ("formatVersion", serde_json::json!(2)),
            ("keyId", serde_json::json!("ck_000000000000000000000000")),
            ("secret", serde_json::json!("AA==")),
        ] {
            let mut key: serde_json::Value = serde_json::from_slice(&original).unwrap();
            key[field] = value;
            let bytes = serde_json::to_vec(&key).unwrap();
            fs::write(&key_path, &bytes).unwrap();
            let mut row = expected.clone();
            row.hash = file_hash(&bytes);
            let mut pointer: serde_json::Value = serde_json::from_slice(&baseline).unwrap();
            pointer["keyHash"] = serde_json::json!(row.hash);
            fs::write(
                root.0.join("active.json"),
                serde_json::to_vec(&pointer).unwrap(),
            )
            .unwrap();
            assert!(
                load(&root.0, &[row], None, true, &budget()).is_err(),
                "{field}"
            );
        }
        fs::write(root.0.join("active.json"), &baseline).unwrap();
        fs::write(&key_path, &original).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_ok()
        );
        fs::remove_file(&key_path).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_err()
        );
        assert!(!key_path.exists(), "missing keys must never be regenerated");
        fs::write(&key_path, vec![b' '; MAX_FILE + 1]).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_err()
        );
        fs::remove_file(&key_path).unwrap();
        fs::create_dir(&key_path).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_err()
        );
    }
    #[cfg(unix)]
    #[test]
    fn projected_symlinks_are_confined_and_nonregular_files_do_not_block() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = Scratch::new();
        let expected = witness();
        let name = format!("keys/{}.json", expected.key);
        fs::create_dir(root.0.join(".generation")).unwrap();
        fs::rename(root.0.join("keys"), root.0.join(".generation/keys")).unwrap();
        fs::rename(
            root.0.join("active.json"),
            root.0.join(".generation/active.json"),
        )
        .unwrap();
        symlink(".generation", root.0.join("..data")).unwrap();
        symlink("..data/active.json", root.0.join("active.json")).unwrap();
        fs::create_dir(root.0.join("keys")).unwrap();
        symlink(format!("../..data/{name}"), root.0.join(&name)).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_ok()
        );
        fs::remove_file(root.0.join(&name)).unwrap();
        symlink(source().join(&name), root.0.join(&name)).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_err()
        );
        fs::remove_file(root.0.join(&name)).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(root.0.join(&name))
                .status()
                .unwrap()
                .success()
        );
        let (send, receive) = std::sync::mpsc::channel();
        let path = root.0.clone();
        let row = expected.clone();
        std::thread::spawn(move || {
            let rejected = load(&path, &[row], None, true, &budget()).is_err();
            let _ = send.send(rejected);
        });
        assert!(
            receive
                .recv_timeout(Duration::from_secs(1))
                .expect("FIFO rejection must not block")
        );
        fs::remove_file(root.0.join(&name)).unwrap();
        fs::copy(source().join(&name), root.0.join(&name)).unwrap();
        fs::set_permissions(root.0.join(&name), fs::Permissions::from_mode(0o666)).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_err()
        );
        fs::set_permissions(root.0.join(&name), fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(
            load(
                &root.0,
                std::slice::from_ref(&expected),
                None,
                true,
                &budget()
            )
            .is_err()
        );
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
