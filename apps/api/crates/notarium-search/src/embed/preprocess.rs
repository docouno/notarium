use super::EmbeddingError;
use serde::Deserialize;
use std::sync::LazyLock;
use tantivy::tokenizer::{RegexTokenizer, TokenStream, Tokenizer};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub(super) const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_PIPELINE_DEPTH: usize = 16;
const MAX_PIPELINE_NODES: usize = 16;
const MAX_PREPEND_BYTES: usize = 256;

#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum Normalizer {
    #[serde(rename = "NFC")]
    Nfc,
    #[serde(rename = "NFD")]
    Nfd,
    #[serde(rename = "NFKC")]
    Nfkc,
    #[serde(rename = "NFKD")]
    Nfkd,
    Lowercase,
    StripAccents,
    #[serde(rename = "BertNormalizer")]
    Bert {
        #[serde(default = "yes")]
        clean_text: bool,
        #[serde(default = "yes")]
        handle_chinese_chars: bool,
        #[serde(default)]
        strip_accents: Option<bool>,
        #[serde(default = "yes")]
        lowercase: bool,
    },
    Prepend {
        prepend: String,
    },
    Replace {
        pattern: Literal,
        content: String,
    },
    Sequence {
        normalizers: Vec<Normalizer>,
    },
}

#[derive(Deserialize)]
pub(super) enum Literal {
    String(String),
}

pub(super) fn yes() -> bool {
    true
}

impl Normalizer {
    pub fn validate(&self) -> Result<(), EmbeddingError> {
        let mut nodes = 0usize;
        self.validate_node(1, &mut nodes)
    }

    fn validate_node(&self, depth: usize, nodes: &mut usize) -> Result<(), EmbeddingError> {
        *nodes = nodes.saturating_add(1);
        if depth > MAX_PIPELINE_DEPTH || *nodes > MAX_PIPELINE_NODES {
            return Err(EmbeddingError::InvalidModel);
        }
        match self {
            Self::Prepend { prepend } if prepend.len() > MAX_PREPEND_BYTES => {
                Err(EmbeddingError::InvalidModel)
            }
            Self::Replace {
                pattern: Literal::String(pattern),
                content,
            } if pattern.is_empty() || content.len() > MAX_INPUT_BYTES => {
                Err(EmbeddingError::InvalidModel)
            }
            Self::Sequence { normalizers } => {
                for normalizer in normalizers {
                    normalizer.validate_node(depth + 1, nodes)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub fn apply(&self, text: String, starts_input: bool) -> Result<String, EmbeddingError> {
        if text.len() > MAX_INPUT_BYTES {
            return Err(EmbeddingError::BudgetExceeded);
        }
        let output = match self {
            Self::Nfc => collect_bounded(text.nfc(), text.len())?,
            Self::Nfd => collect_bounded(text.nfd(), text.len())?,
            Self::Nfkc => collect_bounded(text.nfkc(), text.len())?,
            Self::Nfkd => collect_bounded(text.nfkd(), text.len())?,
            Self::Lowercase => {
                collect_bounded(text.chars().flat_map(char::to_lowercase), text.len())?
            }
            Self::StripAccents => strip_nonspacing_marks(&text),
            Self::Bert {
                clean_text,
                handle_chinese_chars,
                strip_accents: accents,
                lowercase,
            } => {
                let mut tokenizer = BERT_DISCARDED.clone();
                let mut discarded = tokenizer.token_stream(&text);
                let mut next =
                    (*clean_text && discarded.advance()).then(|| discarded.token().offset_from);
                let mut output = String::with_capacity(text.len());
                for (offset, c) in text.char_indices() {
                    if next == Some(offset) {
                        next = discarded.advance().then(|| discarded.token().offset_from);
                        continue;
                    }
                    if *clean_text && is_bert_whitespace(c) {
                        output.push(' ');
                    } else if *handle_chinese_chars && is_cjk(c) {
                        output.push(' ');
                        output.push(c);
                        output.push(' ');
                    } else {
                        output.push(c);
                    }
                    if output.len() > MAX_INPUT_BYTES {
                        return Err(EmbeddingError::BudgetExceeded);
                    }
                }
                if *lowercase {
                    output =
                        collect_bounded(output.chars().flat_map(char::to_lowercase), output.len())?;
                }
                if accents.unwrap_or(*lowercase) {
                    output = strip_accents_nfd(&output)?;
                }
                output
            }
            Self::Prepend { prepend } => {
                if !starts_input || text.is_empty() || prepend.is_empty() {
                    text
                } else {
                    if prepend.len().saturating_add(text.len()) > MAX_INPUT_BYTES {
                        return Err(EmbeddingError::BudgetExceeded);
                    }
                    let mut out = String::with_capacity(prepend.len() + text.len());
                    out.push_str(prepend);
                    out.push_str(&text);
                    out
                }
            }
            Self::Replace {
                pattern: Literal::String(pattern),
                content,
            } => {
                if pattern.is_empty() {
                    return Err(EmbeddingError::InvalidModel);
                }
                let extra = content.len().saturating_sub(pattern.len());
                if extra != 0
                    && text
                        .len()
                        .saturating_add(text.matches(pattern).count().saturating_mul(extra))
                        > MAX_INPUT_BYTES
                {
                    return Err(EmbeddingError::BudgetExceeded);
                }
                text.replace(pattern, content)
            }
            Self::Sequence { normalizers } => {
                normalizers.iter().try_fold(text, |input, normalizer| {
                    normalizer.apply(input, starts_input)
                })?
            }
        };
        if output.len() > MAX_INPUT_BYTES {
            return Err(EmbeddingError::BudgetExceeded);
        }
        Ok(output)
    }
}

fn strip_nonspacing_marks(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut tokenizer = NONSPACING_MARKS.clone();
    let mut marks = tokenizer.token_stream(text);
    let mut start = 0;
    while marks.advance() {
        let mark = marks.token();
        output.push_str(&text[start..mark.offset_from]);
        start = mark.offset_to;
    }
    output.push_str(&text[start..]);
    output
}

fn collect_bounded(
    chars: impl Iterator<Item = char>,
    capacity_hint: usize,
) -> Result<String, EmbeddingError> {
    let mut output = String::with_capacity(capacity_hint.min(MAX_INPUT_BYTES));
    for c in chars {
        if output.len().saturating_add(c.len_utf8()) > MAX_INPUT_BYTES {
            return Err(EmbeddingError::BudgetExceeded);
        }
        output.push(c);
    }
    Ok(output)
}

fn strip_accents_nfd(text: &str) -> Result<String, EmbeddingError> {
    let decomposed = collect_bounded(text.nfd(), text.len())?;
    Ok(strip_nonspacing_marks(&decomposed))
}

fn is_bert_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

fn is_connector_punctuation(c: char) -> bool {
    matches!(
        c,
        '_' | '\u{203F}'
            | '\u{2040}'
            | '\u{2054}'
            | '\u{FE33}'
            | '\u{FE34}'
            | '\u{FE4D}'
            | '\u{FE4E}'
            | '\u{FE4F}'
            | '\u{FF3F}'
    )
}

pub(super) fn is_word_character(c: char) -> bool {
    c.is_alphanumeric()
        || is_combining_mark(c)
        || is_connector_punctuation(c)
        || matches!(c, '\u{200C}' | '\u{200D}')
}

fn is_cjk(c: char) -> bool {
    matches!(u32::from(c), 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0x20000..=0x2a6df
        | 0x2a700..=0x2b73f | 0x2b740..=0x2b81f | 0x2b820..=0x2ceaf | 0xf900..=0xfaff | 0x2f800..=0x2fa1f)
}

#[derive(Clone, Copy, Default, Deserialize)]
pub(super) enum SplitBehavior {
    Removed,
    #[default]
    Isolated,
    MergedWithPrevious,
    MergedWithNext,
    Contiguous,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum PreTokenizer {
    #[serde(rename = "BertPreTokenizer")]
    Bert,
    Whitespace,
    WhitespaceSplit,
    ByteLevel {
        #[serde(default = "yes")]
        add_prefix_space: bool,
        #[serde(default = "yes")]
        use_regex: bool,
    },
    Digits {
        #[serde(default)]
        individual_digits: bool,
    },
    Punctuation {
        #[serde(default)]
        behavior: SplitBehavior,
    },
    Sequence {
        pretokenizers: Vec<PreTokenizer>,
    },
}

static WORD_RUNS: LazyLock<RegexTokenizer> =
    LazyLock::new(|| RegexTokenizer::new(r"\w+|[^\w\s]+").expect("static word boundary pattern"));
static NONSPACING_MARKS: LazyLock<RegexTokenizer> =
    LazyLock::new(|| RegexTokenizer::new(r"\p{Mn}+").expect("static nonspacing mark pattern"));
static BERT_DISCARDED: LazyLock<RegexTokenizer> = LazyLock::new(|| {
    RegexTokenizer::new(r"[\p{C}&&[^\t\n\r]]|\u{fffd}")
        .expect("static BERT control character pattern")
});
static PUNCTUATION: LazyLock<RegexTokenizer> = LazyLock::new(|| {
    RegexTokenizer::new(r"[\p{P}\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]")
        .expect("static punctuation pattern")
});
static BYTELEVEL_RUNS: LazyLock<RegexTokenizer> = LazyLock::new(|| {
    // The trailing whitespace look-ahead is applied in bytelevel_pieces.
    RegexTokenizer::new(r"'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+")
        .expect("static byte-level pattern")
});

impl PreTokenizer {
    pub fn validate(&self) -> Result<(), EmbeddingError> {
        let mut nodes = 0usize;
        self.validate_node(1, &mut nodes)
    }

    fn validate_node(&self, depth: usize, nodes: &mut usize) -> Result<(), EmbeddingError> {
        *nodes = nodes.saturating_add(1);
        if depth > MAX_PIPELINE_DEPTH || *nodes > MAX_PIPELINE_NODES {
            return Err(EmbeddingError::InvalidModel);
        }
        if let Self::Sequence { pretokenizers } = self {
            for pretokenizer in pretokenizers {
                pretokenizer.validate_node(depth + 1, nodes)?;
            }
        }
        Ok(())
    }

    pub fn split(&self, parts: Vec<String>) -> Result<Vec<String>, EmbeddingError> {
        if let Self::Sequence { pretokenizers } = self {
            return pretokenizers
                .iter()
                .try_fold(parts, |parts, pretokenizer| pretokenizer.split(parts));
        }
        let mut output = Vec::new();
        let mut total_bytes = 0usize;
        for mut input in parts {
            if input.is_empty() {
                continue;
            }
            if input.len() > MAX_INPUT_BYTES {
                return Err(EmbeddingError::BudgetExceeded);
            }
            let start = output.len();
            match self {
                Self::WhitespaceSplit => {
                    output.extend(input.split_whitespace().map(str::to_owned));
                }
                Self::Whitespace => push_regex(&mut output, &input, &WORD_RUNS),
                Self::Bert => {
                    for part in input.split_whitespace() {
                        split_punctuation(&mut output, part, SplitBehavior::Isolated);
                    }
                }
                Self::Digits { individual_digits } => {
                    split_digits(&mut output, &input, *individual_digits);
                }
                Self::Punctuation { behavior } => {
                    split_punctuation(&mut output, &input, *behavior);
                }
                Self::ByteLevel {
                    add_prefix_space,
                    use_regex,
                } => {
                    if *add_prefix_space && !input.starts_with(' ') {
                        if input.len().saturating_add(1) > MAX_INPUT_BYTES {
                            return Err(EmbeddingError::BudgetExceeded);
                        }
                        input.insert(0, ' ');
                    }
                    if *use_regex {
                        output.extend(
                            bytelevel_pieces(&input)
                                .into_iter()
                                .map(|piece| encode_bytes(&piece)),
                        );
                    } else {
                        output.push(encode_bytes(&input));
                    }
                }
                Self::Sequence { .. } => unreachable!("handled before splitting"),
            }
            for piece in &output[start..] {
                total_bytes = total_bytes.saturating_add(piece.len());
                if total_bytes > MAX_INPUT_BYTES {
                    return Err(EmbeddingError::BudgetExceeded);
                }
            }
        }
        Ok(output)
    }
}

fn push_regex(output: &mut Vec<String>, text: &str, regex: &RegexTokenizer) {
    let mut regex = regex.clone();
    let mut stream = regex.token_stream(text);
    while stream.advance() {
        output.push(stream.token().text.clone());
    }
}

fn split_punctuation(output: &mut Vec<String>, text: &str, behavior: SplitBehavior) {
    let mut regex = PUNCTUATION.clone();
    let mut found = regex.token_stream(text);
    let mut spans = Vec::new();
    let mut end = 0;
    while found.advance() {
        let token = found.token();
        if end < token.offset_from {
            spans.push((end..token.offset_from, false));
        }
        spans.push((token.offset_from..token.offset_to, true));
        end = token.offset_to;
    }
    if end < text.len() {
        spans.push((end..text.len(), false));
    }
    let start = output.len();
    let mut previous_punctuation = false;
    for (range, punctuation) in spans {
        let value = &text[range];
        if punctuation && matches!(behavior, SplitBehavior::Removed) {
            continue;
        }
        let attach = match behavior {
            SplitBehavior::MergedWithPrevious => punctuation && !previous_punctuation,
            SplitBehavior::MergedWithNext => !punctuation && previous_punctuation,
            SplitBehavior::Contiguous => punctuation && previous_punctuation,
            SplitBehavior::Isolated | SplitBehavior::Removed => false,
        };
        if attach && output.len() > start {
            output.last_mut().expect("split token").push_str(value);
        } else {
            output.push(value.to_owned());
        }
        previous_punctuation = punctuation;
    }
}

fn split_digits(output: &mut Vec<String>, text: &str, single: bool) {
    let mut start = 0;
    let mut digit = None;
    for (offset, c) in text.char_indices() {
        let next = c.is_numeric();
        if digit.is_some_and(|digit| digit != next || (next && single)) {
            output.push(text[start..offset].to_owned());
            start = offset;
        }
        digit = Some(next);
    }
    output.push(text[start..].to_owned());
}

fn bytelevel_pieces(mut text: &str) -> Vec<String> {
    let mut tokenizer = BYTELEVEL_RUNS.clone();
    let mut pieces = Vec::new();
    while !text.is_empty() {
        let mut stream = tokenizer.token_stream(text);
        let mut remainder = "";
        while stream.advance() {
            let token = stream.token();
            let piece = &text[token.offset_from..token.offset_to];
            if token.offset_to < text.len()
                && piece.chars().all(char::is_whitespace)
                && let Some((last, _)) = piece.char_indices().next_back()
                && last != 0
            {
                // The look-ahead leaves the final space for the next regex alternative.
                pieces.push(piece[..last].to_owned());
                remainder = &text[token.offset_from + last..];
                break;
            }
            pieces.push(piece.to_owned());
        }
        text = remainder;
    }
    pieces
}

static BYTE_ALPHABET: LazyLock<[char; 256]> = LazyLock::new(|| {
    let mut next = 256;
    std::array::from_fn(|index| {
        if matches!(index, 33..=126 | 161..=172 | 174..=255) {
            char::from(index as u8)
        } else {
            let c = char::from_u32(next).expect("byte-level alphabet");
            next += 1;
            c
        }
    })
});

fn encode_bytes(text: &str) -> String {
    text.bytes()
        .map(|byte| BYTE_ALPHABET[usize::from(byte)])
        .collect()
}
