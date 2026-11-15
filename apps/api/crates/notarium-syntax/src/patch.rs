use crate::content_digest;
use notarium_core::{
    DomainError, DomainResult, error::ValidationReason, ids::*, patch::*, span::*,
};

pub fn plan(
    source: &str,
    body_range: ByteSpan,
    edits: Vec<(CarrierEditOrigin, ByteSpan, String)>,
) -> DomainResult<CarrierPatchPlan> {
    body_range.slice(source)?;
    if body_range.end() != source.len() {
        return Err(DomainError::validation(ValidationReason::OriginMismatch));
    }
    let mut splices = Vec::new();
    for (origin, bytes, replacement) in edits {
        let utf16 = bytes.to_utf16(source)?;
        if (origin == CarrierEditOrigin::Body && bytes.start() < body_range.start())
            || (origin == CarrierEditOrigin::Header && bytes.end() > body_range.start())
        {
            return Err(DomainError::validation(ValidationReason::OriginMismatch));
        }
        if bytes.slice(source)? == replacement {
            continue;
        }
        splices.push(CarrierSplice {
            origin,
            bytes: CarrierByteSpan(bytes),
            utf16: CarrierUtf16Span(utf16),
            replacement_utf16_len: replacement.encode_utf16().count(),
            replacement,
        });
    }
    splices.sort_by_key(|edit| (edit.bytes.0.start(), edit.bytes.0.end()));
    check_disjoint(splices.iter().map(|s| s.bytes.0))?;
    Ok(CarrierPatchPlan {
        base_content_hash: content_digest(source),
        body_range,
        edits: splices,
    })
}
fn check_disjoint(spans: impl IntoIterator<Item = ByteSpan>) -> DomainResult<()> {
    let mut previous: Option<ByteSpan> = None;
    for span in spans {
        if previous.is_some_and(|p| p.end() > span.start() || p.start() == span.start()) {
            return Err(DomainError::validation(ValidationReason::OverlappingEdits));
        }
        previous = Some(span);
    }
    Ok(())
}
pub fn apply(source: &str, plan: &CarrierPatchPlan) -> DomainResult<String> {
    if content_digest(source) != plan.base_content_hash {
        return Err(DomainError::validation(ValidationReason::SourceMismatch));
    }
    plan.body_range.slice(source)?;
    if plan.body_range.end() != source.len() {
        return Err(DomainError::validation(ValidationReason::OriginMismatch));
    }
    check_disjoint(plan.edits.iter().map(|e| e.bytes.0))?;
    let mut result = String::new();
    let mut cursor = 0;
    for edit in &plan.edits {
        let bytes = edit.bytes.0;
        if (edit.origin == CarrierEditOrigin::Body && bytes.start() < plan.body_range.start())
            || (edit.origin == CarrierEditOrigin::Header && bytes.end() > plan.body_range.start())
        {
            return Err(DomainError::validation(ValidationReason::OriginMismatch));
        }
        if bytes.to_utf16(source)? != edit.utf16.0
            || edit.replacement.encode_utf16().count() != edit.replacement_utf16_len
        {
            return Err(DomainError::validation(ValidationReason::SourceMismatch));
        }
        result.push_str(
            source
                .get(cursor..bytes.start())
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidSpan))?,
        );
        result.push_str(&edit.replacement);
        cursor = bytes.end();
    }
    result.push_str(&source[cursor..]);
    Ok(result)
}

pub fn body_plan(
    source: &str,
    plan: &CarrierPatchPlan,
    identity: BodyIdentity,
) -> DomainResult<BodyPatchPlan> {
    // Verify all coordinates and units, including header changes that are not copied.
    apply(source, plan)?;
    let body = plan.body_range.slice(source)?;
    let mut edits = Vec::new();
    for edit in &plan.edits {
        match edit.origin {
            CarrierEditOrigin::Header => {
                if edit.bytes.0.end() > plan.body_range.start() {
                    return Err(DomainError::validation(ValidationReason::OriginMismatch));
                }
            }
            CarrierEditOrigin::Body => {
                let start = edit
                    .bytes
                    .0
                    .start()
                    .checked_sub(plan.body_range.start())
                    .ok_or_else(|| DomainError::validation(ValidationReason::OriginMismatch))?;
                let end = edit.bytes.0.end() - plan.body_range.start();
                let bytes = ByteSpan::checked(body, start, end)?;
                edits.push(BodySplice {
                    bytes: BodyByteSpan(bytes),
                    utf16: BodyUtf16Span(bytes.to_utf16(body)?),
                    replacement: edit.replacement.clone(),
                    replacement_utf16_len: edit.replacement_utf16_len,
                });
            }
        }
    }
    Ok(BodyPatchPlan {
        base_body_hash: content_digest(body),
        body_identity: identity,
        edits,
    })
}
pub fn apply_body(
    body: &str,
    identity: &BodyIdentity,
    plan: &BodyPatchPlan,
) -> DomainResult<String> {
    if identity != &plan.body_identity || content_digest(body) != plan.base_body_hash {
        return Err(DomainError::validation(ValidationReason::SourceMismatch));
    }
    let carrier = CarrierPatchPlan {
        base_content_hash: plan.base_body_hash,
        body_range: ByteSpan::new(0, body.len())?,
        edits: plan
            .edits
            .iter()
            .map(|s| CarrierSplice {
                origin: CarrierEditOrigin::Body,
                bytes: CarrierByteSpan(s.bytes.0),
                utf16: CarrierUtf16Span(s.utf16.0),
                replacement: s.replacement.clone(),
                replacement_utf16_len: s.replacement_utf16_len,
            })
            .collect(),
    };
    apply(body, &carrier)
}
