use super::EmbeddingError;
use serde::Deserialize;
use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
};

#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum ModelInput {
    WordPiece {
        vocab: HashMap<String, u32>,
        unk_token: String,
        continuing_subword_prefix: String,
        max_input_chars_per_word: usize,
    },
    #[serde(rename = "BPE")]
    Bpe {
        vocab: HashMap<String, u32>,
        merges: Vec<Merge>,
        unk_token: Option<String>,
        #[serde(default)]
        continuing_subword_prefix: Option<String>,
        #[serde(default)]
        end_of_word_suffix: Option<String>,
        #[serde(default)]
        byte_fallback: bool,
        #[serde(default)]
        fuse_unk: bool,
        #[serde(default)]
        dropout: Option<f64>,
        #[serde(default)]
        ignore_merges: bool,
    },
    Unigram {
        vocab: Vec<(String, f64)>,
        unk_id: u32,
        #[serde(default)]
        byte_fallback: bool,
    },
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Merge {
    Text(String),
    Pair([String; 2]),
}

pub(super) enum Model {
    WordPiece(WordPiece),
    Bpe(Bpe),
    Unigram(Unigram),
}

pub(super) struct WordPiece {
    vocab: HashMap<String, u32>,
    unknown: u32,
    prefix: String,
    word_limit: usize,
}

pub(super) struct Bpe {
    vocab: HashMap<String, u32>,
    ranks: HashMap<String, HashMap<String, usize>>,
    unknown: Option<String>,
    prefix: String,
    suffix: String,
    byte_fallback: bool,
    fuse_unk: bool,
    ignore_merges: bool,
}

pub(super) struct Unigram {
    vocab: HashMap<String, u32>,
    trie: Vec<TrieNode>,
    unknown: u32,
    unknown_score: f64,
    byte_fallback: bool,
}

#[derive(Default)]
struct TrieNode {
    edges: HashMap<u8, usize>,
    leaf: Option<(u32, f64)>,
}

impl Model {
    pub fn load(input: ModelInput) -> Result<Self, EmbeddingError> {
        match input {
            ModelInput::WordPiece {
                vocab,
                unk_token,
                continuing_subword_prefix,
                max_input_chars_per_word,
            } => {
                let unknown = *vocab.get(&unk_token).ok_or(EmbeddingError::InvalidModel)?;
                if max_input_chars_per_word == 0 || max_input_chars_per_word > 4096 {
                    return Err(EmbeddingError::InvalidModel);
                }
                Ok(Self::WordPiece(WordPiece {
                    vocab,
                    unknown,
                    prefix: continuing_subword_prefix,
                    word_limit: max_input_chars_per_word,
                }))
            }
            ModelInput::Bpe {
                vocab,
                merges,
                unk_token,
                continuing_subword_prefix,
                end_of_word_suffix,
                byte_fallback,
                fuse_unk,
                dropout,
                ignore_merges,
            } => {
                if dropout.is_some_and(|dropout| dropout != 0.0) || vocab.is_empty() {
                    return Err(EmbeddingError::InvalidModel);
                }
                if unk_token
                    .as_ref()
                    .is_some_and(|token| !vocab.contains_key(token))
                {
                    return Err(EmbeddingError::InvalidModel);
                }
                let mut ranks = HashMap::<String, HashMap<String, usize>>::new();
                for (index, merge) in merges.into_iter().enumerate() {
                    let [left, right] = match merge {
                        Merge::Pair(pair) => pair,
                        Merge::Text(text) => {
                            let (left, right) =
                                text.split_once(' ').ok_or(EmbeddingError::InvalidModel)?;
                            [left.to_owned(), right.to_owned()]
                        }
                    };
                    if left.is_empty()
                        || right.is_empty()
                        || ranks
                            .entry(left)
                            .or_default()
                            .insert(right, index)
                            .is_some()
                    {
                        return Err(EmbeddingError::InvalidModel);
                    }
                }
                Ok(Self::Bpe(Bpe {
                    vocab,
                    ranks,
                    unknown: unk_token,
                    prefix: continuing_subword_prefix.unwrap_or_default(),
                    suffix: end_of_word_suffix.unwrap_or_default(),
                    byte_fallback,
                    fuse_unk,
                    ignore_merges,
                }))
            }
            ModelInput::Unigram {
                vocab,
                unk_id,
                byte_fallback,
            } => {
                if unk_id as usize >= vocab.len() {
                    return Err(EmbeddingError::InvalidModel);
                }
                let mut lookup = HashMap::new();
                let mut trie = vec![TrieNode::default()];
                let mut min_score = f64::INFINITY;
                for (index, (piece, score)) in vocab.into_iter().enumerate() {
                    if piece.is_empty()
                        || !score.is_finite()
                        || lookup.insert(piece.clone(), index as u32).is_some()
                    {
                        return Err(EmbeddingError::InvalidModel);
                    }
                    min_score = min_score.min(score);
                    let mut node = 0;
                    for byte in piece.bytes() {
                        node = if let Some(&next) = trie[node].edges.get(&byte) {
                            next
                        } else {
                            let next = trie.len();
                            trie[node].edges.insert(byte, next);
                            trie.push(TrieNode::default());
                            next
                        };
                    }
                    trie[node].leaf = Some((index as u32, score));
                }
                Ok(Self::Unigram(Unigram {
                    vocab: lookup,
                    trie,
                    unknown: unk_id,
                    unknown_score: min_score - 10.0,
                    byte_fallback,
                }))
            }
        }
    }

    pub fn encode(&self, text: &str, out: &mut Vec<u32>) -> Result<(), EmbeddingError> {
        match self {
            Self::WordPiece(model) => {
                model.encode(text, out);
                Ok(())
            }
            Self::Bpe(model) => model.encode(text, out),
            Self::Unigram(model) => model.encode(text, out),
        }
    }

    pub fn id(&self, text: &str) -> Option<u32> {
        match self {
            Self::WordPiece(model) => model.vocab.get(text),
            Self::Bpe(model) => model.vocab.get(text),
            Self::Unigram(model) => model.vocab.get(text),
        }
        .copied()
    }
}

impl WordPiece {
    fn encode(&self, text: &str, out: &mut Vec<u32>) {
        let original = out.len();
        let mut ends: Vec<_> = text.char_indices().map(|(index, _)| index).collect();
        if ends.len() > self.word_limit {
            out.push(self.unknown);
            return;
        }
        ends.push(text.len());
        let mut start = 0;
        let mut word = String::new();
        while start + 1 < ends.len() {
            let mut found = None;
            for end in (start + 1..ends.len()).rev() {
                let piece = &text[ends[start]..ends[end]];
                let id = if start == 0 {
                    self.vocab.get(piece)
                } else {
                    word.clear();
                    word.push_str(&self.prefix);
                    word.push_str(piece);
                    self.vocab.get(&word)
                };
                if let Some(&id) = id {
                    found = Some((end, id));
                    break;
                }
            }
            if let Some((next, id)) = found {
                out.push(id);
                start = next;
            } else {
                out.truncate(original);
                out.push(self.unknown);
                break;
            }
        }
    }
}

struct Symbol {
    value: String,
    previous: Option<usize>,
    next: Option<usize>,
    active: bool,
}

type MergeQueue = BinaryHeap<Reverse<(usize, usize, usize)>>;

impl Bpe {
    fn encode(&self, text: &str, out: &mut Vec<u32>) -> Result<(), EmbeddingError> {
        if self.ignore_merges
            && let Some(&id) = self.vocab.get(text)
        {
            out.push(id);
            return Ok(());
        }
        let mut symbols = Vec::new();
        let mut chars = text.chars().peekable();
        let mut first = true;
        let mut unknown = false;
        let flush_unknown = |symbols: &mut Vec<Symbol>, unknown: &mut bool| {
            if std::mem::take(unknown) {
                push_symbol(
                    symbols,
                    self.unknown.as_ref().expect("pending unknown").clone(),
                );
            }
        };
        while let Some(c) = chars.next() {
            let mut value = String::new();
            if !first {
                value.push_str(&self.prefix);
            }
            first = false;
            value.push(c);
            if chars.peek().is_none() {
                value.push_str(&self.suffix);
            }
            if self.vocab.contains_key(&value) {
                flush_unknown(&mut symbols, &mut unknown);
                push_symbol(&mut symbols, value);
            } else if self.byte_fallback
                && let Some(tokens) = byte_tokens(&self.vocab, &value)
            {
                flush_unknown(&mut symbols, &mut unknown);
                for symbol in tokens {
                    push_symbol(&mut symbols, symbol);
                }
            } else if let Some(token) = &self.unknown {
                if unknown && !self.fuse_unk {
                    push_symbol(&mut symbols, token.clone());
                }
                unknown = true;
            }
        }
        flush_unknown(&mut symbols, &mut unknown);
        let mut queue = MergeQueue::new();
        for (left, symbol) in symbols.iter().enumerate() {
            if symbol.next.is_some() {
                self.queue_pair(&symbols, left, &mut queue);
            }
        }
        while let Some(Reverse((rank, left, right))) = queue.pop() {
            if !symbols[left].active
                || !symbols[right].active
                || symbols[left].next != Some(right)
                || self.rank(&symbols[left].value, &symbols[right].value) != Some(rank)
            {
                continue;
            }
            let following = symbols[right].next;
            let right_value = std::mem::take(&mut symbols[right].value);
            let right_value = right_value
                .strip_prefix(&self.prefix)
                .unwrap_or(&right_value);
            symbols[left].value.push_str(right_value);
            symbols[left].next = following;
            symbols[right].active = false;
            if let Some(next) = following {
                symbols[next].previous = Some(left);
                self.queue_pair(&symbols, left, &mut queue);
            }
            if let Some(previous) = symbols[left].previous {
                self.queue_pair(&symbols, previous, &mut queue);
            }
        }
        for symbol in symbols.into_iter().filter(|symbol| symbol.active) {
            out.push(
                *self
                    .vocab
                    .get(&symbol.value)
                    .ok_or(EmbeddingError::InvalidModel)?,
            );
        }
        Ok(())
    }

    fn rank(&self, left: &str, right: &str) -> Option<usize> {
        self.ranks.get(left)?.get(right).copied()
    }

    fn queue_pair(&self, symbols: &[Symbol], left: usize, queue: &mut MergeQueue) {
        if let Some(right) = symbols[left].next
            && let Some(rank) = self.rank(&symbols[left].value, &symbols[right].value)
        {
            queue.push(Reverse((rank, left, right)));
        }
    }
}

fn push_symbol(symbols: &mut Vec<Symbol>, value: String) {
    let index = symbols.len();
    if let Some(last) = symbols.last_mut() {
        last.next = Some(index);
    }
    symbols.push(Symbol {
        value,
        previous: index.checked_sub(1),
        next: None,
        active: true,
    });
}

#[derive(Clone, Copy)]
struct Candidate {
    score: f64,
    previous: usize,
    token: Option<u32>,
}

impl Unigram {
    fn encode(&self, text: &str, out: &mut Vec<u32>) -> Result<(), EmbeddingError> {
        if text.is_empty() {
            return Ok(());
        }
        let mut best = vec![None; text.len() + 1];
        best[0] = Some(Candidate {
            score: 0.0,
            previous: 0,
            token: None,
        });
        let bytes = text.as_bytes();
        for (start, first) in text.char_indices() {
            let Some(previous) = best[start] else {
                continue;
            };
            let mut node = 0;
            let mut single = false;
            for (offset, byte) in bytes[start..].iter().enumerate() {
                let Some(&next) = self.trie[node].edges.get(byte) else {
                    break;
                };
                node = next;
                if let Some((id, score)) = self.trie[node].leaf {
                    let end = start + offset + 1;
                    single |= end == start + first.len_utf8();
                    record(
                        &mut best[end],
                        Candidate {
                            score: previous.score + score,
                            previous: start,
                            token: Some(id),
                        },
                    );
                }
            }
            if !single {
                let end = start + first.len_utf8();
                record(
                    &mut best[end],
                    Candidate {
                        score: previous.score + self.unknown_score,
                        previous: start,
                        token: None,
                    },
                );
            }
        }
        let mut path = Vec::new();
        let mut end = text.len();
        while end != 0 {
            let step = best[end].ok_or(EmbeddingError::InvalidModel)?;
            path.push((step.previous..end, step.token));
            end = step.previous;
        }
        let mut path = path.into_iter().rev().peekable();
        while let Some((mut range, token)) = path.next() {
            if let Some(id) = token {
                out.push(id);
            } else {
                while let Some((next, None)) = path.peek() {
                    range.end = next.end;
                    path.next();
                }
                if !self.byte_fallback || !emit_bytes(&self.vocab, &text[range], out) {
                    out.push(self.unknown);
                }
            }
        }
        Ok(())
    }
}

fn record(best: &mut Option<Candidate>, next: Candidate) {
    if best.is_none_or(|value| value.score < next.score) {
        *best = Some(next);
    }
}

fn emit_bytes(vocab: &HashMap<String, u32>, text: &str, out: &mut Vec<u32>) -> bool {
    let start = out.len();
    for byte in text.bytes() {
        let token = format!("<0x{byte:02X}>");
        let Some(&id) = vocab.get(&token) else {
            out.truncate(start);
            return false;
        };
        out.push(id);
    }
    true
}

fn byte_tokens(vocab: &HashMap<String, u32>, text: &str) -> Option<Vec<String>> {
    text.bytes()
        .map(|byte| {
            let token = format!("<0x{byte:02X}>");
            vocab.contains_key(&token).then_some(token)
        })
        .collect()
}
