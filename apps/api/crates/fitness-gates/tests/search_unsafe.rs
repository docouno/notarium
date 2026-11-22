use fitness_gates::unsafe_quarantine::{AuditedLeaf, CrateQuarantine, verify_crate_quarantine};
use std::{fs, path::Path};

#[test]
fn search_unsafe_operations_are_confined_to_audited_vector_leaves() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../notarium-search");
    verify_crate_quarantine(&CrateQuarantine {
        crate_dir: &crate_root,
        leaves: &[
            AuditedLeaf {
                path: "src/vector/mmap_segment.rs",
                exact_unsafe_tokens: Some(2),
                exact_safety_comments: Some(2),
                require_mmap_options: true,
                forbid_map_mut: true,
                required_token_pairs: &[["allow", "unsafe_code"]],
            },
            AuditedLeaf {
                path: "src/vector/simd.rs",
                exact_unsafe_tokens: None,
                exact_safety_comments: None,
                require_mmap_options: false,
                forbid_map_mut: true,
                required_token_pairs: &[["allow", "unsafe_code"]],
            },
        ],
        allowed_external_test_paths: &["../../notarium-canonical/tests/support/mod.rs"],
    });

    // Safe top-level modules and safe vector submodules must forbid unsafe
    // overrides explicitly on every declaration.
    assert_modules_forbid_unsafe(
        &crate_root.join("src/lib.rs"),
        "notarium-search/src/lib.rs",
        &[
            "config", "embed", "engine", "indexer", "layout", "lexical", "model", "ports", "query",
        ],
    );
    assert_modules_forbid_unsafe(
        &crate_root.join("src/vector/mod.rs"),
        "notarium-search/src/vector/mod.rs",
        &[
            "builder",
            "epoch",
            "format",
            "hnsw",
            "quantization",
            "tombstone",
            "wal",
        ],
    );
}

fn assert_modules_forbid_unsafe(path: &Path, label: &str, modules: &[&str]) {
    let source = fs::read_to_string(path).unwrap_or_else(|err| panic!("read {label}: {err}"));
    let lines: Vec<&str> = source.lines().collect();
    for module in modules {
        let decl_indices: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                let trimmed = line.trim();
                trimmed == format!("mod {module};") || trimmed == format!("pub mod {module};")
            })
            .map(|(index, _)| index)
            .collect();
        assert!(
            !decl_indices.is_empty(),
            "{label} missing module declaration `{module}`"
        );
        for index in decl_indices {
            assert!(
                index > 0 && lines[index - 1].trim() == "#[forbid(unsafe_code)]",
                "{label} must mark module `{module}` (line {}) with #[forbid(unsafe_code)]",
                index + 1
            );
        }
    }
}
