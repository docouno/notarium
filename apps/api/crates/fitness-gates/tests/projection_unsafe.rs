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
            let file_type = entry.file_type().expect("entry type");
            assert!(
                !file_type.is_symlink(),
                "symlinked path is forbidden inside projections crate: {}",
                path.display()
            );
            if file_type.is_dir() {
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
                // Reject include!() everywhere (including spaced `include ! (` or `std::include!`)
                // and #[path] anywhere outside tests/ or pointing outside the crate root.
                let in_tests = path
                    .strip_prefix(&crate_root)
                    .is_ok_and(|rel| rel.starts_with("tests"));
                assert!(
                    !contains_include_macro(&contents),
                    "external source inclusion outside {}",
                    path.display()
                );
                if contains_path_attr(&contents) {
                    assert!(
                        in_tests,
                        "external #[path] inclusion outside tests/ in {}",
                        path.display()
                    );
                    let parent = path.parent().expect("source file parent");
                    for target in extract_path_attr_targets(&contents) {
                        assert!(
                            !target.starts_with('/') && !target.contains(".."),
                            "escaping #[path = \"{target}\"] in {}",
                            path.display()
                        );
                        let resolved =
                            fs::canonicalize(parent.join(&target)).expect("resolve #[path] target");
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

fn contains_include_macro(contents: &str) -> bool {
    let bytes = contents.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"include")
            && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_'))
        {
            let mut j = i + "include".len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'!' {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn contains_path_attr(contents: &str) -> bool {
    !extract_path_attr_targets(contents).is_empty()
}

fn extract_path_attr_targets(contents: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let bytes = contents.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'!' {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
            }
            if j < bytes.len() && bytes[j] == b'[' {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if bytes[j..].starts_with(b"path") {
                    j += 4;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if j < bytes.len() && bytes[j] == b'=' {
                        j += 1;
                        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                            j += 1;
                        }
                        if j < bytes.len() && bytes[j] == b'"' {
                            j += 1;
                            let start = j;
                            while j < bytes.len() && bytes[j] != b'"' {
                                j += 1;
                            }
                            if j < bytes.len() {
                                targets
                                    .push(String::from_utf8_lossy(&bytes[start..j]).into_owned());
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
    targets
}
