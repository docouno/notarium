use super::EmbeddingError;
use serde::Deserialize;
use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
};

fn default_unk_token() -> String {
    "[UNK]".to_owned()
}

fn default_continuing_prefix() -> String {
    "##".to_owned()
}

fn default_word_limit() -> usize {
    100
}

#[derive(Deserialize)]
#[serde(tag = "type")]
pub(super) enum ModelInput {
    WordPiece {
        vocab: HashMap<String, u32>,
        #[serde(default = "default_unk_token")]
        unk_token: String,
        #[serde(default = "default_continuing_prefix")]
        continuing_subword_prefix: String,
        #[serde(default = "default_word_limit")]
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
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Merge {
    Text(String),
    Pair([String; 2]),
}

pub(super) enum Model {
    WordPiece(WordPiece),
    Bpe(Box<Bpe>),
}

pub(super) struct WordPiece {
    vocab: HashMap<String, u32>,
    unknown: u32,
    prefix: String,
    word_limit: usize,
}

pub(super) struct Bpe {
    vocab: HashMap<String, u32>,
    /// Flat merge rank table keyed by `(left_id, right_id) -> (rank, merged_id)`.
    merges: HashMap<(u32, u32), (u32, u32)>,
    unknown: Option<u32>,
    byte_tokens: Option<[Option<u32>; 256]>,
    prefix: String,
    suffix: String,
    fuse_unk: bool,
    ignore_merges: bool,
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
                let unknown = match unk_token {
                    Some(token) => Some(*vocab.get(&token).ok_or(EmbeddingError::InvalidModel)?),
                    None => None,
                };
                let prefix = continuing_subword_prefix.unwrap_or_default();
                let suffix = end_of_word_suffix.unwrap_or_default();
                let mut rank_table = HashMap::with_capacity(merges.len());
                let mut merged_buf = String::new();
                let legacy = matches!(merges.first(), Some(Merge::Text(_)));
                for (index, merge) in merges.into_iter().enumerate() {
                    let (left, right) = match &merge {
                        Merge::Pair([left, right]) if !legacy => (left.as_str(), right.as_str()),
                        Merge::Text(line) if legacy => {
                            if line.starts_with("#version") {
                                continue;
                            }
                            line.split_once(' ')
                                .filter(|(_, right)| !right.contains(' '))
                                .ok_or(EmbeddingError::InvalidModel)?
                        }
                        _ => return Err(EmbeddingError::InvalidModel),
                    };
                    let rank = u32::try_from(index).map_err(|_| EmbeddingError::InvalidModel)?;
                    let (left_id, right_id, merged_id) =
                        resolve_merge(&vocab, prefix.len(), left, right, &mut merged_buf)?;
                    rank_table.insert((left_id, right_id), (rank, merged_id));
                }
                let byte_tokens = byte_fallback.then(|| {
                    std::array::from_fn(|byte| {
                        let token = format!("<0x{byte:02X}>");
                        vocab.get(&token).copied()
                    })
                });
                Ok(Self::Bpe(Box::new(Bpe {
                    vocab,
                    merges: rank_table,
                    unknown,
                    byte_tokens,
                    prefix,
                    suffix,
                    fuse_unk,
                    ignore_merges,
                })))
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
        }
    }

    pub fn id(&self, text: &str) -> Option<u32> {
        match self {
            Self::WordPiece(model) => model.vocab.get(text),
            Self::Bpe(model) => model.vocab.get(text),
        }
        .copied()
    }
}

fn resolve_merge(
    vocab: &HashMap<String, u32>,
    prefix_len: usize,
    left: &str,
    right: &str,
    merged_buf: &mut String,
) -> Result<(u32, u32, u32), EmbeddingError> {
    if left.is_empty() || right.is_empty() {
        return Err(EmbeddingError::InvalidModel);
    }
    let left_id = *vocab.get(left).ok_or(EmbeddingError::InvalidModel)?;
    let right_id = *vocab.get(right).ok_or(EmbeddingError::InvalidModel)?;
    // HF BPE removes the configured byte width from every right-hand symbol,
    // including byte-fallback vocabulary entries such as "<0xA9>".
    let right_tail = right
        .get(prefix_len..)
        .ok_or(EmbeddingError::InvalidModel)?;
    merged_buf.clear();
    merged_buf.push_str(left);
    merged_buf.push_str(right_tail);
    let merged_id = *vocab
        .get(merged_buf.as_str())
        .ok_or(EmbeddingError::InvalidModel)?;
    Ok((left_id, right_id, merged_id))
}

impl WordPiece {
    fn encode(&self, text: &str, out: &mut Vec<u32>) {
        // Reject oversized words before allocating a character-offset vector.
        if text.len() > self.word_limit.saturating_mul(4)
            || text.chars().nth(self.word_limit).is_some()
        {
            out.push(self.unknown);
            return;
        }
        let original = out.len();
        let mut ends = Vec::with_capacity(text.len().min(self.word_limit) + 1);
        ends.extend(text.char_indices().map(|(index, _)| index));
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

#[derive(Clone, Copy)]
struct Symbol {
    id: u32,
    previous: Option<usize>,
    next: Option<usize>,
    active: bool,
}

type MergeQueue = BinaryHeap<Reverse<(u32, usize, usize)>>;

impl Bpe {
    fn encode(&self, text: &str, out: &mut Vec<u32>) -> Result<(), EmbeddingError> {
        if text.is_empty() {
            return Ok(());
        }
        if self.ignore_merges
            && let Some(&id) = self.vocab.get(text)
        {
            out.push(id);
            return Ok(());
        }
        let mut symbols = Vec::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        let mut first = true;
        let mut unknown = false;
        let mut buf = String::new();
        let flush_unknown = |symbols: &mut Vec<Symbol>, unknown: &mut bool| {
            if std::mem::take(unknown) {
                push_symbol(symbols, self.unknown.expect("pending unknown"));
            }
        };
        while let Some(c) = chars.next() {
            buf.clear();
            if !first {
                buf.push_str(&self.prefix);
            }
            first = false;
            buf.push(c);
            if chars.peek().is_none() {
                buf.push_str(&self.suffix);
            }
            if let Some(&id) = self.vocab.get(buf.as_str()) {
                flush_unknown(&mut symbols, &mut unknown);
                push_symbol(&mut symbols, id);
            } else if let Some(table) = &self.byte_tokens
                && let Some(raw) = byte_fallback_ids(table, buf.as_bytes())
            {
                // Hugging Face emits these bytes immediately. A pending unknown
                // is emitted on the next vocabulary match or at the end.
                for &byte in raw {
                    push_symbol(&mut symbols, table[usize::from(byte)].expect("byte token"));
                }
            } else if let Some(unk_id) = self.unknown {
                if unknown && !self.fuse_unk {
                    push_symbol(&mut symbols, unk_id);
                }
                unknown = true;
            } else if self.byte_tokens.is_none() {
                return Err(EmbeddingError::InvalidModel);
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
            if !symbols[left].active || !symbols[right].active || symbols[left].next != Some(right)
            {
                continue;
            }
            let Some(&(actual_rank, merged_id)) =
                self.merges.get(&(symbols[left].id, symbols[right].id))
            else {
                continue;
            };
            if actual_rank != rank {
                continue;
            }
            let following = symbols[right].next;
            symbols[left].id = merged_id;
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
        let mut current = (!symbols.is_empty()).then_some(0);
        while let Some(index) = current {
            let symbol = symbols[index];
            out.push(symbol.id);
            current = symbol.next;
        }
        Ok(())
    }

    fn queue_pair(&self, symbols: &[Symbol], left: usize, queue: &mut MergeQueue) {
        if let Some(right) = symbols[left].next
            && let Some(&(rank, _)) = self.merges.get(&(symbols[left].id, symbols[right].id))
        {
            queue.push(Reverse((rank, left, right)));
        }
    }
}

fn byte_fallback_ids<'a>(table: &[Option<u32>; 256], bytes: &'a [u8]) -> Option<&'a [u8]> {
    bytes
        .iter()
        .all(|&byte| table[usize::from(byte)].is_some())
        .then_some(bytes)
}

fn push_symbol(symbols: &mut Vec<Symbol>, id: u32) {
    let index = symbols.len();
    if let Some(last) = symbols.last_mut() {
        last.next = Some(index);
    }
    symbols.push(Symbol {
        id,
        previous: index.checked_sub(1),
        next: None,
        active: true,
    });
}
