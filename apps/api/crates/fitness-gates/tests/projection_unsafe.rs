use fitness_gates::unsafe_quarantine::{AuditedLeaf, CrateQuarantine, verify_crate_quarantine};
use std::{fs, path::Path};

#[test]
fn projection_unsafe_operations_are_confined_to_the_mmap_loader() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../notarium-projections");
    verify_crate_quarantine(&CrateQuarantine {
        crate_dir: &crate_root,
        leaves: &[AuditedLeaf {
            path: "src/mmap/raw.rs",
            exact_unsafe_tokens: Some(2),
            exact_safety_comments: Some(2),
            require_mmap_options: true,
            forbid_map_mut: true,
            required_token_pairs: &[["try_deserialize", "Frozen"], ["allow", "unsafe_code"]],
        }],
        allowed_external_test_paths: &[],
    });
}

#[test]
fn projection_frozen_abi_matches_locked_croaring_versions() {
    let lock_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");
    let lock_text = fs::read_to_string(&lock_path).expect("read workspace Cargo.lock");
    let parsed: toml::Value = toml::from_str(&lock_text).expect("parse Cargo.lock");
    let packages = parsed
        .get("package")
        .and_then(toml::Value::as_array)
        .expect("Cargo.lock package list");
    let version_of = |name: &str| -> String {
        let mut versions: Vec<String> = packages
            .iter()
            .filter(|pkg| pkg.get("name").and_then(toml::Value::as_str) == Some(name))
            .filter_map(|pkg| pkg.get("version").and_then(toml::Value::as_str))
            .map(ToOwned::to_owned)
            .collect();
        versions.sort();
        versions.dedup();
        assert_eq!(
            versions.len(),
            1,
            "expected a single locked version for {name}, found {versions:?}"
        );
        versions.pop().unwrap()
    };
    let croaring_ver = version_of("croaring");
    let croaring_sys_ver = version_of("croaring-sys");
    let mmap_source = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../notarium-projections/src/mmap/mod.rs"),
    )
    .expect("read mmap/mod.rs");
    let expected_fragment = format!("croaring/{croaring_ver};CRoaring/{croaring_sys_ver};frozen");
    assert!(
        mmap_source.contains(&expected_fragment),
        "mmap/mod.rs platform_abi() must match locked versions ({expected_fragment})"
    );
}
