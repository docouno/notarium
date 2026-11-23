//! Pure raw-header intent and merge rules shared by closed and live document owners.
use crate::{
    carrier::Carrier,
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

/// Computes a `HeaderPatchPlan` between the header prefixes of `before` and
/// `after` regardless of whether their bodies differ, drop a trailing header
/// EOL on an empty body, start with literal `---`/BOM, or end with bare `\r`.
/// Returns `Ok(None)` when the header prefixes are byte-identical.
pub fn raw_header_plan_between(
    before: &str,
    after: &str,
    class: DocClass,
    identity: HeaderIdentity,
) -> DomainResult<Option<HeaderPatchPlan>> {
    let old = frontmatter::analyze(before, class)?.carrier;
    let new = frontmatter::analyze(after, class)?.carrier;
    let old_prefix = &before[..old.body.start()];
    let new_prefix = &after[..new.body.start()];
    if old_prefix == new_prefix || is_room_separator_extension(before, after, &old, &new) {
        return Ok(None);
    }
    // Use an inert sentinel body when `before` had a non-empty body so
    // `raw_header_plan` never collides with literal `---`/BOM or leading `\n`
    // in `before`'s old body, while preserving the exact `0..old.body.start()`
    // edit coordinates and `base_header_hash`.
    let safe_body = if old.body.is_empty() { "" } else { "x" };
    let before_synth = format!("{old_prefix}{safe_body}");
    let mut after_synth = String::with_capacity(new_prefix.len() + new.eol.len() + safe_body.len());
    after_synth.push_str(new_prefix);
    if new.header.is_some() && !safe_body.is_empty() && !new_prefix.ends_with(['\r', '\n']) {
        after_synth.push_str(new.eol);
    }
    after_synth.push_str(safe_body);
    raw_header_plan(&before_synth, &after_synth, class, identity).map(Some)
}

/// Combines the header framing from `header_source` with `body`, guaranteeing
/// `Carrier::scan(result)?.body.slice(&result)? == body`.
pub fn project_body(header_source: &str, body: &str) -> DomainResult<String> {
    let carrier = Carrier::scan(header_source)?;
    project_scanned_body(header_source, &carrier, body)
}

/// Combines the already-scanned header framing of `source` with `body`,
/// preserving BOMs, closing-fence boundaries, and literal delimiter bodies.
pub fn project_scanned_body(source: &str, carrier: &Carrier, body: &str) -> DomainResult<String> {
    let mut result;
    if let Some(header) = carrier.header {
        result = String::with_capacity(header.end() + body.len());
        result.push_str(header.slice(source)?);
        append_body(&mut result, carrier.eol, body);
    } else {
        let bom = &source[..carrier.bom_end];
        result = String::with_capacity(bom.len() + body.len());
        result.push_str(bom);
        result.push_str(body);
        if let Ok(scan) = Carrier::scan(&result)
            && scan.header.is_none()
            && scan.bom_end == carrier.bom_end
            && scan.body.slice(&result)? == body
        {
            return Ok(result);
        }
        result.truncate(bom.len());
        result.push_str("---");
        result.push_str(carrier.eol);
        result.push_str("---");
        result.push_str(carrier.eol);
        append_body(&mut result, carrier.eol, body);
    }
    let scan = Carrier::scan(&result)?;
    if scan.body.slice(&result)? != body {
        return Err(DomainError::validation(ValidationReason::OriginMismatch));
    }
    Ok(result)
}

fn append_body(prefix: &mut String, eol: &str, body: &str) {
    if body.is_empty() {
        return;
    }
    if !prefix.ends_with(['\r', '\n']) {
        prefix.push_str(eol);
    }
    // The closing fence's CR and the first body LF are separate characters.
    if prefix.ends_with('\r') && body.starts_with('\n') {
        prefix.push('\n');
    }
    prefix.push_str(body);
}

/// Returns `true` when `after`'s header prefix differs from `before`'s solely
/// by the canonical separator bytes `append_body` inserts before a non-empty
/// body (keeping BOM, YAML bytes, and closing fence byte-identical).
pub fn is_room_separator_extension(
    before: &str,
    after: &str,
    old: &Carrier,
    new: &Carrier,
) -> bool {
    if old.yaml.is_none() || old.yaml != new.yaml || old.bom_end != new.bom_end {
        return false;
    }
    let old_prefix = &before[..old.body.start()];
    let new_prefix = &after[..new.body.start()];
    let new_body = &after[new.body.start()..];
    if new_body.is_empty() {
        return false;
    }
    let mut expected = old_prefix.to_owned();
    if !expected.ends_with(['\r', '\n']) {
        expected.push_str(old.eol);
    }
    if expected.ends_with('\r') && new_body.starts_with('\n') {
        expected.push('\n');
    }
    new_prefix == expected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> HeaderIdentity {
        HeaderIdentity::from_bytes([7; 16])
    }

    #[test]
    fn raw_header_plan_between_handles_boundary_and_delimiter_bodies() {
        // 1. Closing fence without trailing EOL.
        let before = "---\nstatus: todo\n---";
        let after = "---\nstatus: done\n---";
        let plan = raw_header_plan_between(before, after, DocClass::UserDoc, id())
            .unwrap()
            .expect("header changed");
        let merged = merge_raw_header(
            &RoomCarrierState {
                header_identity: id(),
                base_carrier: before.to_owned(),
                pending_fields: BTreeMap::new(),
            },
            &plan,
            DocClass::UserDoc,
            id(),
        )
        .unwrap();
        assert_eq!(project_body(&merged.final_carrier, "").unwrap(), after);
        assert_eq!(
            project_body(&merged.final_carrier, "Body.\n").unwrap(),
            "---\nstatus: done\n---\nBody.\n"
        );

        // 2. Header removal when old body begins with literal `---` block or BOM.
        let before_delim = "---\nstatus: todo\n---\n---\nnot: fm\n---\n";
        let after_delim = "Plain body.\n";
        let plan = raw_header_plan_between(before_delim, after_delim, DocClass::UserDoc, id())
            .unwrap()
            .expect("header removed");
        assert_eq!(plan.semantic_delta.get("status"), Some(&None));
        let merged = merge_raw_header(
            &RoomCarrierState {
                header_identity: id(),
                base_carrier: "---\nstatus: todo\n---\nx\n".to_owned(),
                pending_fields: BTreeMap::new(),
            },
            &plan,
            DocClass::UserDoc,
            id(),
        )
        .unwrap();
        assert_eq!(
            project_body(&merged.final_carrier, "Plain body.\n").unwrap(),
            "Plain body.\n"
        );
        // Preserves literal `---` body safely if a live body still starts with `---`.
        let preserved = project_body(&merged.final_carrier, "---\nnot: fm\n---\n").unwrap();
        let scan = Carrier::scan(&preserved).unwrap();
        assert_eq!(scan.body.slice(&preserved).unwrap(), "---\nnot: fm\n---\n");

        // 3. Bare CR closing fence + LF body separator.
        let before_cr = "---\rstatus: todo\r---\rbody";
        let after_cr = "---\rstatus: done\r---\r\nbody";
        let plan = raw_header_plan_between(before_cr, after_cr, DocClass::UserDoc, id())
            .unwrap()
            .expect("header changed");
        let merged = merge_raw_header(
            &RoomCarrierState {
                header_identity: id(),
                base_carrier: "---\rstatus: todo\r---\rx".to_owned(),
                pending_fields: BTreeMap::new(),
            },
            &plan,
            DocClass::UserDoc,
            id(),
        )
        .unwrap();
        assert_eq!(
            project_body(&merged.final_carrier, "body").unwrap(),
            after_cr
        );

        // 4. Adding a body to an opaque-header note without trailing EOL is a pure separator extension.
        let opaque_before = "---\na: &anc 1\nb: *anc\n---";
        let opaque_after = "---\na: &anc 1\nb: *anc\n---\nhello\n";
        assert!(
            raw_header_plan_between(opaque_before, opaque_after, DocClass::UserDoc, id())
                .unwrap()
                .is_none()
        );
    }
}
