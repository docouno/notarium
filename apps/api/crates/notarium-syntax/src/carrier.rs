use notarium_core::{DomainError, DomainResult, error::ValidationReason, span::ByteSpan};

#[derive(Clone, Debug)]
pub struct Carrier {
    pub bom_end: usize,
    pub header: Option<ByteSpan>,
    pub yaml: Option<ByteSpan>,
    pub body: ByteSpan,
    pub eol: &'static str,
}
impl Carrier {
    pub fn scan(source: &str) -> DomainResult<Self> {
        let bom_end = if source.starts_with('\u{feff}') { 3 } else { 0 };
        let first_end = crate::lines::with_endings(&source[bom_end..])
            .next()
            .map_or(source.len(), |line| bom_end + line.len());
        let eol = crate::lines::ending(&source[..first_end]).unwrap_or("\n");
        if source[bom_end..first_end].trim_end_matches(['\r', '\n', ' ', '\t']) != "---" {
            return Ok(Self {
                bom_end,
                header: None,
                yaml: None,
                body: ByteSpan::new(bom_end, source.len())?,
                eol,
            });
        }
        let mut state = LexState::default();
        let mut offset = first_end;
        for line in crate::lines::with_endings(&source[first_end..]) {
            let text = line.trim_end_matches(['\r', '\n']);
            if state.at_root() && matches!(text.trim_end_matches([' ', '\t']), "---" | "...") {
                let body_start = offset + line.len();
                return Ok(Self {
                    bom_end,
                    header: Some(ByteSpan::new(0, body_start)?),
                    yaml: Some(ByteSpan::new(first_end, offset)?),
                    body: ByteSpan::new(body_start, source.len())?,
                    eol,
                });
            }
            state.feed(line);
            offset += line.len();
        }
        Err(DomainError::validation(
            ValidationReason::UnterminatedFrontmatter,
        ))
    }
}

/// Shared scalar-data ownership for carrier scanning and concrete field edits.
/// The parent is the owning key/dash, not the column of a later scalar marker.
#[derive(Clone, Debug)]
pub(crate) struct BlockScalar {
    parent: usize,
    content_indent: Option<usize>,
}
impl BlockScalar {
    pub fn new(parent: usize, marker: &str) -> Self {
        Self {
            parent,
            content_indent: marker
                .bytes()
                .find(u8::is_ascii_digit)
                .map(|digit| parent + usize::from(digit - b'0')),
        }
    }
    pub fn contains_line(&mut self, line: &str) -> bool {
        if line.trim_matches([' ', '\r', '\n']).is_empty() {
            return true;
        }
        let indent = line.bytes().take_while(|b| *b == b' ').count();
        let required = self
            .content_indent
            .get_or_insert(indent.max(self.parent + 1));
        indent >= *required
    }
}

/// Byte-state tracker only. YAML semantics and validity are delegated to saphyr.
#[derive(Clone, Debug, Default)]
pub(crate) struct LexState {
    pub quote: Option<u8>,
    pub flow: usize,
    plain: bool,
    escaped: bool,
    block_scalar: Option<BlockScalar>,
    node_parent: usize,
    node_start: Option<usize>,
    plain_parent: Option<usize>,
}
impl LexState {
    pub fn at_root(&self) -> bool {
        self.quote.is_none() && self.flow == 0
    }
    pub fn feed(&mut self, text: &str) {
        // A blank line does not end a plain scalar, including one inside flow.
        if self.quote.is_none() && text.trim_matches([' ', '\t', '\r', '\n']).is_empty() {
            return;
        }
        let indent = text.bytes().take_while(|b| *b == b' ').count();
        if let Some(scalar) = &mut self.block_scalar {
            if scalar.contains_line(text) {
                return;
            }
            self.block_scalar = None;
        }
        if self.quote.is_none() && self.flow == 0 {
            // Quotes and brackets in a continued plain scalar are text. Keep
            // its owning indentation across lines, just like block scalar data.
            if self.plain_parent.is_some_and(|parent| indent > parent) {
                return;
            }
            self.plain = false;
            self.plain_parent = None;
            self.node_start = None;
        }
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if let Some(quote) = self.quote {
                if self.escaped {
                    self.escaped = false;
                } else if quote == b'"' && b == b'\\' {
                    self.escaped = true;
                } else if b == quote {
                    if quote == b'\'' && bytes.get(i + 1) == Some(&b'\'') {
                        i += 1;
                    } else {
                        self.quote = None;
                    }
                }
                i += 1;
                continue;
            }
            match b {
                b'!' | b'&' if !self.plain => {
                    // A node property may precede a block scalar. URI tag
                    // punctuation is not quote/flow syntax of the scalar itself.
                    self.node_start.get_or_insert(i);
                    while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    continue;
                }
                b'|' | b'>' if !self.plain && self.flow == 0 => {
                    let marker_end = bytes[i..]
                        .iter()
                        .position(|b| b.is_ascii_whitespace() || *b == b'#')
                        .map_or(bytes.len(), |n| i + n);
                    self.block_scalar =
                        Some(BlockScalar::new(self.node_parent, &text[i..marker_end]));
                    self.plain_parent = None;
                    return;
                }
                b'\n' | b'\r' => {
                    if self.flow == 0 {
                        self.plain = false;
                    }
                }
                b'#' if i == 0 || bytes[i - 1].is_ascii_whitespace() => {
                    while i < bytes.len() && !matches!(bytes[i], b'\r' | b'\n') {
                        i += 1;
                    }
                    continue;
                }
                b'\'' | b'"' if !self.plain => {
                    self.node_start.get_or_insert(i);
                    self.plain_parent = None;
                    self.quote = Some(b);
                }
                b'[' | b'{' if !self.plain || self.flow > 0 => {
                    self.node_start.get_or_insert(i);
                    self.plain_parent = None;
                    self.flow += 1;
                    self.plain = false;
                }
                b']' | b'}' if self.flow > 0 => {
                    self.flow = self.flow.saturating_sub(1);
                    self.plain = false;
                }
                b',' if self.flow > 0 => self.plain = false,
                b':' if !self.plain
                    || bytes.get(i + 1).is_none_or(|b| {
                        b.is_ascii_whitespace()
                            || self.flow > 0 && matches!(b, b',' | b'[' | b']' | b'{' | b'}')
                    }) =>
                {
                    if self.flow == 0 {
                        self.node_parent = self.node_start.unwrap_or(indent);
                    }
                    self.node_start = None;
                    self.plain_parent = None;
                    self.plain = false;
                }
                b' ' | b'\t' => {}
                b'-' | b'?'
                    if !self.plain && bytes.get(i + 1).is_some_and(u8::is_ascii_whitespace) =>
                {
                    self.node_parent = i;
                    self.node_start = None;
                    self.plain_parent = None;
                }
                _ => {
                    if !self.plain {
                        self.node_start.get_or_insert(i);
                        if self.flow == 0 {
                            self.plain_parent = Some(self.node_parent);
                        }
                    }
                    self.plain = true;
                }
            }
            i += 1;
        }
    }
}
