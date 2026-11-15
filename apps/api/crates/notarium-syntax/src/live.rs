//! Pure raw-header intent and merge rules shared by closed and live document owners.
use crate::{
    content_digest,
    frontmatter::{self, FieldEdit},
    patch,
};
use notarium_core::{
    DomainError, DomainResult,
    classes::{DocClass, authorize_field_key},
    error::ValidationReason,
    ids::*,
    patch::*,
    span::ByteSpan,
    value::YamlValue,
};
use std::collections::BTreeMap;

pub fn raw_header_plan(
    before: &str,
    after: &str,
    class: DocClass,
    identity: HeaderIdentity,
) -> DomainResult<HeaderPatchPlan> {
    let old = frontmatter::analyze(before, class)?;
    let new = frontmatter::analyze(after, class)?;
    if old.carrier.body.slice(before)? != new.carrier.body.slice(after)? {
        return Err(DomainError::validation(ValidationReason::OriginMismatch));
    }
    let old_fields = old
        .fields
        .ok_or_else(|| DomainError::validation(ValidationReason::FmNotWritable))?;
    let new_fields = new
        .fields
        .ok_or_else(|| DomainError::validation(ValidationReason::FmNotWritable))?;
    let mut delta = BTreeMap::new();
    for key in old_fields.keys().chain(new_fields.keys()) {
        if old_fields.get(key) != new_fields.get(key) {
            authorize_field_key(key)?;
            delta.insert(key.clone(), new_fields.get(key).cloned());
        }
    }
    let old_header = &before[..old.carrier.body.start()];
    let new_header = &after[..new.carrier.body.start()];
    let mut prefix = old_header
        .bytes()
        .zip(new_header.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old_header.is_char_boundary(prefix) || !new_header.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = old_header[prefix..]
        .bytes()
        .rev()
        .zip(new_header[prefix..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old_header.is_char_boundary(old_header.len() - suffix)
        || !new_header.is_char_boundary(new_header.len() - suffix)
    {
        suffix -= 1;
    }
    let plan = patch::plan(
        before,
        old.carrier.body,
        vec![(
            CarrierEditOrigin::Header,
            ByteSpan::new(prefix, old_header.len() - suffix)?,
            new_header[prefix..new_header.len() - suffix].into(),
        )],
    )?;
    Ok(HeaderPatchPlan {
        base_header_hash: content_digest(old_header),
        header_identity: identity,
        edits: plan.edits,
        semantic_delta: delta,
    })
}

#[derive(Clone, Debug)]
pub struct RoomCarrierState {
    pub header_identity: HeaderIdentity,
    pub base_carrier: String,
    pub pending_fields: BTreeMap<String, Option<YamlValue>>,
}
#[derive(Clone, Debug)]
pub struct HeaderMerge {
    /// Persist together with the canonical carrier before returning a receipt.
    pub new_base: String,
    pub final_carrier: String,
    pub header_identity: HeaderIdentity,
    pub pending_fields: BTreeMap<String, Option<YamlValue>>,
}
pub fn merge_raw_header(
    state: &RoomCarrierState,
    raw: &HeaderPatchPlan,
    class: DocClass,
    next_identity: HeaderIdentity,
) -> DomainResult<HeaderMerge> {
    let current = frontmatter::analyze(&state.base_carrier, class)?;
    let header = &state.base_carrier[..current.carrier.body.start()];
    if state.header_identity != raw.header_identity
        || content_digest(header) != raw.base_header_hash
    {
        return Err(DomainError::validation(ValidationReason::SourceMismatch));
    }
    if raw
        .semantic_delta
        .keys()
        .any(|key| state.pending_fields.contains_key(key))
    {
        return Err(DomainError::validation(ValidationReason::SourceMismatch));
    }
    if raw.edits.iter().any(|e| {
        e.origin != CarrierEditOrigin::Header || e.bytes.0.end() > current.carrier.body.start()
    }) {
        return Err(DomainError::validation(ValidationReason::OriginMismatch));
    }
    let plan = CarrierPatchPlan {
        base_content_hash: content_digest(&state.base_carrier),
        body_range: current.carrier.body,
        edits: raw.edits.clone(),
    };
    let new_base = patch::apply(&state.base_carrier, &plan)?;
    let verified = raw_header_plan(
        &state.base_carrier,
        &new_base,
        class,
        state.header_identity.clone(),
    )?;
    if verified.semantic_delta != raw.semantic_delta {
        return Err(DomainError::validation(ValidationReason::SourceMismatch));
    }
    let fields: Vec<_> = state
        .pending_fields
        .iter()
        .map(|(key, value)| match value {
            Some(value) => FieldEdit::Set {
                key: key.clone(),
                value: value.clone(),
            },
            None => FieldEdit::Unset { key: key.clone() },
        })
        .collect();
    let final_carrier = patch::apply(
        &new_base,
        &frontmatter::patch_frontmatter(&new_base, class, &fields)?,
    )?;
    Ok(HeaderMerge {
        new_base,
        final_carrier,
        header_identity: next_identity,
        pending_fields: state.pending_fields.clone(),
    })
}
