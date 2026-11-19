//! Materialize the CRDT body and field intents as a lossless Markdown carrier.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use notarium_core::{
    DomainError, DomainResult,
    auth::EngineAuthContext,
    classes::{DocClass, authorize_field_key},
    error::ValidationReason,
    ids::{BodyIdentity, ContentDigest, NoteId, RevisionId},
    patch::BodyPatchPlan,
    value::{ExactNumber, YamlValue},
};
use notarium_syntax::{
    carrier::Carrier,
    content_digest, extract,
    frontmatter::{self, FieldEdit, HeaderAnalysis},
    patch, unicode,
};
use yrs::{Any, Number};

pub(crate) type AppliedFm = BTreeMap<String, AppliedFmEntry>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AppliedFmEntry {
    Set(YamlValue),
    Unset,
}

impl AppliedFmEntry {
    pub(crate) fn from_any(value: &Any) -> DomainResult<Self> {
        let field = match value {
            Any::String(text) => YamlValue::String(checked_string(text)?),
            Any::Bool(value) => YamlValue::Bool(*value),
            Any::Number(number) => {
                let exact = match number {
                    Number::Int(integer) => ExactNumber::from(*integer),
                    Number::Float(float) => ExactNumber::from_f64(*float)?,
                };
                field_float(&exact)?;
                YamlValue::Number(exact)
            }
            Any::Array(values) => YamlValue::Sequence(
                values
                    .iter()
                    .map(|value| match value {
                        Any::String(text) => checked_string(text).map(YamlValue::String),
                        _ => Err(fm_not_writable()),
                    })
                    .collect::<DomainResult<Vec<_>>>()?,
            ),
            Any::Map(map) if map.len() == 1 && map.get("$unset") == Some(&Any::Bool(true)) => {
                return Ok(Self::Unset);
            }
            _ => return Err(fm_not_writable()),
        };
        Ok(Self::Set(field))
    }

    pub(crate) fn from_field(value: Option<YamlValue>) -> DomainResult<Self> {
        match value {
            Some(value) => {
                validate_field(&value)?;
                Ok(Self::Set(value))
            }
            None => Ok(Self::Unset),
        }
    }

    pub(crate) fn to_any(&self) -> DomainResult<Any> {
        Ok(match self {
            Self::Set(YamlValue::String(text)) => {
                unicode::validate_content(text)?;
                Any::String(Arc::from(text.as_str()))
            }
            Self::Set(YamlValue::Bool(value)) => Any::Bool(*value),
            Self::Set(YamlValue::Number(number)) => {
                Any::Number(Number::Float(field_float(number)?))
            }
            Self::Set(YamlValue::Sequence(values)) => Any::Array(
                values
                    .iter()
                    .map(|value| match value {
                        YamlValue::String(text) => {
                            unicode::validate_content(text)?;
                            Ok(Any::String(Arc::from(text.as_str())))
                        }
                        _ => Err(fm_not_writable()),
                    })
                    .collect::<DomainResult<Vec<_>>>()?
                    .into(),
            ),
            Self::Unset => Any::Map(Arc::new(HashMap::from([(
                "$unset".into(),
                Any::Bool(true),
            )]))),
            _ => return Err(fm_not_writable()),
        })
    }

    fn as_field(&self) -> Option<&YamlValue> {
        match self {
            Self::Set(value) => Some(value),
            Self::Unset => None,
        }
    }
}

fn fm_not_writable() -> DomainError {
    DomainError::validation(ValidationReason::FmNotWritable)
}

fn checked_string(value: &str) -> DomainResult<String> {
    unicode::validate_content(value)?;
    Ok(value.to_owned())
}

fn field_float(number: &ExactNumber) -> DomainResult<f64> {
    let value = number.as_json().as_f64().ok_or_else(fm_not_writable)?;
    if &ExactNumber::from_f64(value)? != number {
        return Err(fm_not_writable());
    }
    Ok(value)
}

fn validate_field(value: &YamlValue) -> DomainResult<()> {
    match value {
        YamlValue::String(text) => unicode::validate_content(text),
        YamlValue::Bool(_) => Ok(()),
        YamlValue::Number(number) => field_float(number).map(|_| ()),
        YamlValue::Sequence(values) => values.iter().try_for_each(|value| match value {
            YamlValue::String(text) => unicode::validate_content(text),
            _ => Err(fm_not_writable()),
        }),
        _ => Err(fm_not_writable()),
    }
}

pub(crate) fn authorize_collab_key(key: &str) -> DomainResult<()> {
    authorize_field_key(key)?;
    if matches!(
        key,
        "notarium-id" | "notarium-created" | "notarium-source" | "slug" | "title" | "view"
    ) {
        return Err(DomainError::validation(ValidationReason::ProtectedField));
    }
    unicode::validate_content(key)
}

pub(crate) struct RoomCarrierState {
    pub(crate) carrier_rev_id: RevisionId,
    pub(crate) carrier_blob_blake3: ContentDigest,
    pub(crate) base_carrier: String,
    pub(crate) fm_writable: bool,
    pub(crate) applied_fm: AppliedFm,
    pub(crate) last_writer_auth: Option<EngineAuthContext>,
    base_header: HeaderAnalysis,
}

impl RoomCarrierState {
    pub(crate) fn new(
        carrier_rev_id: RevisionId,
        carrier_blob_blake3: ContentDigest,
        base_carrier: String,
    ) -> DomainResult<Self> {
        let (base_header, fm_writable) = analyze_base(&base_carrier, carrier_blob_blake3)?;
        Ok(Self {
            carrier_rev_id,
            carrier_blob_blake3,
            base_carrier,
            fm_writable,
            applied_fm: BTreeMap::new(),
            last_writer_auth: None,
            base_header,
        })
    }

    pub(crate) fn body(&self) -> &str {
        &self.base_carrier[self.base_header.carrier.body.start()..]
    }

    pub(crate) fn restore_applied_fm(&mut self, snapshot: &AppliedFm, carrier_dirty: bool) {
        self.applied_fm = if !carrier_dirty {
            snapshot.clone()
        } else if let Some(fields) = &self.base_header.fields {
            snapshot
                .iter()
                .filter(|(key, entry)| fields.get(*key) == entry.as_field())
                .map(|(key, entry)| (key.clone(), entry.clone()))
                .collect()
        } else {
            BTreeMap::new()
        };
    }

    pub(crate) fn advance(
        &mut self,
        revision: RevisionId,
        digest: ContentDigest,
        carrier: String,
        applied_fm: AppliedFm,
    ) -> DomainResult<()> {
        let (header, writable) = analyze_base(&carrier, digest)?;
        self.carrier_rev_id = revision;
        self.carrier_blob_blake3 = digest;
        self.base_carrier = carrier;
        self.base_header = header;
        self.fm_writable = writable;
        self.applied_fm = applied_fm;
        Ok(())
    }

    fn delta<'a>(
        &'a self,
        current: &'a AppliedFm,
    ) -> impl Iterator<Item = (&'a String, &'a AppliedFmEntry)> + 'a {
        current
            .iter()
            .filter(|(key, entry)| self.applied_fm.get(*key) != Some(*entry))
    }

    pub(crate) fn pending_fields(
        &self,
        current: &AppliedFm,
    ) -> BTreeMap<String, Option<YamlValue>> {
        self.delta(current)
            .map(|(key, entry)| (key.clone(), entry.as_field().cloned()))
            .collect()
    }

    pub(crate) fn materialize(&self, body: &str, current_fm: &AppliedFm) -> DomainResult<String> {
        if self
            .applied_fm
            .keys()
            .any(|key| !current_fm.contains_key(key))
        {
            return Err(fm_not_writable());
        }
        let mut delta = self.delta(current_fm).peekable();
        if delta.peek().is_none() {
            return project_scanned_body(&self.base_carrier, &self.base_header.carrier, body);
        }
        if !self.fm_writable {
            return Err(fm_not_writable());
        }
        let edits = delta
            .map(|(key, entry)| {
                authorize_collab_key(key)?;
                Ok(match entry {
                    AppliedFmEntry::Set(value) => {
                        validate_field(value)?;
                        FieldEdit::Set {
                            key: key.clone(),
                            value: value.clone(),
                        }
                    }
                    AppliedFmEntry::Unset => FieldEdit::Unset { key: key.clone() },
                })
            })
            .collect::<DomainResult<Vec<_>>>()?;
        // An existing header alone is enough to apply the patch. When creating the
        // first header, the syntax crate derives its line ending from the old body.
        let source = self
            .base_header
            .carrier
            .header
            .map_or(Ok(self.base_carrier.as_str()), |span| {
                span.slice(&self.base_carrier)
            })?;
        let updated = patch::apply(
            source,
            &frontmatter::patch_frontmatter(source, DocClass::UserDoc, &edits)?,
        )?;
        project_body(&updated, body)
    }
}

fn analyze_base(source: &str, digest: ContentDigest) -> DomainResult<(HeaderAnalysis, bool)> {
    if content_digest(source) != digest {
        return Err(DomainError::validation(ValidationReason::SourceMismatch));
    }
    let analysis = frontmatter::analyze(source, DocClass::UserDoc)?;
    let prefix = &source[..analysis.carrier.body.start()];
    let writable = analysis.writable
        && analysis.diagnostic.is_none()
        && frontmatter::patch_frontmatter(prefix, DocClass::UserDoc, &[]).is_ok();
    Ok((analysis, writable))
}

pub(crate) fn project_body(header_source: &str, body: &str) -> DomainResult<String> {
    let carrier = Carrier::scan(header_source)?;
    project_scanned_body(header_source, &carrier, body)
}

fn project_scanned_body(source: &str, carrier: &Carrier, body: &str) -> DomainResult<String> {
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

pub(crate) fn finalize_nota(
    carrier: &str,
    note: &NoteId,
    body_identity: BodyIdentity,
) -> DomainResult<BodyPatchPlan> {
    let plan = extract::finalize_document(carrier, DocClass::UserDoc, note, &[])?;
    patch::body_plan(carrier, &plan, body_identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(source: &str) -> RoomCarrierState {
        RoomCarrierState::new(
            RevisionId::from_bytes([1; 16]),
            content_digest(source),
            source.to_owned(),
        )
        .unwrap()
    }

    fn text(value: &str) -> AppliedFmEntry {
        AppliedFmEntry::Set(YamlValue::String(value.into()))
    }

    #[test]
    fn fifty_checkpoints_preserve_comments_and_unrelated_fields() {
        let nested =
            "caption: 'keep these quotes' # caption\ncustom_meta:\n  local: [1, 2] # nested\n";
        let base =
            format!("---\n# header\nstatus: 'todo' # status\n{nested}---\n# Архитектура 🚀\n");
        let mut room = state(&base);
        let mut overrides = AppliedFm::new();
        for index in 0..50 {
            let entry = match index % 4 {
                0 => text("done"),
                1 => AppliedFmEntry::Unset,
                2 => text("active"),
                _ => text("todo"),
            };
            overrides.insert("status".into(), entry.clone());
            let body = format!("# Архитектура 🚀\nVersion {index}\n");
            let carrier = room.materialize(&body, &overrides).unwrap();
            if index == 0 {
                assert!(carrier.contains("status: 'done' # status\n"));
            }
            assert!(carrier.contains("# header\n"));
            assert!(carrier.contains("# status\n"));
            assert!(carrier.contains(nested));
            let parsed = frontmatter::analyze(&carrier, DocClass::UserDoc).unwrap();
            assert_eq!(parsed.fields.unwrap().get("status"), entry.as_field());
            assert_eq!(parsed.carrier.body.slice(&carrier).unwrap(), body);
            let revision = RevisionId::from_bytes([index + 2; 16]);
            room.advance(
                revision,
                content_digest(&carrier),
                carrier.clone(),
                overrides.clone(),
            )
            .unwrap();
            assert_eq!(room.materialize(&body, &overrides).unwrap(), carrier);
        }
        assert!(room.materialize(room.body(), &AppliedFm::new()).is_err());
    }

    #[test]
    fn projects_every_closing_fence_boundary_without_absorbing_body() {
        for marker in ["---", "..."] {
            for opening_eol in ["\n", "\r\n", "\r"] {
                for closing_eol in ["", "\n", "\r\n", "\r"] {
                    for body in ["", "т 🚀", "\n", "\r", "\r\n", "\n\u{feff}"] {
                        let prefix = format!(
                            "\u{feff}---{opening_eol}# comment{opening_eol}{marker} \t{closing_eol}"
                        );
                        let mut expected_prefix = prefix.clone();
                        if !body.is_empty() {
                            if closing_eol.is_empty() {
                                expected_prefix.push_str(opening_eol);
                            }
                            if expected_prefix.ends_with('\r') && body.starts_with('\n') {
                                expected_prefix.push('\n');
                            }
                        }
                        let projected = project_body(&prefix, body).unwrap();
                        let scan = Carrier::scan(&projected).unwrap();
                        assert_eq!(
                            scan.header.unwrap().slice(&projected).unwrap(),
                            expected_prefix
                        );
                        assert_eq!(scan.body.slice(&projected).unwrap(), body);
                        assert_eq!(project_body(&projected, body).unwrap(), projected);
                        let status = AppliedFm::from([("status".into(), text("done"))]);
                        let changed = state(&prefix).materialize(body, &status).unwrap();
                        let changed_header =
                            frontmatter::analyze(&changed, DocClass::UserDoc).unwrap();
                        assert!(changed.contains(&format!("# comment{opening_eol}")));
                        assert_eq!(changed_header.carrier.body.slice(&changed).unwrap(), body);
                        assert_eq!(
                            changed_header.fields.unwrap().get("status"),
                            Some(&YamlValue::String("done".into()))
                        );
                        assert_eq!(project_body(&changed, body).unwrap(), changed);
                    }
                }
            }
        }
    }

    #[test]
    fn preserves_bom_and_literal_leading_body_delimiters() {
        for bom in ["", "\u{feff}"] {
            for old_eol in ["\n", "\r", "\r\n"] {
                for body in [
                    "",
                    "draft",
                    "\u{feff}draft",
                    "\u{feff}\u{feff}draft",
                    "---",
                    "---\r\nclass: skill\r\n---\r\nprose",
                    "--- \t\rtitle: text\r",
                    "\r",
                    "\n",
                    "\r\n",
                ] {
                    let base = format!("{bom}draft{old_eol}");
                    let room = state(&base);
                    for fm in [
                        AppliedFm::new(),
                        AppliedFm::from([("status".into(), text("done"))]),
                    ] {
                        let projected = room.materialize(body, &fm).unwrap();
                        let parsed = frontmatter::analyze(&projected, DocClass::UserDoc).unwrap();
                        assert_eq!(parsed.carrier.bom_end, bom.len());
                        assert_eq!(parsed.carrier.body.slice(&projected).unwrap(), body);
                        assert_eq!(project_body(&projected, body).unwrap(), projected);
                        if fm.is_empty()
                            && !body.starts_with("---")
                            && (!bom.is_empty() || !body.starts_with('\u{feff}'))
                        {
                            assert!(parsed.carrier.header.is_none());
                        }
                        assert!(!parsed.fields.unwrap().contains_key("class"));
                    }
                }
            }
        }
    }

    #[test]
    fn opaque_yaml_keeps_prose_editable() {
        for yaml in [
            "a: &anch value\nb: *anch",
            "foo: one\nfoo: two",
            "? explicit_key\n: 2",
        ] {
            let header = format!("---\n{yaml}\n---\n");
            let room = state(&format!("{header}body"));
            assert!(!room.fm_writable, "{yaml}");
            assert_eq!(
                room.materialize("new body", &AppliedFm::new()).unwrap(),
                format!("{header}new body")
            );
            assert_eq!(
                room.materialize(
                    "new body",
                    &AppliedFm::from([("status".into(), text("done"))])
                ),
                Err(fm_not_writable())
            );
        }
    }

    #[test]
    fn dirty_recovery_only_marks_materialized_snapshot_intents_applied() {
        let mut room = state("---\nstatus: done\nkeep: null\n---\nbody");
        let snapshot = AppliedFm::from([
            ("status".into(), text("done")),
            ("added".into(), text("new")),
            ("absent".into(), AppliedFmEntry::Unset),
            ("keep".into(), AppliedFmEntry::Unset),
        ]);
        room.restore_applied_fm(&snapshot, true);
        assert_eq!(
            room.pending_fields(&snapshot),
            BTreeMap::from([
                ("added".into(), Some(YamlValue::String("new".into()))),
                ("keep".into(), None),
            ])
        );
        room.restore_applied_fm(&snapshot, false);
        assert!(room.pending_fields(&snapshot).is_empty());
    }

    #[test]
    fn frontmatter_values_round_trip_without_losing_numeric_precision() {
        for value in [
            Any::String("é 🚀".into()),
            Any::Bool(false),
            Any::Number(Number::Int(1234)),
            Any::Number(Number::Float(1.2)),
            Any::Array(vec![Any::String("CJK 冰".into())].into()),
            Any::Map(Arc::new(HashMap::from([(
                "$unset".into(),
                Any::Bool(true),
            )]))),
        ] {
            let entry = AppliedFmEntry::from_any(&value).unwrap();
            assert_eq!(
                AppliedFmEntry::from_any(&entry.to_any().unwrap()).unwrap(),
                entry
            );
        }
        for value in [
            Any::String("bad\0string".into()),
            Any::Null,
            Any::Number(Number::Float(f64::NAN)),
            Any::Number(Number::Int((1i64 << 53) + 1)),
            Any::Array(vec![Any::Bool(true)].into()),
            Any::Map(Arc::new(HashMap::from([(
                "$unset".into(),
                Any::Bool(false),
            )]))),
        ] {
            assert!(AppliedFmEntry::from_any(&value).is_err());
        }
        assert!(AppliedFmEntry::from_field(Some(YamlValue::Number(u64::MAX.into()))).is_err());
        assert_eq!(
            AppliedFmEntry::from_field(None).unwrap(),
            AppliedFmEntry::Unset
        );
    }

    #[test]
    fn all_room_identity_and_routing_keys_are_protected() {
        for key in [
            "notarium-id",
            "notarium-created",
            "notarium-source",
            "class",
            "slug",
            "title",
            "view",
            "id",
            "space_id",
            "folder_id",
            "revision_id",
            "ability_id",
            "__proto__",
        ] {
            assert_eq!(
                authorize_collab_key(key),
                Err(DomainError::validation(ValidationReason::ProtectedField))
            );
        }
        assert!(authorize_collab_key("status").is_ok());
    }

    #[test]
    fn nota_finalization_uses_body_utf16_offsets_and_is_idempotent() {
        let note = NoteId::from_bytes([2; 16]);
        let identity = BodyIdentity::from_bytes([3; 16]);
        let body = "Архитектура 🚀\n\n```nota\ntype: table # keep\n```\n";
        let header = "---\ncaption: '🥶'\n---\n";
        let source = format!("{header}{body}");
        let plan = finalize_nota(&source, &note, identity.clone()).unwrap();
        assert_eq!(plan.edits.len(), 1);
        assert_eq!(
            plan.edits[0].utf16.0.start(),
            "Архитектура 🚀\n\n```nota\ntype: table # keep\n"
                .encode_utf16()
                .count()
        );
        let finalized = patch::apply_body(body, &identity, &plan).unwrap();
        assert!(finalized.contains("type: table # keep"));
        let second = project_body(&source, &finalized).unwrap();
        let extract::ExtractedDocDelta::Plain(document) =
            extract::extract(&second, DocClass::UserDoc, &note, "Test", None).unwrap()
        else {
            panic!("expected a plain user document");
        };
        assert_eq!(document.views.len(), 1);
        assert_eq!(
            document.views[0].state,
            notarium_core::document::ViewState::Ready
        );
        assert!(document.views[0].id.is_some());
        assert!(
            finalize_nota(&second, &note, identity.clone())
                .unwrap()
                .edits
                .is_empty()
        );
        for invalid in ["```nota\ntype: [\n```\n", "```nota\ntype: table\n"] {
            assert!(
                finalize_nota(invalid, &note, identity.clone())
                    .unwrap()
                    .edits
                    .is_empty()
            );
        }
    }
}
