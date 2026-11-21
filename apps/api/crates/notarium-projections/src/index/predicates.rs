use std::{borrow::Cow, cmp::Ordering};

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

/// Disjoint partition of candidates: `definite` rows satisfy the predicate
/// without hydration, while `uncertain` rows require exact validation against
/// their retained card version. Storing `uncertain` disjointly eliminates
/// full-bitmap clones on exact predicates.
pub struct FilterCandidates {
    pub definite: Bitmap,
    pub uncertain: Bitmap,
}

impl FilterCandidates {
    pub(crate) fn exact(rows: Bitmap) -> Self {
        Self {
            definite: rows,
            uncertain: Bitmap::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.definite.is_empty() && self.uncertain.is_empty()
    }

    pub fn needs_check(&self) -> Bitmap {
        self.uncertain.clone()
    }

    #[cfg(test)]
    pub fn possible(&self) -> Bitmap {
        if self.uncertain.is_empty() {
            self.definite.clone()
        } else {
            self.definite.or(&self.uncertain)
        }
    }

    pub fn into_possible(mut self) -> Bitmap {
        if !self.uncertain.is_empty() {
            self.definite.or_inplace(&self.uncertain);
        }
        self.definite
    }

    fn possible_cow(&self) -> Cow<'_, Bitmap> {
        if self.uncertain.is_empty() {
            Cow::Borrowed(&self.definite)
        } else {
            Cow::Owned(self.definite.or(&self.uncertain))
        }
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
        let mut definite = candidates.definite;
        for dense in candidates.uncertain.iter() {
            if check(self.dense(dense), predicate)? {
                definite.add(dense);
            }
        }
        Ok(definite)
    }

    pub fn tag_candidates(
        &self,
        tag: &str,
        universe: &Bitmap,
    ) -> Result<FilterCandidates, IndexError> {
        let prefix = [TAG_NAMESPACE];
        let direct_key = PostingKey::Tag(tag.to_owned()).encode();
        if !self.base.has_posting(&bucket_marker(&prefix), false) {
            return Ok(FilterCandidates::exact(
                self.ordinary_posting_in(&direct_key, universe)?,
            ));
        }
        let slot = bucket_key(&prefix, tag.as_bytes());
        let mut uncertain = self.base_posting_in(&slot, false, universe)?;
        let definite = self.l0_posting_in(&direct_key, universe);
        uncertain.andnot_inplace(&definite);
        Ok(FilterCandidates {
            definite,
            uncertain,
        })
    }

    pub fn filter_candidates(
        &self,
        predicate: &Predicate,
        universe: &Bitmap,
    ) -> Result<FilterCandidates, IndexError> {
        let posting = |key: &PostingKey| self.posting_in(key, universe);
        let exact = match predicate {
            Predicate::All(terms) => {
                let mut iter = terms.iter();
                let Some(first) = iter.next() else {
                    return Ok(FilterCandidates::exact(universe.clone()));
                };
                let mut conjunction = self.filter_candidates(first, universe)?;
                for term in iter {
                    if conjunction.is_empty() {
                        break;
                    }
                    let scope = conjunction.possible_cow();
                    let next = self.filter_candidates(term, scope.as_ref())?;
                    if conjunction.uncertain.is_empty() && next.uncertain.is_empty() {
                        conjunction.definite = next.definite;
                    } else {
                        let new_definite = conjunction.definite.and(&next.definite);
                        let mut new_uncertain = next.into_possible();
                        new_uncertain.andnot_inplace(&new_definite);
                        conjunction.definite = new_definite;
                        conjunction.uncertain = new_uncertain;
                    }
                }
                return Ok(conjunction);
            }
            Predicate::Any(terms) => {
                let mut disjunction = FilterCandidates::exact(Bitmap::new());
                for term in terms {
                    let unresolved = if disjunction.definite.is_empty() {
                        Cow::Borrowed(universe)
                    } else {
                        let u = universe.andnot(&disjunction.definite);
                        if u.is_empty() {
                            break;
                        }
                        Cow::Owned(u)
                    };
                    let next = self.filter_candidates(term, unresolved.as_ref())?;
                    disjunction.definite.or_inplace(&next.definite);
                    if !next.uncertain.is_empty() {
                        disjunction.uncertain.or_inplace(&next.uncertain);
                    }
                    if !disjunction.uncertain.is_empty() {
                        disjunction.uncertain.andnot_inplace(&disjunction.definite);
                    }
                }
                return Ok(disjunction);
            }
            Predicate::Not(term) => {
                let complement = self.filter_candidates(term, universe)?;
                let mut definite = universe.andnot(&complement.definite);
                if !complement.uncertain.is_empty() {
                    definite.andnot_inplace(&complement.uncertain);
                }
                return Ok(FilterCandidates {
                    definite,
                    uncertain: complement.uncertain,
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
                self.ordinary_posting_in(&direct_key, universe)?,
            ));
        }
        let slot = bucket_key(&prefix, &direct_key[prefix.len()..]);
        let mut uncertain = self.base_posting_in(&slot, false, universe)?;
        let definite = self.l0_posting_in(&direct_key, universe);
        uncertain.andnot_inplace(&definite);
        Ok(FilterCandidates {
            definite,
            uncertain,
        })
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
        let mut selected = self.base_posting_in(&bsi_entry(&domain, BSI_EXISTS), true, universe)?;
        match comparison {
            Comparison::Equal(value) => {
                let (_, equal, _) = self.compare_base(&domain, kind, selected, value, false)?;
                selected = equal;
            }
            Comparison::Range { lower, upper } => {
                if let Some(bound) = lower {
                    let (_, equal, mut greater) =
                        self.compare_base(&domain, kind, selected, &bound.value, true)?;
                    if bound.inclusive {
                        greater.or_inplace(&equal);
                    }
                    selected = greater;
                }
                if let Some(bound) = upper {
                    let (mut less, equal, _) =
                        self.compare_base(&domain, kind, selected, &bound.value, false)?;
                    if bound.inclusive {
                        less.or_inplace(&equal);
                    }
                    selected = less;
                }
            }
        }
        if !self.l0.all_replaced.is_empty() {
            let mut shadowed = Bitmap::new();
            let multi_layer = !self.l0.layers.is_empty();
            for layer in self.l0.iter_layers_newest_first() {
                if let Some(live) = layer.bsi_live.get(&domain) {
                    for (&dense, value) in live {
                        if universe.contains(dense)
                            && (!multi_layer || !shadowed.contains(dense))
                            && comparison.matches(value)
                        {
                            selected.add(dense);
                        }
                    }
                }
                if multi_layer {
                    shadowed.or_inplace(&layer.replaced);
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
        track_greater: bool,
    ) -> Result<(Bitmap, Bitmap, Bitmap), IndexError> {
        let key = BsiKind::key(bound).ok_or(IndexError::InvalidInput("invalid range boundary"))?;
        let mut less = Bitmap::new();
        let mut greater = Bitmap::new();
        let mut plane_key = Vec::with_capacity(domain.len() + 1);
        plane_key.extend_from_slice(domain);
        plane_key.push(0);
        for bit in (0..kind.width()).rev() {
            if equal.is_empty() {
                break;
            }
            *plane_key.last_mut().expect("plane key tag") = BSI_FIRST_PLANE + bit;
            let plane = self.base.bitmap_view(&plane_key, true)?;
            if key & (1u128 << bit) != 0 {
                if let Some(plane) = plane {
                    if !track_greater {
                        less.or_inplace(&equal.andnot(&plane));
                    }
                    equal.and_inplace(&plane);
                } else {
                    if !track_greater {
                        less.or_inplace(&equal);
                    }
                    equal.clear();
                }
            } else if let Some(plane) = plane {
                if track_greater {
                    greater.or_inplace(&equal.and(&plane));
                }
                equal.andnot_inplace(&plane);
            }
        }
        if let ScalarValue::Number(number) = bound
            && !equal.is_empty()
        {
            self.refine_numeric_boundary(
                domain,
                key,
                number,
                &mut less,
                &mut equal,
                &mut greater,
                track_greater,
            )?;
        }
        Ok((less, equal, greater))
    }

    #[allow(clippy::too_many_arguments)]
    fn refine_numeric_boundary(
        &self,
        domain: &[u8],
        key: u128,
        bound: &ExactNumber,
        less: &mut Bitmap,
        equal: &mut Bitmap,
        greater: &mut Bitmap,
        track_greater: bool,
    ) -> Result<(), IndexError> {
        let large_keys = bsi_entry(domain, BSI_LARGE_INTEGER);
        let large = self
            .base
            .bitmap_view(&large_keys, true)?
            .map_or_else(Bitmap::new, |marked| equal.and(&marked));
        equal.andnot_inplace(&large);
        let projected = ExactNumber::from_f64(number_from_key(key))
            .map_err(|_| IndexError::Untrusted("nonfinite BSI boundary bucket"))?;
        match projected.cmp(bound) {
            Ordering::Equal => {}
            Ordering::Less => {
                if !track_greater {
                    less.or_inplace(equal);
                }
                equal.clear();
            }
            Ordering::Greater => {
                if track_greater {
                    greater.or_inplace(equal);
                }
                equal.clear();
            }
        }

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
                Ordering::Less => {
                    if !track_greater {
                        less.add(index);
                    }
                }
                Ordering::Equal => equal.add(index),
                Ordering::Greater => {
                    if track_greater {
                        greater.add(index);
                    }
                }
            }
        }
        Ok(())
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
