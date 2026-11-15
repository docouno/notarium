//! Mandatory byte-exactness gate. The floor cannot be lowered by PROPTEST_CASES.
use notarium_core::{classes::DocClass, ids::*, span::ByteSpan, value::YamlValue};
use notarium_syntax::{
    carrier::Carrier,
    encrypted, extract,
    frontmatter::{self, FieldEdit},
    live, markdown, patch,
};
use proptest::{
    prelude::*,
    test_runner::{Config, FileFailurePersistence, RngSeed, TestRunner},
};
use std::{cell::Cell, io::Write};

#[test]
fn at_least_ten_thousand_generated_documents_preserve_untouched_bytes() {
    let defaults = Config::default();
    let cases = defaults.cases.max(10_000);
    let seed = match defaults.rng_seed {
        RngSeed::Random => RngSeed::Fixed(0x202611150002),
        fixed => fixed,
    };
    let persistence: &'static str = Box::leak(
        format!(
            "{}/../../target/syntax-proptest-regressions.txt",
            env!("CARGO_MANIFEST_DIR")
        )
        .into_boxed_str(),
    );
    let config = Config {
        cases,
        rng_seed: seed,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct(persistence))),
        ..defaults
    };
    let strategy = (
        0usize..22,
        any::<u32>(),
        any::<bool>(),
        any::<bool>(),
        prop::collection::vec(
            prop::sample::select(vec![
                "a",
                "я",
                "é",
                "e\u{301}",
                "世界",
                "🚀",
                "👩‍💻",
                "#",
                "'",
                "---",
                " ",
            ]),
            1..16,
        ),
    );
    let counts = Cell::new([0u32; 22]);
    let outcome = TestRunner::new(config).run(&strategy, |(family, number, crlf, bom, parts)| {
        let eol = if crlf { "\r\n" } else { "\n" };
        let bom = if bom { "\u{feff}" } else { "" };
        let text = parts.concat();
        let body_eol = if number % 3 == 0 { "\n" } else { eol };
        let mut body = format!("# Heading{body_eol}{text}{body_eol}\n```text{body_eol}[[ignored]] #ignored{body_eol}```{body_eol}");
        if number % 2 == 0 { body.truncate(body.len() - body_eol.len()); }
        let header = format!("{bom}---{eol}title: \"Unicode 🚀\" # retained{eol}status: old # retained status{eol}custom: {{nested: [1, true]}}{eol}---{eol}");
        let source = format!("{header}{body}");
        let new = format!("value{number}");
        let value = YamlValue::String(new.clone());
        match family {
            0 => {
                let plan = frontmatter::set_field(&source, DocClass::UserDoc, "status", value.clone()).unwrap();
                let expected = source.replacen("status: old", &format!("status: {new}"), 1);
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected.as_str());
                let start = source.find("old # retained status").unwrap();
                prop_assert_eq!(plan.edits[0].bytes.0, ByteSpan::new(start, start + 3).unwrap());
                prop_assert_eq!(plan.edits[0].utf16.0.start(), source[..start].encode_utf16().count());
                prop_assert!(frontmatter::set_field(&expected, DocClass::UserDoc, "status", value).unwrap().edits.is_empty());
            }
            1 => {
                let plan = frontmatter::unset_field(&source, DocClass::UserDoc, "status").unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), source.replacen("status: old", " ", 1));
            }
            2 => {
                let source = format!("{bom}---{eol}{{title: '🚀', status: old, # comment{eol} custom: [1, 2],}}{eol}---{eol}{body}");
                let plan = frontmatter::set_field(&source, DocClass::UserDoc, "status", value).unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), source.replacen("status: old", &format!("status: {new}"), 1));
            }
            3 => {
                let source = format!("{header}> # Selected{eol}> old{eol}{eol}{body}");
                let plan = markdown::replace_section(&source, &markdown::SectionSelector { title: "Selected".into(), occurrence: None }, &format!("{new}{eol}")).unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), source.replacen("> old", &format!("> {new}"), 1));
            }
            4 => {
                let desired = source.replacen("# retained status", &format!("# {new}"), 1);
                let plan = live::raw_header_plan(&source, &desired, DocClass::UserDoc, HeaderIdentity::from_bytes([1;16])).unwrap();
                prop_assert!(plan.semantic_delta.is_empty());
                let state = live::RoomCarrierState { header_identity: HeaderIdentity::from_bytes([1;16]), base_carrier: source.clone(), pending_fields: [("status".into(), Some(value))].into() };
                let merged = live::merge_raw_header(&state, &plan, DocClass::UserDoc, HeaderIdentity::from_bytes([2;16])).unwrap();
                prop_assert_eq!(merged.final_carrier, desired.replacen("status: old", &format!("status: {new}"), 1));
            }
            5 => {
                let source = format!("{source}{eol}```nota{eol}type: table # config{eol}```{eol}");
                let plan = extract::finalize_document(&source, DocClass::UserDoc, &NoteId::from_bytes([2;16]), &[]).unwrap();
                prop_assert_eq!(plan.edits.len(), 1);
                let changed = patch::apply(&source, &plan).unwrap();
                prop_assert_eq!(changed.replacen(&plan.edits[0].replacement, "", 1), source.as_str());
                prop_assert!(extract::finalize_document(&changed, DocClass::UserDoc, &NoteId::from_bytes([2;16]), &[]).unwrap().edits.is_empty());
            }
            6 | 7 => {
                let invalid = if family == 6 { "x: 1\nx: 2" } else { "x: &ref 1\ny: *ref" }.replace('\n', eol);
                let source = format!("{bom}---{eol}{invalid}{eol}---{eol}{body}");
                prop_assert!(!frontmatter::analyze(&source, DocClass::UserDoc).unwrap().writable);
                prop_assert!(frontmatter::set_field(&source, DocClass::UserDoc, "status", value).is_err());
                let plan = extract::finalize_document(&source, DocClass::UserDoc, &NoteId::from_bytes([2;16]), &[]).unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), source);
            }
            8 => {
                prop_assert!(frontmatter::set_field(&source, DocClass::UserDoc, "class", value).is_err());
                let poisoned = source.replacen("custom: {nested: [1, true]}", "custom: {__proto__: x}", 1);
                prop_assert!(frontmatter::analyze(&poisoned, DocClass::UserDoc).is_err());
            }
            9 => {
                let source = source.replacen("custom: {nested: [1, true]}", &format!("custom: |{eol}  \"unbalanced quote is scalar data{eol}  ---{eol}  # 🚀"), 1);
                let plan = frontmatter::set_field(&source, DocClass::UserDoc, "status", value).unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), source.replacen("status: old", &format!("status: {new}"), 1));
            }
            10 => {
                let armor = include_str!("fixtures/age-v1.asc").replace('\n', eol);
                let source = format!("{bom}---{eol}class: encrypted-note{eol}---{eol}```age{eol}{armor}```{eol}");
                prop_assert!(encrypted::validate(&source).is_ok());
                let with_plaintext = format!("{source}<!-- {text} -->{eol}");
                prop_assert!(encrypted::validate(&with_plaintext).is_err());
            }
            11 => {
                let plan = frontmatter::patch_frontmatter(&source, DocClass::UserDoc, &[FieldEdit::Set { key: "status".into(), value }, FieldEdit::Unset { key: "custom".into() }]).unwrap();
                let expected = source.replacen("status: old", &format!("status: {new}"), 1).replacen("custom: {nested: [1, true]}", "   ", 1);
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
            }
            12 => {
                let bracket = if number % 2 == 0 { '[' } else { '{' };
                let source = format!("{bom}---{eol}title: An {bracket}example{eol}status: old{eol}---{eol}{body}");
                let plan = frontmatter::set_field(&source, DocClass::UserDoc, "status", value).unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), source.replacen("status: old", &format!("status: {new}"), 1));
                let source = format!("---{eol}{{url: https://example.test/{number}, status: old}}{eol}---{eol}");
                let value = YamlValue::String(format!("{new},[tail]"));
                let plan = frontmatter::set_field(&source, DocClass::UserDoc, "status", value.clone()).unwrap();
                let changed = patch::apply(&source, &plan).unwrap();
                prop_assert_eq!(&frontmatter::analyze(&changed, DocClass::UserDoc).unwrap().fields.unwrap()["status"], &value);
                prop_assert_eq!(changed, source.replace("status: old", &format!("status: \"{new},[tail]\"")));
            }
            13 => {
                let (prefix, continuation) = if number % 2 == 0 { (">   ", "> ") } else { ("> - ", ">   ") };
                let flow = if number % 3 == 0 {
                    format!("{{url: https://example.test/{number}, type: table, # keep{eol}{continuation}}}")
                } else { format!("{{url: https://example.test/{number}, type: table}}") };
                let source = format!("{prefix}```nota{eol}{continuation}{flow}{eol}{continuation}```{eol}");
                let plan = extract::finalize_document(&source, DocClass::UserDoc, &NoteId::from_bytes([2;16]), &[]).unwrap();
                prop_assert_eq!(plan.edits.len(), 1);
                let changed = patch::apply(&source, &plan).unwrap();
                let mut logical = String::new();
                for event in pulldown_cmark::Parser::new(&changed) {
                    if let pulldown_cmark::Event::Text(text) = event { logical.push_str(&text); }
                }
                let parsed = frontmatter::analyze(&format!("---\n{logical}---\n"), DocClass::UserDoc).unwrap();
                prop_assert!(parsed.fields.unwrap().contains_key("id"));
                prop_assert_eq!(changed.replacen(&plan.edits[0].replacement, "", 1), source);
            }
            14 => {
                let armor = include_str!("fixtures/age-v1.asc");
                let source = format!("---\nclass: encrypted-note\n---\n# Title\rsecret {number}\n```age\n{armor}```\n");
                prop_assert!(encrypted::validate(&source).is_err());
                let source = format!("---{eol}? class{eol}: encrypted-note{eol}x: 1{eol}x: 2{eol}---{eol}{body}");
                prop_assert!(extract::extract(&source, DocClass::UserDoc, &NoteId::from_bytes([2;16]), "Title", None).is_err());
            }
            15 => {
                let source = format!("- Item{number}{eol}  - Nested{number}{eol}- Last{number}{eol}");
                let md = markdown::analyze(&source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
                for word in [format!("Item{number}"), format!("Nested{number}"), format!("Last{number}")] {
                    let start = source.find(&word).unwrap();
                    prop_assert_eq!(md.blocks.iter().filter(|s| s.start() <= start && s.end() >= start + word.len()).count(), 1);
                }
            }
            16 => {
                let prefix = if number % 2 == 0 { "> " } else { "> > " };
                let source = format!("{prefix}# A{eol}{prefix}old{eol}{prefix}# B{eol}{prefix}keep{eol}");
                let plan = markdown::replace_section(&source, &markdown::SectionSelector { title: "A".into(), occurrence: None }, &format!("{new}{eol}")).unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), source.replace("old", &new));
            }
            17 => {
                let info = if number % 2 == 0 { "text" } else { "nota" };
                let source = format!("\u{feff}```{info}{eol}type: table{eol}```{eol}");
                let plan = extract::finalize_document(&source, DocClass::UserDoc, &NoteId::from_bytes([2;16]), &[]).unwrap();
                let changed = patch::apply(&source, &plan).unwrap();
                prop_assert!(extract::extract(&changed, DocClass::UserDoc, &NoteId::from_bytes([2;16]), "Title", None).is_ok());
                if info == "text" { prop_assert_eq!(changed, source); }
                else {
                    prop_assert_eq!(plan.edits.len(), 1);
                    prop_assert_eq!(changed.replacen(&plan.edits[0].replacement, "", 1), source);
                }
            }
            18 => {
                let source = format!("{bom}---{eol}status: {{a: x, # {new}{eol} b: y}}{eol}next: keep{eol}---{eol}{body}");
                let expected = format!("{bom}---{eol}   # {new}{eol}  {eol}next: keep{eol}---{eol}{body}");
                let plan = frontmatter::unset_field(&source, DocClass::UserDoc, "status").unwrap();
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
            }
            19 => {
                let layout = number % 4;
                let (prefix, parent, replacement, erased) = match layout {
                    0 => ("status: ", 0, format!("status: {new} # marker{eol}"), format!("  # marker{eol}")),
                    1 => ("status:\n  child: ", 2, format!("status:{eol}  {new}{eol}"), format!("{eol}    # marker{eol}")),
                    2 => ("status:\n  - ", 2, format!("status:{eol}  {new}{eol}"), format!("{eol}    # marker{eol}")),
                    _ => ("status:\n- ", 0, format!("status:{eol}  {new}{eol}"), format!("{eol}  # marker{eol}")),
                };
                let marker = ["|", ">-", "|4+", ">-4"][((number / 4) % 4) as usize];
                let data_indent = " ".repeat(parent + 4);
                let outside = format!("{}# outside {new}{eol}", " ".repeat(parent + 2));
                let suffix = if number % 3 == 0 { String::new() } else { format!("next: keep{eol}") };
                let raw = format!("{}{marker} # marker{eol}{data_indent}# scalar data {text}{eol}{outside}{suffix}", prefix.replace('\n', eol));
                let source = format!("{bom}---{eol}{raw}---{eol}{body}");
                let plan = frontmatter::set_field(&source, DocClass::UserDoc, "status", value).unwrap();
                let expected = format!("{bom}---{eol}{replacement}{outside}{suffix}---{eol}{body}");
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
                let plan = frontmatter::unset_field(&source, DocClass::UserDoc, "status").unwrap();
                let expected = format!("{bom}---{eol}{erased}{outside}{suffix}---{eol}{body}");
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
            }
            20 => {
                let marker_indent = " ".repeat((number % 8 + 1) as usize);
                let content_indent = " ".repeat((number / 8 % 8 + 1) as usize);
                let marker = if number % 2 == 0 { "|" } else { ">-" };
                let source = format!("{bom}---{eol}status:{eol}{marker_indent}{marker} # marker{eol}{content_indent}\"data [ {{ {text}{eol}# outside{eol}next: keep{eol}---{eol}{body}");
                let plan = frontmatter::set_field(&source, DocClass::UserDoc, "status", value).unwrap();
                let expected = format!("{bom}---{eol}status:{eol}{marker_indent}{new} # marker{eol}# outside{eol}next: keep{eol}---{eol}{body}");
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
                let plan = frontmatter::unset_field(&source, DocClass::UserDoc, "status").unwrap();
                let expected = format!("{bom}---{eol}{eol}{marker_indent} # marker{eol}# outside{eol}next: keep{eol}---{eol}{body}");
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
            }
            _ => {
                let (first, continuation) = [("", ""), ("> ", "> "), ("> - ", ">   "), ("- ", "  "), ("1. ", "   ")][(number % 5) as usize];
                let suffix = if number % 2 == 0 { String::new() } else { format!("{eol}{continuation}# B{eol}{continuation}keep") };
                let source = format!("{header}{first}# A{suffix}");
                let plan = markdown::replace_section(&source, &markdown::SectionSelector { title: "A".into(), occurrence: None }, &new).unwrap();
                let expected = format!("{header}{first}# A{eol}{continuation}{new}{suffix}");
                prop_assert_eq!(patch::apply(&source, &plan).unwrap(), expected);
            }
        }
        // Independent UTF-16 oracle over every scalar boundary of the generated carrier.
        let carrier = Carrier::scan(&source).unwrap();
        for (end, _) in source.char_indices().chain(std::iter::once((source.len(), '\0'))) {
            let span = ByteSpan::new(0, end).unwrap();
            prop_assert_eq!(span.to_utf16(&source).unwrap().end(), source[..end].encode_utf16().count());
        }
        prop_assert_eq!(carrier.body.slice(&source).unwrap(), body.as_str());
        let mut totals = counts.get(); totals[family] += 1; counts.set(totals);
        Ok(())
    });
    let counts = counts.get();
    let rejected = counts[6] + counts[7] + counts[8] + counts[14];
    let accepted = counts.iter().sum::<u32>() - rejected;
    writeln!(std::io::stdout().lock(), "generated-documents: floor=10000 cases={cases} seed={seed} accepted={accepted} rejected={rejected} families={counts:?} (including persisted regression replays)").unwrap();
    outcome.unwrap();
    assert!(counts.into_iter().all(|n| n > 0));
    assert!(counts.into_iter().sum::<u32>() >= 10_000);
}
