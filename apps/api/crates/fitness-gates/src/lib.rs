//! Architecture checks use Cargo's package identities, including renamed,
//! optional, target, development and build dependency declarations.

pub mod unsafe_quarantine;

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
};

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

const FIXTURE_CRATES: &[&str] = &[
    "notarium-agents",
    "notarium-canonical",
    "notarium-projections",
    "notarium-search",
];

struct WorkspaceDep<'a> {
    target: &'a str,
    alias: &'a str,
    is_dev: bool,
    optional: bool,
    uses_default_features: bool,
    features: Vec<&'a str>,
}

struct WorkspacePackage<'a> {
    deps: Vec<WorkspaceDep<'a>>,
    features: BTreeMap<&'a str, Vec<&'a str>>,
}

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
    let mut graph: BTreeMap<&str, WorkspacePackage<'_>> = BTreeMap::new();
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
        let mut workspace_deps = Vec::new();
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
                let self_test_harness = FIXTURE_CRATES.contains(&source)
                    && target == source
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
                let alias = dep["rename"].as_str().unwrap_or(target);
                let is_dev = dep["kind"].as_str() == Some("dev");
                let optional = dep["optional"].as_bool().unwrap_or(false);
                let uses_default_features = dep["uses_default_features"].as_bool().unwrap_or(true);
                let features = dep["features"]
                    .as_array()
                    .map(|items| items.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                workspace_deps.push(WorkspaceDep {
                    target,
                    alias,
                    is_dev,
                    optional,
                    uses_default_features,
                    features,
                });
            } else if local.is_some() {
                return Err(format!("unregistered path dependency {source} -> {target}"));
            }
            if source == "notarium-agents" && ["tantivy", "ort", "yrs"].contains(&target) {
                return Err(format!("heavy dependency {source} -> {target}"));
            }
        }
        let mut pkg_features = BTreeMap::new();
        if let Some(features) = package["features"].as_object() {
            for (feature_name, entries) in features {
                let list = entries
                    .as_array()
                    .map(|items| items.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                pkg_features.insert(feature_name.as_str(), list);
            }
        }
        graph.insert(
            source,
            WorkspacePackage {
                deps: workspace_deps,
                features: pkg_features,
            },
        );
    }
    validate_fixture_feature_graph(&graph)?;
    Ok(())
}

fn validate_fixture_feature_graph(
    graph: &BTreeMap<&str, WorkspacePackage<'_>>,
) -> Result<(), String> {
    for (&source, pkg) in graph {
        for dep in pkg.deps.iter().filter(|dep| !dep.is_dev) {
            let mut seeds: Vec<(&str, &str)> = dep
                .features
                .iter()
                .map(|&feat| (dep.target, feat))
                .collect();
            if dep.uses_default_features {
                seeds.push((dep.target, "default"));
            }
            if let Some(fixture) = reaches_fixture_api(graph, seeds, None) {
                return Err(format!(
                    "fixture API enabled by dependency {source} -> {} (reaches {fixture}/test-support)",
                    dep.target
                ));
            }
        }
        for &feature_name in pkg.features.keys() {
            if source == "fitness-gates" && feature_name != "default" {
                continue;
            }
            let own_fixture = FIXTURE_CRATES.contains(&source) && feature_name == "test-support";
            let exempt_fixture = own_fixture.then_some(source);
            if let Some(fixture) =
                reaches_fixture_api(graph, [(source, feature_name)], exempt_fixture)
            {
                return Err(format!(
                    "fixture API enabled by feature {source}/{feature_name} (reaches {fixture}/test-support)"
                ));
            }
        }
    }
    Ok(())
}

fn reaches_fixture_api<'a>(
    graph: &BTreeMap<&'a str, WorkspacePackage<'a>>,
    seeds: impl IntoIterator<Item = (&'a str, &'a str)>,
    exempt_fixture: Option<&'a str>,
) -> Option<&'a str> {
    fn enqueue<'a>(
        node: (&'a str, &'a str),
        visited: &mut BTreeSet<(&'a str, &'a str)>,
        queue: &mut VecDeque<(&'a str, &'a str)>,
    ) {
        if visited.insert(node) {
            queue.push_back(node);
        }
    }

    fn enqueue_dep_defaults<'a>(
        dep: &WorkspaceDep<'a>,
        visited: &mut BTreeSet<(&'a str, &'a str)>,
        queue: &mut VecDeque<(&'a str, &'a str)>,
    ) {
        for &dep_feat in &dep.features {
            enqueue((dep.target, dep_feat), visited, queue);
        }
        if dep.uses_default_features {
            enqueue((dep.target, "default"), visited, queue);
        }
    }

    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    for seed in seeds {
        enqueue(seed, &mut visited, &mut queue);
    }
    while let Some((pkg_name, feat_name)) = queue.pop_front() {
        if feat_name == "test-support"
            && FIXTURE_CRATES.contains(&pkg_name)
            && exempt_fixture != Some(pkg_name)
        {
            return Some(pkg_name);
        }
        let Some(pkg) = graph.get(pkg_name) else {
            continue;
        };
        let Some(entries) = pkg.features.get(feat_name) else {
            continue;
        };
        for &entry in entries {
            let stripped = entry.strip_prefix("dep:").unwrap_or(entry);
            if let Some((raw_alias, target_feat)) = stripped.split_once('/') {
                let weak = raw_alias.ends_with('?');
                let alias = raw_alias.trim_end_matches('?');
                for dep in pkg.deps.iter().filter(|dep| dep.alias == alias) {
                    enqueue((dep.target, target_feat), &mut visited, &mut queue);
                    if !weak && !dep.is_dev {
                        enqueue_dep_defaults(dep, &mut visited, &mut queue);
                    }
                }
            } else if let Some(alias) = entry.strip_prefix("dep:") {
                for dep in pkg
                    .deps
                    .iter()
                    .filter(|dep| !dep.is_dev && dep.alias == alias)
                {
                    enqueue_dep_defaults(dep, &mut visited, &mut queue);
                }
            } else {
                enqueue((pkg_name, entry), &mut visited, &mut queue);
                for dep in pkg
                    .deps
                    .iter()
                    .filter(|dep| !dep.is_dev && dep.optional && dep.alias == entry)
                {
                    enqueue_dep_defaults(dep, &mut visited, &mut queue);
                }
            }
        }
    }
    None
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
