use std::{collections::BTreeSet, fs, path::PathBuf, process::Command};

use fitness_gates::{ALLOWED, BANNED, CORE_RUNTIME_DEPENDENCIES, validate_lock, validate_metadata};
use proptest::prelude::*;
use serde_json::{Value, json};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn metadata() -> Value {
    static METADATA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    METADATA.get_or_init(load_metadata).clone()
}

fn load_metadata() -> Value {
    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--locked",
            "--offline",
            "--manifest-path",
        ])
        .arg(root().join("Cargo.toml"))
        .output()
        .expect("run cargo metadata");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn workspace_has_exactly_the_allowed_package_graph() {
    validate_metadata(&metadata(), &root()).unwrap();
}

#[test]
fn lock_contains_no_banned_packages() {
    let lock = document(&fs::read_to_string(root().join("Cargo.lock")).unwrap());
    validate_lock(&lock).unwrap();
}

fn document(input: &str) -> toml::Value {
    toml::from_str(input).unwrap_or_else(|error| panic!("{error}"))
}

fn bound_dependencies(manifest: &toml::Value, result: &mut BTreeSet<String>) {
    for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(deps) = manifest.get(section).and_then(toml::Value::as_table) {
            for (name, spec) in deps {
                assert_eq!(
                    spec.get("workspace").and_then(toml::Value::as_bool),
                    Some(true),
                    "{name} must inherit workspace dependencies"
                );
                result.insert(name.clone());
            }
        }
    }
    if let Some(targets) = manifest.get("target").and_then(toml::Value::as_table) {
        for target in targets.values() {
            bound_dependencies(target, result);
        }
    }
}

#[test]
fn workspace_dependencies_are_bound_locked_and_lints_inherited() {
    let root = root();
    assert!(
        !root
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("Cargo.toml")
            .exists()
    );
    let manifest = document(&fs::read_to_string(root.join("Cargo.toml")).unwrap());
    let expected: BTreeSet<_> = ALLOWED
        .iter()
        .map(|(name, _)| format!("crates/{name}"))
        .collect();
    let members: BTreeSet<_> = manifest["workspace"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(members, expected);
    assert_eq!(
        manifest["workspace"]["default-members"].as_array().unwrap(),
        &[toml::Value::String("crates/notarium-bin".into())]
    );
    assert_eq!(
        manifest["workspace"]["lints"]["rust"]["unsafe_code"].as_str(),
        Some("deny")
    );
    assert_eq!(
        manifest["workspace"]["package"]["edition"].as_str(),
        Some("2024")
    );
    assert_eq!(
        manifest["workspace"]["package"]["rust-version"].as_str(),
        Some("1.99.1")
    );
    let mut bound = BTreeSet::new();
    for (name, _) in ALLOWED {
        let member = document(
            &fs::read_to_string(root.join("crates").join(name).join("Cargo.toml")).unwrap(),
        );
        assert_eq!(member["lints"]["workspace"].as_bool(), Some(true), "{name}");
        bound_dependencies(&member, &mut bound);
    }
    let lock = document(&fs::read_to_string(root.join("Cargo.lock")).unwrap());
    let locked: BTreeSet<_> = lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    for (name, spec) in manifest["workspace"]["dependencies"].as_table().unwrap() {
        assert!(
            bound.contains(name),
            "workspace dependency {name} is not bound by any member"
        );
        let package = spec
            .get("package")
            .and_then(toml::Value::as_str)
            .unwrap_or(name);
        assert!(
            locked.contains(package),
            "workspace dependency {name} is not locked"
        );
    }
}

#[test]
fn banned_package_names_are_checked_exactly() {
    for name in BANNED {
        let lock = document(&format!(
            "[[package]]\nname = {name:?}\nversion = \"1.0.0\"\n"
        ));
        assert!(validate_lock(&lock).unwrap_err().contains(name));
    }
    let lock = document("[[package]]\nname = \"cmake-free\"\nversion = \"1.0.0\"\n");
    validate_lock(&lock).unwrap();
}

proptest! {
    #[test]
    fn renamed_optional_and_target_edges_cannot_bypass_allowlist(
        alias in "[a-z][a-z_]{0,20}", kind in 0usize..3, optional in any::<bool>(), target in any::<bool>()
    ) {
        // Start with the actual graph so this exercises the same parser and validator.
        let mut data = metadata();
        let kind = [Value::Null, json!("dev"), json!("build")][kind].clone();
        let dep = json!({"name": "notarium-canonical", "rename": alias,
            "path": root().join("crates/notarium-canonical"),
            "kind": kind,
            "optional": optional, "target": if target { json!("cfg(windows)") } else { Value::Null }});
        let packages = data["packages"].as_array_mut().unwrap();
        let http = packages.iter_mut().find(|p| p["name"] == "notarium-http").unwrap();
        http["dependencies"].as_array_mut().unwrap().push(dep);
        prop_assert!(validate_metadata(&data, &root()).unwrap_err().contains("notarium-http -> notarium-canonical"));
    }
}

#[test]
fn no_package_can_import_executable_or_gate_packages() {
    for destination in ["notarium-bin", "notarium-migrate", "fitness-gates"] {
        let mut data = metadata();
        let source = if destination == "notarium-bin" {
            "fitness-gates"
        } else {
            "notarium-bin"
        };
        let package = data["packages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|p| p["name"] == source)
            .unwrap();
        package["dependencies"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name": destination, "path": root().join("crates").join(destination)}));
        assert!(
            validate_metadata(&data, &root())
                .unwrap_err()
                .contains(destination)
        );
    }
}

#[test]
fn core_runtime_dependencies_are_rejected_in_every_declaration_kind() {
    for dependency in CORE_RUNTIME_DEPENDENCIES {
        for kind in [Value::Null, json!("dev"), json!("build")] {
            let mut data = metadata();
            let core = data["packages"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|p| p["name"] == "notarium-core")
                .unwrap();
            core["dependencies"].as_array_mut().unwrap().push(json!({"name": dependency, "rename": "innocent_alias", "kind": kind, "optional": true, "target": "cfg(windows)"}));
            assert!(
                validate_metadata(&data, &root())
                    .unwrap_err()
                    .contains(&format!("notarium-core -> {dependency}"))
            );
        }
    }
}

#[test]
fn pure_libraries_forbid_unsafe_code_even_if_an_inner_module_tries_to_allow_it() {
    for name in ["notarium-core", "notarium-syntax", "notarium-canonical"] {
        let source =
            fs::read_to_string(root().join("crates").join(name).join("src/lib.rs")).unwrap();
        assert!(
            source.contains("#![forbid(unsafe_code)]"),
            "{name} must forbid unsafe overrides"
        );
    }
}
