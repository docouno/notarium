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

#[test]
fn plain_scalars_do_not_open_collections_and_flow_values_are_quoted_when_needed() {
    for title in [
        "An [example",
        "An {example",
        "A } [balanced",
        "https://example.test/a:b",
    ] {
        let source = format!("---\ntitle: {title}\nstatus: old\n---\nBody\n");
        let plan = set_field(&source, DocClass::UserDoc, "status", string("new")).unwrap();
        assert_eq!(
            patch::apply(&source, &plan).unwrap(),
            source.replace("status: old", "status: new")
        );
    }
    for value in [
        "one,two",
        "one[two]",
        "one{two}",
        "https://example.test/a:b",
    ] {
        for mapping in [
            "{status: old, url: https://example.test/path, keep: yes}",
            "status: old\nkeep: yes",
        ] {
            let source = format!("---\n{mapping}\n---\nBody\n");
            let plan = set_field(&source, DocClass::UserDoc, "status", string(value)).unwrap();
            let changed = patch::apply(&source, &plan).unwrap();
            assert_eq!(
                analyze(&changed, DocClass::UserDoc)
                    .unwrap()
                    .fields
                    .unwrap()["status"],
                string(value)
            );
            let replacement = &plan.edits[0].replacement;
            assert_eq!(
                changed,
                source.replace("status: old", &format!("status: {replacement}"))
            );
        }
    }
}

#[test]
fn unset_preserves_collection_comment_trivia_but_removes_block_scalar_data() {
    for (mapping, expected) in [
        (
            "status: {a: x, # keep this exact comment\n b: y}\nnext: keep\n",
            "   # keep this exact comment\n  \nnext: keep\n",
        ),
        (
            "status:\n  a: x\n  # authored child comment\n  b: y\n# outside\nnext: keep\n",
            "\n   \n  # authored child comment\n   \n# outside\nnext: keep\n",
        ),
        (
            "status: | # marker comment\n  # literal value data\nnext: keep\n",
            "  # marker comment\nnext: keep\n",
        ),
    ] {
        for eol in ["\n", "\r\n"] {
            let source = format!("---\n{mapping}---\nBody\n").replace('\n', eol);
            let expected = format!("---\n{expected}---\nBody\n").replace('\n', eol);
            let plan = unset_field(&source, DocClass::UserDoc, "status").unwrap();
            assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
        }
    }
}

#[test]
fn scalar_data_ownership_and_collection_separators_follow_yaml_indentation() {
    use saphyr::LoadableYamlNode;

    // Each tuple declares its own concrete parent/content indentation. Markers
    // on a later line inherit the preceding key or dash, not their own column.
    let layouts = [
        ("status: ", 0),
        ("status:\n  ", 0),
        ("status: !!str ", 0),
        ("status: !!str # property comment\n  ", 0),
        ("status:\n  child: ", 2),
        ("status:\n  child:\n    ", 2),
        ("status:\n  - ", 2),
        ("status:\n  -\n    ", 2),
        ("status:\n- ", 0),
        ("status:\n  - child: ", 4),
        ("status:\n  - - ", 4),
    ];
    for (prefix, parent) in layouts {
        for root_indent in ["", "  "] {
            for marker in [
                "|", "|-", "|+", "|4", "|-4", "|4+", ">", ">-", ">+", ">4", ">-4", ">4+",
            ] {
                for eol in ["\n", "\r\n"] {
                    for bom in ["", "\u{feff}"] {
                        for suffix in ["", "next: keep\n", "\nnext: keep\n"] {
                            let data_indent = " ".repeat(parent + 4);
                            let comment_indent = " ".repeat(parent + 2);
                            let raw = format!(
                                "{prefix}{marker} # marker comment\n{data_indent}# literal value data 🚀\n{data_indent}\"more data [ {{\n{comment_indent}# outside scalar comment\n{suffix}"
                            );
                            let raw = raw
                                .split_inclusive('\n')
                                .map(|line| format!("{root_indent}{line}"))
                                .collect::<String>()
                                .replace('\n', eol);
                            let comment_indent = format!("{root_indent}{comment_indent}");
                            let source = format!("{bom}---{eol}{raw}---{eol}Body🚀");
                            assert!(
                                saphyr::Yaml::load_from_str(&raw).is_ok(),
                                "invalid fixture: {raw:?}"
                            );
                            assert!(analyze(&source, DocClass::UserDoc).unwrap().writable);
                            for unset in [false, true] {
                                let plan = if unset {
                                    unset_field(&source, DocClass::UserDoc, "status")
                                } else {
                                    set_field(&source, DocClass::UserDoc, "status", string("done"))
                                }
                                .unwrap_or_else(|e| panic!("{raw:?}, unset={unset}: {e:?}"));
                                let changed = patch::apply(&source, &plan).unwrap();
                                assert!(changed.starts_with(&format!("{bom}---{eol}")));
                                assert!(
                                    changed.ends_with(&format!("---{eol}Body🚀")),
                                    "{changed:?}"
                                );
                                assert!(!changed.contains("literal value data"), "{changed:?}");
                                assert!(!changed.contains("more data"), "{changed:?}");
                                assert!(
                                    changed.contains(&format!(
                                        "{comment_indent}# outside scalar comment{eol}"
                                    )),
                                    "{changed:?}"
                                );
                                if unset || parent == 0 && !prefix.contains('-') {
                                    assert!(
                                        changed.contains(&format!(" # marker comment{eol}")),
                                        "{changed:?}"
                                    );
                                }
                                if prefix.contains("property comment") {
                                    assert!(
                                        changed.contains(&format!(" # property comment{eol}")),
                                        "{changed:?}"
                                    );
                                }
                                let carrier = Carrier::scan(&changed).unwrap();
                                assert_eq!(carrier.body.slice(&changed).unwrap(), "Body🚀");
                                let actual = saphyr::Yaml::load_from_str(
                                    carrier.yaml.unwrap().slice(&changed).unwrap(),
                                )
                                .unwrap();
                                let expected = format!(
                                    "{}{suffix}",
                                    if unset { "" } else { "status: done\n" }
                                );
                                let expected = saphyr::Yaml::load_from_str(&expected).unwrap();
                                // A comments-only YAML document and an empty one both
                                // represent no fields; compare nonempty mappings fully.
                                if unset && suffix.is_empty() {
                                    assert!(
                                        analyze(&changed, DocClass::UserDoc)
                                            .unwrap()
                                            .fields
                                            .unwrap()
                                            .is_empty()
                                    );
                                } else {
                                    assert_eq!(actual, expected, "{changed:?}");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn replacing_a_final_block_scalar_subtree_preserves_the_carrier_boundary() {
    for raw in [
        "status:\n  child: |\n    value\n",
        "status:\n  child: >-\n    value\n",
        "status:\n  - key: |\n      value\n",
        "status:\n  - |\n    # literal\n",
        "status:\n  child: |\n",
        "status:\n  - |\n",
    ] {
        for eol in ["\n", "\r\n"] {
            for ending in ["---\nBody", "...\nBody", "---", "..."] {
                for suffix in ["", "\n", "next: keep\n"] {
                    let source = format!("\u{feff}---\n{raw}{suffix}{ending}").replace('\n', eol);
                    let before = Carrier::scan(&source).unwrap();
                    let plan =
                        set_field(&source, DocClass::UserDoc, "status", string("done")).unwrap();
                    let changed = patch::apply(&source, &plan).unwrap();
                    let after = analyze(&changed, DocClass::UserDoc).unwrap();
                    assert_eq!(after.fields.unwrap()["status"], string("done"));
                    assert!(changed.ends_with(&ending.replace('\n', eol)), "{changed:?}");
                    assert_eq!(
                        after.carrier.body.slice(&changed).unwrap(),
                        before.body.slice(&source).unwrap()
                    );
                    assert!(
                        set_field(&changed, DocClass::UserDoc, "status", string("done"))
                            .unwrap()
                            .edits
                            .is_empty()
                    );
                }
            }
        }
    }
}

#[test]
fn carrier_and_field_edits_agree_when_marker_and_data_indentation_vary() {
    use saphyr::LoadableYamlNode;
    let mut valid = 0;
    for (prefix, parent) in [
        ("status:\n", 0),
        ("status: !!str\n", 0),
        ("status:\n  child:\n", 2),
        ("status:\n  -\n", 2),
        ("status:\n-\n", 0),
    ] {
        for marker_indent in parent + 1..=parent + 5 {
            for content_indent in parent + 1..=parent + 5 {
                for marker in [
                    "|", "|-", "|+", "|1", "|2", "|4", ">", ">-", ">1", ">2", ">4",
                ] {
                    for eol in ["\n", "\r\n"] {
                        let raw = format!("{prefix}{}{marker} # marker\n{}\"literal data [ {{ 🚀\n# outside\nnext: keep\n", " ".repeat(marker_indent), " ".repeat(content_indent)).replace('\n', eol);
                        if saphyr::Yaml::load_from_str(&raw).is_err() {
                            continue;
                        }
                        valid += 1;
                        let source = format!("---{eol}{raw}---{eol}Body🚀");
                        for unset in [false, true] {
                            let plan = if unset {
                                unset_field(&source, DocClass::UserDoc, "status")
                            } else {
                                set_field(&source, DocClass::UserDoc, "status", string("done"))
                            }
                            .unwrap_or_else(|e| panic!("{raw:?}: {e:?}"));
                            let changed = patch::apply(&source, &plan).unwrap();
                            let after = Carrier::scan(&changed).unwrap();
                            assert_eq!(after.body.slice(&changed).unwrap(), "Body🚀");
                            assert!(changed.contains(&format!("# outside{eol}")));
                            let actual = saphyr::Yaml::load_from_str(
                                after.yaml.unwrap().slice(&changed).unwrap(),
                            )
                            .unwrap();
                            let expected = saphyr::Yaml::load_from_str(if unset {
                                "next: keep\n"
                            } else {
                                "status: done\nnext: keep\n"
                            })
                            .unwrap();
                            assert_eq!(actual, expected, "{raw:?}");
                        }
                    }
                }
            }
        }
    }
    assert_eq!(valid, 2350);
}

#[test]
fn literal_lookalikes_and_readonly_properties_preserve_their_authored_bytes() {
    use saphyr::LoadableYamlNode;
    for raw in [
        "status: &anchor |\n  \"literal [ {\nnext: keep\n",
        "status: &anchor !!str |\n  \"literal [ {\nnext: keep\n",
        "status: !!str &anchor |\n  \"literal [ {\nnext: keep\n",
        "status:\n  &anchor\n    |2\n  \"literal [ {\nnext: keep\n",
    ] {
        for eol in ["\n", "\r\n"] {
            let raw = raw.replace('\n', eol);
            assert!(saphyr::Yaml::load_from_str(&raw).is_ok());
            let source = format!("---{eol}{raw}---{eol}Body");
            let analysis = analyze(&source, DocClass::UserDoc).unwrap();
            assert!(!analysis.writable);
            let plan = notarium_syntax::extract::finalize_document(
                &source,
                DocClass::UserDoc,
                &NoteId::from_bytes([1; 16]),
                &[],
            )
            .unwrap();
            assert_eq!(patch::apply(&source, &plan).unwrap(), source);
            let plan = patch::plan(
                &source,
                analysis.carrier.body,
                vec![(
                    CarrierEditOrigin::Body,
                    analysis.carrier.body,
                    "New body".into(),
                )],
            )
            .unwrap();
            assert_eq!(
                patch::apply(&source, &plan).unwrap(),
                format!("---{eol}{raw}---{eol}New body")
            );
        }
    }
    for continuation in [
        "|",
        "- |",
        "!!str |",
        "\"unclosed quote",
        "[unclosed flow",
        ":plain",
    ] {
        let raw = format!(
            "status: first line\n  {continuation}\n          # retained trivia\nnext: keep\n"
        );
        assert!(saphyr::Yaml::load_from_str(&raw).is_ok(), "{raw:?}");
        let source = format!("---\n{raw}---\nBody");
        for unset in [false, true] {
            let plan = if unset {
                unset_field(&source, DocClass::UserDoc, "status")
            } else {
                set_field(&source, DocClass::UserDoc, "status", string("done"))
            }
            .unwrap();
            let changed = patch::apply(&source, &plan).unwrap();
            assert!(
                changed.contains("          # retained trivia\n"),
                "{changed:?}"
            );
            let after = Carrier::scan(&changed).unwrap();
            let actual =
                saphyr::Yaml::load_from_str(after.yaml.unwrap().slice(&changed).unwrap()).unwrap();
            let expected = saphyr::Yaml::load_from_str(if unset {
                "next: keep\n"
            } else {
                "status: done\nnext: keep\n"
            })
            .unwrap();
            assert_eq!(actual, expected);
        }
    }
}
