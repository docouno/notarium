//! Position-preserving analyzers for prose and technical identifiers.

use notarium_core::{DomainResult, classes::SearchContent};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use std::collections::BTreeSet;
use tantivy::tokenizer::{
    Language, RawTokenizer, Stemmer, TextAnalyzer, Token, TokenStream, Tokenizer,
};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub const PROSE: &str = "notarium_prose_v1";
pub const EXACT: &str = "notarium_exact_v1";
pub const TOKENIZER_VERSION: u32 = 2;
const MAX_TERM_BYTES: usize = 255;
// NFC and case folding cannot shrink valid UTF-8 by more than 4x.
const MAX_RAW_TERM_BYTES: usize = MAX_TERM_BYTES * 4;
const EXACT_TRIM: [char; 4] = ['.', ':', '-', '/'];

#[derive(Clone)]
pub(super) struct Prose {
    russian: TextAnalyzer,
    english: TextAnalyzer,
}

impl Default for Prose {
    fn default() -> Self {
        let stemmer = |language| {
            TextAnalyzer::builder(RawTokenizer::default())
                .filter(Stemmer::new(language))
                .build()
        };
        Self {
            russian: stemmer(Language::Russian),
            english: stemmer(Language::English),
        }
    }
}

impl Prose {
    pub(super) fn tokens(&mut self, text: &str) -> Vec<Token> {
        let mut tokens = Vec::new();
        let mut position = 0;
        for (start, raw) in word_spans(text, |c| word(c) || c == '_') {
            let trimmed = raw.trim_matches('_');
            if !has_alnum(trimmed) || trimmed.len() > MAX_RAW_TERM_BYTES {
                continue;
            }
            let normalized = normalize(trimmed);
            if normalized.is_empty() || normalized.len() > MAX_TERM_BYTES {
                continue;
            }
            let stemmer = if normalized
                .chars()
                .all(|c| matches!(c, '\u{0400}'..='\u{052f}'))
            {
                Some(&mut self.russian)
            } else if normalized.bytes().all(|byte| byte.is_ascii_lowercase()) {
                Some(&mut self.english)
            } else {
                None
            };
            let text = match stemmer {
                Some(stemmer) => {
                    let stemmed = {
                        let mut stream = stemmer.token_stream(&normalized);
                        stream.advance().then(|| stream.token().text.clone())
                    };
                    stemmed.unwrap_or(normalized)
                }
                None => normalized,
            };
            tokens.push(make_token(start, raw.len(), position, text));
            position += 1;
        }
        tokens
    }
}

impl Tokenizer for Prose {
    type TokenStream<'a> = AnalysisStream;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> AnalysisStream {
        self.tokens(text).into()
    }
}

#[derive(Clone, Default)]
pub(super) struct Exact;

impl Tokenizer for Exact {
    type TokenStream<'a> = AnalysisStream;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> AnalysisStream {
        let mut tokens = Vec::new();
        let mut position = 0;
        for (start, raw) in exact_spans(text) {
            let span = raw.trim_matches(EXACT_TRIM);
            if !has_alnum(span) {
                continue;
            }
            let mut terms = BTreeSet::new();
            insert_bounded_term(&mut terms, span);
            for segment in span.split(['/', ':', '@']) {
                let segment = segment.trim_matches(EXACT_TRIM);
                if has_alnum(segment) {
                    insert_bounded_term(&mut terms, segment);
                }
            }
            terms.extend(atoms(span));
            if !terms.is_empty() {
                tokens.extend(
                    terms
                        .into_iter()
                        .map(|term| make_token(start, raw.len(), position, term)),
                );
                position += 1;
            }
        }
        tokens.into()
    }
}

pub(super) struct AnalysisStream {
    pending: std::vec::IntoIter<Token>,
    current: Token,
}
impl From<Vec<Token>> for AnalysisStream {
    fn from(tokens: Vec<Token>) -> Self {
        Self {
            pending: tokens.into_iter(),
            current: Token::default(),
        }
    }
}
impl TokenStream for AnalysisStream {
    fn advance(&mut self) -> bool {
        let Some(token) = self.pending.next() else {
            return false;
        };
        self.current = token;
        true
    }
    fn token(&self) -> &Token {
        &self.current
    }
    fn token_mut(&mut self) -> &mut Token {
        &mut self.current
    }
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || is_combining_mark(c)
}

fn has_alnum(value: &str) -> bool {
    value.chars().any(char::is_alphanumeric)
}

fn insert_bounded_term(terms: &mut BTreeSet<String>, raw: &str) {
    if raw.len() > MAX_RAW_TERM_BYTES {
        return;
    }
    let normalized = normalize(raw);
    if !normalized.is_empty() && normalized.len() <= MAX_TERM_BYTES {
        terms.insert(normalized);
    }
}

pub(super) fn normalize(value: &str) -> String {
    value
        .nfc()
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ё' { 'е' } else { c })
        .nfc()
        .collect()
}

fn make_token(start: usize, length: usize, position: usize, text: String) -> Token {
    Token {
        offset_from: start,
        offset_to: start + length,
        position,
        text,
        position_length: 1,
    }
}

fn word_spans(text: &str, allowed: impl Fn(char) -> bool) -> Vec<(usize, &str)> {
    let mut start = None;
    let mut spans = Vec::new();
    for (offset, c) in text.char_indices() {
        if allowed(c) {
            start.get_or_insert(offset);
        } else if let Some(begin) = start.take() {
            spans.push((begin, &text[begin..offset]));
        }
    }
    if let Some(begin) = start {
        spans.push((begin, &text[begin..]));
    }
    spans
}

fn exact_spans(text: &str) -> Vec<(usize, &str)> {
    word_spans(text, |c| word(c) || "_-/.@#:".contains(c))
}

pub(super) fn exact_phrase(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut position = 0;
    for (start, raw) in exact_spans(text) {
        let span = raw.trim_matches(EXACT_TRIM);
        if !has_alnum(span) {
            continue;
        }
        let mut emitted = false;
        if span.len() <= MAX_RAW_TERM_BYTES {
            let normalized = normalize(span);
            if !normalized.is_empty() && normalized.len() <= MAX_TERM_BYTES {
                tokens.push(make_token(start, raw.len(), position, normalized));
                emitted = true;
            }
        }
        if emitted || !atoms(span).is_empty() {
            position += 1;
        }
    }
    tokens
}

pub(super) fn atoms(text: &str) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    for (_, raw) in word_spans(text, word) {
        if !has_alnum(raw) {
            continue;
        }
        // Compose to NFC before splitting case/numeric boundaries so NFD and
        // NFC spellings produce identical identifier atoms.
        let word: std::borrow::Cow<'_, str> = if raw.is_ascii() {
            std::borrow::Cow::Borrowed(raw)
        } else {
            std::borrow::Cow::Owned(raw.nfc().collect())
        };
        let mut start = 0;
        let mut previous: Option<char> = None;
        for (offset, current) in word.char_indices() {
            if is_combining_mark(current) {
                continue;
            }
            if let Some(prev) = previous {
                let next_base = word[offset + current.len_utf8()..]
                    .chars()
                    .find(|&c| !is_combining_mark(c));
                let case_boundary = current.is_uppercase()
                    && (prev.is_lowercase()
                        || (prev.is_uppercase() && next_base.is_some_and(char::is_lowercase)));
                let numeric_boundary = prev.is_numeric() != current.is_numeric();
                if case_boundary || numeric_boundary {
                    insert_bounded_term(&mut result, &word[start..offset]);
                    start = offset;
                }
            }
            previous = Some(current);
        }
        insert_bounded_term(&mut result, &word[start..]);
    }
    result
}

/// Rank canonical chunks using the same prose stems, identifier aliases and
/// phrase positions as the document index. Equal evidence keeps source order.
pub(crate) struct ChunkRelevance {
    prose: Prose,
    prose_terms: BTreeSet<String>,
    exact_terms: BTreeSet<String>,
    phrases: Vec<(Vec<Token>, Vec<Token>)>,
}

fn exact_tokens(text: &str) -> Vec<Token> {
    Exact.token_stream(text).pending.collect()
}

impl ChunkRelevance {
    pub(crate) fn new(text: &str) -> Self {
        let mut prose = Prose::default();
        let prose_terms = prose
            .tokens(text)
            .into_iter()
            .map(|token| token.text)
            .collect();
        let exact_terms = exact_tokens(text)
            .into_iter()
            .map(|token| token.text)
            .collect();
        let pieces: Vec<_> = text.split('"').collect();
        let phrases = pieces
            .windows(2)
            .skip(1)
            .step_by(2)
            .map(|piece| (prose.tokens(piece[0]), exact_phrase(piece[0])))
            .filter(|(prose, exact)| prose.len() > 1 || exact.len() > 1)
            .collect();
        Self {
            prose,
            prose_terms,
            exact_terms,
            phrases,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.prose_terms.is_empty() && self.exact_terms.is_empty()
    }

    pub(crate) fn score(&mut self, text: &str) -> (usize, usize, usize) {
        let prose = self.prose.tokens(text);
        let exact = exact_tokens(text);
        let phrases = self
            .phrases
            .iter()
            .filter(|(p, e)| phrase_matches(p, &prose) || phrase_matches(e, &exact))
            .count();
        let mut distinct = BTreeSet::new();
        let mut matches = 0;
        for (tokens, terms) in [(&prose, &self.prose_terms), (&exact, &self.exact_terms)] {
            for token in tokens {
                if terms.contains(&token.text) {
                    distinct.insert(token.text.as_str());
                    matches += 1;
                }
            }
        }
        (phrases, distinct.len(), matches)
    }
}

fn phrase_matches(phrase: &[Token], tokens: &[Token]) -> bool {
    let Some(first) = phrase.first() else {
        return false;
    };
    tokens
        .iter()
        .filter(|token| token.text == first.text)
        .any(|start| {
            phrase.iter().skip(1).all(|expected| {
                let position = start.position + (expected.position - first.position);
                let offset = tokens.partition_point(|token| token.position < position);
                tokens[offset..]
                    .iter()
                    .take_while(|token| token.position == position)
                    .any(|token| token.text == expected.text)
            })
        })
}

pub fn extract_note_body(content: &SearchContent) -> DomainResult<String> {
    let source = content.text();
    let header = notarium_syntax::frontmatter::analyze(source, content.provenance().class())?;
    let body = &source[header.carrier.body.start()..header.carrier.body.end()];
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut output = String::new();
    let mut prose = String::new();
    let mut code = false;
    let mut skip = false;
    for event in Parser::new_ext(body, options) {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                push_visible(&mut output, &mut prose);
                output.push('\n');
                skip = matches!(kind, CodeBlockKind::Fenced(info) if info.split_whitespace().next() == Some("nota"));
                code = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                skip = false;
                code = false;
                output.push('\n');
            }
            _ if skip => {}
            Event::Text(text) if code => output.push_str(&text),
            Event::Text(text) => prose.push_str(&text),
            Event::Code(text) => {
                push_visible(&mut output, &mut prose);
                output.push(' ');
                output.push_str(&text);
                output.push(' ');
            }
            Event::Start(
                Tag::Item
                | Tag::List(_)
                | Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::BlockQuote(_)
                | Tag::Table(_),
            ) => {
                if !prose.is_empty() {
                    push_visible(&mut output, &mut prose);
                    output.push('\n');
                }
            }
            Event::SoftBreak
            | Event::HardBreak
            | Event::Rule
            | Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::TableCell
                | TagEnd::TableRow,
            ) => {
                push_visible(&mut output, &mut prose);
                output.push('\n');
            }
            _ => {}
        }
    }
    push_visible(&mut output, &mut prose);
    Ok(output)
}

fn push_visible(output: &mut String, prose: &mut String) {
    let mut text = prose.as_str();
    while let Some((left, right)) = text.split_once("[[") {
        output.push_str(left);
        let Some((link, tail)) = right.split_once("]]") else {
            output.push_str("[[");
            text = right;
            break;
        };
        // Any `[[` inside `link` starts a nearer candidate before `]]`;
        // jumping straight to the last `[[` keeps total work linear.
        let (prefix, candidate) = match link.rfind("[[") {
            Some(pos) => {
                output.push_str("[[");
                (&link[..pos], &link[pos + 2..])
            }
            None => ("", link),
        };
        output.push_str(prefix);
        if candidate.contains(['\r', '\n']) {
            output.push_str("[[");
            output.push_str(candidate);
            output.push_str("]]");
        } else {
            let label = candidate
                .split_once('|')
                .map_or(candidate, |(target, label)| {
                    if label.trim().is_empty() {
                        target
                    } else {
                        label
                    }
                });
            output.push_str(label);
        }
        text = tail;
    }
    output.push_str(text);
    prose.clear();
}
