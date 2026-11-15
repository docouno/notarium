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

#[test]
fn neighboring_section_prefixes_remain_byte_exact() {
    for eol in ["\n", "\r\n"] {
        for source in [
            "> # A\n> old\n> # B\n> keep\n",
            "- # A\n  old\n  # B\n  keep\n",
            "> - # A\n>   old\n>   # B\n>   keep\n",
            "> > # A\n> > old\n> > # B\n> > keep\n",
        ] {
            let source = source.replace('\n', eol);
            let plan = replace_section(
                &source,
                &SectionSelector {
                    title: "A".into(),
                    occurrence: None,
                },
                &format!("new{eol}"),
            )
            .unwrap();
            assert_eq!(
                patch::apply(&source, &plan).unwrap(),
                source.replace("old", "new")
            );
        }
    }
}

#[test]
fn empty_sections_preserve_headings_at_eof_and_before_neighbors() {
    for (heading, prefix) in [
        ("# A", ""),
        ("> # A", "> "),
        ("- # A", "  "),
        ("> - # A", ">   "),
        ("> > # A", "> > "),
        ("1. # A", "   "),
        ("> 1. # A", ">    "),
        ("A\n===", ""),
        ("> A\n> ===", "> "),
    ] {
        for eol in ["\n", "\r\n"] {
            for header in ["", "\u{feff}", "\u{feff}---\nstatus: old\n---\n"] {
                let header = header.replace('\n', eol);
                let heading = heading.replace('\n', eol);
                for ending in 0..3 {
                    let neighbor = format!("{prefix}# B{eol}{prefix}keep");
                    let source = match ending {
                        0 => format!("{header}{heading}"),
                        1 => format!("{header}{heading}{eol}"),
                        _ => format!("{header}{heading}{eol}{neighbor}"),
                    };
                    for logical in [
                        String::new(),
                        "new".into(),
                        format!("new{eol}"),
                        format!("new{eol}second"),
                    ] {
                        let body = if logical.is_empty() {
                            String::new()
                        } else {
                            logical
                                .split_inclusive('\n')
                                .map(|line| format!("{prefix}{line}"))
                                .collect::<String>()
                        };
                        let expected = match ending {
                            0 if body.is_empty() => source.clone(),
                            0 => format!(
                                "{source}{}{body}",
                                if !heading.contains('\n') && !header.contains('\n') {
                                    "\n"
                                } else {
                                    eol
                                }
                            ),
                            1 => format!("{source}{body}"),
                            _ => format!(
                                "{header}{heading}{eol}{body}{}{neighbor}",
                                if !body.is_empty() && !body.ends_with('\n') {
                                    eol
                                } else {
                                    ""
                                }
                            ),
                        };
                        let plan = replace_section(
                            &source,
                            &SectionSelector {
                                title: "A".into(),
                                occurrence: None,
                            },
                            &logical,
                        )
                        .unwrap();
                        let changed = patch::apply(&source, &plan).unwrap();
                        assert_eq!(
                            changed, expected,
                            "source={source:?} replacement={logical:?}"
                        );
                        let after =
                            analyze(&changed, Carrier::scan(&changed).unwrap().body).unwrap();
                        let titles: Vec<_> =
                            after.headings.iter().map(|h| h.title.as_str()).collect();
                        assert_eq!(
                            titles,
                            if ending == 2 {
                                vec!["A", "B"]
                            } else {
                                vec!["A"]
                            }
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn replacement_line_endings_preserve_every_container_and_neighbor() {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};

    for (heading, prefix, depth) in [
        ("# A", "", 0),
        ("> # A", "> ", 1),
        ("- # A", "  ", 1),
        ("> - # A", ">   ", 2),
        ("> > # A", "> > ", 2),
        ("1. # A", "   ", 1),
        ("> 1. # A", ">    ", 2),
        ("A\n===", "", 0),
        ("> A\n> ===", "> ", 1),
    ] {
        for eol in ["\n", "\r\n", "\r"] {
            let heading = heading.replace('\n', eol);
            for first in ["\n", "\r\n", "\r"] {
                for second in ["\n", "\r\n", "\r"] {
                    for layout in 0..4 {
                        let neighbor = format!("{prefix}# B{eol}{prefix}keep");
                        let source = match layout {
                            0 => heading.clone(),
                            1 => format!("{heading}{eol}{prefix}old"),
                            2 => format!("{heading}{eol}{prefix}old{eol}{neighbor}"),
                            _ => format!("{heading}{eol}{neighbor}"),
                        };
                        let logical = format!("# C{first}# D{second}text🚀");
                        let inserted =
                            format!("{prefix}# C{first}{prefix}# D{second}{prefix}text🚀");
                        let separator = if layout == 0 && !heading.contains(['\r', '\n']) {
                            "\n"
                        } else {
                            eol
                        };
                        let expected = if layout < 2 {
                            format!("{heading}{separator}{inserted}")
                        } else {
                            format!("{heading}{eol}{inserted}{eol}{neighbor}")
                        };
                        let plan = replace_section(
                            &source,
                            &SectionSelector {
                                title: "A".into(),
                                occurrence: None,
                            },
                            &logical,
                        )
                        .unwrap();
                        let changed = patch::apply(&source, &plan).unwrap();
                        assert_eq!(changed, expected, "source={source:?}, logical={logical:?}");

                        // Independent CommonMark consumer: new headings must stay
                        // in the selected quote/list item, including bare-CR lines.
                        let mut ancestry = 0;
                        let mut title = None;
                        let mut headings = Vec::new();
                        for event in Parser::new(&changed) {
                            match event {
                                Event::Start(Tag::BlockQuote(_) | Tag::Item) => ancestry += 1,
                                Event::End(TagEnd::BlockQuote(_) | TagEnd::Item) => ancestry -= 1,
                                Event::Start(Tag::Heading { .. }) => title = Some(String::new()),
                                Event::Text(text) => {
                                    if let Some(title) = &mut title {
                                        title.push_str(&text);
                                    }
                                }
                                Event::End(TagEnd::Heading(_)) => {
                                    headings.push((title.take().unwrap(), ancestry))
                                }
                                _ => {}
                            }
                        }
                        let expected: Vec<_> = if layout < 2 {
                            vec!["A", "C", "D"]
                        } else {
                            vec!["A", "C", "D", "B"]
                        }
                        .into_iter()
                        .map(|title| (title.to_owned(), depth))
                        .collect();
                        assert_eq!(headings, expected, "{changed:?}");
                    }
                }
            }
        }
    }
}
