use std::collections::BTreeMap;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{NoteId, RevisionId, ViewKey},
    patch::{CarrierEditOrigin, CarrierPatchPlan},
    ports::{EditNote, Mutation, SpaceContext, ViewRef},
    query::FieldSchema,
    span::ByteSpan,
    value::{ExactNumber, YamlValue},
};
use notarium_syntax::{
    carrier::Carrier,
    frontmatter::{self, FieldEdit},
    markdown::{self, SectionSelector},
    nota::{self, ViewBlockPatch},
    patch,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    NoteRoute, ToolCallContext, corpus, decode, invalid, preconditions, receipt_result, route,
    route_snapshot, separator_after,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::mcp) struct EditInput {
    #[serde(rename = "ref")]
    pub(super) note: NoteId,
    operation: Option<EditOperation>,
    content: Option<String>,
    section: Option<String>,
    find: Option<String>,
    #[serde(default)]
    fields: BTreeMap<String, FrontmatterValue>,
    view: Option<ViewInput>,
    pub(super) version_token: Option<RevisionId>,
}

impl EditInput {
    pub(super) fn edits_view(&self) -> bool {
        self.view.is_some()
    }

    pub(super) fn edited_view_key(&self) -> Result<Option<ViewKey>, PortError> {
        self.view
            .as_ref()
            .map(|view| Ok(view.reference(&self.note)?.key))
            .transpose()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum EditOperation {
    Append,
    Prepend,
    Replace,
    ReplaceSection,
    FindReplace,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum FrontmatterValue {
    Text(String),
    Texts(Vec<String>),
    Null,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewInput {
    view_ref: String,
    source: Option<FieldChanges>,
    common: Option<FieldChanges>,
    options: Option<FieldChanges>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FieldChanges {
    #[serde(default)]
    set: BTreeMap<String, Value>,
    #[serde(default)]
    remove: Vec<String>,
}

impl FieldChanges {
    fn edits(&self) -> Result<Vec<FieldEdit>, PortError> {
        for key in self.set.keys().chain(&self.remove) {
            corpus::validate_field_key(key)?;
        }
        let mut edits = self
            .set
            .iter()
            .map(|(key, value)| {
                Ok(FieldEdit::Set {
                    key: key.clone(),
                    value: view_value(value)?,
                })
            })
            .collect::<Result<Vec<_>, PortError>>()?;
        edits.extend(
            self.remove
                .iter()
                .map(|key| FieldEdit::Unset { key: key.clone() }),
        );
        Ok(edits)
    }
}

const MAX_VIEW_VALUE_DEPTH: usize = 8;

fn view_value(value: &Value) -> Result<YamlValue, PortError> {
    view_value_at(value, 0)
}

fn view_value_at(value: &Value, depth: usize) -> Result<YamlValue, PortError> {
    if depth > MAX_VIEW_VALUE_DEPTH {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(match value {
        Value::Null => YamlValue::Null,
        Value::String(text) => {
            notarium_syntax::unicode::validate_content(text)?;
            YamlValue::String(text.clone())
        }
        Value::Bool(value) => YamlValue::Bool(*value),
        Value::Number(number) => YamlValue::Number(ExactNumber::new(number.clone())),
        Value::Array(items) => YamlValue::Sequence(
            items
                .iter()
                .map(|item| view_value_at(item, depth + 1))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Value::Object(fields) => {
            let mapped = fields
                .iter()
                .map(|(key, value)| {
                    corpus::validate_field_key(key)?;
                    Ok((key.clone(), view_value_at(value, depth + 1)?))
                })
                .collect::<Result<BTreeMap<_, _>, PortError>>()?;
            YamlValue::Mapping(mapped)
        }
    })
}

impl ViewInput {
    fn reference(&self, note: &NoteId) -> Result<ViewRef, PortError> {
        let (owner, key) = self
            .view_ref
            .split_once(':')
            .ok_or_else(|| invalid(ValidationReason::InvalidView))?;
        if NoteId::parse(owner)? != *note {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        Ok(ViewRef {
            note: note.clone(),
            key: ViewKey::parse(key)?,
        })
    }

    fn patch(&self) -> Result<ViewBlockPatch, PortError> {
        let edits = |group: &Option<FieldChanges>| {
            group
                .as_ref()
                .map_or_else(|| Ok(Vec::new()), FieldChanges::edits)
        };
        Ok(ViewBlockPatch {
            source: edits(&self.source)?,
            common: edits(&self.common)?,
            options: edits(&self.options)?,
        })
    }
}

impl EditInput {
    pub(super) fn validate(&self) -> Result<(), PortError> {
        let body = self.operation.is_some();
        if body != self.content.is_some()
            || self.view.is_some() && (body || !self.fields.is_empty())
            || self.view.is_none() && !body && self.fields.is_empty()
            || matches!(self.operation, Some(EditOperation::ReplaceSection))
                != self.section.is_some()
            || matches!(self.operation, Some(EditOperation::FindReplace)) != self.find.is_some()
            || self
                .section
                .as_deref()
                .is_some_and(|section| section.trim().is_empty())
            || self.find.as_deref().is_some_and(str::is_empty)
        {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        if let Some(content) = &self.content {
            notarium_syntax::unicode::validate_content(content)?;
        }
        if let Some(section) = &self.section {
            notarium_syntax::unicode::validate_content(section)?;
        }
        if let Some(find) = &self.find {
            notarium_syntax::unicode::validate_content(find)?;
        }
        for (key, value) in &self.fields {
            corpus::validate_field_key(key)?;
            match value {
                FrontmatterValue::Null => {}
                FrontmatterValue::Text(text) => {
                    notarium_syntax::unicode::validate_content(text)?;
                }
                FrontmatterValue::Texts(texts) => {
                    for text in texts {
                        notarium_syntax::unicode::validate_content(text)?;
                    }
                }
            }
        }
        if let Some(view) = &self.view {
            view.reference(&self.note)?;
            view.patch()?;
        }
        Ok(())
    }

    fn field_edits(&self) -> Vec<FieldEdit> {
        self.fields
            .iter()
            .map(|(key, value)| match value {
                FrontmatterValue::Null => FieldEdit::Unset { key: key.clone() },
                FrontmatterValue::Text(text) => FieldEdit::Set {
                    key: key.clone(),
                    value: YamlValue::String(text.clone()),
                },
                FrontmatterValue::Texts(texts) => FieldEdit::Set {
                    key: key.clone(),
                    value: YamlValue::Sequence(
                        texts.iter().cloned().map(YamlValue::String).collect(),
                    ),
                },
            })
            .collect()
    }

    pub(super) fn plan(
        &self,
        original: &str,
        class: DocClass,
        route: &NoteRoute,
        schema: &BTreeMap<String, FieldSchema>,
    ) -> Result<CarrierPatchPlan, PortError> {
        if route.note != self.note
            || self
                .version_token
                .as_ref()
                .is_some_and(|revision| revision != &route.revision)
        {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        if let Some(view) = &self.view {
            return Ok(nota::patch_view_block(
                original,
                class,
                &view.reference(&self.note)?,
                &view.patch()?,
                schema,
            )?);
        }
        let carrier = Carrier::scan(original)?;
        let mut edits = Vec::new();
        if !self.fields.is_empty() {
            let fields = frontmatter::patch_frontmatter(original, class, &self.field_edits())?;
            edits.extend(
                fields
                    .edits
                    .into_iter()
                    .map(|edit| (edit.origin, edit.bytes.0, edit.replacement)),
            );
        }
        if let (Some(operation), Some(content)) = (self.operation, &self.content) {
            edits.extend(body_edits(
                original,
                &carrier,
                operation,
                content,
                self.section.as_deref(),
                self.find.as_deref(),
            )?);
        }
        let plan = patch::plan(original, carrier.body, edits)?;
        let changed = patch::apply(original, &plan)?;
        if nota_fences(original)? != nota_fences(&changed)? {
            return Err(invalid(ValidationReason::InvalidView));
        }
        Ok(plan)
    }
}

type Splice = (CarrierEditOrigin, ByteSpan, String);

fn body_edits(
    source: &str,
    carrier: &Carrier,
    operation: EditOperation,
    text: &str,
    section: Option<&str>,
    find: Option<&str>,
) -> Result<Vec<Splice>, PortError> {
    let body = carrier.body.slice(source)?;
    let (span, replacement) = match operation {
        EditOperation::Append if !text.is_empty() => (
            ByteSpan::new(carrier.body.end(), carrier.body.end())?,
            format!("{}{text}", separator_after(body, carrier.eol)),
        ),
        EditOperation::Prepend if !text.is_empty() => (
            ByteSpan::new(carrier.body.start(), carrier.body.start())?,
            if body.is_empty() {
                text.to_owned()
            } else {
                format!("{text}{}", separator_after(text, carrier.eol))
            },
        ),
        EditOperation::Append | EditOperation::Prepend => return Ok(Vec::new()),
        EditOperation::Replace => (carrier.body, text.to_owned()),
        EditOperation::ReplaceSection => {
            let title = section
                .filter(|section| !section.trim().is_empty())
                .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?;
            let plan = markdown::replace_section(
                source,
                &SectionSelector {
                    title: title.to_owned(),
                    occurrence: None,
                },
                text,
            )?;
            return Ok(plan
                .edits
                .into_iter()
                .map(|edit| (edit.origin, edit.bytes.0, edit.replacement))
                .collect());
        }
        EditOperation::FindReplace => {
            let find = find
                .filter(|find| !find.is_empty())
                .ok_or_else(|| invalid(ValidationReason::InvalidQuery))?;
            let first = body.find(find).ok_or(DomainError::ResourceNotFound)?;
            let next_at = first + find.chars().next().expect("nonempty search").len_utf8();
            if body[next_at..].contains(find) {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
            let start = carrier.body.start() + first;
            (ByteSpan::new(start, start + find.len())?, text.to_owned())
        }
    };
    let mut edits = Vec::new();
    if span.start() == carrier.body.start()
        && carrier.header.is_some()
        && !source[..span.start()].ends_with('\n')
        && !replacement.is_empty()
    {
        edits.push((
            CarrierEditOrigin::Header,
            ByteSpan::new(span.start(), span.start())?,
            carrier.eol.to_owned(),
        ));
    }
    edits.push((CarrierEditOrigin::Body, span, replacement));
    Ok(edits)
}

fn nota_fences(source: &str) -> Result<Vec<&str>, PortError> {
    let carrier = Carrier::scan(source)?;
    let markdown = markdown::analyze(source, carrier.body)?;
    markdown
        .fences
        .into_iter()
        .filter(|fence| fence.info == "nota")
        .map(|fence| fence.span.slice(source).map_err(PortError::from))
        .collect()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct JournaledViewSchema {
    revision: Option<RevisionId>,
}

/// Plan a view edit while journaling only the Space schema revision ID in
/// content-free `control.mcp_dedup` so retries survive schema drift, project
/// trash, and large view payloads without storing user-authored content in
/// control storage.
pub(super) async fn plan_view_edit_with_schema_journal(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    journal_label: &str,
    input: &EditInput,
    original: &str,
    class: DocClass,
    route: &NoteRoute,
) -> Result<CarrierPatchPlan, PortError> {
    if let Some(saved) = call
        .lookup_journal_with_key::<JournaledViewSchema>(
            journal_label,
            &call.request_key,
            call.request_hash,
        )
        .await?
    {
        let fields = match saved.revision {
            Some(rev) => {
                call.registry
                    .engine
                    .space_schema_snapshot(scope.clone(), Some(rev))
                    .await?
                    .fields
            }
            None => BTreeMap::new(),
        };
        return input.plan(original, class, route, &fields);
    }
    let snapshot = call
        .registry
        .engine
        .space_schema_snapshot(scope.clone(), None)
        .await?;
    let plan = input.plan(original, class, route, &snapshot.fields)?;
    let recorded = call
        .record_journal_with_key(
            journal_label,
            &call.request_key,
            call.request_hash,
            &JournaledViewSchema {
                revision: snapshot.revision.clone(),
            },
        )
        .await?;
    if recorded.revision != snapshot.revision {
        let fields = match recorded.revision {
            Some(rev) => {
                call.registry
                    .engine
                    .space_schema_snapshot(scope.clone(), Some(rev))
                    .await?
                    .fields
            }
            None => BTreeMap::new(),
        };
        return input.plan(original, class, route, &fields);
    }
    Ok(plan)
}

pub(super) async fn edit_note(
    call: &mut ToolCallContext<'_>,
    arguments: Value,
) -> Result<Value, PortError> {
    let input: EditInput = decode(arguments)?;
    input.validate()?;
    let (route, trashed_replay) = route(call, &input.note, input.version_token.as_ref()).await?;
    let (scope, observed) = route_snapshot(call, &route).await?;
    let source = if trashed_replay {
        corpus::admit_note_metadata_write(call, &scope, &observed.document.metadata()).await?;
        observed.document.explicit_read(scope.auth())?.to_owned()
    } else {
        corpus::note_document(call, &scope, &observed.document).await?
    };
    let plan = if input.edits_view() {
        plan_view_edit_with_schema_journal(
            call,
            &scope,
            "edit-note-view-schema",
            &input,
            &source,
            observed.document.class(),
            &route,
        )
        .await?
    } else {
        input.plan(&source, observed.document.class(), &route, &BTreeMap::new())?
    };
    let committed = call
        .registry
        .engine
        .edit_note(
            call.corpus_writer(scope.clone()).await?,
            Mutation {
                identity: call.command_identity(&route.scope, "edit_note", 0),
                preconditions: preconditions(&route),
                input: EditNote {
                    note: route.note.clone(),
                    plan,
                },
            },
        )
        .await?;
    receipt_result(call, scope, &route.note, committed, "edited")
        .await
        .map_err(|error| super::batch_operational_error("notarium.mcp.edit-note.v1", error, true))
}

#[cfg(test)]
mod tests {
    use notarium_core::{
        ids::{HistoryIncarnation, SpaceId},
        model::HistoryScope,
    };
    use serde_json::json;

    use super::*;

    fn note_route() -> NoteRoute {
        NoteRoute {
            scope: HistoryScope {
                space_id: SpaceId::from_bytes([1; 16]),
                incarnation: HistoryIncarnation::from_bytes([2; 16]),
            },
            note: NoteId::from_bytes([3; 16]),
            revision: RevisionId::from_bytes([4; 16]),
        }
    }

    #[test]
    fn view_edits_require_a_structural_address_and_prose_keeps_the_fence() {
        let route = note_route();
        let key = ViewKey::from_bytes([5; 16]);
        let other = ViewKey::from_bytes([6; 16]);
        let original_fence = format!("```nota\nid: {other}\ntype: table\n```\n");
        let source = format!("Intro.\n\n```nota\nid: {key}\ntype: table\n```\n\n{original_fence}");
        let replace: EditInput = decode(json!({
            "ref": route.note, "operation": "findReplace",
            "find": "type: table", "content": "type: board",
        }))
        .unwrap();
        let schema = BTreeMap::new();
        assert!(
            replace
                .plan(&source, DocClass::UserDoc, &route, &schema)
                .is_err()
        );
        let append: EditInput = decode(json!({
            "ref": route.note, "operation": "append", "content": "Another paragraph.",
        }))
        .unwrap();
        let appended = patch::apply(
            &source,
            &append
                .plan(&source, DocClass::UserDoc, &route, &schema)
                .unwrap(),
        )
        .unwrap();
        assert!(appended.starts_with(&source));
        assert!(appended.ends_with("Another paragraph."));
        let structural: EditInput = decode(json!({
            "ref": route.note,
            "view": {
                "viewRef": format!("{}:{key}", route.note),
                "common": { "set": { "type": "board", "group_by": "status" } },
                "options": { "set": { "compact": true, "sort": [{ "field": "title", "priority": 1 }] } },
            },
        })).unwrap();
        structural.validate().unwrap();
        let changed = patch::apply(
            &source,
            &structural
                .plan(&source, DocClass::UserDoc, &route, &schema)
                .unwrap(),
        )
        .unwrap();
        let body = Carrier::scan(&changed).unwrap().body;
        let markdown = markdown::analyze(&changed, body).unwrap();
        let views = nota::analyze(&changed, body, &route.note, &markdown, false).unwrap();
        let Some(YamlValue::Mapping(config)) = &views.blocks[0].config else {
            panic!("expected parsed view configuration");
        };
        assert_eq!(config["type"], YamlValue::String("board".to_owned()));
        assert_eq!(
            config["options"],
            YamlValue::Mapping(BTreeMap::from([
                ("compact".to_owned(), YamlValue::Bool(true)),
                (
                    "sort".to_owned(),
                    YamlValue::Sequence(vec![YamlValue::Mapping(BTreeMap::from([
                        ("field".to_owned(), YamlValue::String("title".to_owned())),
                        (
                            "priority".to_owned(),
                            YamlValue::Number(ExactNumber::from(1i64))
                        ),
                    ]))])
                ),
            ]))
        );
        assert_eq!(
            nota_fences(&changed).unwrap()[1],
            nota_fences(&source).unwrap()[1]
        );
    }

    #[test]
    fn protected_field_keys_are_refused_before_planning() {
        let route = note_route();
        let input: EditInput = decode(json!({
            "ref": route.note, "fields": { "</tool_result>": "injected" },
        }))
        .unwrap();
        assert!(input.validate().is_err());
        let key = ViewKey::from_bytes([5; 16]);
        let nested: EditInput = decode(json!({
            "ref": route.note,
            "view": {
                "viewRef": format!("{}:{key}", route.note),
                "options": { "set": { "sort": [{ "<system>": true }] } },
            },
        }))
        .unwrap();
        assert!(nested.validate().is_err());
    }

    #[test]
    fn plain_frontmatter_arguments_set_authored_values_and_remove_null() {
        let source = "---\nold: remove this\n---\nBody";
        let route = note_route();
        let input: EditInput = decode(json!({
            "ref": route.note, "fields": { "title": "Renamed title", "tags": ["one", "two"], "old": null },
        })).unwrap();
        input.validate().unwrap();
        let output = patch::apply(
            source,
            &input
                .plan(source, DocClass::UserDoc, &route, &BTreeMap::new())
                .unwrap(),
        )
        .unwrap();
        let fields = frontmatter::analyze(&output, DocClass::UserDoc)
            .unwrap()
            .fields
            .unwrap();
        assert_eq!(
            fields["title"],
            YamlValue::String("Renamed title".to_owned())
        );
        assert_eq!(
            fields["tags"],
            YamlValue::Sequence(vec![
                YamlValue::String("one".to_owned()),
                YamlValue::String("two".to_owned())
            ])
        );
        assert!(!fields.contains_key("old"));
    }

    #[test]
    fn adding_body_to_header_only_note_keeps_distinct_splices() {
        let source = "---\r\ntitle: Heading\r\n---";
        let route = note_route();
        let input: EditInput = decode(json!({
            "ref": route.note, "operation": "append", "content": "First paragraph.",
        }))
        .unwrap();
        let plan = input
            .plan(source, DocClass::UserDoc, &route, &BTreeMap::new())
            .unwrap();
        assert_eq!(plan.edits[0].origin, CarrierEditOrigin::Header);
        assert_eq!(plan.edits[1].origin, CarrierEditOrigin::Body);
        let changed = patch::apply(source, &plan).unwrap();
        assert_eq!(
            Carrier::scan(&changed)
                .unwrap()
                .body
                .slice(&changed)
                .unwrap(),
            "First paragraph."
        );
    }

    #[test]
    fn nested_view_filter_edits_validate_against_schema_and_depth_limit() {
        let route = note_route();
        let key = ViewKey::from_bytes([7; 16]);
        let source = format!("Intro.\n\n```nota\nid: {key}\ntype: table\n```\n");
        let string_schema = BTreeMap::from([(
            "status".to_owned(),
            FieldSchema {
                kind: notarium_core::query::FieldType::Scalar(
                    notarium_core::query::ScalarType::String,
                ),
                nullable: false,
            },
        )]);
        let nested_filter: EditInput = decode(json!({
            "ref": route.note,
            "view": {
                "viewRef": format!("{}:{key}", route.note),
                "common": {
                    "set": {
                        "filter": {
                            "all": [{ "eq": { "key": "status", "value": "open" } }]
                        }
                    }
                }
            }
        }))
        .unwrap();
        nested_filter.validate().unwrap();
        let patched = patch::apply(
            &source,
            &nested_filter
                .plan(&source, DocClass::UserDoc, &route, &string_schema)
                .unwrap(),
        )
        .unwrap();
        assert!(patched.contains("status"));

        // Schema type mismatch fails pre-commit validation instead of storing an invalid nota block.
        let number_schema = BTreeMap::from([(
            "status".to_owned(),
            FieldSchema {
                kind: notarium_core::query::FieldType::Scalar(
                    notarium_core::query::ScalarType::Number,
                ),
                nullable: false,
            },
        )]);
        assert!(
            nested_filter
                .plan(&source, DocClass::UserDoc, &route, &number_schema)
                .is_err()
        );

        // Excessively nested JSON values beyond MAX_VIEW_VALUE_DEPTH are rejected.
        let mut deep = json!("leaf");
        for _ in 0..10 {
            deep = json!({ "nested": deep });
        }
        let too_deep: EditInput = decode(json!({
            "ref": route.note,
            "view": {
                "viewRef": format!("{}:{key}", route.note),
                "options": { "set": { "deep": deep } }
            }
        }))
        .unwrap();
        assert!(too_deep.validate().is_err());
    }
}
