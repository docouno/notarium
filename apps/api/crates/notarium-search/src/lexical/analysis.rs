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
pub const TOKENIZER_VERSION: u32 = 1;
const MAX_TERM_BYTES: usize = 255;

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
        word_spans(text, |c| word(c) || c == '_')
            .into_iter()
            .enumerate()
            .filter_map(|(position, (start, raw))| {
                let normalized = normalize(raw.trim_matches('_'));
                if normalized.is_empty() || normalized.len() > MAX_TERM_BYTES {
                    return None;
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
                        let mut stream = stemmer.token_stream(&normalized);
                        if stream.advance() {
                            stream.token().text.clone()
                        } else {
                            normalized.clone()
                        }
                    }
                    None => normalized,
                };
                Some(make_token(start, raw.len(), position, text))
            })
            .collect()
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
        for (position, (start, raw)) in exact_spans(text).into_iter().enumerate() {
            let span = raw.trim_matches(['.', ':', '-', '/']);
            let mut terms = BTreeSet::new();
            terms.insert(normalize(span));
            for segment in span.split(['/', ':', '@']) {
                terms.insert(normalize(segment));
            }
            terms.extend(atoms(span));
            tokens.extend(
                terms
                    .into_iter()
                    .filter(|term| !term.is_empty() && term.len() <= MAX_TERM_BYTES)
                    .map(|term| make_token(start, raw.len(), position, term)),
            );
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

pub(super) fn normalize(value: &str) -> String {
    value
        .nfc()
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ё' { 'е' } else { c })
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
    exact_spans(text)
        .into_iter()
        .enumerate()
        .filter_map(|(position, (start, raw))| {
            let span = normalize(raw.trim_matches(['.', ':', '-', '/']));
            (!span.is_empty() && span.len() <= MAX_TERM_BYTES)
                .then(|| make_token(start, raw.len(), position, span))
        })
        .collect()
}

pub(super) fn atoms(text: &str) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    for (_, word) in word_spans(text, word) {
        let mut chars = word.char_indices().peekable();
        let mut start = 0;
        let mut previous: Option<char> = None;
        while let Some((offset, current)) = chars.next() {
            if let Some(previous) = previous {
                let case_boundary = current.is_uppercase()
                    && (previous.is_lowercase()
                        || (previous.is_uppercase()
                            && chars.peek().is_some_and(|(_, c)| c.is_lowercase())));
                let numeric_boundary =
                    previous.is_numeric() != current.is_numeric() && !is_combining_mark(current);
                if case_boundary || numeric_boundary {
                    result.insert(normalize(&word[start..offset]));
                    start = offset;
                }
            }
            previous = Some(current);
        }
        result.insert(normalize(&word[start..]));
    }
    result.retain(|word| word.len() <= MAX_TERM_BYTES);
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
            Event::SoftBreak
            | Event::HardBreak
            | Event::Rule
            | Event::End(
                TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::Item | TagEnd::TableCell,
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
        let Some((link, tail)) = right.split_once("]]") else {
            break;
        };
        output.push_str(left);
        let label = link.split_once('|').map_or(link, |(_, label)| label);
        output.push_str(label);
        text = tail;
    }
    output.push_str(text);
    prose.clear();
}
