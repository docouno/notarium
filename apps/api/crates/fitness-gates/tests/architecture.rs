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

fn assert_json_fields(value: &Value, fields: &[&str]) {
    let object = value.as_object().expect("expected a JSON object");
    assert!(
        object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)),
        "expected fields {fields:?}, found {object:?}"
    );
}

fn validate_shards(config: &Value, workspace: &BTreeSet<&str>) {
    assert_json_fields(
        config,
        &["schema_version", "feature_anchor_crates", "shards"],
    );
    assert_eq!(config["schema_version"].as_u64(), Some(1));
    let mut anchors = BTreeSet::new();
    for anchor in config["feature_anchor_crates"].as_array().unwrap() {
        let name = anchor.as_str().unwrap();
        assert!(
            workspace.contains(name) && anchors.insert(name),
            "invalid anchor {name}"
        );
    }
    assert!(
        anchors.contains("notarium-bin"),
        "missing notarium-bin anchor"
    );

    let mut ids = BTreeSet::new();
    let mut assigned = BTreeSet::new();
    let mut fixture_writers = 0;
    let mut doc_runners = 0;
    for shard in config["shards"].as_array().unwrap() {
        assert_json_fields(
            shard,
            &[
                "id",
                "crates",
                "needs_build_api",
                "saves_fixture_cache",
                "runs_doc_tests",
            ],
        );
        let id = shard["id"].as_str().unwrap();
        let valid_id = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        let mut bytes = id.bytes();
        assert!(
            bytes.next().is_some_and(valid_id) && bytes.all(|byte| valid_id(byte) || byte == b'-'),
            "invalid shard ID {id:?}"
        );
        assert!(ids.insert(id), "duplicate shard ID {id}");
        let needs_build_api = shard["needs_build_api"].as_bool().unwrap();
        fixture_writers += usize::from(shard["saves_fixture_cache"].as_bool().unwrap());
        doc_runners += usize::from(shard["runs_doc_tests"].as_bool().unwrap());
        let crates = shard["crates"].as_array().unwrap();
        for krate in crates {
            let name = krate.as_str().unwrap();
            assert!(
                assigned.insert(name),
                "crate {name} assigned more than once"
            );
        }
        assert!(!crates.is_empty(), "shard {id} has no crates");
        assert!(
            !crates.iter().any(|krate| krate == "fitness-gates") || needs_build_api,
            "fitness-gates requires build-api"
        );
    }
    assert_eq!(
        &assigned, workspace,
        "shards must cover the exact workspace"
    );
    assert_eq!(fixture_writers, 1, "expected one fixture cache writer");
    assert_eq!(doc_runners, 1, "expected one workspace doc test runner");
}

#[test]
fn ci_api_shards_cover_all_workspace_members_exactly() {
    let actual = metadata();
    let members: BTreeSet<_> = actual["workspace_members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    let packages = actual["packages"].as_array().unwrap();
    let workspace: BTreeSet<_> = packages
        .iter()
        .filter(|pkg| members.contains(pkg["id"].as_str().unwrap()))
        .map(|pkg| pkg["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        workspace,
        ALLOWED
            .iter()
            .map(|(name, _)| *name)
            .collect::<BTreeSet<_>>()
    );
    assert_eq!(members.len(), workspace.len());
    let config: Value = serde_json::from_slice(
        &fs::read(root().join("../../scripts/ci-api-shards.json"))
            .expect("read API shard manifest"),
    )
    .expect("parse API shard manifest");
    validate_shards(&config, &workspace);
}

#[test]
fn invalid_ci_api_shards_are_rejected() {
    let valid = json!({
        "schema_version": 1,
        "feature_anchor_crates": ["notarium-bin"],
        "shards": [
            {"id": "bin", "crates": ["notarium-bin", "another-crate"], "needs_build_api": false,
             "saves_fixture_cache": true, "runs_doc_tests": false},
            {"id": "fitness", "crates": ["fitness-gates"], "needs_build_api": true,
             "saves_fixture_cache": false, "runs_doc_tests": true}
        ]
    });
    let workspace = BTreeSet::from(["notarium-bin", "another-crate", "fitness-gates"]);
    validate_shards(&valid, &workspace);
    let invalid_fields = [
        ("/shards/0/crates", json!(["notarium-bin"])),
        (
            "/shards/0/crates",
            json!(["notarium-bin", "another-crate", "fitness-gates"]),
        ),
        ("/shards/0/id", json!("../bin")),
        ("/shards/0/id", json!("fitness")),
        ("/shards/1/needs_build_api", json!(false)),
        ("/shards/0/saves_fixture_cache", json!(false)),
        ("/shards/1/saves_fixture_cache", json!(true)),
        ("/shards/1/runs_doc_tests", json!(false)),
        ("/shards/0/runs_doc_tests", json!(true)),
    ];
    for (field, replacement) in invalid_fields {
        let mut config = valid.clone();
        *config.pointer_mut(field).unwrap() = replacement;
        assert!(
            std::panic::catch_unwind(|| validate_shards(&config, &workspace)).is_err(),
            "accepted invalid shard field {field}"
        );
    }
}

#[test]
fn lock_contains_no_banned_packages() {
    let lock = document(&fs::read_to_string(root().join("Cargo.lock")).unwrap());
    validate_lock(&lock).unwrap();
}

fn document(input: &str) -> toml::Value {
    toml::from_str(input).unwrap_or_else(|error| panic!("{error}"))
}

fn validate_profile_packages(manifest: &toml::Value, lock: &toml::Value) -> Result<(), String> {
    let locked: BTreeSet<_> = lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pkg| {
            (
                pkg["name"].as_str().unwrap(),
                pkg["version"].as_str().unwrap(),
            )
        })
        .collect();
    let Some(profiles) = manifest.get("profile").and_then(toml::Value::as_table) else {
        return Ok(());
    };
    for (profile, settings) in profiles {
        let Some(packages) = settings.get("package").and_then(toml::Value::as_table) else {
            continue;
        };
        for spec in packages.keys().filter(|spec| spec.as_str() != "*") {
            let matches = match spec.split_once(['@', ':']) {
                Some(pair) => locked.contains(&pair),
                None => locked.iter().any(|(name, _)| *name == spec.as_str()),
            };
            if !matches {
                return Err(format!(
                    "profile.{profile}.package.{spec} does not match Cargo.lock"
                ));
            }
        }
    }
    Ok(())
}

#[test]
fn package_profile_overrides_match_locked_versions() {
    let root = root();
    let manifest = document(&fs::read_to_string(root.join("Cargo.toml")).unwrap());
    let lock = document(&fs::read_to_string(root.join("Cargo.lock")).unwrap());
    validate_profile_packages(&manifest, &lock).unwrap();
}

#[test]
fn stale_package_profile_overrides_are_rejected() {
    let lock = document("[[package]]\nname = 'scrypt'\nversion = '0.12.0'");
    for spec in ["*", "scrypt", "scrypt@0.12.0", "scrypt:0.12.0"] {
        let manifest = document(&format!("[profile.dev.package.\"{spec}\"]\nopt-level = 3"));
        validate_profile_packages(&manifest, &lock).unwrap();
    }
    for spec in ["nonexistent-crate", "scrypt@0.0.1", "scrypt:0.0.1"] {
        let manifest = document(&format!("[profile.test.package.\"{spec}\"]\nopt-level = 3"));
        assert_eq!(
            validate_profile_packages(&manifest, &lock).unwrap_err(),
            format!("profile.test.package.{spec} does not match Cargo.lock")
        );
    }
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
fn canonical_fixture_methods_are_only_enabled_for_tests() {
    let actual = metadata();
    let packages = actual["packages"].as_array().unwrap();
    let index = packages
        .iter()
        .position(|p| p["name"] == "notarium-canonical")
        .unwrap();
    let canonical = &packages[index];
    let dependencies = canonical["dependencies"].as_array().unwrap();
    let own_tests = dependencies
        .iter()
        .position(|dep| dep["name"] == "notarium-canonical")
        .unwrap();
    assert_eq!(dependencies[own_tests]["features"], json!(["test-support"]));
    assert!(
        canonical["features"]["default"].is_null() || canonical["features"]["default"] == json!([])
    );
    for kind in [Value::Null, json!("build")] {
        let mut altered = actual.clone();
        altered["packages"][index]["dependencies"][own_tests]["kind"] = kind;
        assert!(
            validate_metadata(&altered, &root())
                .unwrap_err()
                .contains("forbidden edge")
        );
    }
    let mut altered = actual;
    let bin = altered["packages"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|p| p["name"] == "notarium-bin")
        .unwrap();
    let dep = bin["dependencies"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|dep| dep["name"] == "notarium-canonical")
        .unwrap();
    dep["features"] = json!(["test-support"]);
    assert!(
        validate_metadata(&altered, &root())
            .unwrap_err()
            .contains("fixture API")
    );
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
