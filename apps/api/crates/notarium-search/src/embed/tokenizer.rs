use super::{
    EmbeddingError,
    preprocess::{Normalizer, PreTokenizer, Pretokenized},
    tokenizer_model::{Model, ModelInput},
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::{DomainError, DomainResult, error::ValidationReason, ids::ModelProfileId};
use notarium_syntax::chunk::TokenizerBudget;
use serde::Deserialize;
use std::{collections::HashMap, io::Read, path::Path};

const MAX_TOKENIZER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_MODEL_TOKENS: u32 = 512;

pub struct Encoding {
    pub ids: Vec<i64>,
    pub type_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct Input {
    normalizer: Option<Normalizer>,
    pre_tokenizer: Option<PreTokenizer>,
    model: ModelInput,
    post_processor: Option<PostProcessor>,
    padding: Option<Padding>,
    #[serde(default)]
    added_tokens: Vec<AddedToken>,
}

#[derive(Deserialize)]
struct Padding {
    pad_id: u32,
}

#[derive(Deserialize)]
struct AddedToken {
    id: u32,
    content: String,
    #[serde(default)]
    single_word: bool,
    #[serde(default)]
    lstrip: bool,
    #[serde(default)]
    rstrip: bool,
    #[serde(default)]
    normalized: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum PostProcessor {
    #[serde(rename = "BertProcessing")]
    Bert {
        cls: (String, u32),
        sep: (String, u32),
    },
    #[serde(rename = "RobertaProcessing")]
    Roberta {
        cls: (String, u32),
        sep: (String, u32),
    },
    #[serde(rename = "TemplateProcessing")]
    Template {
        single: Vec<TemplatePiece>,
        special_tokens: HashMap<String, SpecialToken>,
    },
}

#[derive(Deserialize)]
enum TemplatePiece {
    Sequence { id: String, type_id: u32 },
    SpecialToken { id: String, type_id: u32 },
}
#[derive(Deserialize)]
struct SpecialToken {
    ids: Vec<u32>,
}
enum Template {
    Input(u32),
    Special(Vec<u32>, u32),
}
impl PostProcessor {
    fn instructions(self) -> Result<Vec<Template>, EmbeddingError> {
        match self {
            Self::Bert { cls, sep } | Self::Roberta { cls, sep } => Ok(vec![
                Template::Special(vec![cls.1], 0),
                Template::Input(0),
                Template::Special(vec![sep.1], 0),
            ]),
            Self::Template {
                single,
                special_tokens,
            } => {
                if single
                    .iter()
                    .filter(
                        |piece| matches!(piece, TemplatePiece::Sequence { id, .. } if id == "A"),
                    )
                    .count()
                    != 1
                {
                    return Err(EmbeddingError::InvalidModel);
                }
                single
                    .into_iter()
                    .map(|piece| match piece {
                        TemplatePiece::Sequence { id, type_id } if id == "A" => {
                            Ok(Template::Input(type_id))
                        }
                        TemplatePiece::SpecialToken { id, type_id } => {
                            let token = special_tokens
                                .get(&id)
                                .ok_or(EmbeddingError::InvalidModel)?;
                            if token.ids.is_empty() {
                                return Err(EmbeddingError::InvalidModel);
                            }
                            Ok(Template::Special(token.ids.clone(), type_id))
                        }
                        TemplatePiece::Sequence { .. } => Err(EmbeddingError::InvalidModel),
                    })
                    .collect()
            }
        }
    }
}

pub struct LocalTokenizerBudget {
    profile: ModelProfileId,
    max_tokens: u32,
    pad_id: u32,
    model: Model,
    normalizer: Option<Normalizer>,
    pre_tokenizer: Option<PreTokenizer>,
    template: Vec<Template>,
    added_tokens: [HashMap<char, Vec<AddedToken>>; 2],
}

impl LocalTokenizerBudget {
    pub fn open(
        path: &Path,
        profile: ModelProfileId,
        max_tokens: u32,
    ) -> Result<Self, EmbeddingError> {
        let parent = path.parent().ok_or(EmbeddingError::InvalidModel)?;
        let name = Path::new(path.file_name().ok_or(EmbeddingError::InvalidModel)?);
        let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
        Self::open_in(&dir, name, profile, max_tokens)
    }

    pub(super) fn open_in(
        dir: &Dir,
        name: &Path,
        profile: ModelProfileId,
        max_tokens: u32,
    ) -> Result<Self, EmbeddingError> {
        let meta = dir.symlink_metadata(name)?;
        if !meta.is_file() || meta.len() > MAX_TOKENIZER_BYTES {
            return Err(EmbeddingError::InvalidModel);
        }
        let file = dir.open_with(
            name,
            OpenOptions::new().read(true).follow(FollowSymlinks::No),
        )?;
        let mut json = Vec::new();
        file.take(MAX_TOKENIZER_BYTES + 1).read_to_end(&mut json)?;
        Self::from_json(&json, profile, max_tokens)
    }

    pub fn from_json(
        json: &[u8],
        profile: ModelProfileId,
        max_tokens: u32,
    ) -> Result<Self, EmbeddingError> {
        if max_tokens == 0 || json.len() as u64 > MAX_TOKENIZER_BYTES {
            return Err(EmbeddingError::InvalidModel);
        }
        let input: Input =
            serde_json::from_slice(json).map_err(|_| EmbeddingError::InvalidModel)?;
        let model = Model::load(input.model)?;
        let mut added_tokens = input.added_tokens;
        if added_tokens.len() > 4096 || added_tokens.iter().any(|token| token.content.is_empty()) {
            return Err(EmbeddingError::InvalidModel);
        }
        let pad_id = input
            .padding
            .map(|padding| padding.pad_id)
            .or_else(|| {
                ["[PAD]", "<pad>"].into_iter().find_map(|token| {
                    model.id(token).or_else(|| {
                        added_tokens
                            .iter()
                            .find(|added| added.content == token)
                            .map(|added| added.id)
                    })
                })
            })
            .unwrap_or(0);
        let template = match input.post_processor {
            Some(processor) => processor.instructions()?,
            None => vec![Template::Input(0)],
        };
        let wrapper: usize = template
            .iter()
            .filter_map(|piece| {
                if let Template::Special(ids, _) = piece {
                    Some(ids.len())
                } else {
                    None
                }
            })
            .sum();
        let max_tokens = max_tokens.min(MAX_MODEL_TOKENS);
        if wrapper >= max_tokens as usize {
            return Err(EmbeddingError::InvalidModel);
        }
        if let Some(normalizer) = &input.normalizer {
            for token in added_tokens.iter_mut().filter(|token| token.normalized) {
                token.content = normalizer.apply(std::mem::take(&mut token.content))?;
            }
        }
        added_tokens.sort_by_key(|token| std::cmp::Reverse(token.content.len()));
        let mut buckets: [HashMap<_, Vec<_>>; 2] = Default::default();
        for token in added_tokens {
            let Some(first) = token.content.chars().next() else {
                continue;
            };
            buckets[usize::from(token.normalized)]
                .entry(first)
                .or_default()
                .push(token);
        }
        Ok(Self {
            profile,
            max_tokens,
            pad_id,
            model,
            normalizer: input.normalizer,
            pre_tokenizer: input.pre_tokenizer,
            template,
            added_tokens: buckets,
        })
    }

    pub fn pad_id(&self) -> i64 {
        i64::from(self.pad_id)
    }

    pub fn encode(&self, text: &str) -> Result<Encoding, EmbeddingError> {
        if text.len() > MAX_INPUT_BYTES {
            return Err(EmbeddingError::BudgetExceeded);
        }
        let mut ids = Vec::new();
        for piece in split_added(text, &self.added_tokens[0]) {
            match piece {
                Piece::Token(id) => ids.push(id),
                Piece::Text(raw, raw_starts_input) => {
                    let normalized = match &self.normalizer {
                        Some(normalizer) => normalizer.apply(raw.to_owned())?,
                        None => raw.to_owned(),
                    };
                    for piece in split_added(&normalized, &self.added_tokens[1]) {
                        match piece {
                            Piece::Token(id) => ids.push(id),
                            Piece::Text(text, starts_input) => {
                                if let Some(tokenizer) = &self.pre_tokenizer {
                                    for part in tokenizer.split(vec![Pretokenized {
                                        text: text.to_owned(),
                                        starts_input: raw_starts_input && starts_input,
                                    }]) {
                                        self.model.encode(&part.text, &mut ids)?;
                                    }
                                } else {
                                    self.model.encode(text, &mut ids)?;
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut encoding = Encoding {
            ids: Vec::new(),
            type_ids: Vec::new(),
        };
        for piece in &self.template {
            let (ids, type_id) = match piece {
                Template::Input(type_id) => (ids.as_slice(), *type_id),
                Template::Special(ids, type_id) => (ids.as_slice(), *type_id),
            };
            encoding.ids.extend(ids.iter().map(|&id| i64::from(id)));
            encoding
                .type_ids
                .extend(std::iter::repeat_n(i64::from(type_id), ids.len()));
        }
        Ok(encoding)
    }
}

enum Piece<'a> {
    Text(&'a str, bool),
    Token(u32),
}

fn split_added<'a>(text: &'a str, tokens: &HashMap<char, Vec<AddedToken>>) -> Vec<Piece<'a>> {
    if tokens.is_empty() {
        return vec![Piece::Text(text, true)];
    }
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    while offset < text.len() {
        let first = text[offset..].chars().next().expect("character boundary");
        let Some(token) = tokens.get(&first).into_iter().flatten().find(|token| {
            text[offset..].starts_with(&token.content)
                && (!token.single_word
                    || at_word_boundary(text, offset, offset + token.content.len()))
        }) else {
            offset += first.len_utf8();
            continue;
        };
        let prefix = &text[start..offset];
        let prefix = if token.lstrip {
            prefix.trim_end_matches(char::is_whitespace)
        } else {
            prefix
        };
        if !prefix.is_empty() {
            pieces.push(Piece::Text(prefix, start == 0));
        }
        pieces.push(Piece::Token(token.id));
        offset += token.content.len();
        if token.rstrip {
            let rest = &text[offset..];
            offset += rest.len() - rest.trim_start_matches(char::is_whitespace).len();
        }
        start = offset;
    }
    if start < text.len() {
        pieces.push(Piece::Text(&text[start..], start == 0));
    }
    pieces
}

fn at_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let alphanumeric = |c: char| c.is_alphanumeric() || c == '_';
    !text[..start].chars().next_back().is_some_and(alphanumeric)
        && !text[end..].chars().next().is_some_and(alphanumeric)
}

impl TokenizerBudget for LocalTokenizerBudget {
    fn profile(&self) -> ModelProfileId {
        self.profile.clone()
    }
    fn max_tokens(&self) -> u32 {
        self.max_tokens
    }
    fn count(&self, input: &str) -> DomainResult<u32> {
        let count = self.encode(input).map_err(|_| token_error())?.ids.len();
        u32::try_from(count.max(usize::from(!input.is_empty()))).map_err(|_| token_error())
    }
    fn split_hint(&self, text: &str, budget: u32) -> Option<usize> {
        split_hint(self, text, budget)
    }
}

fn token_error() -> DomainError {
    DomainError::validation(ValidationReason::TokenBudgetExceeded)
}

pub struct RemoteConservativeTokenizerBudget {
    profile: ModelProfileId,
    max_tokens: u32,
}

impl RemoteConservativeTokenizerBudget {
    pub fn new(profile: ModelProfileId, max_tokens: u32) -> Self {
        Self {
            profile,
            max_tokens: max_tokens.min(MAX_MODEL_TOKENS),
        }
    }

    pub fn lexical_fallback() -> Self {
        const LEXICAL_PROFILE: [u8; 16] = *b"lexical-only-v1\0";
        Self::new(
            ModelProfileId::from_bytes(LEXICAL_PROFILE),
            MAX_MODEL_TOKENS,
        )
    }
}

impl TokenizerBudget for RemoteConservativeTokenizerBudget {
    fn profile(&self) -> ModelProfileId {
        self.profile.clone()
    }
    fn max_tokens(&self) -> u32 {
        self.max_tokens
    }
    fn count(&self, input: &str) -> DomainResult<u32> {
        let twelfths = input
            .chars()
            .map(|c| match c.len_utf8() {
                1 => 4u64,
                2 => 6,
                _ => 12,
            })
            .sum::<u64>();
        u32::try_from(twelfths.div_ceil(12) + 8).map_err(|_| token_error())
    }
    fn split_hint(&self, text: &str, budget: u32) -> Option<usize> {
        let max_units = u64::from(budget.checked_sub(8)?) * 12;
        let mut units = 0;
        let mut end = 0;
        for (offset, c) in text.char_indices() {
            units += match c.len_utf8() {
                1 => 4,
                2 => 6,
                _ => 12,
            };
            if units > max_units {
                break;
            }
            end = offset + c.len_utf8();
        }
        (end != 0).then_some(end)
    }
}

fn split_hint(tokenizer: &impl TokenizerBudget, text: &str, budget: u32) -> Option<usize> {
    if text.is_empty() || budget == 0 {
        return None;
    }
    let full = tokenizer.count(text).ok()?;
    if full <= budget {
        return Some(text.len());
    }
    let mut lower = 0;
    let mut upper = text.len();
    let guess = text.len().saturating_mul(budget as usize) / full as usize;
    for probe in 0..8 {
        let mut bound = if probe == 0 {
            guess
        } else {
            lower + (upper - lower) / 2
        };
        while !text.is_char_boundary(bound) {
            bound -= 1;
        }
        if bound <= lower || bound >= upper {
            break;
        }
        if tokenizer.count(&text[..bound]).ok()? <= budget {
            lower = bound;
        } else {
            upper = bound;
        }
    }
    if lower == 0 {
        let first = text.chars().next()?.len_utf8();
        return (tokenizer.count(&text[..first]).ok()? <= budget).then_some(first);
    }
    Some(lower)
}
