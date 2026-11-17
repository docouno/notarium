use notarium_core::{DomainResult, classes::DocClass, document::*, ids::*, span::ByteSpan};
use notarium_syntax::{
    carrier::Carrier,
    chunk::{self, TokenizerBudget},
    extract::{self, ExtractedDocDelta},
    markdown, nota, patch,
};

fn views(source: &str, insert: bool) -> nota::NotaAnalysis {
    let body = Carrier::scan(source).unwrap().body;
    let md = markdown::analyze(source, body).unwrap();
    nota::analyze(source, body, &NoteId::from_bytes([9; 16]), &md, insert).unwrap()
}
#[test]
fn view_ids_are_persisted_once_and_ambiguous_input_defers_insertion() {
    for source in [
        "```nota\ntype: table # keep\n```\n",
        "> ```nota\n> type: table # keep\n> ```\n",
        "- ```nota\n  {type: table} # keep\n  ```\n",
    ] {
        let initial = views(source, true);
        assert_eq!(initial.blocks.len(), 1);
        assert_eq!(initial.blocks[0].state, ViewState::Ready);
        let changed = patch::apply(source, &initial.plan).unwrap();
        assert!(changed.contains("# keep"));
        let repeated = views(&changed, true);
        assert_eq!(repeated.blocks[0].id, initial.blocks[0].id);
        assert!(repeated.plan.edits.is_empty());
        let moved = format!("# New context\n{changed}");
        assert_eq!(views(&moved, true).blocks[0].id, initial.blocks[0].id);
    }
    for broken in ["```nota\ntype: [\n```\n", "```nota\ntype: table\n"] {
        let source = format!("```nota\ntype: table\n```\n\n{broken}");
        let result = views(&source, true);
        assert!(result.plan.edits.is_empty());
        assert_ne!(result.blocks[1].state, ViewState::Ready);
        let final_plan = extract::finalize_document(
            &source,
            DocClass::UserDoc,
            &NoteId::from_bytes([1; 16]),
            &[],
        )
        .unwrap();
        assert_eq!(patch::apply(&source, &final_plan).unwrap(), source);
    }
}
#[test]
fn explicit_ids_survive_invalid_edits_and_duplicate_ids_never_execute() {
    let id = ViewKey::from_bytes([7; 16]);
    let valid = format!("```nota\nid: {id}\ntype: table\n```\n");
    assert_eq!(views(&valid, true).blocks[0].state, ViewState::Ready);
    let invalid = valid.replace("type: table", "type: [");
    assert_eq!(views(&invalid, true).blocks[0].state, ViewState::Invalid);
    assert!(views(&invalid, true).plan.edits.is_empty());
    assert_eq!(views(&valid, true).blocks[0].id, Some(id));
    let duplicate = format!("{valid}\n{valid}");
    assert!(
        views(&duplicate, true)
            .blocks
            .iter()
            .all(|b| b.state == ViewState::Invalid && !b.diagnostics.is_empty())
    );
    let example = format!("````markdown\n{valid}````\n");
    assert!(views(&example, true).blocks.is_empty());
}
#[test]
fn links_tags_and_headings_share_byte_offsets_but_never_parse_code_or_escapes() {
    let note = NoteId::from_bytes([2; 16]);
    let source = format!(
        "# Café\n[[../Straße/e\u{301}|Label]] [[{note}]] #Straße #STRASSE\n\\[[escaped]] \\#escaped `[[code]] #code`\n```text\n[[fenced]] #fenced\n```\n"
    );
    let ExtractedDocDelta::Plain(result) =
        extract::extract(&source, DocClass::UserDoc, &note, "CAFÉ", None).unwrap()
    else {
        panic!()
    };
    assert_eq!(result.slug_fold, "café");
    assert_eq!(result.headings.len(), 1);
    assert_eq!(result.links.len(), 2);
    assert_eq!(
        result.links[0].span.slice(&source).unwrap(),
        "[[../Straße/e\u{301}|Label]]"
    );
    assert_eq!(
        result.links[0].target,
        WikiTargetKind::NamePath {
            absolute: false,
            directory: vec![
                LinkNavigation::Parent,
                LinkNavigation::Named("strasse".into())
            ],
            leaf_key: "é".into()
        }
    );
    assert_eq!(result.links[1].target, WikiTargetKind::StableNoteId(note));
    assert_eq!(result.tags.len(), 1);
    assert_eq!(result.tags[0].key, "strasse");
    assert_eq!(result.tags[0].source_spans.len(), 2);
}

// Fixed greedy vocabulary with UTF-8 byte fallback and two serving special tokens.
// This is an exact fixture tokenizer, not a character/word-count estimate.
struct FixtureTokenizer {
    limit: u32,
    model: u8,
}
fn fixture_pieces(mut text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    while !text.is_empty() {
        let word = ["hello", "world", "🚀", "\n\n"]
            .into_iter()
            .find(|word| text.starts_with(word));
        let end = word
            .map(str::len)
            .unwrap_or_else(|| text.chars().next().unwrap().len_utf8());
        pieces.push(&text[..end]);
        text = &text[end..];
    }
    pieces
}
impl TokenizerBudget for FixtureTokenizer {
    fn profile(&self) -> ModelProfileId {
        ModelProfileId::from_bytes([self.model; 16])
    }
    fn max_tokens(&self) -> u32 {
        self.limit
    }
    fn count(&self, text: &str) -> DomainResult<u32> {
        Ok(2 + fixture_pieces(text)
            .iter()
            .map(|s| {
                if ["hello", "world", "🚀", "\n\n"].contains(s) {
                    1
                } else {
                    s.len() as u32
                }
            })
            .sum::<u32>())
    }
    fn split_hint(&self, _text: &str, _budget: u32) -> Option<usize> {
        Some(3)
    } // intentionally inside an emoji sometimes
}
#[test]
fn chunks_count_the_actual_model_input_and_cover_oversized_blocks_without_loss() {
    let tokenizer = FixtureTokenizer {
        limit: 48,
        model: 1,
    };
    assert_eq!(tokenizer.count("hello world🚀").unwrap(), 6);
    assert_eq!(tokenizer.count("é").unwrap(), 4);
    for body in [
        "hello world🚀 ".repeat(180),
        format!("```rust\n{}\n```\n", "let x = 1;\n".repeat(100)),
        format!(
            "| head | value |\n| --- | --- |\n{}",
            "| 🚀 | hello world |\n".repeat(90)
        ),
    ] {
        let source = format!("# Heading\n{body}");
        let md = markdown::analyze(&source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
        let plan = chunk::chunks(&source, &md, Some(&tokenizer)).unwrap();
        let ChunkPlan::Ready { chunks, .. } = &plan else {
            panic!()
        };
        assert!(chunks.len() > 1);
        for c in chunks {
            assert_eq!(c.tokens, tokenizer.count(&c.text).unwrap());
            assert!(c.tokens <= tokenizer.limit);
            for span in &c.spans {
                assert!(c.text.ends_with(span.slice(&source).unwrap()));
            }
        }
        for block in &md.blocks {
            let mut position = block.start();
            for span in chunks
                .iter()
                .flat_map(|c| &c.spans)
                .filter(|s| s.start() >= block.start() && s.end() <= block.end())
            {
                assert_eq!(span.start(), position);
                position = span.end();
            }
            assert_eq!(position, block.end());
        }
        assert_eq!(plan, chunk::chunks(&source, &md, Some(&tokenizer)).unwrap());
        let ChunkPlan::Ready { chunks: other, .. } = chunk::chunks(
            &source,
            &md,
            Some(&FixtureTokenizer {
                model: 2,
                ..tokenizer
            }),
        )
        .unwrap() else {
            panic!()
        };
        assert!(chunks.iter().zip(other).all(|(a, b)| a.key != b.key));
        assert!(matches!(
            chunk::chunks(&source, &md, None).unwrap(),
            ChunkPlan::Deferred { .. }
        ));
    }
}
#[test]
fn a_breadcrumb_larger_than_the_budget_is_reduced_without_losing_source() {
    let source = format!("# {}\n🚀hello world\n", "heading".repeat(50));
    let md = markdown::analyze(&source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
    let ChunkPlan::Ready { chunks, .. } =
        chunk::chunks(&source, &md, Some(&FixtureTokenizer { limit: 8, model: 1 })).unwrap()
    else {
        panic!()
    };
    let actual: String = chunks
        .iter()
        .flat_map(|c| &c.spans)
        .map(|s| s.slice(&source).unwrap())
        .collect();
    assert_eq!(actual, "🚀hello world\n");
}

#[test]
fn five_hundred_line_carrier_combines_field_and_view_edits_without_other_changes() {
    let original = include_str!("fixtures/complex-500.md");
    assert_eq!(original.lines().count(), 500);
    let note = NoteId::from_bytes([3; 16]);
    for source in [
        original.to_owned(),
        format!("\u{feff}{}", original.replace('\n', "\r\n")),
    ] {
        let plan = extract::finalize_document(
            &source,
            DocClass::UserDoc,
            &note,
            &[notarium_syntax::frontmatter::FieldEdit::Set {
                key: "status".into(),
                value: notarium_core::value::YamlValue::String("done".into()),
            }],
        )
        .unwrap();
        assert_eq!(plan.edits.len(), 2);
        let output = patch::apply(&source, &plan).unwrap();
        let result = views(&output, false);
        assert_eq!(result.blocks.len(), 2);
        assert_eq!(
            result.blocks[0].id.as_ref().unwrap().as_str(),
            "v_11111111111111111111111111111111"
        );
        let id = result.blocks[1].id.as_ref().unwrap();
        let eol = if source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let expected = source.replacen("status: old", "status: done", 1).replacen(
            &format!("type: board # missing identity{eol}"),
            &format!("type: board # missing identity{eol}\"id\": \"{id}\"{eol}"),
            1,
        );
        assert_eq!(output, expected);
        assert!(
            extract::finalize_document(&output, DocClass::UserDoc, &note, &[])
                .unwrap()
                .edits
                .is_empty()
        );
        let identity = BodyIdentity::from_bytes([1; 16]);
        let body_plan = patch::body_plan(&source, &plan, identity.clone()).unwrap();
        assert_eq!(body_plan.edits.len(), 1);
        assert_eq!(
            patch::apply_body(
                Carrier::scan(&source).unwrap().body.slice(&source).unwrap(),
                &identity,
                &body_plan
            )
            .unwrap(),
            Carrier::scan(&output).unwrap().body.slice(&output).unwrap()
        );
    }
}

#[test]
fn adversarial_yaml_depth_is_bounded_before_constructing_a_recursive_tree() {
    let source = format!(
        "```nota\nvalue: {}0{}\n```\n",
        "[".repeat(20_000),
        "]".repeat(20_000)
    );
    let analysis = views(&source, true);
    assert_eq!(analysis.blocks[0].state, ViewState::Invalid);
    assert!(analysis.plan.edits.is_empty());
}

#[test]
fn tight_list_text_is_covered_without_relying_on_the_analyzers_block_list() {
    let tokenizer = FixtureTokenizer {
        limit: 48,
        model: 1,
    };
    for source in [
        "- One\n- Two\n",
        "Intro\n\n- One\n  - Nested\n- Two\n",
        "> - One\n> - Two\n",
    ] {
        let md = markdown::analyze(source, ByteSpan::new(0, source.len()).unwrap()).unwrap();
        let ChunkPlan::Ready { chunks, .. } = chunk::chunks(source, &md, Some(&tokenizer)).unwrap()
        else {
            panic!()
        };
        for word in ["One", "Two", "Nested", "Intro"] {
            if let Some(start) = source.find(word) {
                for offset in start..start + word.len() {
                    assert_eq!(
                        chunks
                            .iter()
                            .flat_map(|c| &c.spans)
                            .filter(|s| s.start() <= offset && offset < s.end())
                            .count(),
                        1
                    );
                }
            }
        }
    }
}

fn commonmark_fence_text(source: &str) -> String {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    let mut code = false;
    let mut result = String::new();
    for event in Parser::new(source) {
        match event {
            Event::Start(Tag::CodeBlock(_)) => code = true,
            Event::End(TagEnd::CodeBlock) => code = false,
            Event::Text(text) if code => result.push_str(&text),
            _ => {}
        }
    }
    result
}

#[test]
fn persisted_view_identity_uses_canonical_dedent_and_physical_line_endings() {
    for source in [
        ">   ```nota\n> type: table\n>   ```\n",
        "  ```nota\n type: table\n  ```\n",
        "- ```nota\n  type: table\n  ```\n",
        "> - ```nota\n>   type: table\n>   ```\n",
        ">   ```nota\n>   ```\n",
        "```nota\n{url: https://example.test, type: table}\n```\n",
    ] {
        for eol in ["\n", "\r\n"] {
            let source = source.replace('\n', eol);
            let initial = views(&source, true);
            if commonmark_fence_text(&source).is_empty() {
                assert_eq!(initial.blocks[0].state, ViewState::Invalid);
                assert!(initial.plan.edits.is_empty());
                continue;
            }
            assert_eq!(initial.blocks[0].raw_yaml, commonmark_fence_text(&source));
            let changed = patch::apply(&source, &initial.plan).unwrap();
            assert_eq!(initial.plan.edits.len(), 1, "{source}");
            let logical = commonmark_fence_text(&changed);
            let carrier = format!("---\n{logical}---\n");
            let fields = notarium_syntax::frontmatter::analyze(&carrier, DocClass::UserDoc)
                .unwrap()
                .fields
                .unwrap();
            assert_eq!(
                fields["id"],
                notarium_core::value::YamlValue::String(
                    initial.blocks[0].id.as_ref().unwrap().to_string()
                )
            );
            assert_eq!(
                changed.replacen(&initial.plan.edits[0].replacement, "", 1),
                source
            );
            assert!(views(&changed, true).plan.edits.is_empty());
        }
    }
}

#[test]
fn fence_indentation_matrix_roundtrips_through_an_independent_parser() {
    for prefix in ["", "> ", "- ", "> - "] {
        let continuation = prefix.replace('-', " ");
        for opening in 0..=3 {
            for content in 0..=4 {
                let source = format!(
                    "{prefix}{}```nota\n{continuation}{}type: table\n{continuation}```\n",
                    " ".repeat(opening),
                    " ".repeat(content)
                );
                let initial = views(&source, true);
                let changed = patch::apply(&source, &initial.plan).unwrap();
                let logical = commonmark_fence_text(&changed);
                if initial
                    .blocks
                    .first()
                    .is_some_and(|block| block.state == ViewState::Ready)
                {
                    let header = format!("---\n{logical}---\n");
                    let fields = notarium_syntax::frontmatter::analyze(&header, DocClass::UserDoc)
                        .unwrap()
                        .fields
                        .unwrap();
                    assert!(fields.contains_key("id"), "{changed}");
                    assert_eq!(
                        fields["type"],
                        notarium_core::value::YamlValue::String("table".into())
                    );
                    assert!(views(&changed, true).plan.edits.is_empty());
                }
            }
        }
    }
}

#[test]
fn unsupported_optional_view_edit_preserves_an_ordinary_raw_save() {
    let source = "```nota\n? type\n: table\n```\n";
    let note = NoteId::from_bytes([8; 16]);
    let analysis = views(source, true);
    assert_eq!(analysis.blocks[0].state, ViewState::Invalid);
    assert!(!analysis.blocks[0].diagnostics.is_empty());
    let plan = extract::finalize_document(source, DocClass::UserDoc, &note, &[]).unwrap();
    assert_eq!(patch::apply(source, &plan).unwrap(), source);
}

#[test]
fn first_fences_preserve_a_leading_bom_without_frontmatter() {
    let note = NoteId::from_bytes([1; 16]);
    for eol in ["\n", "\r\n"] {
        for info in ["text", "nota"] {
            let source = format!("\u{feff}```{info}{eol}type: table{eol}```{eol}");
            assert!(extract::extract(&source, DocClass::UserDoc, &note, "Title", None).is_ok());
            let plan = extract::finalize_document(&source, DocClass::UserDoc, &note, &[]).unwrap();
            let changed = patch::apply(&source, &plan).unwrap();
            assert!(changed.starts_with('\u{feff}'));
            if info == "text" {
                assert_eq!(changed, source);
            } else {
                assert_eq!(plan.edits.len(), 1);
                assert_eq!(changed.replacen(&plan.edits[0].replacement, "", 1), source);
            }
        }
    }
}

#[test]
fn flow_identity_insertion_has_right_affinity_at_each_physical_line_boundary() {
    for (opening, continuation) in [
        ("", ""),
        ("> ", "> "),
        ("- ", "  "),
        ("> - ", ">   "),
        ("> > ", "> > "),
    ] {
        for indent in ["", " ", "  ", "   ", "\t"] {
            for eol in ["\n", "\r\n"] {
                let source = format!(
                    "{opening}```nota{eol}{continuation}{indent}{{type: table, # keep{eol}{continuation}{indent}}}{eol}{continuation}```{eol}"
                );
                let analysis = views(&source, true);
                let changed = patch::apply(&source, &analysis.plan).unwrap();
                let logical = commonmark_fence_text(&changed);
                let carrier = format!("---\n{logical}---\n");
                let fields = notarium_syntax::frontmatter::analyze(&carrier, DocClass::UserDoc)
                    .unwrap()
                    .fields
                    .unwrap();
                assert_eq!(analysis.blocks[0].state, ViewState::Ready, "{source}");
                assert!(fields.contains_key("id"), "{changed}");
                assert_eq!(
                    changed.replacen(&analysis.plan.edits[0].replacement, "", 1),
                    source
                );
                assert!(views(&changed, true).plan.edits.is_empty());
            }
        }
    }
}

#[test]
fn selected_chunks_reach_embedding_and_recall_with_original_provenance() {
    use notarium_core::{auth::*, classes::*, error::ValidationReason, model::*, ports::*};
    use std::{
        collections::BTreeMap,
        future::Future,
        sync::Arc,
        task::{Context, Poll, Waker},
        time::Duration,
    };
    let space = SpaceId::from_bytes([1; 16]);
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([1; 16]),
        BTreeMap::from([(
            space.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        false,
    ));
    let source = format!(
        "---\ntitle: Carrier metadata\n---\n# Heading 🚀\n{}\n",
        "hello world sample ".repeat(200)
    );
    let make_document = |source: &str, class, lifecycle| {
        Arc::new(
            ClassifiedDocument::from_canonical(
                NoteRef {
                    space_id: space.clone(),
                    note_id: NoteId::from_bytes([1; 16]),
                },
                RevisionId::from_bytes([7; 16]),
                ResourceFacts {
                    space: Space {
                        id: space.clone(),
                        lifecycle: SpaceLifecycle::Active,
                        kind: SpaceKind::Personal,
                    },
                    class,
                    ancestor_folders: vec![],
                    folder_write_locked: false,
                    ability_package: None,
                },
                lifecycle,
                source.into(),
                notarium_syntax::content_digest(source),
            )
            .unwrap(),
        )
    };
    let document = make_document(&source, DocClass::UserDoc, Lifecycle::Active);
    let tokenizer = FixtureTokenizer {
        limit: 512,
        model: 1,
    };
    let ExtractedDocDelta::Plain(delta) = extract::extract(
        document.explicit_read(&auth).unwrap(),
        document.class(),
        &document.reference().note_id,
        "Title",
        Some(&tokenizer),
    )
    .unwrap() else {
        panic!()
    };
    let ChunkPlan::Ready { chunks, model } = delta.chunks else {
        panic!()
    };
    assert!(chunks.len() > 1);
    assert!(tokenizer.count(&source).unwrap() > 512);
    let descriptor = chunks[0].clone();
    let part = ContentPart::from_chunk(document.clone(), descriptor.clone()).unwrap();
    let policy = ProviderPolicy {
        provider: ProviderResourceId::from_bytes([1; 16]),
        audience: ProviderAudience::Personal { consented: true },
        allowed_classes: DocClass::all(),
    };
    let selected = ClassEgressFence::provider_part(part.clone(), &auth, &policy).unwrap();
    assert_eq!(selected.text(), descriptor.text);
    assert_eq!(selected.part().spans(), descriptor.spans);
    assert_eq!(selected.part().context(), descriptor.context);
    assert_eq!(selected.provenance().reference(), document.reference());
    assert_eq!(selected.provenance().revision(), document.revision());
    assert_eq!(selected.provenance().digest(), document.digest());
    assert!(!format!("{part:?}").contains("hello world"));
    let request = EmbeddingRequest {
        project: None,
        intent: CommandKey::from_bytes([1; 16]),
        model,
        provider: policy.provider.clone(),
        chunks: vec![selected],
        declared_tokens: descriptor.tokens,
    };
    struct EmbeddingFixture {
        expected: String,
    }
    impl EmbeddingProviderPort for EmbeddingFixture {
        fn embed(
            &self,
            _ctx: SpaceContext,
            request: EmbeddingRequest,
        ) -> PortFuture<'_, EmbeddingResult> {
            Box::pin(async move {
                request.validate()?;
                let tokenizer = FixtureTokenizer {
                    limit: 512,
                    model: 1,
                };
                assert_eq!(request.chunks[0].text(), self.expected);
                assert_eq!(
                    tokenizer.count(request.chunks[0].text())?,
                    request.declared_tokens
                );
                assert!(request.declared_tokens <= 512);
                Ok(EmbeddingResult {
                    model: request.model,
                    dimension: 1,
                    vectors: vec![Ok(vec![1.0])],
                    usage: ProviderUsage::Exact {
                        input_tokens: u64::from(request.declared_tokens),
                        output_tokens: 0,
                    },
                })
            })
        }
    }
    let fixture = EmbeddingFixture {
        expected: descriptor.text.clone(),
    };
    let port: &dyn EmbeddingProviderPort = &fixture;
    let ctx = SpaceContext::new(
        auth.clone(),
        HistoryScope {
            space_id: space.clone(),
            incarnation: HistoryIncarnation::from_bytes([1; 16]),
        },
        CallBudget {
            request: RequestId::from_bytes([1; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(1),
        },
    )
    .unwrap();
    let mut future = port.embed(ctx, request.clone());
    let Poll::Ready(Ok(result)) =
        Future::poll(future.as_mut(), &mut Context::from_waker(Waker::noop()))
    else {
        panic!()
    };
    assert_eq!(
        result.usage,
        ProviderUsage::Exact {
            input_tokens: u64::from(descriptor.tokens),
            output_tokens: 0,
        }
    );
    let hit = SearchHit {
        card: NoteCard {
            document: ClassEgressFence::search_metadata(document.metadata(), &auth).unwrap(),
            title: "Title".into(),
            path: "note.md".into(),
            preview: "sample".into(),
        },
        score: 1.0,
        chunks: vec![ClassEgressFence::search_part(part.clone(), &auth).unwrap()],
    };
    assert_eq!(hit.chunks[0].text(), descriptor.text);
    assert_eq!(hit.chunks[0].provenance().revision(), document.revision());
    assert!(
        ContentPart::from_chunk(
            make_document("foreign source", DocClass::UserDoc, Lifecycle::Active),
            descriptor.clone()
        )
        .is_err()
    );
    let mut forged = descriptor.clone();
    forged.text.push_str("foreign content");
    assert!(ContentPart::from_chunk(document.clone(), forged).is_err());
    let mut forged = descriptor.clone();
    forged.context = vec![ByteSpan::new(0, source.len() + 1).unwrap()];
    assert!(ContentPart::from_chunk(document.clone(), forged).is_err());
    for (class, lifecycle) in [
        (DocClass::EncryptedNote, Lifecycle::Active),
        (DocClass::UserDoc, Lifecycle::Trashed),
    ] {
        let blocked =
            ContentPart::from_chunk(make_document(&source, class, lifecycle), descriptor.clone())
                .unwrap();
        assert!(ClassEgressFence::search_part(blocked.clone(), &auth).is_err());
        assert!(ClassEgressFence::provider_part(blocked, &auth, &policy).is_err());
    }
    assert!(
        ClassEgressFence::provider_part(
            part,
            &auth,
            &ProviderPolicy {
                audience: ProviderAudience::Personal { consented: false },
                ..policy
            }
        )
        .is_err()
    );
    let mut bad = request.clone();
    bad.declared_tokens += 1;
    assert_eq!(
        bad.validate().unwrap_err(),
        notarium_core::DomainError::validation(ValidationReason::TokenBudgetExceeded)
    );
    let mut bad = request.clone();
    bad.model = ModelProfileId::from_bytes([2; 16]);
    assert!(bad.validate().is_err());
    let mut bad = request;
    bad.provider = ProviderResourceId::from_bytes([2; 16]);
    assert!(bad.validate().is_err());
}
