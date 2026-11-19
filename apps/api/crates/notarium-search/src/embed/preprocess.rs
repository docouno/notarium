use super::EmbeddingError;
use serde::Deserialize;
use std::sync::LazyLock;
use tantivy::tokenizer::{RegexTokenizer, TokenStream, Tokenizer};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

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
        #[serde(default)]
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
    pub fn apply(&self, text: String) -> Result<String, EmbeddingError> {
        let output = match self {
            Self::Nfc => text.nfc().collect(),
            Self::Nfd => text.nfd().collect(),
            Self::Nfkc => text.nfkc().collect(),
            Self::Nfkd => text.nfkd().collect(),
            Self::Lowercase => text.to_lowercase(),
            Self::StripAccents => text.chars().filter(|&c| !is_combining_mark(c)).collect(),
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
                    if *clean_text && c.is_whitespace() {
                        output.push(' ');
                    } else if *handle_chinese_chars && is_cjk(c) {
                        output.push(' ');
                        output.push(c);
                        output.push(' ');
                    } else {
                        output.push(c);
                    }
                }
                if accents.unwrap_or(*lowercase) {
                    output = strip_accents(&output);
                }
                if *lowercase {
                    output = output.to_lowercase();
                }
                output
            }
            Self::Prepend { prepend } => {
                if prepend.len().saturating_add(text.len()) > 8 * 1024 * 1024 {
                    return Err(EmbeddingError::BudgetExceeded);
                }
                prepend.clone() + &text
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
                        > 8 * 1024 * 1024
                {
                    return Err(EmbeddingError::BudgetExceeded);
                }
                text.replace(pattern, content)
            }
            Self::Sequence { normalizers } => normalizers
                .iter()
                .try_fold(text, |input, normalizer| normalizer.apply(input))?,
        };
        if output.len() > 8 * 1024 * 1024 {
            return Err(EmbeddingError::BudgetExceeded);
        }
        Ok(output)
    }
}

fn strip_accents(text: &str) -> String {
    text.nfd().filter(|&c| !is_combining_mark(c)).collect()
}

fn is_cjk(c: char) -> bool {
    matches!(u32::from(c), 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0x20000..=0x2a6df
        | 0x2a700..=0x2b73f | 0x2b740..=0x2b81f | 0x2b820..=0x2ceaf | 0xf900..=0xfaff | 0x2f800..=0x2fa1f)
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum PrependScheme {
    #[default]
    Always,
    First,
    Never,
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
    Metaspace {
        replacement: char,
        #[serde(default)]
        prepend_scheme: PrependScheme,
        #[serde(default = "yes")]
        split: bool,
        #[serde(default)]
        add_prefix_space: Option<bool>,
    },
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
    pub fn split(&self, parts: Vec<String>) -> Vec<String> {
        if let Self::Sequence { pretokenizers } = self {
            return pretokenizers
                .iter()
                .fold(parts, |parts, pretokenizer| pretokenizer.split(parts));
        }
        let mut output = Vec::new();
        for (index, input) in parts.into_iter().enumerate() {
            if input.is_empty() {
                continue;
            }
            match self {
                Self::WhitespaceSplit => output.extend(input.split_whitespace().map(str::to_owned)),
                Self::Whitespace => push_regex(&mut output, &input, &WORD_RUNS),
                Self::Bert => {
                    for part in input.split_whitespace() {
                        split_punctuation(&mut output, part, SplitBehavior::Isolated);
                    }
                }
                Self::Digits { individual_digits } => {
                    split_digits(&mut output, &input, *individual_digits)
                }
                Self::Punctuation { behavior } => split_punctuation(&mut output, &input, *behavior),
                Self::Metaspace {
                    replacement,
                    prepend_scheme,
                    add_prefix_space,
                    split,
                } => {
                    let prepend = add_prefix_space.unwrap_or(match prepend_scheme {
                        PrependScheme::Always => true,
                        PrependScheme::First => index == 0,
                        PrependScheme::Never => false,
                    });
                    let mut replaced = input.replace(' ', &replacement.to_string());
                    if prepend && !replaced.starts_with(*replacement) {
                        replaced.insert(0, *replacement);
                    }
                    if *split {
                        let mut start = 0;
                        for (offset, c) in replaced.char_indices() {
                            if c == *replacement && offset > start {
                                output.push(replaced[start..offset].to_owned());
                                start = offset;
                            }
                        }
                        output.push(replaced[start..].to_owned());
                    } else {
                        output.push(replaced);
                    }
                }
                Self::ByteLevel {
                    add_prefix_space,
                    use_regex,
                } => {
                    let mut input = input;
                    if *add_prefix_space && !input.starts_with(' ') {
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
        }
        output
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
