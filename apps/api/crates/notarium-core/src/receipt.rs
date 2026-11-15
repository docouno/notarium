//! Exact mutation receipts and wait-only watermarks have different semantics.
use crate::{DomainError, DomainResult, error::ValidationReason, ids::*, model::*};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(
    try_from = "(HistoryScope, SpaceSeq)",
    into = "(HistoryScope, SpaceSeq)"
)]
pub struct MutationReceiptToken {
    scope: HistoryScope,
    seq: SpaceSeq,
}
impl MutationReceiptToken {
    pub fn new(scope: HistoryScope, seq: SpaceSeq) -> DomainResult<Self> {
        if seq == SpaceSeq::ZERO {
            return Err(DomainError::validation(ValidationReason::ZeroReceipt));
        }
        Ok(Self { scope, seq })
    }
    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }
    pub fn seq(&self) -> SpaceSeq {
        self.seq
    }
}
impl TryFrom<(HistoryScope, SpaceSeq)> for MutationReceiptToken {
    type Error = DomainError;
    fn try_from((scope, seq): (HistoryScope, SpaceSeq)) -> DomainResult<Self> {
        Self::new(scope, seq)
    }
}
impl From<MutationReceiptToken> for (HistoryScope, SpaceSeq) {
    fn from(r: MutationReceiptToken) -> Self {
        (r.scope, r.seq)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ChangeCursor {
    pub scope: HistoryScope,
    pub after: SpaceSeq,
}
impl ChangeCursor {
    pub fn check(&self, current: &HistoryScope) -> DomainResult<SpaceSeq> {
        current.check(&self.scope)?;
        Ok(self.after)
    }
}
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    try_from = "Vec<MutationReceiptToken>",
    into = "Vec<MutationReceiptToken>"
)]
pub struct ReceiptSet(Vec<MutationReceiptToken>);
impl ReceiptSet {
    pub const LIMIT: usize = 8;
    pub fn new(receipts: impl IntoIterator<Item = MutationReceiptToken>) -> DomainResult<Self> {
        let mut set = BTreeSet::new();
        for receipt in receipts {
            set.insert(receipt);
            if set.len() > Self::LIMIT {
                return Err(DomainError::validation(
                    ValidationReason::ReceiptLimitExceeded,
                ));
            }
        }
        Ok(Self(set.into_iter().collect()))
    }
    pub fn tokens(&self) -> &[MutationReceiptToken] {
        &self.0
    }
    pub fn discard_caught_up(&mut self, scope: &HistoryScope, projected: SpaceSeq) {
        self.0.retain(|r| r.scope() != scope || r.seq() > projected);
    }
    pub fn for_scope(&self, scope: &HistoryScope) -> DomainResult<Vec<&MutationReceiptToken>> {
        let mut result = Vec::new();
        for receipt in &self.0 {
            if receipt.scope.space_id == scope.space_id {
                scope.check(receipt.scope())?;
                result.push(receipt);
            }
        }
        Ok(result)
    }
}
impl TryFrom<Vec<MutationReceiptToken>> for ReceiptSet {
    type Error = DomainError;
    fn try_from(v: Vec<MutationReceiptToken>) -> DomainResult<Self> {
        Self::new(v)
    }
}
impl From<ReceiptSet> for Vec<MutationReceiptToken> {
    fn from(v: ReceiptSet) -> Self {
        v.0
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AwaitWatermarks(BTreeMap<HistoryScope, SpaceSeq>);
impl AwaitWatermarks {
    pub fn from_receipts(receipts: impl IntoIterator<Item = MutationReceiptToken>) -> Self {
        let mut values = BTreeMap::new();
        for receipt in receipts {
            let seq = values.entry(receipt.scope).or_insert(SpaceSeq::ZERO);
            *seq = (*seq).max(receipt.seq);
        }
        Self(values)
    }
    pub fn scopes(&self) -> &BTreeMap<HistoryScope, SpaceSeq> {
        &self.0
    }
    pub fn required(&self, scope: &HistoryScope) -> DomainResult<SpaceSeq> {
        for history in self.0.keys().filter(|h| h.space_id == scope.space_id) {
            scope.check(history)?;
        }
        Ok(self.0.get(scope).copied().unwrap_or(SpaceSeq::ZERO))
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CausalBasis {
    Exact(ReceiptSet),
    Await(AwaitWatermarks),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcknowledgedCursor {
    pub scope: HistoryScope,
    pub seq: SpaceSeq,
}
impl AcknowledgedCursor {
    pub fn acknowledge(&mut self, delivered: &ChangeCursor) -> DomainResult<()> {
        self.scope.check(&delivered.scope)?;
        self.seq = self.seq.max(delivered.after);
        Ok(())
    }
    /// Internal restore cutover only. This never validates an old external token.
    pub fn restore(&self, new_scope: HistoryScope, ceiling: SpaceSeq) -> DomainResult<Self> {
        if self.scope.space_id != new_scope.space_id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        if self.scope.incarnation == new_scope.incarnation {
            return Err(DomainError::validation(ValidationReason::InvalidState));
        }
        Ok(Self {
            scope: new_scope,
            seq: self.seq.min(ceiling),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandIdentity {
    pub scope: HistoryScope,
    pub actor: PrincipalId,
    pub key: CommandKey,
    pub hash: ContentDigest,
}
impl CommandIdentity {
    pub fn check_retry(&self, previous: &Self, current: &HistoryScope) -> DomainResult<()> {
        current.check(&self.scope)?;
        current.check(&previous.scope)?;
        if self.actor != previous.actor || self.key != previous.key {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        if self.hash != previous.hash {
            return Err(DomainError::IdempotencyKeyReused);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountCommandIdentity {
    pub owner: PrincipalId,
    pub actor: PrincipalId,
    pub key: CommandKey,
    pub hash: ContentDigest,
    pub expected: ControlRevision,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OverlayRowVersion {
    pub note_id: NoteId,
    pub revision: RevisionId,
    pub rank_version: ContentDigest,
}
#[derive(Clone, Debug)]
pub enum MutationEffect {
    NoRelevantEffect,
    Notes {
        versions: Vec<OverlayRowVersion>,
        payload_bytes: usize,
    },
    AwaitProjection {
        reason: AwaitReason,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AwaitReason {
    Bulk,
    Structural,
    UnknownEffect,
    UnavailableVersion,
    TooManyNotes,
    PayloadBudget,
}
#[derive(Clone, Debug)]
pub struct TrustedMutationEffect {
    pub receipt: MutationReceiptToken,
    pub effect: MutationEffect,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OverlayDecision {
    Bounded {
        versions: Vec<OverlayRowVersion>,
    },
    AwaitProjection {
        watermarks: AwaitWatermarks,
        reason: AwaitReason,
    },
}

/// Requires canonical effect facts for every exact receipt. Client eligibility flags
/// are not inputs. Later versions of one note replace earlier versions once.
pub fn plan_overlay(
    scope: &HistoryScope,
    base: SpaceSeq,
    receipts: &ReceiptSet,
    effects: &[TrustedMutationEffect],
    max_payload_bytes: usize,
) -> DomainResult<OverlayDecision> {
    let relevant = receipts.for_scope(scope)?;
    let wait = |reason| OverlayDecision::AwaitProjection {
        watermarks: AwaitWatermarks::from_receipts(relevant.iter().map(|r| (*r).clone())),
        reason,
    };
    let mut rows = BTreeMap::new();
    let mut bytes = 0usize;
    for receipt in relevant.iter().filter(|r| r.seq() > base) {
        let matches: Vec<_> = effects.iter().filter(|e| e.receipt == **receipt).collect();
        if matches.len() != 1 {
            return Ok(wait(AwaitReason::UnknownEffect));
        }
        match &matches[0].effect {
            MutationEffect::NoRelevantEffect => {}
            MutationEffect::AwaitProjection { reason } => return Ok(wait(*reason)),
            MutationEffect::Notes {
                versions,
                payload_bytes,
            } => {
                bytes = bytes.saturating_add(*payload_bytes);
                if bytes > max_payload_bytes {
                    return Ok(wait(AwaitReason::PayloadBudget));
                }
                for version in versions {
                    rows.insert(version.note_id.clone(), version.clone());
                    if rows.len() > 8 {
                        return Ok(wait(AwaitReason::TooManyNotes));
                    }
                }
            }
        }
    }
    Ok(OverlayDecision::Bounded {
        versions: rows.into_values().collect(),
    })
}
