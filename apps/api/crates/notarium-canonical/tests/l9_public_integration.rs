#![forbid(unsafe_code)]

mod support;

use std::{
    collections::BTreeSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn workspace_api_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .parent()
        .expect("apps/api dir")
        .to_path_buf()
}

fn repo_root() -> PathBuf {
    workspace_api_root()
        .parent()
        .expect("apps dir")
        .parent()
        .expect("repository root")
        .to_path_buf()
}

fn collect_files_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if matches!(
            name,
            ".git" | ".artifacts" | ".devkit" | "target" | "node_modules" | "dist" | "release"
        ) {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            collect_files_recursive(&path, out);
        } else if ft.is_file() {
            out.push(path);
        }
    }
}

fn example_binary(name: &str) -> PathBuf {
    let api_root = workspace_api_root();
    let target_root = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| api_root.join("target"));
    let debug_bin = target_root
        .join("debug")
        .join("examples")
        .join(format!("{name}{}", env::consts::EXE_SUFFIX));
    if debug_bin.exists() {
        return debug_bin;
    }

    // Fallback when cargo test ran without `--examples` pre-built: compile offline in Cargo target.
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--offline",
            "--locked",
            "--manifest-path",
            api_root.join("Cargo.toml").to_str().expect("utf8 path"),
            "-p",
            "notarium-canonical",
            "--example",
            name,
        ])
        .status()
        .expect("invoke cargo build --example");
    assert!(
        status.success(),
        "failed building example binary '{name}' offline"
    );
    assert!(
        debug_bin.exists(),
        "compiled example binary missing at {}",
        debug_bin.display()
    );
    debug_bin
}

#[test]
fn l9_canonical_forbids_unsafe_has_zero_ignored_tests_and_single_sqlite_sys() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let lib_rs = fs::read_to_string(crate_root.join("src/lib.rs")).expect("read src/lib.rs");
    assert!(
        lib_rs.contains("#![forbid(unsafe_code)]"),
        "notarium-canonical/src/lib.rs must enforce #![forbid(unsafe_code)]"
    );

    // Every canonical integration test and example must enforce `#![forbid(unsafe_code)]`
    // and contain zero ignored-test attributes.
    let mut ignore_attr = String::from("#[");
    ignore_attr.push_str("ignore");

    for subdir in ["tests", "examples"] {
        let dir = crate_root.join(subdir);
        for entry in fs::read_dir(&dir).expect("read canonical subdir").flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("rs") {
                continue;
            }
            let content = fs::read_to_string(&path).expect("read rust target file");
            assert!(
                content.contains("#![forbid(unsafe_code)]"),
                "{} must declare #![forbid(unsafe_code)]",
                path.display()
            );
            assert!(
                !content.contains(&ignore_attr),
                "{} must not contain skipped/ignored tests",
                path.display()
            );
        }
    }

    // Zero `ATTACH DATABASE` across canonical storage sources.
    let mut src_files = Vec::new();
    collect_files_recursive(&crate_root.join("src"), &mut src_files);
    assert!(!src_files.is_empty());
    let mut attach_kw = String::from("ATTACH ");
    attach_kw.push_str("DATABASE");
    for file in &src_files {
        if file.extension().and_then(|s| s.to_str()) != Some("rs")
            && file.extension().and_then(|s| s.to_str()) != Some("sql")
        {
            continue;
        }
        let upper = fs::read_to_string(file)
            .expect("read canonical source")
            .to_ascii_uppercase();
        assert!(
            !upper.contains(&attach_kw),
            "forbidden cross-database SQL attachment in {}",
            file.display()
        );
    }

    // `sqlx` and `rusqlite` must resolve to a single `libsqlite3-sys` package in Cargo.lock.
    let lock_raw =
        fs::read_to_string(workspace_api_root().join("Cargo.lock")).expect("read Cargo.lock");
    let mut sqlite_sys_versions = BTreeSet::new();
    for block in lock_raw.split("[[package]]").skip(1) {
        let mut pkg_name = None;
        let mut pkg_version = None;
        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("name = ") {
                pkg_name = Some(rest.trim_matches('"'));
            } else if let Some(rest) = trimmed.strip_prefix("version = ") {
                pkg_version = Some(rest.trim_matches('"'));
            }
            if pkg_name.is_some() && pkg_version.is_some() {
                break;
            }
        }
        if pkg_name == Some("libsqlite3-sys")
            && let Some(ver) = pkg_version
        {
            sqlite_sys_versions.insert(ver.to_owned());
        }
    }
    assert_eq!(
        sqlite_sys_versions.len(),
        1,
        "expected exactly 1 libsqlite3-sys version in Cargo.lock, found {sqlite_sys_versions:?}"
    );
}

#[test]
fn l9_public_repository_hygiene_docs_and_pinned_fixture_provenance() {
    let root = repo_root();

    for required in [
        "README.md",
        "AGENTS.md",
        ".github/workflows/ci.yml",
        "Makefile",
        "compose.storage-tests.yaml",
        "docker/storage-fixtures/with-storage-fixtures.sh",
        "docker/storage-fixtures/minio-ce.Dockerfile",
        "docker/storage-fixtures/uds-bridge.Dockerfile",
        "docker/storage-fixtures/uds_tcp_bridge.rs",
        "docs/architecture.md",
        "docs/development.md",
        "docs/core-contracts.md",
        "docs/syntax.md",
        "docs/storage.md",
    ] {
        assert!(
            root.join(required).is_file(),
            "required public file missing: {required}"
        );
    }

    // UDS bridge utility must forbid unsafe code as well.
    let bridge_src = fs::read_to_string(root.join("docker/storage-fixtures/uds_tcp_bridge.rs"))
        .expect("read uds_tcp_bridge.rs");
    assert!(bridge_src.contains("#![forbid(unsafe_code)]"));

    // Only `README.md` and `AGENTS.md` are permitted Markdown files in the repository root,
    // and no local hook directories may exist.
    for entry in fs::read_dir(&root).expect("read repository root").flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if name.ends_with(".md") {
            assert!(
                matches!(name, "README.md" | "AGENTS.md"),
                "unexpected root Markdown configuration file: {name}"
            );
        }
    }

    // Verify pinned MinIO Community commit and offline network isolation in compose & docs.
    let compose =
        fs::read_to_string(root.join("compose.storage-tests.yaml")).expect("read compose");
    let minio_dockerfile =
        fs::read_to_string(root.join("docker/storage-fixtures/minio-ce.Dockerfile"))
            .expect("read minio-ce.Dockerfile");
    let storage_doc = fs::read_to_string(root.join("docs/storage.md")).expect("read storage.md");

    let expected_minio_commit = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a";
    let expected_minio_tag = "RELEASE.2025-10-15T17-29-55Z";
    assert!(compose.contains("postgres:16-bookworm@sha256:"));
    assert!(compose.contains("network_mode: none"));
    assert!(compose.contains("network_mode: \"service:minio\""));
    assert!(minio_dockerfile.contains(expected_minio_commit));
    assert!(minio_dockerfile.contains(expected_minio_tag));
    assert!(storage_doc.contains(expected_minio_commit));
    assert!(storage_doc.contains(expected_minio_tag));

    // Public Markdown documentation must be self-contained (no internal wiki-links `[[...]]`)
    // and every relative Markdown link must resolve to an existing repository file.
    let mut md_files = vec![root.join("README.md"), root.join("AGENTS.md")];
    for entry in fs::read_dir(root.join("docs"))
        .expect("read docs dir")
        .flatten()
    {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) == Some("md") {
            md_files.push(p);
        }
    }
    for md_path in &md_files {
        let text = fs::read_to_string(md_path).expect("read public markdown");
        assert!(
            !text.contains("[["),
            "non-portable wiki-link syntax found in {}",
            md_path.display()
        );
        let parent = md_path.parent().expect("markdown parent");
        for segment in text.split("](").skip(1) {
            let Some((raw_target, _)) = segment.split_once(')') else {
                continue;
            };
            let target = raw_target.split('#').next().unwrap_or("").trim();
            if target.is_empty() || target.starts_with("https://") || target.starts_with("http://")
            {
                continue;
            }
            let resolved = parent.join(target);
            assert!(
                resolved.exists(),
                "broken relative link '{target}' in {} (resolved to {})",
                md_path.display(),
                resolved.display()
            );
        }
    }
}

#[test]
fn l9_missing_storage_fixtures_fail_closed_and_live_s3_reports_unverified() {
    if env::var_os("NOTARIUM_L9_FAIL_CLOSED_CHILD").is_some() {
        let _ = support::StorageTestFixtures::load_required();
        return;
    }

    // 1. Verify fail-closed fixture loader in an isolated child process with a missing manifest.
    let current_exe = env::current_exe().expect("current test executable");
    let missing_manifest = env::temp_dir().join(format!(
        "notarium-missing-fixtures-{}.json",
        std::process::id()
    ));
    let _ = fs::remove_file(&missing_manifest);

    let child_out = Command::new(&current_exe)
        .arg("--exact")
        .arg("l9_missing_storage_fixtures_fail_closed_and_live_s3_reports_unverified")
        .arg("--nocapture")
        .env("NOTARIUM_L9_FAIL_CLOSED_CHILD", "1")
        .env("NOTARIUM_STORAGE_FIXTURES_MANIFEST", &missing_manifest)
        .output()
        .expect("spawn fail-closed probe child");

    assert!(
        !child_out.status.success(),
        "integration fixture loader must fail closed when manifest is absent"
    );
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&child_out.stdout),
        String::from_utf8_lossy(&child_out.stderr)
    );
    assert!(
        combined.contains("make test app=api"),
        "fail-closed error must point developers to 'make test app=api', got:\n{combined}"
    );

    // 2. Verify active offline storage fixtures are running right now during normal test execution.
    let live_fixtures = support::StorageTestFixtures::load_required();
    assert_eq!(
        live_fixtures.minio_source_commit,
        "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a"
    );

    // 3. Verify `live_s3_acceptance` without live credentials exits 2 with `"status": "UNVERIFIED"`.
    let runner = example_binary("live_s3_acceptance");
    let mut cmd = Command::new(&runner);
    for var in [
        "NOTARIUM_LIVE_S3_PROVIDER",
        "NOTARIUM_LIVE_S3_ENDPOINT",
        "NOTARIUM_LIVE_S3_REGION",
        "NOTARIUM_LIVE_S3_BUCKET",
        "NOTARIUM_LIVE_S3_PREFIX",
        "NOTARIUM_LIVE_S3_ACCESS_KEY_ID",
        "NOTARIUM_LIVE_S3_SECRET_ACCESS_KEY",
        "NOTARIUM_LIVE_S3_SESSION_TOKEN",
        "NOTARIUM_LIVE_S3_BUCKET_MODE",
        "NOTARIUM_LIVE_S3_ADDRESSING",
    ] {
        cmd.env_remove(var);
    }
    let out = cmd.output().expect("execute live_s3_acceptance");
    assert_eq!(
        out.status.code(),
        Some(2),
        "live_s3_acceptance without credentials must exit 2, stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("parse live_s3_acceptance JSON output");
    assert_eq!(report["status"].as_str(), Some("UNVERIFIED"));
    assert!(
        report["checks_executed"]
            .as_array()
            .expect("checks_executed array")
            .is_empty(),
        "UNVERIFIED run must not claim executed cloud checks"
    );
    assert!(
        !report["missing_env"]
            .as_array()
            .expect("missing_env array")
            .is_empty()
    );
}
