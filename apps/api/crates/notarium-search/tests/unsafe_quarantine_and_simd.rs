use notarium_search::vector::simd::{Dot, Kernel, dot_i8_scalar};
use proptest::{
    collection::vec,
    prelude::*,
    test_runner::{Config, TestRunner},
};
use std::{fs, path::Path};

#[test]
fn simd_matches_scalar_bit_for_bit() {
    let vectors = prop::sample::select(vec![64, 100, 384, 768, 1024, 1536])
        .prop_flat_map(|dim| (vec(-127i8..=127, dim), vec(-127i8..=127, dim)));
    let mut runner = TestRunner::new(Config {
        cases: 10_000,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&vectors, |(query, value)| {
            let expected = dot_i8_scalar(&query, &value);
            for kernel in Kernel::ALL.into_iter().filter(|kernel| kernel.available()) {
                let actual = Dot::with_kernel(&query, kernel).unwrap().dot(&value);
                prop_assert_eq!(actual, expected);
            }
            Ok(())
        })
        .unwrap();
    for dim in [64, 100, 384, 768, 1024, 1536, 4096] {
        let query = vec![-127; dim];
        let value = vec![127; dim];
        for kernel in Kernel::ALL.into_iter().filter(|kernel| kernel.available()) {
            let dot = Dot::with_kernel(&query, kernel).unwrap();
            assert_eq!(dot.dot(&value), Some(-127 * 127 * dim as i32));
            assert_eq!(dot.dot(&vec![0; dim]), Some(0));
        }
    }
}

#[test]
fn search_unsafe_is_limited_to_audited_leaves() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut directories = vec![root.join("src"), root.join("tests")];
    let permitted = ["src/vector/mmap_segment.rs", "src/vector/simd.rs"];
    let block = ["un", "safe {"].concat();
    let function = ["un", "safe fn"].concat();
    let allowance = ["allow(un", "safe_code)"].concat();
    while let Some(dir) = directories.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                directories.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let source = fs::read_to_string(&path).unwrap();
            let relative = path.strip_prefix(root).unwrap().to_str().unwrap();
            let mut proof = false;
            for line in source.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("// SAFETY:") {
                    proof = true;
                } else if trimmed.starts_with("//") {
                    continue;
                } else if trimmed.contains(&block) {
                    assert!(permitted.contains(&relative) && proof, "{relative}: {line}");
                    proof = false;
                } else {
                    if trimmed.contains(&function) || trimmed.contains(&allowance) {
                        assert!(permitted.contains(&relative), "{relative}: {line}");
                    }
                    proof = false;
                }
            }
        }
    }
}
