use std::{fs, path::Path};

#[test]
fn projection_unsafe_operations_are_confined_to_the_mmap_loader() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../notarium-projections/src");
    let quarantine = source.join("mmap/raw.rs");
    let mut directories = vec![source];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory).expect("read projections source directory") {
            let entry = entry.expect("read projection source entry");
            let path = entry.path();
            if entry.file_type().expect("source entry type").is_dir() {
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

fn source_tokens(contents: &str) -> impl Iterator<Item = &str> {
    contents
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .flat_map(|source| source.split(|ch: char| ch != '_' && !ch.is_ascii_alphanumeric()))
        .filter(|token| !token.is_empty())
}
