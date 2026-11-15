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
        let first_end = source[bom_end..]
            .find('\n')
            .map_or(source.len(), |i| bom_end + i + 1);
        let eol = if source[..first_end].ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
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
        for line in source[first_end..].split_inclusive('\n') {
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

/// Byte-state tracker only. YAML semantics and validity are delegated to saphyr.
#[derive(Clone, Debug, Default)]
pub(crate) struct LexState {
    pub quote: Option<u8>,
    pub flow: usize,
    plain: bool,
    escaped: bool,
    block_indent: Option<usize>,
}
impl LexState {
    pub fn at_root(&self) -> bool {
        self.quote.is_none() && self.flow == 0
    }
    pub fn feed(&mut self, text: &str) {
        let indent = text.bytes().take_while(|b| *b == b' ').count();
        if let Some(parent) = self.block_indent {
            if text.trim().is_empty() || indent > parent {
                return;
            }
            self.block_indent = None;
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
                b'|' | b'>' if !self.plain && self.flow == 0 => {
                    self.block_indent = Some(indent);
                    self.plain = true;
                }
                b'\n' | b'\r' => self.plain = false,
                b'#' if i == 0 || bytes[i - 1].is_ascii_whitespace() => {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                b'\'' | b'"' if !self.plain => self.quote = Some(b),
                b'[' | b'{' => {
                    self.flow += 1;
                    self.plain = false;
                }
                b']' | b'}' => {
                    self.flow = self.flow.saturating_sub(1);
                    self.plain = false;
                }
                b',' if self.flow > 0 => self.plain = false,
                b':' if self.flow > 0
                    || bytes.get(i + 1).is_none_or(|b| b.is_ascii_whitespace()) =>
                {
                    self.plain = false
                }
                b' ' | b'\t' => {}
                b'-' | b'?'
                    if !self.plain && bytes.get(i + 1).is_some_and(u8::is_ascii_whitespace) => {}
                _ => self.plain = true,
            }
            i += 1;
        }
    }
}
