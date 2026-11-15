//! Source-preserving line boundaries shared by readers and edit builders.

pub(crate) fn ending(source: &str) -> Option<&'static str> {
    if source.ends_with("\r\n") {
        Some("\r\n")
    } else if source.ends_with('\r') {
        Some("\r")
    } else if source.ends_with('\n') {
        Some("\n")
    } else {
        None
    }
}

pub(crate) fn with_endings(source: &str) -> impl Iterator<Item = &str> {
    let mut rest = source;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let end = rest.find(['\r', '\n']).map_or(rest.len(), |i| {
            i + if rest.as_bytes()[i] == b'\r' && rest.as_bytes().get(i + 1) == Some(&b'\n') {
                2
            } else {
                1
            }
        });
        let (line, tail) = rest.split_at(end);
        rest = tail;
        Some(line)
    })
}
