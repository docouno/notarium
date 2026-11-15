use notarium_core::{
    classes::DocClass, ids::*, patch::CarrierEditOrigin, span::*, value::YamlValue,
};
use notarium_syntax::{carrier::Carrier, frontmatter::*, patch, unicode::*};

fn string(s: &str) -> YamlValue {
    YamlValue::String(s.into())
}
#[test]
fn edits_preserve_independently_known_multibyte_ranges() {
    for eol in ["\n", "\r\n"] {
        for bom in ["", "\u{feff}"] {
            let source = format!(
                "{bom}---{eol}title: 'Привет 🚀 世界'{eol}status: todo # keep me{eol}nested:{eol}  custom: [a, b] # custom{eol}---{eol}# Текст{eol}Body🧪"
            );
            let expected = source.replacen("status: todo", "status: in-progress", 1);
            let plan =
                set_field(&source, DocClass::UserDoc, "status", string("in-progress")).unwrap();
            assert_eq!(plan.edits.len(), 1);
            let start = source.find("todo").unwrap();
            assert_eq!(
                plan.edits[0].bytes.0,
                ByteSpan::new(start, start + 4).unwrap()
            );
            assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
            assert!(
                set_field(
                    &expected,
                    DocClass::UserDoc,
                    "status",
                    string("in-progress")
                )
                .unwrap()
                .edits
                .is_empty()
            );
        }
    }
}
#[test]
fn comments_quotes_and_nested_value_data_are_not_confused() {
    let source = "---\n'status': 'it''s # fine' # outside\nmessage: | # keep marker comment\n  # value data\n  🚀\ncustom:\n  x: true # nested comment\n---\nbody\n";
    let plan = set_field(source, DocClass::UserDoc, "status", string("it's changed")).unwrap();
    assert_eq!(
        patch::apply(source, &plan).unwrap(),
        source.replace("'it''s # fine'", "'it''s changed'")
    );
    let plan = set_field(source, DocClass::UserDoc, "message", string("new")).unwrap();
    let changed = patch::apply(source, &plan).unwrap();
    assert!(changed.contains("message: new # keep marker comment\n"));
    assert!(!changed.contains("# value data"));
    assert!(changed.contains("custom:\n  x: true # nested comment\n"));
    let plan = unset_field(source, DocClass::UserDoc, "status").unwrap();
    assert!(
        patch::apply(source, &plan)
            .unwrap()
            .contains(" # outside\n")
    );
    assert!(
        unset_field(source, DocClass::UserDoc, "missing")
            .unwrap()
            .edits
            .is_empty()
    );
}
#[test]
fn flow_mapping_insert_and_delete_reparse_with_comments_and_punctuation() {
    for mapping in [
        "{}",
        "{status: todo}",
        "{a: 1, status: todo, z: 3}",
        "{a: 1, # first\n status: todo, z: 3,}",
    ] {
        let source = format!("---\n{mapping}\n---\nbody");
        let changed = patch::apply(
            &source,
            &set_field(&source, DocClass::UserDoc, "owner", string("editor")).unwrap(),
        )
        .unwrap();
        let analysis = analyze(&changed, DocClass::UserDoc).unwrap();
        assert_eq!(
            analysis.fields.unwrap().get("owner"),
            Some(&string("editor"))
        );
        assert!(changed.ends_with("\n---\nbody"));
        for key in ["a", "status", "z", "owner"] {
            let output = patch::apply(
                &changed,
                &unset_field(&changed, DocClass::UserDoc, key).unwrap(),
            )
            .unwrap();
            assert!(
                !analyze(&output, DocClass::UserDoc)
                    .unwrap()
                    .fields
                    .unwrap()
                    .contains_key(key)
            );
            if mapping.contains("# first") {
                assert!(output.contains("# first\n"));
            }
        }
    }
    let source = "---\n{a: 1, b: 2, c: 3}\n---\nbody";
    let plan = patch_frontmatter(
        source,
        DocClass::UserDoc,
        &[
            FieldEdit::Unset { key: "a".into() },
            FieldEdit::Unset { key: "b".into() },
            FieldEdit::Unset { key: "c".into() },
        ],
    )
    .unwrap();
    assert!(
        analyze(&patch::apply(source, &plan).unwrap(), DocClass::UserDoc)
            .unwrap()
            .fields
            .unwrap()
            .is_empty()
    );
}
#[test]
fn ambiguous_headers_are_readonly_and_protected_class_never_falls_back() {
    for source in [
        "---\na: 1\na: 2\n---\nBody",
        "---\na: &id 1\nb: *id\n---\nBody",
    ] {
        let analysis = analyze(source, DocClass::UserDoc).unwrap();
        assert!(!analysis.writable);
        assert!(set_field(source, DocClass::UserDoc, "status", string("new")).is_err());
        let body = analysis.carrier.body;
        let plan = patch::plan(
            source,
            body,
            vec![(CarrierEditOrigin::Body, body, "New body".into())],
        )
        .unwrap();
        assert_eq!(
            patch::apply(source, &plan).unwrap(),
            format!("{}New body", &source[..body.start()])
        );
    }
    for source in [
        "---\nclass: encrypted-note\n---\nBody",
        "---\nclass: user-doc\nclass: encrypted-note\n---\nBody",
        "---\nmeta: {__proto__: bad}\n---\nBody",
    ] {
        assert!(analyze(source, DocClass::UserDoc).is_err());
    }
    assert!(set_field("Body", DocClass::UserDoc, "class", string("encrypted-note")).is_err());
}
#[test]
fn body_coordinates_are_distinct_and_checked_against_live_identity() {
    let source = "---\nstatus: todo\n---\nA🚀B\n";
    let body = Carrier::scan(source).unwrap().body;
    assert_eq!(source.find('B'), Some(26));
    let plan = patch::plan(
        source,
        body,
        vec![(
            CarrierEditOrigin::Body,
            ByteSpan::new(26, 27).unwrap(),
            "C".into(),
        )],
    )
    .unwrap();
    assert_eq!(plan.edits[0].utf16.0, Utf16Span::new(24, 25).unwrap());
    let identity = BodyIdentity::from_bytes([1; 16]);
    let translated = patch::body_plan(source, &plan, identity.clone()).unwrap();
    assert_eq!(translated.edits[0].utf16.0, Utf16Span::new(3, 4).unwrap());
    assert_eq!(
        patch::apply_body("A🚀B\n", &identity, &translated).unwrap(),
        "A🚀C\n"
    );
    assert!(patch::apply_body("A🚀X\n", &identity, &translated).is_err());
    assert!(patch::apply_body("A🚀B\n", &BodyIdentity::from_bytes([2; 16]), &translated).is_err());
    assert!(
        patch::plan(
            source,
            body,
            vec![(
                CarrierEditOrigin::Body,
                ByteSpan::new(18, 27).unwrap(),
                "x".into()
            )]
        )
        .is_err()
    );
}
#[test]
fn portable_names_preserve_identity_and_apply_final_filename_budgets() {
    assert!(PortableFilename::note_slug(&"a".repeat(252)).is_ok());
    assert!(PortableFilename::note_slug(&"a".repeat(253)).is_err());
    assert!(PortableFilename::note_slug(&"я".repeat(126)).is_ok());
    assert!(PortableFilename::note_slug(&"я".repeat(127)).is_err());
    for bad in [
        "CON.md", "lpt1.txt", "COM².md", "../file", "a/b", "name.", "x:y", "NUL",
    ] {
        assert!(PortableFilename::parse(bad).is_err());
    }
    let revision = RevisionId::from_bytes([5; 16]);
    let name = PortableFilename::conflict(&"🚀".repeat(100), &revision).unwrap();
    assert!(name.as_str().len() <= 255);
    assert!(name.as_str().ends_with(&format!(".conflict-{revision}.md")));
    assert_eq!(lookup_key("Straße"), lookup_key("STRASSE"));
    assert_eq!(lookup_key("e\u{301}"), lookup_key("é"));
    assert!(validate_content("a\u{80}b").is_err());
}
