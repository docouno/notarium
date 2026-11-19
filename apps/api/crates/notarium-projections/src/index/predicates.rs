use std::cmp::Ordering;

use croaring::Bitmap;
#[cfg(any(test, feature = "test-support"))]
use notarium_core::model::DenseNodeId;
use notarium_core::{
    query::{Bound, Predicate, ValueRange},
    value::{ExactNumber, ScalarValue},
};

use super::{
    IndexError, IndexView, PostingKey,
    builder::{BSI_EXISTS, BSI_FIRST_PLANE, BSI_LARGE_INTEGER, bsi_entry},
    model::*,
};

/// Rows in `possible - definite` require exact validation against their
/// retained card version. Boolean composition preserves this distinction,
/// including when a hashed test is negated.
pub struct FilterCandidates {
    pub definite: Bitmap,
    pub possible: Bitmap,
}

impl FilterCandidates {
    fn exact(rows: Bitmap) -> Self {
        Self {
            definite: rows.clone(),
            possible: rows,
        }
    }

    pub fn needs_check(&self) -> Bitmap {
        self.possible.andnot(&self.definite)
    }
}

impl IndexView {
    #[cfg(any(test, feature = "test-support"))]
    pub fn filter(
        &self,
        predicate: &Predicate,
        universe: &Bitmap,
        mut check: impl FnMut(DenseNodeId, &Predicate) -> Result<bool, IndexError>,
    ) -> Result<Bitmap, IndexError> {
        let candidates = self.filter_candidates(predicate, universe)?;
        let witness = candidates.needs_check();
        let mut definite = candidates.definite;
        for dense in witness.iter() {
            if check(self.dense(dense), predicate)? {
                definite.add(dense);
            }
        }
        Ok(definite)
    }

    pub fn filter_candidates(
        &self,
        predicate: &Predicate,
        universe: &Bitmap,
    ) -> Result<FilterCandidates, IndexError> {
        let posting = |key: &PostingKey| self.posting(key).map(|set| set.and(universe));
        let exact = match predicate {
            Predicate::All(terms) => {
                let mut conjunction = FilterCandidates::exact(universe.clone());
                for term in terms {
                    if conjunction.possible.is_empty() {
                        break;
                    }
                    let next = self.filter_candidates(term, &conjunction.possible)?;
                    conjunction.definite.and_inplace(&next.definite);
                    conjunction.possible = next.possible;
                }
                return Ok(conjunction);
            }
            Predicate::Any(terms) => {
                let mut disjunction = FilterCandidates::exact(Bitmap::new());
                for term in terms {
                    let unresolved = universe.andnot(&disjunction.definite);
                    if unresolved.is_empty() {
                        break;
                    }
                    let next = self.filter_candidates(term, &unresolved)?;
                    disjunction.definite.or_inplace(&next.definite);
                    disjunction.possible.or_inplace(&next.possible);
                }
                return Ok(disjunction);
            }
            Predicate::Not(term) => {
                let complement = self.filter_candidates(term, universe)?;
                return Ok(FilterCandidates {
                    definite: universe.andnot(&complement.possible),
                    possible: universe.andnot(&complement.definite),
                });
            }
            Predicate::Eq {
                key,
                value: ScalarValue::Null,
            } => posting(&PostingKey::FieldNull(key.clone()))?,
            Predicate::Eq { key, value } => {
                if let Some(kind) = BsiKind::for_scalar(value) {
                    self.bsi_filter(key, kind, universe, Comparison::Equal(value))?
                } else {
                    return self.discrete(FIELD_SCALAR, key, value, universe);
                }
            }
            Predicate::Contains {
                value: ScalarValue::Null,
                ..
            } => Bitmap::new(),
            Predicate::Contains { key, value } => {
                return self.discrete(FIELD_LIST_ELEM, key, value, universe);
            }
            Predicate::Exists { key } | Predicate::IsAbsent { key } => {
                let mut present = posting(&PostingKey::FieldOk(key.clone()))?;
                present.or_inplace(&posting(&PostingKey::FieldBad(key.clone()))?);
                if matches!(predicate, Predicate::IsAbsent { .. }) {
                    universe.andnot(&present)
                } else {
                    present
                }
            }
            Predicate::IsBad { key } => posting(&PostingKey::FieldBad(key.clone()))?,
            Predicate::NumberRange { key, range } => {
                self.bsi_range(key, BsiKind::Number, universe, range, ScalarValue::Number)?
            }
            Predicate::DateRange { key, range } => {
                self.bsi_range(key, BsiKind::Date, universe, range, ScalarValue::Date)?
            }
            Predicate::TimestampRange { key, range } => self.bsi_range(
                key,
                BsiKind::Timestamp,
                universe,
                range,
                ScalarValue::Timestamp,
            )?,
        };
        Ok(FilterCandidates::exact(exact))
    }

    fn discrete(
        &self,
        namespace: u8,
        field: &str,
        value: &ScalarValue,
        universe: &Bitmap,
    ) -> Result<FilterCandidates, IndexError> {
        let direct_key = value_key(namespace, field, value);
        let prefix = field_prefix(namespace, field);
        if !self.base.has_posting(&bucket_marker(&prefix), false) {
            return Ok(FilterCandidates::exact(
                self.ordinary_posting(&direct_key)?.and(universe),
            ));
        }
        let slot = bucket_key(&prefix, &direct_key[prefix.len()..]);
        let mut possible = self.base_posting(&slot, false)?.and(universe);
        let definite = self
            .l0
            .postings
            .get(&direct_key)
            .map_or_else(Bitmap::new, |live| live.and(universe));
        possible.or_inplace(&definite);
        Ok(FilterCandidates { definite, possible })
    }

    fn bsi_range<T: Clone>(
        &self,
        field: &str,
        kind: BsiKind,
        universe: &Bitmap,
        range: &ValueRange<T>,
        convert: impl Fn(T) -> ScalarValue,
    ) -> Result<Bitmap, IndexError> {
        let bound = |bound: &Bound<T>| Bound {
            value: convert(bound.value.clone()),
            inclusive: bound.inclusive,
        };
        let lower = range.lower.as_ref().map(bound);
        let upper = range.upper.as_ref().map(bound);
        self.bsi_filter(
            field,
            kind,
            universe,
            Comparison::Range {
                lower: lower.as_ref(),
                upper: upper.as_ref(),
            },
        )
    }

    fn bsi_filter(
        &self,
        field: &str,
        kind: BsiKind,
        universe: &Bitmap,
        comparison: Comparison<'_>,
    ) -> Result<Bitmap, IndexError> {
        let domain = kind.prefix(field);
        let mut selected = self
            .base_posting(&bsi_entry(&domain, BSI_EXISTS), true)?
            .and(universe);
        match comparison {
            Comparison::Equal(value) => {
                let (_, equal) = self.compare_base(&domain, kind, selected, value)?;
                selected = equal;
            }
            Comparison::Range { lower, upper } => {
                if let Some(bound) = lower {
                    let (mut less, equal) =
                        self.compare_base(&domain, kind, selected.clone(), &bound.value)?;
                    if !bound.inclusive {
                        less.or_inplace(&equal);
                    }
                    selected.andnot_inplace(&less);
                }
                if let Some(bound) = upper {
                    let (mut less, equal) =
                        self.compare_base(&domain, kind, selected, &bound.value)?;
                    if bound.inclusive {
                        less.or_inplace(&equal);
                    }
                    selected = less;
                }
            }
        }
        if let Some(live) = self.l0.bsi_live.get(&domain) {
            for (dense, value) in live {
                if universe.contains(*dense) && comparison.matches(value) {
                    selected.add(*dense);
                }
            }
        }
        Ok(selected)
    }

    fn compare_base(
        &self,
        domain: &[u8],
        kind: BsiKind,
        mut equal: Bitmap,
        bound: &ScalarValue,
    ) -> Result<(Bitmap, Bitmap), IndexError> {
        let key = BsiKind::key(bound).ok_or(IndexError::InvalidInput("invalid range boundary"))?;
        let mut less = Bitmap::new();
        for bit in (0..kind.width()).rev() {
            if equal.is_empty() {
                break;
            }
            let plane_key = bsi_entry(domain, BSI_FIRST_PLANE + bit);
            let plane = self.base.bitmap_view(&plane_key, true)?;
            if key & (1u128 << bit) != 0 {
                if let Some(plane) = plane {
                    less.or_inplace(&equal.andnot(&plane));
                    equal.and_inplace(&plane);
                } else {
                    less.or_inplace(&equal);
                    equal.clear();
                }
            } else if let Some(plane) = plane {
                equal.andnot_inplace(&plane);
            }
        }
        if let ScalarValue::Number(number) = bound
            && !equal.is_empty()
        {
            self.refine_numeric_boundary(domain, key, number, &mut less, &mut equal)?;
        }
        Ok((less, equal))
    }

    fn refine_numeric_boundary(
        &self,
        domain: &[u8],
        key: u128,
        bound: &ExactNumber,
        less: &mut Bitmap,
        equal: &mut Bitmap,
    ) -> Result<(), IndexError> {
        let large_keys = bsi_entry(domain, BSI_LARGE_INTEGER);
        let large = self
            .base
            .bitmap_view(&large_keys, true)?
            .map_or_else(Bitmap::new, |marked| equal.and(&marked));
        equal.andnot_inplace(&large);
        let projected = ExactNumber::from_f64(number_from_key(key))
            .map_err(|_| IndexError::Untrusted("nonfinite BSI boundary bucket"))?;
        push_bucket(projected.cmp(bound), less, equal);

        for index in large.iter() {
            let integer = self
                .base
                .exact_integer(domain, index)
                .ok_or(IndexError::Untrusted("missing exact integer BSI record"))?;
            let number = if integer < 0 {
                i64::try_from(integer).map(ExactNumber::from)
            } else {
                u64::try_from(integer).map(ExactNumber::from)
            }
            .map_err(|_| IndexError::Untrusted("invalid exact integer BSI record"))?;
            match number.cmp(bound) {
                Ordering::Less => less.add(index),
                Ordering::Equal => equal.add(index),
                Ordering::Greater => {}
            }
        }
        Ok(())
    }
}

fn push_bucket(order: Ordering, less: &mut Bitmap, equal: &mut Bitmap) {
    match order {
        Ordering::Equal => {}
        Ordering::Less => {
            less.or_inplace(equal);
            equal.clear();
        }
        Ordering::Greater => equal.clear(),
    }
}

#[derive(Clone, Copy)]
enum Comparison<'a> {
    Equal(&'a ScalarValue),
    Range {
        lower: Option<&'a Bound<ScalarValue>>,
        upper: Option<&'a Bound<ScalarValue>>,
    },
}

impl Comparison<'_> {
    fn matches(self, value: &ScalarValue) -> bool {
        match self {
            Self::Equal(bound) => value == bound,
            Self::Range { lower, upper } => {
                lower.is_none_or(|bound| {
                    value.compare_same_type(&bound.value).is_ok_and(|ordering| {
                        ordering == Ordering::Greater
                            || (bound.inclusive && ordering == Ordering::Equal)
                    })
                }) && upper.is_none_or(|bound| {
                    value.compare_same_type(&bound.value).is_ok_and(|ordering| {
                        ordering == Ordering::Less
                            || (bound.inclusive && ordering == Ordering::Equal)
                    })
                })
            }
        }
    }
}
