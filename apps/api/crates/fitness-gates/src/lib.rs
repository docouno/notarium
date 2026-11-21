//! Architecture checks use Cargo's package identities, including renamed,
//! optional, target, development and build dependency declarations.

pub mod unsafe_quarantine;

use std::{collections::BTreeSet, path::Path};

use serde_json::Value;

pub const ALLOWED: &[(&str, &[&str])] = &[
    ("notarium-core", &[]),
    ("notarium-syntax", &["notarium-core"]),
    ("notarium-control", &["notarium-core"]),
    ("notarium-canonical", &["notarium-core", "notarium-syntax"]),
    (
        "notarium-projections",
        &["notarium-core", "notarium-syntax", "notarium-canonical"],
    ),
    (
        "notarium-search",
        &["notarium-core", "notarium-syntax", "notarium-canonical"],
    ),
    (
        "notarium-collab",
        &["notarium-core", "notarium-syntax", "notarium-canonical"],
    ),
    (
        "notarium-vault",
        &["notarium-core", "notarium-syntax", "notarium-canonical"],
    ),
    (
        "notarium-jobs",
        &[
            "notarium-core",
            "notarium-syntax",
            "notarium-canonical",
            "notarium-control",
        ],
    ),
    (
        "notarium-agents",
        &["notarium-core", "notarium-syntax", "notarium-control"],
    ),
    (
        "notarium-http",
        &[
            "notarium-core",
            "notarium-control",
            "notarium-agents",
            "notarium-collab",
            "notarium-vault",
        ],
    ),
    (
        "notarium-bin",
        &[
            "notarium-core",
            "notarium-syntax",
            "notarium-control",
            "notarium-canonical",
            "notarium-projections",
            "notarium-search",
            "notarium-collab",
            "notarium-jobs",
            "notarium-vault",
            "notarium-agents",
            "notarium-http",
        ],
    ),
    (
        "notarium-migrate",
        &[
            "notarium-core",
            "notarium-syntax",
            "notarium-canonical",
            "notarium-control",
        ],
    ),
    (
        "fitness-gates",
        &[
            "notarium-core",
            "notarium-syntax",
            "notarium-control",
            "notarium-canonical",
            "notarium-projections",
            "notarium-search",
            "notarium-collab",
            "notarium-jobs",
            "notarium-vault",
            "notarium-agents",
            "notarium-http",
        ],
    ),
];

pub const BANNED: &[&str] = &[
    "openssl-sys",
    "native-tls",
    "aws-lc-sys",
    "cmake",
    "cxx",
    "usearch",
    "tikv-jemalloc-sys",
];

/// Core owns values and port signatures, never adapters or parser/runtime engines.
pub const CORE_RUNTIME_DEPENDENCIES: &[&str] = &[
    "tokio",
    "sqlx",
    "rusqlite",
    "tantivy",
    "ort",
    "yrs",
    "reqwest",
    "axum",
    "utoipa",
    "tonic",
    "hyper",
    "moka",
    "object_store",
    "pulldown-cmark",
    "saphyr",
    "saphyr-parser",
    "memmap2",
    "notify",
    "croaring",
];

pub fn validate_metadata(metadata: &Value, root: &Path) -> Result<(), String> {
    let packages = metadata["packages"].as_array().ok_or("missing packages")?;
    let members = metadata["workspace_members"]
        .as_array()
        .ok_or("missing workspace_members")?;
    let expected: BTreeSet<_> = ALLOWED.iter().map(|(name, _)| *name).collect();
    let actual: BTreeSet<_> = packages
        .iter()
        .map(|p| p["name"].as_str().unwrap_or(""))
        .collect();
    if actual != expected || members.len() != expected.len() || packages.len() != expected.len() {
        return Err(format!(
            "expected exactly 14 workspace packages: {actual:?}"
        ));
    }
    for package in packages {
        let source = package["name"].as_str().ok_or("missing name")?;
        if !members.contains(&package["id"]) {
            return Err(format!("{source} is not a workspace member"));
        }
        let manifest = root.join("crates").join(source).join("Cargo.toml");
        if package["manifest_path"].as_str().map(Path::new) != Some(manifest.as_path()) {
            return Err(format!("{source} must live at {}", manifest.display()));
        }
        let allowed = ALLOWED.iter().find(|(name, _)| *name == source).unwrap().1;
        for dep in package["dependencies"]
            .as_array()
            .ok_or("missing dependencies")?
        {
            let target = dep["name"].as_str().ok_or("missing dependency name")?;
            if source == "notarium-core" && CORE_RUNTIME_DEPENDENCIES.contains(&target) {
                return Err(format!("runtime dependency {source} -> {target}"));
            }
            let local = dep["path"].as_str();
            if expected.contains(target) {
                // Cargo builds a package's own integration tests as downstream crates.
                // Self dev-dependencies select fixture methods only for test targets.
                let self_test_harness = matches!(
                    source,
                    "notarium-canonical" | "notarium-projections" | "notarium-search"
                ) && target == source
                    && dep["kind"] == "dev"
                    && dep["features"] == serde_json::json!(["test-support"])
                    && dep["rename"].is_null()
                    && dep["target"].is_null()
                    && dep["optional"] == false;
                if (!allowed.contains(&target) && !self_test_harness)
                    || local.map(Path::new) != Some(root.join("crates").join(target).as_path())
                {
                    return Err(format!(
                        "forbidden edge {source} -> {target} (alias={}, kind={}, target={})",
                        dep["rename"], dep["kind"], dep["target"]
                    ));
                }
                if matches!(
                    target,
                    "notarium-canonical" | "notarium-projections" | "notarium-search"
                ) && dep["kind"] != "dev"
                    && dep["features"]
                        .as_array()
                        .is_some_and(|features| features.iter().any(|f| f == "test-support"))
                {
                    return Err(format!(
                        "fixture API enabled by dependency {source} -> {target}"
                    ));
                }
            } else if local.is_some() {
                return Err(format!("unregistered path dependency {source} -> {target}"));
            }
            if source == "notarium-agents" && ["tantivy", "ort", "yrs"].contains(&target) {
                return Err(format!("heavy dependency {source} -> {target}"));
            }
        }
    }
    Ok(())
}

pub fn validate_lock(lock: &toml::Value) -> Result<(), String> {
    for package in lock["package"].as_array().ok_or("missing lock packages")? {
        let name = package["name"]
            .as_str()
            .ok_or("missing lock package name")?;
        if BANNED.contains(&name) {
            return Err(format!("banned package in Cargo.lock: {name}"));
        }
    }
    Ok(())
}
