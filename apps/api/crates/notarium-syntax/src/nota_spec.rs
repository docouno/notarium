//! Pure declarative `nota` view specification compiler and validator.
//!
//! Shared between pre-commit view-block patching (`notarium-syntax`) and
//! derived view compilation (`notarium-projections`) with zero storage dependencies.

use crate::{nota::recover_top_level_id, unicode::lookup_key};
use notarium_core::{
    DomainError, DomainResult,
    classes::DocClass,
    document::{ViewBlock, ViewState},
    error::ValidationReason,
    ids::{FolderId, ViewKey},
    ports::{BoardGroupFieldKind, GroupKey},
    query::{
        Bound, Direction, FieldFilterAstV1, FieldSchema, FieldType, Predicate, ScalarType,
        SortColumn, SortKey, SortSpec, ValueRange,
    },
    value::{Date, ExactNumber, ScalarValue, Timestamp, YamlValue},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};

type Fields = BTreeMap<String, YamlValue>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewKind {
    Table,
    List,
    Board,
    Calendar,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceScope {
    #[default]
    Space,
    Project,
    Folder,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SourceFolder {
    Id(FolderId),
    Path(String),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ViewSource {
    pub scope: SourceScope,
    pub folder: Option<SourceFolder>,
    pub recursive: bool,
    pub classes: BTreeSet<DocClass>,
    /// Keys in the same Unicode lookup form as the structural tag index.
    pub tags: BTreeSet<String>,
}

impl Default for ViewSource {
    fn default() -> Self {
        Self {
            scope: SourceScope::Space,
            folder: None,
            recursive: true,
            classes: BTreeSet::from([DocClass::UserDoc]),
            tags: BTreeSet::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NotaDescriptor {
    pub kind: ViewKind,
    pub source: ViewSource,
    pub filter: FieldFilterAstV1,
    pub sort: SortSpec,
    pub group_by: Option<String>,
    pub date_field: Option<String>,
    pub columns: Vec<GroupKey>,
    /// Authored presentation data survives projection and schema recompilation.
    pub presentation: BTreeMap<String, YamlValue>,
}

impl NotaDescriptor {
    pub fn board_group_kind(
        &self,
        schema: &BTreeMap<String, FieldSchema>,
    ) -> DomainResult<BoardGroupFieldKind> {
        let field = self
            .group_by
            .as_deref()
            .filter(|_| self.kind == ViewKind::Board)
            .ok_or_else(invalid_view)?;
        match schema.get(field).map(|value| &value.kind) {
            None => Ok(BoardGroupFieldKind::Scalar),
            Some(FieldType::Scalar(ScalarType::String)) => Ok(BoardGroupFieldKind::String),
            Some(FieldType::Scalar(ScalarType::Bool)) => Ok(BoardGroupFieldKind::Bool),
            Some(FieldType::Scalar(ScalarType::Number)) => Ok(BoardGroupFieldKind::Number),
            Some(FieldType::Scalar(ScalarType::Date)) => Ok(BoardGroupFieldKind::Date),
            Some(FieldType::Scalar(ScalarType::Timestamp)) => Ok(BoardGroupFieldKind::Timestamp),
            Some(FieldType::List(_) | FieldType::Map) => Err(invalid_view()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DescriptorState {
    Ready(Box<NotaDescriptor>),
    Rejected(ValidationReason),
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct CompiledViews {
    pub descriptors: BTreeMap<ViewKey, DescriptorState>,
    pub has_pending_nota: bool,
    pub has_invalid_nota: bool,
}

impl CompiledViews {
    pub fn get(&self, id: &ViewKey) -> DomainResult<&NotaDescriptor> {
        match self.descriptors.get(id) {
            Some(DescriptorState::Ready(descriptor)) => Ok(descriptor),
            Some(DescriptorState::Rejected(reason)) => Err(DomainError::validation(*reason)),
            None if self.has_pending_nota => {
                Err(DomainError::validation(ValidationReason::PendingView))
            }
            None if self.has_invalid_nota => Err(invalid_view()),
            None => Err(DomainError::ResourceNotFound),
        }
    }
}

pub struct ViewCompileInput<'a> {
    pub id: Option<ViewKey>,
    pub parsed_id: bool,
    pub state: &'a ViewState,
    pub config: Option<&'a YamlValue>,
}

/// Compile extracted `ViewBlock`s against a Space field schema.
pub fn compile_views(
    blocks: &[ViewBlock],
    schema: &BTreeMap<String, FieldSchema>,
) -> CompiledViews {
    compile_inputs(
        blocks.iter().map(|block| ViewCompileInput {
            id: block
                .id
                .clone()
                .or_else(|| recover_top_level_id(&block.raw_yaml)),
            parsed_id: block.id.is_some(),
            state: &block.state,
            config: block.config.as_ref(),
        }),
        schema,
    )
}

/// Compile pre-extracted inputs (for projection schema recompilation).
pub fn compile_inputs<'a>(
    blocks: impl IntoIterator<Item = ViewCompileInput<'a>>,
    schema: &BTreeMap<String, FieldSchema>,
) -> CompiledViews {
    let mut result = CompiledViews::default();
    for block in blocks {
        let Some(id) = block.id else {
            match block.state {
                ViewState::Pending => result.has_pending_nota = true,
                ViewState::Invalid | ViewState::Ready => result.has_invalid_nota = true,
            }
            continue;
        };
        let entry = result.descriptors.entry(id.clone());
        match entry {
            Entry::Vacant(entry) => {
                let state = match block.state {
                    ViewState::Ready => match compile_ready(block.config, &id, schema) {
                        Ok(descriptor) => DescriptorState::Ready(Box::new(descriptor)),
                        Err(DomainError::ValidationFailed { diagnostic }) => {
                            DescriptorState::Rejected(diagnostic.reason)
                        }
                        Err(_) => DescriptorState::Rejected(ValidationReason::InvalidView),
                    },
                    ViewState::Pending if !block.parsed_id => {
                        DescriptorState::Rejected(ValidationReason::PendingView)
                    }
                    ViewState::Invalid | ViewState::Pending => {
                        DescriptorState::Rejected(ValidationReason::InvalidView)
                    }
                };
                entry.insert(state);
            }
            Entry::Occupied(mut entry) => {
                entry.insert(DescriptorState::Rejected(ValidationReason::DuplicateViewId));
                if !block.parsed_id && *block.state == ViewState::Pending {
                    result.has_pending_nota = true;
                } else {
                    result.has_invalid_nota = true;
                }
            }
        }
    }
    result
}

/// Validate a single ready view configuration against the Space field schema.
pub fn validate_view_config(
    config: &YamlValue,
    id: &ViewKey,
    schema: &BTreeMap<String, FieldSchema>,
) -> DomainResult<NotaDescriptor> {
    compile_ready(Some(config), id, schema)
}

fn invalid_view() -> DomainError {
    DomainError::validation(ValidationReason::InvalidView)
}

fn invalid_query() -> DomainError {
    DomainError::validation(ValidationReason::InvalidQuery)
}

fn compile_ready(
    config: Option<&YamlValue>,
    id: &ViewKey,
    schema: &BTreeMap<String, FieldSchema>,
) -> DomainResult<NotaDescriptor> {
    let Some(YamlValue::Mapping(fields)) = config else {
        return Err(invalid_view());
    };
    if string(fields.get("id").ok_or_else(invalid_view)?)? != id.as_str() {
        return Err(invalid_view());
    }
    if let Some(version) = fields.get("version")
        && !matches!(version, YamlValue::Number(value) if value.as_json().as_u64() == Some(1))
    {
        return Err(DomainError::validation(
            ValidationReason::UnsupportedQueryVersion,
        ));
    }
    let kind = match string(fields.get("type").ok_or_else(invalid_view)?)? {
        "table" => ViewKind::Table,
        "list" => ViewKind::List,
        "board" => ViewKind::Board,
        "calendar" => ViewKind::Calendar,
        _ => return Err(invalid_view()),
    };
    let filter = FieldFilterAstV1 {
        version: 1,
        predicate: fields
            .get("filter")
            .map(|value| parse_predicate(value, schema, 0, &mut 0))
            .transpose()?
            .unwrap_or_else(|| Predicate::All(Vec::new())),
    };
    filter.validate_declared(schema)?;
    let group_by = optional_string(fields, "group_by")?
        .map(|name| {
            if name.is_empty() || name == "__proto__" {
                Err(invalid_view())
            } else {
                Ok(name.to_owned())
            }
        })
        .transpose()?;
    let date_field = optional_string(fields, "date_field")?
        .map(|name| {
            if name.is_empty() || name == "__proto__" {
                Err(invalid_view())
            } else {
                Ok(name.to_owned())
            }
        })
        .transpose()?;
    if kind == ViewKind::Calendar {
        let field = date_field
            .as_deref()
            .filter(|field| !field.is_empty())
            .ok_or_else(invalid_view)?;
        if schema.get(field).is_some_and(|declaration| {
            !matches!(
                declaration.kind,
                FieldType::Scalar(ScalarType::Date | ScalarType::Timestamp)
            )
        }) {
            return Err(invalid_view());
        }
    }
    let columns = if kind == ViewKind::Board {
        parse_columns(
            fields.get("options"),
            group_by.as_deref().and_then(|key| schema.get(key)),
        )?
    } else {
        Vec::new()
    };
    let descriptor = NotaDescriptor {
        kind,
        source: fields
            .get("source")
            .map(parse_source)
            .transpose()?
            .unwrap_or_default(),
        filter,
        sort: fields
            .get("sort")
            .map(|value| parse_sort(value, schema))
            .transpose()?
            .unwrap_or_default(),
        group_by,
        date_field,
        columns,
        presentation: fields
            .iter()
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "id" | "version"
                        | "type"
                        | "source"
                        | "filter"
                        | "sort"
                        | "group_by"
                        | "date_field"
                )
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    };
    if kind == ViewKind::Board {
        descriptor.board_group_kind(schema)?;
        if descriptor.group_by.as_ref().is_some_and(String::is_empty) {
            return Err(invalid_view());
        }
    }
    Ok(descriptor)
}

fn mapping(value: &YamlValue) -> DomainResult<&Fields> {
    match value {
        YamlValue::Mapping(fields) => Ok(fields),
        _ => Err(invalid_view()),
    }
}

fn sequence(value: &YamlValue) -> DomainResult<&[YamlValue]> {
    match value {
        YamlValue::Sequence(items) => Ok(items),
        _ => Err(invalid_view()),
    }
}

fn string(value: &YamlValue) -> DomainResult<&str> {
    match value {
        YamlValue::String(text) => Ok(text),
        _ => Err(invalid_view()),
    }
}

fn optional_string<'a>(fields: &'a Fields, key: &str) -> DomainResult<Option<&'a str>> {
    fields.get(key).map(string).transpose()
}

fn boolean(value: &YamlValue) -> DomainResult<bool> {
    match value {
        YamlValue::Bool(value) => Ok(*value),
        _ => Err(invalid_view()),
    }
}

const MAX_SOURCE_TAGS: usize = 256;

fn parse_source(value: &YamlValue) -> DomainResult<ViewSource> {
    let fields = mapping(value)?;
    if fields.keys().any(|key| {
        !matches!(
            key.as_str(),
            "scope" | "folder" | "recursive" | "classes" | "tags"
        )
    }) {
        return Err(invalid_view());
    }
    let folder = optional_string(fields, "folder")?
        .map(parse_source_folder)
        .transpose()?;
    let scope = match optional_string(fields, "scope")? {
        None if folder.is_some() => SourceScope::Folder,
        None => SourceScope::Space,
        Some("space") if folder.is_none() => SourceScope::Space,
        Some("project") if folder.is_none() => SourceScope::Project,
        Some("folder") if folder.is_some() => SourceScope::Folder,
        _ => return Err(invalid_view()),
    };
    let mut classes = match fields.get("classes") {
        Some(value) => sequence(value)?
            .iter()
            .map(parse_class)
            .collect::<DomainResult<_>>()?,
        None => BTreeSet::from([DocClass::UserDoc]),
    };
    classes.remove(&DocClass::EncryptedNote);
    let tags = fields
        .get("tags")
        .map(|tags| {
            let items = sequence(tags)?;
            if items.len() > MAX_SOURCE_TAGS {
                return Err(DomainError::validation(ValidationReason::InvalidLimit));
            }
            items
                .iter()
                .map(|tag| {
                    let tag = string(tag)?.trim_start_matches('#');
                    if tag.is_empty() {
                        return Err(invalid_view());
                    }
                    Ok(lookup_key(tag))
                })
                .collect::<DomainResult<_>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(ViewSource {
        scope,
        folder,
        recursive: fields
            .get("recursive")
            .map(boolean)
            .transpose()?
            .unwrap_or(true),
        classes,
        tags,
    })
}

fn parse_source_folder(value: &str) -> DomainResult<SourceFolder> {
    if let Ok(id) = FolderId::parse_v1(value) {
        return Ok(SourceFolder::Id(id));
    }
    // Keep a single path name a path even when it has a legacy ID's length.
    // Root-relative path lookup belongs to the retained projection cut.
    if value == "/" {
        return Ok(SourceFolder::Path(value.to_owned()));
    }
    for part in value.strip_prefix('/').unwrap_or(value).split('/') {
        crate::unicode::validate_component(part).map_err(|_| invalid_view())?;
    }
    Ok(SourceFolder::Path(value.to_owned()))
}

fn parse_class(value: &YamlValue) -> DomainResult<DocClass> {
    match string(value)? {
        "user-doc" => Ok(DocClass::UserDoc),
        "encrypted-note" => Ok(DocClass::EncryptedNote),
        "agent-memory" => Ok(DocClass::AgentMemory),
        "skill" => Ok(DocClass::Skill),
        "profile" => Ok(DocClass::Profile),
        _ => Err(invalid_view()),
    }
}

fn parse_sort(value: &YamlValue, schema: &BTreeMap<String, FieldSchema>) -> DomainResult<SortSpec> {
    let keys = sequence(value)?;
    if keys.is_empty() || keys.len() > 8 {
        return Err(DomainError::validation(ValidationReason::InvalidLimit));
    }
    let mut result = Vec::with_capacity(keys.len());
    for key in keys {
        let key = mapping(key)?;
        if key
            .keys()
            .any(|k| !matches!(k.as_str(), "field" | "direction" | "type" | "nullable"))
        {
            return Err(invalid_view());
        }
        let name = optional_string(key, "field")?.ok_or_else(invalid_view)?;
        if name.is_empty() || name == "__proto__" {
            return Err(invalid_view());
        }
        let direction = match optional_string(key, "direction")? {
            None | Some("asc") => Direction::Asc,
            Some("desc") => Direction::Desc,
            _ => return Err(invalid_view()),
        };
        let column = if name == "updated_at" {
            SortColumn::UpdatedAt
        } else {
            let declared = schema.get(name);
            let explicit = optional_string(key, "type")?
                .map(parse_scalar_type)
                .transpose()?
                .map(FieldType::Scalar);
            let nullable = key.get("nullable").map(boolean).transpose()?;
            let field_schema = match (declared, explicit) {
                (Some(field), explicit) => {
                    if explicit.is_some_and(|expected| expected != field.kind)
                        || nullable.is_some_and(|expected| expected != field.nullable)
                    {
                        return Err(unsupported_sort());
                    }
                    field.clone()
                }
                (None, Some(kind)) if !name.is_empty() => FieldSchema {
                    kind,
                    nullable: nullable.unwrap_or(true),
                },
                (None, _) => return Err(unsupported_sort()),
            };
            SortColumn::Field {
                key: name.to_owned(),
                schema: field_schema,
            }
        };
        result.push(SortKey { column, direction });
    }
    SortSpec::new(result)
}

fn unsupported_sort() -> DomainError {
    DomainError::validation(ValidationReason::UnsupportedSortType)
}

fn parse_scalar_type(value: &str) -> DomainResult<ScalarType> {
    match value {
        "string" => Ok(ScalarType::String),
        "bool" => Ok(ScalarType::Bool),
        "number" => Ok(ScalarType::Number),
        "date" => Ok(ScalarType::Date),
        "timestamp" => Ok(ScalarType::Timestamp),
        _ => Err(unsupported_sort()),
    }
}

const MAX_VIEW_COLUMNS: usize = 256;

fn parse_columns(
    value: Option<&YamlValue>,
    schema: Option<&FieldSchema>,
) -> DomainResult<Vec<GroupKey>> {
    let Some(YamlValue::Mapping(options)) = value else {
        return Ok(Vec::new());
    };
    let Some(YamlValue::Sequence(columns)) = options.get("columns") else {
        return Ok(Vec::new());
    };
    if columns.len() > MAX_VIEW_COLUMNS {
        return Err(DomainError::validation(ValidationReason::InvalidLimit));
    }
    let kind = schema.and_then(|schema| match schema.kind {
        FieldType::Scalar(kind) => Some(kind),
        _ => None,
    });
    let mut result = Vec::with_capacity(columns.len());
    let mut seen = BTreeSet::new();
    for column in columns {
        let group = match column {
            YamlValue::Mapping(fields) => {
                let value = fields.get("value").ok_or_else(invalid_view)?;
                GroupKey::Value(scalar(value, kind, true).map_err(|_| invalid_view())?)
            }
            value => GroupKey::Value(scalar(value, kind, true).map_err(|_| invalid_view())?),
        };
        let group = match group {
            GroupKey::Value(ScalarValue::Number(number)) => {
                GroupKey::Value(ScalarValue::Number(number.canonicalize()))
            }
            other => other,
        };
        let encoded = serde_json::to_vec(&group).map_err(|_| invalid_view())?;
        if seen.insert(encoded) {
            result.push(group);
        }
    }
    Ok(result)
}

fn parse_predicate(
    value: &YamlValue,
    schema: &BTreeMap<String, FieldSchema>,
    depth: usize,
    nodes: &mut usize,
) -> DomainResult<Predicate> {
    *nodes += 1;
    if depth > 32 || *nodes > 1024 {
        return Err(invalid_query());
    }
    let fields = mapping(value).map_err(|_| invalid_query())?;
    let Some((operator, argument)) = fields.first_key_value().filter(|_| fields.len() == 1) else {
        return Err(invalid_query());
    };
    match operator.as_str() {
        "all" | "any" => {
            let items = sequence(argument)
                .map_err(|_| invalid_query())?
                .iter()
                .map(|item| parse_predicate(item, schema, depth + 1, nodes))
                .collect::<DomainResult<_>>()?;
            if operator == "all" {
                Ok(Predicate::All(items))
            } else {
                Ok(Predicate::Any(items))
            }
        }
        "not" => Ok(Predicate::Not(Box::new(parse_predicate(
            argument,
            schema,
            depth + 1,
            nodes,
        )?))),
        "exists" | "is_bad" | "is_absent" => {
            let key = valid_field_name(argument)?;
            Ok(match operator.as_str() {
                "exists" => Predicate::Exists { key },
                "is_bad" => Predicate::IsBad { key },
                _ => Predicate::IsAbsent { key },
            })
        }
        _ => parse_comparison(operator, argument, schema),
    }
}

fn valid_field_name(value: &YamlValue) -> DomainResult<String> {
    let key = string(value).map_err(|_| invalid_query())?;
    if key.is_empty() || key == "__proto__" {
        return Err(invalid_query());
    }
    Ok(key.to_owned())
}

fn parse_comparison(
    operator: &str,
    argument: &YamlValue,
    schema: &BTreeMap<String, FieldSchema>,
) -> DomainResult<Predicate> {
    let fields = mapping(argument).map_err(|_| invalid_query())?;
    let key = valid_field_name(fields.get("key").ok_or_else(invalid_query)?)?;
    match operator {
        "eq" | "contains" => {
            if fields.len() != 2 {
                return Err(invalid_query());
            }
            let kind = schema.get(&key).and_then(|field| match field.kind {
                FieldType::Scalar(kind) | FieldType::List(kind) => Some(kind),
                FieldType::Map => None,
            });
            let value = scalar(
                fields.get("value").ok_or_else(invalid_query)?,
                kind,
                operator == "eq",
            )?;
            if operator == "eq" {
                Ok(Predicate::Eq { key, value })
            } else {
                Ok(Predicate::Contains { key, value })
            }
        }
        "number_range" => Ok(Predicate::NumberRange {
            key,
            range: parse_range(fields, number)?,
        }),
        "date_range" => Ok(Predicate::DateRange {
            key,
            range: parse_range(fields, |value| {
                Date::parse(string(value).map_err(|_| invalid_query())?)
            })?,
        }),
        "timestamp_range" => Ok(Predicate::TimestampRange {
            key,
            range: parse_range(fields, |value| {
                Timestamp::parse(string(value).map_err(|_| invalid_query())?)
            })?,
        }),
        _ => Err(invalid_query()),
    }
}

fn parse_range<T>(
    fields: &Fields,
    value: impl Fn(&YamlValue) -> DomainResult<T>,
) -> DomainResult<ValueRange<T>> {
    if fields
        .keys()
        .any(|key| !matches!(key.as_str(), "key" | "lower" | "upper"))
    {
        return Err(invalid_query());
    }
    let bound = |encoded: &YamlValue| {
        let bound = mapping(encoded).map_err(|_| invalid_query())?;
        if bound
            .keys()
            .any(|key| !matches!(key.as_str(), "value" | "inclusive"))
        {
            return Err(invalid_query());
        }
        Ok::<_, DomainError>(Bound {
            value: value(bound.get("value").ok_or_else(invalid_query)?)?,
            inclusive: bound
                .get("inclusive")
                .map(|raw| boolean(raw).map_err(|_| invalid_query()))
                .transpose()?
                .unwrap_or(true),
        })
    };
    Ok(ValueRange {
        lower: fields.get("lower").map(bound).transpose()?,
        upper: fields.get("upper").map(bound).transpose()?,
    })
}

fn number(value: &YamlValue) -> DomainResult<ExactNumber> {
    if let YamlValue::Number(value) = value {
        Ok(value.clone())
    } else {
        Err(invalid_query())
    }
}

fn scalar(
    value: &YamlValue,
    kind: Option<ScalarType>,
    infer_date: bool,
) -> DomainResult<ScalarValue> {
    match (value, kind) {
        (YamlValue::Null, _) => Ok(ScalarValue::Null),
        (YamlValue::String(value), Some(ScalarType::Date)) => {
            Date::parse(value).map(ScalarValue::Date)
        }
        (YamlValue::String(value), Some(ScalarType::Timestamp)) => {
            Timestamp::parse(value).map(ScalarValue::Timestamp)
        }
        (YamlValue::String(value), None) if infer_date => {
            if let Ok(timestamp) = Timestamp::parse(value) {
                Ok(ScalarValue::Timestamp(timestamp))
            } else if let Ok(date) = Date::parse(value) {
                Ok(ScalarValue::Date(date))
            } else {
                Ok(ScalarValue::String(value.clone()))
            }
        }
        (YamlValue::String(value), None | Some(ScalarType::String)) => {
            Ok(ScalarValue::String(value.clone()))
        }
        (YamlValue::Bool(value), None | Some(ScalarType::Bool)) => Ok(ScalarValue::Bool(*value)),
        (YamlValue::Number(value), None | Some(ScalarType::Number)) => {
            Ok(ScalarValue::Number(value.clone()))
        }
        _ => Err(invalid_query()),
    }
}
