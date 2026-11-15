use notarium_core::{
    DomainResult, classes::DocClass, document::ChunkPlan, ids::*, span::ByteSpan, value::YamlValue,
};
use notarium_syntax::{
    carrier::Carrier,
    chunk::{self, TokenizerBudget},
    extract::{self, ExtractedDocDelta},
    frontmatter::*,
    markdown, patch,
};
use std::cell::Cell;

fn string(value: &str) -> YamlValue {
    YamlValue::String(value.into())
}

#[test]
fn empty_flow_values_compose_with_insertions_and_neighbor_deletions() {
    for header in ["{a:}", "{\"a\":}", "{b: other, a:}", "{a: }", "{a: null}"] {
        let source = format!("---\n{header}\n---\nBody🚀");
        let changes = [
            FieldEdit::Set {
                key: "a".into(),
                value: string("changed"),
            },
            FieldEdit::Set {
                key: "c".into(),
                value: string("inserted"),
            },
        ];
        let mut outputs = Vec::new();
        for edits in [changes.to_vec(), changes.into_iter().rev().collect()] {
            let plan = patch_frontmatter(&source, DocClass::UserDoc, &edits).unwrap();
            let changed = patch::apply(&source, &plan).unwrap();
            let fields = analyze(&changed, DocClass::UserDoc)
                .unwrap()
                .fields
                .unwrap();
            assert_eq!(fields["a"], string("changed"));
            assert_eq!(fields["c"], string("inserted"));
            assert!(changed.ends_with("---\nBody🚀"));
            outputs.push(changed);
        }
        assert_eq!(outputs[0], outputs[1]);
    }
    let source = "---\n{\"a\":,\"b\":\"other\"}\n---\nBody🚀";
    for edits in [
        vec![
            FieldEdit::Set {
                key: "a".into(),
                value: string("changed"),
            },
            FieldEdit::Unset { key: "b".into() },
        ],
        vec![
            FieldEdit::Unset { key: "b".into() },
            FieldEdit::Set {
                key: "a".into(),
                value: string("changed"),
            },
        ],
    ] {
        let changed = patch::apply(
            source,
            &patch_frontmatter(source, DocClass::UserDoc, &edits).unwrap(),
        )
        .unwrap();
        let fields = analyze(&changed, DocClass::UserDoc)
            .unwrap()
            .fields
            .unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields["a"], string("changed"));
        assert!(changed.ends_with("---\nBody🚀"));
    }
}

fn independent_titles(source: &str) -> Vec<String> {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    let mut titles = Vec::new();
    let mut current = None;
    for event in Parser::new(source) {
        match event {
            Event::Start(Tag::Heading { .. }) => current = Some(String::new()),
            Event::Text(text) | Event::Code(text) => {
                if let Some(title) = &mut current {
                    title.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(title) = &mut current {
                    title.push(' ');
                }
            }
            Event::End(TagEnd::Heading(_)) => titles.push(current.take().unwrap()),
            _ => {}
        }
    }
    titles
}

#[test]
fn replacing_a_section_preserves_the_next_setext_heading_semantics() {
    for source in [
        "# Selected\nold\n\nNext\n====\nkeep\n",
        "Selected\n========\nold\n\nNext\n====\nkeep\n",
        "> # Selected\n> old\n>\n> Next\n> ====\n> keep\n",
        "- # Selected\n  old\n\n  Next\n  ====\n  keep\n",
    ] {
        for eol in ["\n", "\r\n", "\r"] {
            let source = source.replace('\n', eol);
            for replacement in ["new", "new\n", "new\n\n", ""] {
                let plan = markdown::replace_section(
                    &source,
                    &markdown::SectionSelector {
                        title: "Selected".into(),
                        occurrence: None,
                    },
                    &replacement.replace('\n', eol),
                )
                .unwrap();
                let changed = patch::apply(&source, &plan).unwrap();
                assert_eq!(independent_titles(&changed), ["Selected", "Next"]);
                let end = plan.edits.first().map_or(0, |edit| edit.bytes.0.end());
                assert!(changed.ends_with(&source[end..]));
            }
        }
    }
}

#[derive(Default)]
struct CountingBudget {
    counted: Cell<usize>,
    offered: Cell<usize>,
    max_hint: Cell<usize>,
}
impl TokenizerBudget for CountingBudget {
    fn profile(&self) -> ModelProfileId {
        ModelProfileId::from_bytes([1; 16])
    }
    fn max_tokens(&self) -> u32 {
        512
    }
    fn count(&self, input: &str) -> DomainResult<u32> {
        self.counted.set(self.counted.get() + input.len());
        Ok(input.len() as u32 + 2)
    }
    fn split_hint(&self, input: &str, _: u32) -> Option<usize> {
        self.offered.set(self.offered.get() + input.len());
        self.max_hint.set(self.max_hint.get().max(input.len()));
        Some(input.len().min(510))
    }
}

#[test]
fn long_context_is_amortized_and_body_budget_is_retried_after_shortening() {
    for length in [1024, 4096, 16384] {
        let source = format!("# {}\n{}", "h".repeat(length), "a".repeat(512));
        let md = markdown::analyze(&source, Carrier::scan(&source).unwrap().body).unwrap();
        let budget = CountingBudget::default();
        let ChunkPlan::Ready { chunks, .. } = chunk::chunks(&source, &md, Some(&budget)).unwrap()
        else {
            panic!()
        };
        assert!(chunks.len() <= 8, "{} chunks for {length}", chunks.len());
        let body: String = chunks
            .iter()
            .flat_map(|c| &c.spans)
            .map(|span| span.slice(&source).unwrap())
            .collect();
        assert_eq!(body, "a".repeat(512));
        assert!(
            chunks
                .iter()
                .all(|c| c.tokens == c.text.len() as u32 + 2 && c.tokens <= 512)
        );
        assert!(budget.counted.get() < 40 * source.len());
    }
}

#[test]
fn tokenizer_hints_receive_bounded_utf8_windows() {
    let source = "hello🚀世界 ".repeat(10_000);
    let md = markdown::analyze(&source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
    let budget = CountingBudget::default();
    let ChunkPlan::Ready { chunks, .. } = chunk::chunks(&source, &md, Some(&budget)).unwrap()
    else {
        panic!()
    };
    let body: String = chunks
        .iter()
        .flat_map(|c| &c.spans)
        .map(|span| span.slice(&source).unwrap())
        .collect();
    assert_eq!(body, source);
    assert!(budget.max_hint.get() <= 512 * 16);
    assert!(budget.offered.get() < 40 * source.len());
}

#[test]
fn unmatched_wiki_openers_do_not_skip_later_tags_or_cross_code_masks() {
    for suffix in [" #kept", " ]] #kept", " `]]` #kept"] {
        let source = format!("{}{}", "text [[unclosed ".repeat(1024), suffix);
        let ExtractedDocDelta::Plain(delta) = extract::extract(
            &source,
            DocClass::UserDoc,
            &NoteId::from_bytes([1; 16]),
            "title",
            None,
        )
        .unwrap() else {
            panic!()
        };
        assert!(delta.tags.iter().any(|tag| tag.key == "kept"));
        assert_eq!(delta.links.len(), usize::from(suffix == " ]] #kept"));
    }
}
