use super::{
    analysis::{Prose, atoms, exact_phrase},
    schema::TextFields,
};
use notarium_core::{DomainError, DomainResult, error::ValidationReason};
use tantivy::{
    Term,
    query::{
        AllQuery, BooleanQuery, BoostQuery, DisjunctionMaxQuery, EmptyQuery, Occur, PhraseQuery,
        Query, TermQuery,
    },
    schema::{Field, IndexRecordOption},
    tokenizer::Token,
};

const TIE_BREAKER: f32 = 0.2;
const MAX_QUERY_BYTES: usize = 4096;
const MAX_CLAUSES: usize = 64;

pub(super) struct QueryPlan {
    clauses: Vec<Box<dyn Query>>,
    pub browse: bool,
}

impl QueryPlan {
    pub fn parse(text: &str, fields: &[TextFields], filtered: bool) -> DomainResult<Self> {
        let invalid = || DomainError::validation(ValidationReason::InvalidQuery);
        if text.len() > MAX_QUERY_BYTES {
            return Err(invalid());
        }
        if text.trim().is_empty() {
            return if filtered {
                Ok(Self {
                    clauses: Vec::new(),
                    browse: true,
                })
            } else {
                Err(invalid())
            };
        }
        let mut prose = Prose::default();
        let mut clauses = Vec::new();
        let pieces: Vec<_> = text.split('"').collect();
        for (index, piece) in pieces.iter().enumerate() {
            if index % 2 == 1 && index + 1 < pieces.len() {
                if let Some(query) = phrase(&mut prose, piece, fields) {
                    clauses.push(query);
                }
            } else {
                for token in piece.split_whitespace() {
                    if let Some(query) = free_token(&mut prose, token, fields) {
                        clauses.push(query);
                    }
                    if clauses.len() > MAX_CLAUSES {
                        return Err(invalid());
                    }
                }
            }
        }
        if clauses.len() > MAX_CLAUSES {
            return Err(invalid());
        }
        Ok(Self {
            browse: false,
            clauses,
        })
    }

    pub fn query(&self, fallback: bool) -> Box<dyn Query> {
        if self.browse {
            return Box::new(AllQuery);
        }
        if self.clauses.is_empty() {
            return Box::new(EmptyQuery);
        }
        let count = self.clauses.len();
        let required = if fallback {
            1
        } else {
            match count {
                1..=2 => 1,
                3..=4 => 2,
                _ => (count * 3).div_ceil(5),
            }
        };
        let clauses = self
            .clauses
            .iter()
            .map(|query| (Occur::Should, query.box_clone()))
            .collect();
        let mut query = BooleanQuery::new(clauses);
        query.set_minimum_number_should_match(required);
        Box::new(query)
    }

    pub fn can_fallback(&self) -> bool {
        self.clauses.len() > 2
    }
}

fn term(field: Field, token: &str) -> Box<dyn Query> {
    Box::new(TermQuery::new(
        Term::from_field_text(field, token),
        IndexRecordOption::WithFreqs,
    ))
}

fn in_order(field: Field, tokens: &[Token]) -> Option<Box<dyn Query>> {
    match tokens {
        [] => None,
        [token] => Some(term(field, &token.text)),
        _ => Some(Box::new(PhraseQuery::new_with_offset(
            tokens
                .iter()
                .map(|token| (token.position, Term::from_field_text(field, &token.text)))
                .collect(),
        ))),
    }
}

fn disjunction(clauses: Vec<Box<dyn Query>>) -> Option<Box<dyn Query>> {
    (!clauses.is_empty()).then(|| {
        Box::new(DisjunctionMaxQuery::with_tie_breaker(clauses, TIE_BREAKER)) as Box<dyn Query>
    })
}

fn boosted(query: Box<dyn Query>, weight: f32) -> Box<dyn Query> {
    Box::new(BoostQuery::new(query, weight))
}

fn phrase(prose: &mut Prose, text: &str, fields: &[TextFields]) -> Option<Box<dyn Query>> {
    let prose = prose.tokens(text);
    let exact = exact_phrase(text);
    let mut clauses = Vec::with_capacity(fields.len() * 2);
    for field in fields {
        if let Some(query) = in_order(field.prose, &prose) {
            clauses.push(boosted(query, field.prose_weight));
        }
        if let Some(query) = in_order(field.exact, &exact) {
            clauses.push(boosted(query, field.exact_weight));
        }
    }
    disjunction(clauses)
}

fn free_token(prose: &mut Prose, text: &str, fields: &[TextFields]) -> Option<Box<dyn Query>> {
    let prose = prose.tokens(text);
    let exact = exact_phrase(text);
    let atoms = atoms(text);
    if atoms.len() <= 1 {
        let mut clauses = Vec::with_capacity(fields.len() * 2);
        for field in fields {
            if let Some(query) = in_order(field.prose, &prose) {
                clauses.push(boosted(query, field.prose_weight));
            }
            if let Some(query) = in_order(field.exact, &exact) {
                clauses.push(boosted(query, field.exact_weight));
            }
        }
        return disjunction(clauses);
    }
    let mut clauses = Vec::with_capacity(fields.len() * 2);
    for field in fields {
        if let Some(query) = in_order(field.exact, &exact) {
            clauses.push(boosted(query, field.exact_weight));
        }
        let parts = atoms
            .iter()
            .map(|atom| (Occur::Must, term(field.exact, atom)))
            .collect();
        clauses.push(boosted(
            Box::new(BooleanQuery::new(parts)),
            field.prose_weight,
        ));
    }
    disjunction(clauses)
}
