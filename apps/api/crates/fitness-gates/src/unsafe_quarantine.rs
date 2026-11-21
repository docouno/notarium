//! Static unsafe-code quarantine verifier shared across crates that contain
//! small audited unsafe leaves (`notarium-projections` and `notarium-search`).

use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, Debug)]
pub struct AuditedLeaf<'a> {
    pub path: &'a str,
    pub exact_unsafe_tokens: Option<usize>,
    pub exact_safety_comments: Option<usize>,
    pub require_mmap_options: bool,
    pub forbid_map_mut: bool,
    pub required_token_pairs: &'a [[&'a str; 2]],
}

#[derive(Clone, Copy, Debug)]
pub struct CrateQuarantine<'a> {
    pub crate_dir: &'a Path,
    pub leaves: &'a [AuditedLeaf<'a>],
    pub allowed_external_test_paths: &'a [&'a str],
}

/// Normalize a relative path to POSIX `/` separators so quarantine checks
/// behave identically on Unix and Windows checkouts.
pub fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn verify_crate_quarantine(spec: &CrateQuarantine<'_>) {
    let canonical_root = fs::canonicalize(spec.crate_dir).expect("canonicalize crate root");
    let mut expected_leaves: BTreeSet<&str> = spec.leaves.iter().map(|leaf| leaf.path).collect();
    let allowed_external: BTreeSet<PathBuf> = spec
        .allowed_external_test_paths
        .iter()
        .map(|rel| {
            let candidate = spec.crate_dir.join("tests").join(rel);
            let meta = fs::symlink_metadata(&candidate).unwrap_or_else(|err| {
                panic!(
                    "read metadata for allowed external test path {}: {err}",
                    candidate.display()
                )
            });
            assert!(
                !meta.file_type().is_symlink(),
                "allowed external test path must not be a symlink: {}",
                candidate.display()
            );
            let resolved = fs::canonicalize(&candidate).unwrap_or_else(|err| {
                panic!(
                    "canonicalize allowed external test path {}: {err}",
                    candidate.display()
                )
            });
            verify_clean_source(&resolved, &resolved.to_string_lossy());
            resolved
        })
        .collect();

    let mut directories = vec![spec.crate_dir.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory).expect("read crate directory") {
            let entry = entry.expect("read crate directory entry");
            let path = entry.path();
            let file_type = entry.file_type().expect("entry file type");
            assert!(
                !file_type.is_symlink(),
                "symlinked path is forbidden inside crate: {}",
                path.display()
            );
            if file_type.is_dir() {
                if path.file_name().is_some_and(|name| name == "target") {
                    continue;
                }
                directories.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let rel_path = path
                .strip_prefix(spec.crate_dir)
                .expect("source path under crate root");
            let rel_posix = normalize_relative_path(rel_path);
            let contents = fs::read_to_string(&path).expect("read Rust source file");
            let no_comments = strip_rust_comments(&contents, false);
            let code_only = strip_rust_comments(&contents, true);

            assert!(
                !contains_include_macro(&code_only),
                "external include!() macro is forbidden in {rel_posix}"
            );

            let in_tests = rel_posix.starts_with("tests/");
            let in_examples = rel_posix.starts_with("examples/");
            let path_attrs = extract_path_attrs(&no_comments).unwrap_or_else(|err| {
                panic!("unsupported #[path] attribute in {rel_posix}: {err}");
            });
            if !path_attrs.is_empty() {
                assert!(
                    in_tests || in_examples,
                    "#[path] inclusion outside tests/ or examples/ in {rel_posix}"
                );
                let parent = path.parent().expect("source file parent");
                for target in path_attrs {
                    assert!(
                        !target.starts_with('/') && !target.starts_with('\\'),
                        "absolute #[path = \"{target}\"] in {rel_posix}"
                    );
                    let joined = parent.join(&target);
                    let meta = fs::symlink_metadata(&joined).unwrap_or_else(|err| {
                        panic!("missing #[path = \"{target}\"] target from {rel_posix}: {err}")
                    });
                    assert!(
                        !meta.file_type().is_symlink(),
                        "symlinked #[path = \"{target}\"] in {rel_posix}"
                    );
                    let resolved = fs::canonicalize(&joined).expect("canonicalize #[path] target");
                    if resolved.starts_with(&canonical_root) {
                        assert!(
                            !target.contains(".."),
                            "parent traversal #[path = \"{target}\"] in {rel_posix}"
                        );
                        let target_rel = resolved
                            .strip_prefix(&canonical_root)
                            .expect("resolved #[path] target under crate root");
                        let target_posix = normalize_relative_path(target_rel);
                        assert!(
                            resolved.extension().and_then(|ext| ext.to_str()) == Some("rs"),
                            "non-.rs #[path = \"{target}\"] target in {rel_posix}"
                        );
                        assert!(
                            !target_rel.components().any(|component| {
                                matches!(component, Component::Normal(part) if part == "target")
                            }),
                            "#[path = \"{target}\"] targets build directory in {rel_posix}"
                        );
                        assert!(
                            !spec.leaves.iter().any(|leaf| leaf.path == target_posix),
                            "#[path = \"{target}\"] targets audited unsafe leaf in {rel_posix}"
                        );
                        verify_clean_source(&resolved, &target_posix);
                    } else {
                        assert!(
                            in_tests && allowed_external.contains(&resolved),
                            "#[path = \"{target}\"] escapes crate root in {rel_posix}"
                        );
                    }
                }
            }

            if let Some(leaf) = spec.leaves.iter().find(|leaf| leaf.path == rel_posix) {
                expected_leaves.remove(leaf.path);
                verify_audited_leaf(&rel_posix, &contents, &code_only, leaf);
            } else {
                verify_safe_tokens(&rel_posix, &code_only);
            }
        }
    }

    assert!(
        expected_leaves.is_empty(),
        "audited unsafe leaves missing from crate {}: {expected_leaves:?}",
        spec.crate_dir.display()
    );
}

fn verify_clean_source(path: &Path, label: &str) {
    let contents = fs::read_to_string(path).expect("read external test support source");
    let no_comments = strip_rust_comments(&contents, false);
    let code_only = strip_rust_comments(&contents, true);
    assert!(
        !contains_include_macro(&code_only),
        "external include!() macro is forbidden in {label}"
    );
    let path_attrs = extract_path_attrs(&no_comments)
        .unwrap_or_else(|err| panic!("unsupported #[path] attribute in {label}: {err}"));
    assert!(
        path_attrs.is_empty(),
        "nested #[path] attribute is forbidden in {label}"
    );
    verify_safe_tokens(label, &code_only);
}

fn verify_safe_tokens(label: &str, code_only: &str) {
    let tokens: Vec<&str> = code_tokens(code_only).collect();
    assert!(
        !tokens.contains(&"unsafe"),
        "unsafe operation outside audited leaves in {label}"
    );
    // The workspace denies unsafe_code; only deny/forbid may mention the lint
    // outside audited leaves.
    assert!(
        tokens
            .iter()
            .enumerate()
            .all(|(index, token)| *token != "unsafe_code"
                || (index > 0 && matches!(tokens[index - 1], "deny" | "forbid"))),
        "unsafe_code lint override outside audited leaves in {label}"
    );
}

fn verify_audited_leaf(label: &str, raw: &str, code_only: &str, leaf: &AuditedLeaf<'_>) {
    let tokens: Vec<&str> = code_tokens(code_only).collect();
    let total_unsafe = tokens.iter().filter(|token| **token == "unsafe").count();
    assert!(
        total_unsafe >= 1,
        "audited leaf {label} has no unsafe operations; remove it from the allowlist"
    );
    if let Some(expected) = leaf.exact_unsafe_tokens {
        assert_eq!(
            total_unsafe, expected,
            "audited leaf {label} expected exactly {expected} unsafe occurrences, found {total_unsafe}"
        );
    }
    if let Some(expected) = leaf.exact_safety_comments {
        let count = raw.matches("// SAFETY:").count();
        assert_eq!(
            count, expected,
            "audited leaf {label} expected exactly {expected} // SAFETY: comments, found {count}"
        );
    }
    if leaf.require_mmap_options {
        assert!(
            tokens.contains(&"MmapOptions"),
            "audited leaf {label} must use MmapOptions"
        );
    }
    if leaf.forbid_map_mut {
        assert!(
            !tokens.contains(&"map_mut"),
            "audited leaf {label} must not call map_mut"
        );
    }
    for pair in leaf.required_token_pairs {
        assert!(
            tokens.windows(2).any(|window| window == *pair),
            "audited leaf {label} missing required token sequence {pair:?}"
        );
    }
    verify_safety_comments(label, raw, code_only);
}

fn verify_safety_comments(label: &str, raw: &str, code_only: &str) {
    let mut has_safety_comment = false;
    for (raw_line, code_line) in raw.lines().zip(code_only.lines()) {
        let trimmed = raw_line.trim();
        if let Some(rest) = trimmed.strip_prefix("// SAFETY:") {
            has_safety_comment = !rest.trim().is_empty();
            continue;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        let blocks = unsafe_block_count(code_line);
        if trimmed.starts_with("#[") && blocks == 0 {
            continue;
        }
        assert!(
            blocks == 0 || (blocks == 1 && has_safety_comment),
            "audited leaf {label} has undocumented unsafe block on line: {raw_line}"
        );
        has_safety_comment = false;
    }
}

fn is_ident_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub fn unsafe_block_count(code_line: &str) -> usize {
    let bytes = code_line.as_bytes();
    let mut count = 0;
    let mut i = 0;
    while i < bytes.len() {
        if is_ident_char(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_ident_char(bytes[i]) {
                i += 1;
            }
            if &bytes[start..i] == b"unsafe" {
                let mut j = i;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                let followed_by_fn = bytes[j..].starts_with(b"fn")
                    && (j + 2 >= bytes.len() || !is_ident_char(bytes[j + 2]));
                if !followed_by_fn {
                    count += 1;
                }
            }
        } else {
            i += 1;
        }
    }
    count
}

pub fn code_tokens(code_only: &str) -> impl Iterator<Item = &str> {
    code_only
        .split(|ch: char| ch != '_' && !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
}

/// Strip `//` line comments and nested `/* ... */` block comments while
/// respecting Rust string, raw string, byte string, C-string and char literals.
/// Preserves line counts (`\n`) so line-oriented safety checks stay aligned.
pub fn strip_rust_comments(source: &str, strip_strings: bool) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < bytes.len() {
        // Line comment `// ...`
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Nested block comment `/* ... */`
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            let mut depth = 1usize;
            i += 2;
            out.push(' ');
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    if bytes[i] == b'\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
            out.push(' ');
            continue;
        }
        // Raw string literal `r#*"..."#*`, `br#*"..."#*`, `cr#*"..."#*`
        if let Some((prefix_end, hashes)) = match_raw_string_start(bytes, i) {
            if !strip_strings {
                out.push_str(&source[i..prefix_end]);
            } else {
                out.push(' ');
            }
            i = prefix_end;
            while i < bytes.len() {
                if bytes[i] == b'"'
                    && i + 1 + hashes <= bytes.len()
                    && bytes[i + 1..i + 1 + hashes].iter().all(|&b| b == b'#')
                {
                    if !strip_strings {
                        out.push_str(&source[i..i + 1 + hashes]);
                    } else {
                        out.push(' ');
                    }
                    i += 1 + hashes;
                    break;
                }
                if bytes[i] == b'\n' {
                    out.push('\n');
                } else if !strip_strings {
                    let ch = source[i..].chars().next().expect("valid utf8");
                    out.push(ch);
                    i += ch.len_utf8();
                    continue;
                }
                i += 1;
            }
            continue;
        }
        // Regular string literal `"..."`
        if bytes[i] == b'"' {
            if !strip_strings {
                out.push('"');
            } else {
                out.push(' ');
            }
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    let ch = source[i + 1..].chars().next().expect("valid utf8");
                    if !strip_strings {
                        out.push('\\');
                        out.push(ch);
                    } else if ch == '\n' {
                        out.push('\n');
                    }
                    i += 1 + ch.len_utf8();
                    continue;
                }
                if bytes[i] == b'"' {
                    if !strip_strings {
                        out.push('"');
                    } else {
                        out.push(' ');
                    }
                    i += 1;
                    break;
                }
                if bytes[i] == b'\n' {
                    out.push('\n');
                    i += 1;
                } else {
                    let ch = source[i..].chars().next().expect("valid utf8");
                    if !strip_strings {
                        out.push(ch);
                    }
                    i += ch.len_utf8();
                }
            }
            continue;
        }
        // Char literal `'a'`, `'\''`, `'\u{...}'` (not lifetime `'a`)
        if bytes[i] == b'\''
            && let Some(end) = match_char_literal(source, i)
        {
            if !strip_strings {
                out.push_str(&source[i..end]);
            } else {
                out.push(' ');
            }
            i = end;
            continue;
        }
        let ch = source[i..].chars().next().expect("valid utf8");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn match_raw_string_start(bytes: &[u8], i: usize) -> Option<(usize, usize)> {
    let prev_is_ident = i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
    if prev_is_ident {
        return None;
    }
    let mut j = i;
    if bytes[j] == b'b' || bytes[j] == b'c' {
        j += 1;
    }
    if j >= bytes.len() || bytes[j] != b'r' {
        return None;
    }
    j += 1;
    let hash_start = j;
    while j < bytes.len() && bytes[j] == b'#' {
        j += 1;
    }
    if j < bytes.len() && bytes[j] == b'"' {
        Some((j + 1, j - hash_start))
    } else {
        None
    }
}

fn match_char_literal(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let next = start + 1;
    if next >= bytes.len() {
        return None;
    }
    if bytes[next] == b'\\' {
        let mut j = next + 1;
        if j < bytes.len() {
            j += 1;
        }
        while j < bytes.len() && bytes[j] != b'\'' && bytes[j] != b'\n' {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'\'' {
            return Some(j + 1);
        }
        return None;
    }
    let ch = source[next..].chars().next()?;
    if ch == '\'' || ch == '\n' || ch == '\r' {
        return None;
    }
    let after = next + ch.len_utf8();
    if after < bytes.len() && bytes[after] == b'\'' {
        Some(after + 1)
    } else {
        None
    }
}

pub fn contains_include_macro(code_only: &str) -> bool {
    let bytes = code_only.as_bytes();
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

fn skip_literal(source: &str, i: usize) -> Result<Option<usize>, String> {
    let bytes = source.as_bytes();
    if let Some((prefix_end, hashes)) = match_raw_string_start(bytes, i) {
        let mut j = prefix_end;
        while j < bytes.len() {
            if bytes[j] == b'"'
                && j + 1 + hashes <= bytes.len()
                && bytes[j + 1..j + 1 + hashes].iter().all(|&b| b == b'#')
            {
                return Ok(Some(j + 1 + hashes));
            }
            j += 1;
        }
        return Err("unterminated raw string literal".into());
    }
    let string_quote = if bytes[i] == b'"' {
        Some(i)
    } else if (bytes[i] == b'b' || bytes[i] == b'c')
        && (i == 0 || !is_ident_char(bytes[i - 1]))
        && i + 1 < bytes.len()
        && bytes[i + 1] == b'"'
    {
        Some(i + 1)
    } else {
        None
    };
    if let Some(quote) = string_quote {
        let mut j = quote + 1;
        while j < bytes.len() {
            if bytes[j] == b'\\' && j + 1 < bytes.len() {
                let ch = source[j + 1..].chars().next().expect("valid utf8");
                j += 1 + ch.len_utf8();
            } else if bytes[j] == b'"' {
                return Ok(Some(j + 1));
            } else {
                let ch = source[j..].chars().next().expect("valid utf8");
                j += ch.len_utf8();
            }
        }
        return Err("unterminated string literal".into());
    }
    let char_quote = if bytes[i] == b'\'' {
        Some(i)
    } else if bytes[i] == b'b'
        && (i == 0 || !is_ident_char(bytes[i - 1]))
        && i + 1 < bytes.len()
        && bytes[i + 1] == b'\''
    {
        Some(i + 1)
    } else {
        None
    };
    if let Some(quote) = char_quote
        && let Some(end) = match_char_literal(source, quote)
    {
        return Ok(Some(end));
    }
    Ok(None)
}

/// Extract all `#[path = "..."]` / `#![path = "..."]` (and `cfg_attr(..., path = "...")`)
/// targets from comment-stripped Rust source. Fails closed if a `path =` attribute
/// does not use a plain string literal.
pub fn extract_path_attrs(no_comments: &str) -> Result<Vec<String>, String> {
    let mut targets = Vec::new();
    let bytes = no_comments.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if let Some(next) = skip_literal(no_comments, i)? {
            i = next;
            continue;
        }
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
                let start = j + 1;
                let end = find_matching_bracket(no_comments, j)?;
                extract_path_assignments(&no_comments[start..end], &mut targets)?;
                i = end + 1;
                continue;
            }
        }
        let ch = no_comments[i..].chars().next().expect("valid utf8");
        i += ch.len_utf8();
    }
    Ok(targets)
}

fn find_matching_bracket(source: &str, open: usize) -> Result<usize, String> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        if let Some(next) = skip_literal(source, i)? {
            i = next;
            continue;
        }
        match bytes[i] {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(i);
                }
            }
            _ => {}
        }
        let ch = source[i..].chars().next().expect("valid utf8");
        i += ch.len_utf8();
    }
    Err("unclosed attribute bracket".into())
}

fn extract_path_assignments(attr: &str, targets: &mut Vec<String>) -> Result<(), String> {
    let bytes = attr.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"path")
            && (i == 0 || !is_ident_char(bytes[i - 1]))
            && (i + 4 >= bytes.len() || !is_ident_char(bytes[i + 4]))
        {
            let mut j = i + 4;
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
                        if bytes[j] == b'\\' {
                            return Err("escaped string in #[path] attribute".into());
                        }
                        j += 1;
                    }
                    if j >= bytes.len() {
                        return Err("unterminated string in #[path] attribute".into());
                    }
                    targets.push(attr[start..j].to_owned());
                    i = j + 1;
                    continue;
                }
                return Err("non-literal #[path = ...] value".into());
            }
        }
        if let Some(next) = skip_literal(attr, i)? {
            i = next;
            continue;
        }
        let ch = attr[i..].chars().next().expect("valid utf8");
        i += ch.len_utf8();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempCrateDir(PathBuf);

    impl TempCrateDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "notarium-quarantine-{tag}-{}-{id}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempCrateDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn comment_and_string_stripper_handles_nested_comments_raw_strings_and_lifetimes() {
        let sample = r###"
            // unsafe { ignored_line() }
            /* nested /* unsafe */ still_comment */
            fn borrow<'a>(s: &'a str) -> &'a str {
                let literal = "unsafe { include!(\"x\") }";
                let raw = r#"/* not a comment */ unsafe"#;
                let ch = '\'';
                let _ = (literal, raw, ch);
                s
            }
        "###;
        let stripped = strip_rust_comments(sample, true);
        let tokens: Vec<&str> = code_tokens(&stripped).collect();
        assert!(!tokens.contains(&"unsafe"));
        assert!(!contains_include_macro(&stripped));
        assert!(tokens.contains(&"borrow"));
    }

    #[test]
    fn detector_catches_spaced_include_and_cfg_attr_path() {
        let code = strip_rust_comments("std::include /* trick */ ! (\"evil.rs\");", true);
        assert!(contains_include_macro(&code));

        let no_comments = strip_rust_comments(
            "#[cfg_attr(all(), path = \"../outside.rs\")] mod hidden;",
            false,
        );
        assert_eq!(
            extract_path_attrs(&no_comments).unwrap(),
            vec!["../outside.rs".to_owned()]
        );

        let raw_path = strip_rust_comments("#[path = r\"../outside.rs\"] mod hidden;", false);
        assert!(extract_path_attrs(&raw_path).is_err());

        assert_eq!(
            unsafe_block_count("unsafe fn f() { unsafe { inner() } }"),
            1
        );
    }

    #[test]
    fn path_parser_resists_raw_string_and_char_literal_bypasses() {
        let raw_string_smuggle = r####"
            const A: &str = r##"#["##;
            #[path = "../../../outside.rs"]
            mod smuggled;
            const B: &str = r##"]"##;
        "####;
        let stripped = strip_rust_comments(raw_string_smuggle, false);
        assert_eq!(
            extract_path_attrs(&stripped).unwrap(),
            vec!["../../../outside.rs".to_owned()]
        );

        let raw_backslash_smuggle = r####"
            #[cfg_attr(all(), doc = r#"\"#, path = "../../../outside.rs", doc = r#"""#)]
            mod smuggled;
        "####;
        let stripped = strip_rust_comments(raw_backslash_smuggle, false);
        assert_eq!(
            extract_path_attrs(&stripped).unwrap(),
            vec!["../../../outside.rs".to_owned()]
        );

        let no_false_positive = r##"const S: &str = "#["; const C: char = '[';"##;
        let stripped = strip_rust_comments(no_false_positive, false);
        assert!(extract_path_attrs(&stripped).unwrap().is_empty());
    }

    #[test]
    fn safety_comment_check_catches_inline_attr_and_unsafe_block_with_fn() {
        assert_eq!(unsafe_block_count("unsafe { fn _() {} }"), 1);
        assert_eq!(unsafe_block_count("#[inline] unsafe { foo() }"), 1);
        assert_eq!(unsafe_block_count("unsafe fn helper() {}"), 0);

        let inline_bypass = "#[inline] unsafe { foo() }\n";
        let code_only = strip_rust_comments(inline_bypass, true);
        assert!(
            std::panic::catch_unwind(|| verify_safety_comments(
                "leaf.rs",
                inline_bypass,
                &code_only
            ))
            .is_err()
        );

        let block_with_fn = "unsafe { fn _() {} foo() }\n";
        let code_only = strip_rust_comments(block_with_fn, true);
        assert!(
            std::panic::catch_unwind(|| verify_safety_comments(
                "leaf.rs",
                block_with_fn,
                &code_only
            ))
            .is_err()
        );

        let documented_with_attr =
            "// SAFETY: verified invariant\n#[allow(clippy::all)]\nunsafe { foo() }\n";
        let code_only = strip_rust_comments(documented_with_attr, true);
        verify_safety_comments("leaf.rs", documented_with_attr, &code_only);
    }

    #[test]
    fn intra_crate_path_rejects_non_rs_and_target_files() {
        let non_rs = TempCrateDir::new("non-rs");
        fs::create_dir_all(non_rs.0.join("src")).unwrap();
        fs::create_dir_all(non_rs.0.join("tests")).unwrap();
        fs::write(non_rs.0.join("src/lib.rs"), "pub fn ok() {}\n").unwrap();
        fs::write(non_rs.0.join("tests/helper.inc"), "unsafe { bad(); }\n").unwrap();
        fs::write(
            non_rs.0.join("tests/entry.rs"),
            "#[path = \"helper.inc\"]\nmod helper;\n",
        )
        .unwrap();
        assert!(
            std::panic::catch_unwind(|| {
                verify_crate_quarantine(&CrateQuarantine {
                    crate_dir: &non_rs.0,
                    leaves: &[],
                    allowed_external_test_paths: &[],
                });
            })
            .is_err()
        );

        let target_dir = TempCrateDir::new("target-dir");
        fs::create_dir_all(target_dir.0.join("src")).unwrap();
        fs::create_dir_all(target_dir.0.join("tests/target")).unwrap();
        fs::write(target_dir.0.join("src/lib.rs"), "pub fn ok() {}\n").unwrap();
        fs::write(
            target_dir.0.join("tests/target/helper.rs"),
            "unsafe { bad(); }\n",
        )
        .unwrap();
        fs::write(
            target_dir.0.join("tests/entry.rs"),
            "#[path = \"target/helper.rs\"]\nmod helper;\n",
        )
        .unwrap();
        assert!(
            std::panic::catch_unwind(|| {
                verify_crate_quarantine(&CrateQuarantine {
                    crate_dir: &target_dir.0,
                    leaves: &[],
                    allowed_external_test_paths: &[],
                });
            })
            .is_err()
        );
    }
}
