use std::{fs, path::Path};

#[test]
fn projection_unsafe_operations_are_confined_to_the_mmap_loader() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../notarium-projections");
    let canonical_root = fs::canonicalize(&crate_root).expect("canonicalize projections crate");
    let quarantine = crate_root.join("src/mmap/raw.rs");
    let mut directories = vec![crate_root.clone()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory).expect("read projections crate directory") {
            let entry = entry.expect("read projection crate entry");
            let path = entry.path();
            if entry.file_type().expect("entry type").is_dir() {
                if path.file_name().is_some_and(|name| name == "target") {
                    continue;
                }
                directories.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs")
                && path != quarantine
            {
                let contents = fs::read_to_string(&path).expect("read projection source");
                let tokens: Vec<&str> = source_tokens(&contents).collect();
                assert!(
                    !tokens.contains(&"unsafe"),
                    "unsafe operation outside {}",
                    path.display()
                );
                // Reject include!() everywhere and #[path] anywhere outside tests/
                // or pointing outside the crate root (which could smuggle Rust files
                // outside this recursive scan).
                let in_tests = path
                    .strip_prefix(&crate_root)
                    .is_ok_and(|rel| rel.starts_with("tests"));
                assert!(
                    !contents.contains("include!("),
                    "external source inclusion outside {}",
                    path.display()
                );
                if contents.contains("#[path") {
                    assert!(
                        in_tests,
                        "external #[path] inclusion outside tests/ in {}",
                        path.display()
                    );
                    let parent = path.parent().expect("source file parent");
                    for line in contents.lines().filter(|l| l.contains("#[path")) {
                        let (_, rest) = line.split_once('"').expect("quoted #[path]");
                        let (target, _) = rest.split_once('"').expect("closed #[path]");
                        assert!(
                            !target.starts_with('/') && !target.contains(".."),
                            "escaping #[path = \"{target}\"] in {}",
                            path.display()
                        );
                        let resolved =
                            fs::canonicalize(parent.join(target)).expect("resolve #[path] target");
                        assert!(
                            resolved.starts_with(&canonical_root),
                            "#[path = \"{target}\"] escapes crate root in {}",
                            path.display()
                        );
                    }
                }
                // The workspace denies unsafe code. Any local lint override would bypass it.
                assert!(
                    tokens
                        .iter()
                        .enumerate()
                        .all(|(i, token)| *token != "unsafe_code"
                            || i > 0 && matches!(tokens[i - 1], "deny" | "forbid")),
                    "unsafe_code override outside {}",
                    path.display()
                );
            }
        }
    }
    let raw = fs::read_to_string(quarantine).expect("the mmap loader is present");
    let tokens: Vec<&str> = source_tokens(&raw).collect();
    assert_eq!(tokens.iter().filter(|token| **token == "unsafe").count(), 2);
    assert_eq!(raw.matches("// SAFETY:").count(), 2);
    assert!(tokens.contains(&"MmapOptions"));
    assert!(!tokens.contains(&"map_mut"));
    assert!(
        tokens
            .windows(2)
            .any(|pair| pair == ["try_deserialize", "Frozen"])
    );
    assert!(
        tokens
            .windows(2)
            .any(|pair| pair == ["allow", "unsafe_code"])
    );
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

fn source_tokens(contents: &str) -> impl Iterator<Item = &str> {
    contents
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .flat_map(|source| source.split(|ch: char| ch != '_' && !ch.is_ascii_alphanumeric()))
        .filter(|token| !token.is_empty())
}
