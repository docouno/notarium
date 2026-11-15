use notarium_core::{classes::DocClass, ids::HeaderIdentity, span::ByteSpan, value::YamlValue};
use notarium_syntax::{carrier::Carrier, frontmatter, live::*, markdown::*, patch};
use std::collections::BTreeMap;

#[test]
fn sections_end_at_the_owning_container_and_preserve_neighbors() {
    let source = "# H\nold\n## Child\nmore\n# Next\nkept\n";
    let expected_body = "old\n## Child\nmore\n";
    let expected = "# H\nnew\n# Next\nkept\n";
    let analysis = analyze(source, Carrier::scan(source).unwrap().body).unwrap();
    assert_eq!(
        analysis.headings[0].section_span.slice(source).unwrap(),
        expected_body
    );
    assert_eq!(
        patch::apply(
            source,
            &replace_section(
                source,
                &SectionSelector {
                    title: "H".into(),
                    occurrence: None
                },
                "new\n"
            )
            .unwrap()
        )
        .unwrap(),
        expected
    );
    let quote = "> # H\n> old\nlazy continuation\n\noutside\n";
    let analysis = analyze(quote, ByteSpan::new(0, quote.len()).unwrap()).unwrap();
    assert_eq!(
        analysis.headings[0].section_span.slice(quote).unwrap(),
        "> old\nlazy continuation\n"
    );
    let changed = patch::apply(
        quote,
        &replace_section(
            quote,
            &SectionSelector {
                title: "H".into(),
                occurrence: None,
            },
            "new\nsecond\n",
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(changed, "> # H\n> new\n> second\n\noutside\n");
    let list = "- # H\n  old\n\n- next\n\noutside\n";
    let changed = patch::apply(
        list,
        &replace_section(
            list,
            &SectionSelector {
                title: "H".into(),
                occurrence: None,
            },
            "new\n",
        )
        .unwrap(),
    )
    .unwrap();
    assert!(changed.starts_with("- # H\n  new\n"));
    assert!(changed.ends_with("- next\n\noutside\n"));
}
#[test]
fn nested_headings_do_not_end_a_root_section_and_code_headings_do_not_exist() {
    let source = "# Root\nintro\n> # Nested\n> text\n\n```md\n# Fake\n```\n# End\n";
    let analysis = analyze(source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
    assert_eq!(analysis.headings.len(), 3);
    assert_eq!(
        analysis.headings[0].section_span.end(),
        source.find("# End").unwrap()
    );
    assert!(
        replace_section(
            source,
            &SectionSelector {
                title: "Fake".into(),
                occurrence: None
            },
            "x"
        )
        .is_err()
    );
    let repeated = "# X\na\n# X\nb\n";
    assert!(
        replace_section(
            repeated,
            &SectionSelector {
                title: "X".into(),
                occurrence: None
            },
            "x"
        )
        .is_err()
    );
}
#[test]
fn fenced_examples_and_unclosed_fences_have_explicit_states() {
    let source = "````md\n```nota\ntype: table\n```\n````\n\n> ```nota\n> type: table\n> ```\n\n```nota\ncolumns: [title,\n";
    let analysis = analyze(source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
    assert_eq!(analysis.fences.len(), 3);
    assert_eq!(analysis.fences[0].info, "md");
    assert!(analysis.fences[0].closed);
    assert_eq!(analysis.fences[1].text, "type: table\n");
    assert!(analysis.fences[1].closed);
    assert!(!analysis.fences[2].closed);
}
#[test]
fn raw_header_intent_survives_disjoint_overrides_and_replay() {
    let original = "---\nstatus: todo # old\nowner: editor\n---\nA🚀B\n";
    let desired = original.replace("# old", "# new");
    let old_identity = HeaderIdentity::from_bytes([1; 16]);
    let new_identity = HeaderIdentity::from_bytes([2; 16]);
    let raw = raw_header_plan(original, &desired, DocClass::UserDoc, old_identity.clone()).unwrap();
    assert!(raw.semantic_delta.is_empty());
    let state = RoomCarrierState {
        header_identity: old_identity.clone(),
        base_carrier: original.into(),
        pending_fields: BTreeMap::from([("status".into(), Some(YamlValue::String("done".into())))]),
    };
    let merged = merge_raw_header(&state, &raw, DocClass::UserDoc, new_identity.clone()).unwrap();
    assert_eq!(merged.new_base, desired);
    assert_eq!(
        merged.final_carrier,
        desired.replace("status: todo", "status: done")
    );
    let checkpoint = frontmatter::set_field(
        &merged.new_base,
        DocClass::UserDoc,
        "status",
        YamlValue::String("done".into()),
    )
    .unwrap();
    assert_eq!(
        patch::apply(&merged.new_base, &checkpoint).unwrap(),
        merged.final_carrier
    );
    let changed = original.replace("todo", "doing");
    let conflicting = raw_header_plan(original, &changed, DocClass::UserDoc, old_identity).unwrap();
    assert!(
        merge_raw_header(
            &state,
            &conflicting,
            DocClass::UserDoc,
            new_identity.clone()
        )
        .is_err()
    );
    let stale = RoomCarrierState {
        header_identity: new_identity,
        ..state
    };
    assert!(
        merge_raw_header(
            &stale,
            &raw,
            DocClass::UserDoc,
            HeaderIdentity::from_bytes([3; 16])
        )
        .is_err()
    );
}
#[test]
fn block_scalar_quotes_and_fence_like_content_do_not_end_the_header() {
    let source = "---\nmessage: |\n  \"unclosed quote is data\n  ---\nstatus: todo\n---\nBody\n";
    let changed = patch::apply(
        source,
        &frontmatter::set_field(
            source,
            DocClass::UserDoc,
            "status",
            YamlValue::String("done".into()),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(changed, source.replace("status: todo", "status: done"));
}

#[test]
fn four_space_indented_marker_is_fence_content_not_a_closer() {
    for end in ["    ```", "\t```", "```\u{a0}"] {
        let source = format!("```nota\ntype: table\n{end}\n");
        let analysis = analyze(&source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
        assert!(!analysis.fences[0].closed);
    }
    let source = "```nota\ntype: table\n   ```\n";
    assert!(
        analyze(source, ByteSpan::new(0, source.len()).unwrap())
            .unwrap()
            .fences[0]
            .closed
    );
}
