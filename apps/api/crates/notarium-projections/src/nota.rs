//! Semantic compilation of the lossless Markdown extractor's view blocks.

use notarium_core::{
    document::{ViewBlock, ViewState},
    ids::ViewKey,
    query::FieldSchema,
    value::YamlValue,
};
use notarium_syntax::nota::recover_top_level_id;
pub use notarium_syntax::nota::spec::{
    CompiledViews, DescriptorState, NotaDescriptor, SourceFolder, SourceScope, ViewCompileInput,
    ViewKind, ViewSource, compile_inputs,
};
#[cfg(any(test, feature = "test-support"))]
pub use notarium_syntax::nota::spec::{compile_views, validate_view_config};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The compiler inputs retained for re-evaluation after schema changes.
/// Syntax diagnostics and raw Markdown remain on the authored revision.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct ViewInput {
    id: Option<ViewKey>,
    parsed_id: bool,
    state: ViewState,
    config: Option<YamlValue>,
}

pub(crate) fn first_view_type(
    blocks: &[u8],
) -> Result<Option<String>, notarium_core::error::PortError> {
    let blocks: Vec<ViewInput> = crate::derived::decode_payload(blocks)?;
    Ok(blocks.into_iter().find_map(|block| {
        let YamlValue::Mapping(mut config) = block.config? else {
            return None;
        };
        match config.remove("type") {
            Some(YamlValue::String(kind))
                if matches!(kind.as_str(), "table" | "list" | "board" | "calendar") =>
            {
                Some(kind)
            }
            _ => None,
        }
    }))
}

impl From<ViewBlock> for ViewInput {
    fn from(block: ViewBlock) -> Self {
        let parsed_id = block.id.is_some();
        Self {
            id: block.id.or_else(|| recover_top_level_id(&block.raw_yaml)),
            parsed_id,
            config: if block.state == ViewState::Ready {
                block.config
            } else {
                None
            },
            state: block.state,
        }
    }
}

pub(crate) fn compile_projected_views(
    blocks: &[ViewInput],
    schema: &BTreeMap<String, FieldSchema>,
) -> CompiledViews {
    compile_inputs(
        blocks.iter().map(|block| ViewCompileInput {
            id: block.id.clone(),
            parsed_id: block.parsed_id,
            state: &block.state,
            config: block.config.as_ref(),
        }),
        schema,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use notarium_core::{
        DomainError,
        classes::DocClass,
        document::ViewBlock,
        error::ValidationReason,
        ids::NoteId,
        ports::{BoardGroupFieldKind, GroupKey},
        query::{FieldType, ScalarType},
        value::ScalarValue,
    };
    use notarium_syntax::extract::{ExtractedDocDelta, extract};

    use super::*;

    fn invalid_view() -> DomainError {
        DomainError::validation(ValidationReason::InvalidView)
    }

    fn blocks(body: &str) -> Vec<ViewBlock> {
        let note = NoteId::from_bytes([1; 16]);
        let ExtractedDocDelta::Plain(delta) =
            extract(body, DocClass::UserDoc, &note, "authoring", None).unwrap()
        else {
            panic!("fixture must be Markdown")
        };
        delta.views
    }

    #[test]
    fn incomplete_and_invalid_edits_replace_the_executable_view() {
        let first = ViewKey::from_bytes([1; 16]);
        let second = ViewKey::from_bytes([2; 16]);
        let ready = format!("```nota\nid: {first}\ntype: table\n```\n");
        assert!(
            compile_views(&blocks(&ready), &BTreeMap::new())
                .get(&first)
                .is_ok()
        );

        let pending = format!("```nota\nid: '{first}' # still typed\noptions: [unfinished,\n");
        let compile = |source| compile_views(&blocks(source), &BTreeMap::new());
        assert_eq!(
            compile(&pending).get(&first),
            Err(DomainError::validation(ValidationReason::PendingView)),
        );

        let invalid = format!("{pending}```\n");
        assert_eq!(compile(&invalid).get(&first), Err(invalid_view()));

        let untargeted = format!("```nota\noptions:\n  id: {first}\n");
        let descriptors = compile(&untargeted);
        assert!(!descriptors.descriptors.contains_key(&first));
        assert!(descriptors.has_pending_nota);
        assert_eq!(
            descriptors.get(&second),
            Err(DomainError::validation(ValidationReason::PendingView)),
        );
        assert!(compile(&ready).get(&first).is_ok());
    }

    #[test]
    fn persisted_inputs_preserve_compilation_and_id_provenance() {
        let id = ViewKey::from_bytes([3; 16]);
        let other = ViewKey::from_bytes([4; 16]);
        let ready = format!("```nota\nid: {id}\ntype: table\noptions: {{color: purple}}\n```\n");
        let duplicate = format!("{ready}```nota\nid: '{id}'\noptions: [unfinished,");
        let invalid = format!("```nota\nid: {other}\noptions: [unfinished,\n```\n");
        let unknown = "```nota\noptions:\n  id: nested\n";
        for source in [
            ready.as_str(),
            duplicate.as_str(),
            invalid.as_str(),
            unknown,
        ] {
            let blocks = blocks(source);
            let fields = BTreeMap::new();
            let expected = compile_views(&blocks, &fields);
            let inputs = blocks.into_iter().map(ViewInput::from).collect::<Vec<_>>();
            let encoded = rmp_serde::to_vec_named(&inputs).unwrap();
            let decoded: Vec<ViewInput> = rmp_serde::from_slice(&encoded).unwrap();
            assert_eq!(compile_projected_views(&decoded, &fields), expected);
        }
    }

    #[test]
    fn compiler_checks_declared_types_and_preserves_view_presentation() {
        let id = ViewKey::from_bytes([3; 16]);
        let text = format!(
            "```nota\nid: {id}\nversion: 1\ntype: board\nsource: {{classes: [user-doc, encrypted-note], tags: [Focus]}}\nfilter: {{date_range: {{key: due, lower: {{value: '2026-01-01', inclusive: false}}}}}}\nsort: [{{field: status, type: string}}]\ngroup_by: status\noptions: {{columns: [doing, todo], color: purple}}\ncolumns: [title, owner]\n```"
        );
        let blocks = blocks(&text);
        let open_world = compile_views(&blocks, &BTreeMap::new());
        let descriptor = open_world.get(&id).unwrap();
        assert_eq!(
            descriptor.board_group_kind(&BTreeMap::new()).unwrap(),
            BoardGroupFieldKind::Scalar,
        );
        assert_eq!(descriptor.source.tags, BTreeSet::from(["focus".to_owned()]));
        assert_eq!(
            descriptor.source.classes,
            BTreeSet::from([DocClass::UserDoc])
        );
        assert_eq!(
            descriptor.columns[0],
            GroupKey::Value(ScalarValue::String("doing".into()))
        );
        assert!(descriptor.presentation.contains_key("options"));
        assert!(descriptor.presentation.contains_key("columns"));

        let declaration = FieldSchema {
            kind: FieldType::Scalar(ScalarType::String),
            nullable: true,
        };
        let schema = BTreeMap::from([
            ("inapplicable".into(), declaration.clone()),
            ("status".into(), declaration),
        ]);
        let compiled = compile_views(&blocks, &schema);
        assert_eq!(
            compiled
                .get(&id)
                .unwrap()
                .board_group_kind(&schema)
                .unwrap(),
            BoardGroupFieldKind::String
        );
        let due_cannot_be_text = BTreeMap::from([(
            "due".into(),
            FieldSchema {
                kind: FieldType::Scalar(ScalarType::String),
                nullable: false,
            },
        )]);
        assert_eq!(
            compile_views(&blocks, &due_cannot_be_text).get(&id),
            Err(DomainError::validation(ValidationReason::InvalidQuery)),
        );
    }

    #[test]
    fn unsupported_version_type_sort_and_null_contains_are_rejected() {
        let id = ViewKey::from_bytes([4; 16]);
        let cases = [
            (
                "type: list\nversion: 2",
                ValidationReason::UnsupportedQueryVersion,
            ),
            ("type: matrix", ValidationReason::InvalidView),
            (
                "type: calendar\ndate_field: status",
                ValidationReason::InvalidView,
            ),
            (
                "type: table\nsort: [{field: labels}]",
                ValidationReason::UnsupportedSortType,
            ),
            (
                "type: list\nfilter: {contains: {key: tags, value: null}}",
                ValidationReason::InvalidQuery,
            ),
            (
                "type: board\ngroup_by: labels",
                ValidationReason::InvalidView,
            ),
        ];
        let schema = BTreeMap::from([
            (
                "status".into(),
                FieldSchema {
                    kind: FieldType::Scalar(ScalarType::String),
                    nullable: false,
                },
            ),
            (
                "labels".into(),
                FieldSchema {
                    kind: FieldType::List(ScalarType::String),
                    nullable: false,
                },
            ),
        ]);
        for (config, expected) in cases {
            let source = format!("```nota\nid: {id}\n{config}\n```\n");
            assert_eq!(
                compile_views(&blocks(&source), &schema).get(&id),
                Err(DomainError::validation(expected)),
                "{config}",
            );
        }
    }

    #[test]
    fn options_columns_limits_table_config_proto_and_contradictory_source_scope() {
        let id = ViewKey::from_bytes([5; 16]);
        let schema = BTreeMap::new();

        // Table/list views ignore UI column presentation objects in options.columns.
        let table = format!(
            "```nota\nid: {id}\ntype: table\noptions:\n  columns:\n    - {{field: status, width: 120}}\n```\n"
        );
        let compiled = compile_views(&blocks(&table), &schema);
        let compiled_table = compiled.get(&id).unwrap();
        assert_eq!(compiled_table.kind, ViewKind::Table);
        assert!(compiled_table.columns.is_empty());

        // Board options.columns caps at 256 items to prevent quadratic CPU DoS.
        let mut many = String::from("type: board\ngroup_by: status\noptions:\n  columns: [");
        for i in 0..=256 {
            if i > 0 {
                many.push_str(", ");
            }
            many.push_str(&format!("col{i}"));
        }
        many.push(']');
        let too_many = format!("```nota\nid: {id}\n{many}\n```\n");
        assert_eq!(
            compile_views(&blocks(&too_many), &schema).get(&id),
            Err(DomainError::validation(ValidationReason::InvalidLimit)),
        );

        // Reject __proto__, empty keys, and contradictory scope: space|project with folder.
        for (config, expected) in [
            (
                "type: board\ngroup_by: __proto__",
                ValidationReason::InvalidView,
            ),
            ("type: board\ngroup_by: ''", ValidationReason::InvalidView),
            (
                "type: calendar\ndate_field: __proto__",
                ValidationReason::InvalidView,
            ),
            (
                "type: table\nsort: [{field: __proto__, type: string}]",
                ValidationReason::InvalidView,
            ),
            (
                "type: list\nfilter: {exists: __proto__}",
                ValidationReason::InvalidQuery,
            ),
            (
                "type: list\nfilter: {eq: {key: '', value: x}}",
                ValidationReason::InvalidQuery,
            ),
            (
                "type: table\nsource: {scope: space, folder: /work}",
                ValidationReason::InvalidView,
            ),
            (
                "type: table\nsource: {scope: project, folder: /work}",
                ValidationReason::InvalidView,
            ),
        ] {
            let source = format!("```nota\nid: {id}\n{config}\n```\n");
            assert_eq!(
                compile_views(&blocks(&source), &schema).get(&id),
                Err(DomainError::validation(expected)),
                "{config}",
            );
        }
    }
}
