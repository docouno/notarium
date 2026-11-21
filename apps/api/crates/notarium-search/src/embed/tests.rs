use super::*;
use crate::ports::RemoteIndexingGrant;
use notarium_core::{
    DomainError,
    auth::{
        EngineAuthContext, ResourceFacts, Space, SpaceGrant, SpaceKind, SpaceLifecycle, SpaceRole,
        VerifiedHuman,
    },
    classes::{ClassifiedDocument, ContentPart, DocClass, ProviderAudience, ProviderPolicy},
    document::ChunkDescriptor,
    error::ValidationReason,
    ids::{
        ContentDigest, GrantId, HistoryIncarnation, ModelProfileId, NoteId, PrincipalId,
        ProviderResourceId, RequestId, RevisionId, SpaceId,
    },
    model::{FolderRef, HistoryScope, Lifecycle, NoteRef},
    ports::{
        CallBudget, Cancellation, EmbeddingInput, EmbeddingProviderPort, EmbeddingQueryInput,
        EmbeddingRequest, EmbeddingResult, PortFuture, ProviderRuntimeEpochs, ProviderUsage,
        SpaceContext,
    },
    span::ByteSpan,
};
use notarium_syntax::chunk::TokenizerBudget;
use std::{
    collections::{BTreeMap, BTreeSet},
    future::{Future, poll_fn},
    pin::{Pin, pin},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::Poll,
    time::Duration,
};
use tokio::sync::oneshot;

fn profile() -> ModelProfileId {
    ModelProfileId::from_bytes([1; 16])
}

fn budget(remaining: Duration) -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([2; 16]),
        cancellation: Cancellation::default(),
        remaining,
    }
}

#[test]
fn local_wordpiece_bpe_and_remote_counts_match_served_input() {
    let wordpiece = LocalTokenizerBudget::from_json(
        br###"{
        "normalizer":{"type":"BertNormalizer","lowercase":true},
        "pre_tokenizer":{"type":"BertPreTokenizer"},
        "post_processor":{"type":"BertProcessing","cls":["[CLS]",101],"sep":["[SEP]",102]},
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"run":2,"##ning":3,"!":4,"cafe":5},
        "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###,
        profile(),
        512,
    )
    .unwrap();
    assert_eq!(
        wordpiece.encode("Running café!").unwrap().ids,
        [101, 2, 3, 5, 4, 102]
    );
    assert_eq!(wordpiece.count("Running café!").unwrap(), 6);

    let bpe = LocalTokenizerBudget::from_json(
        br#"{
        "pre_tokenizer":{"type":"WhitespaceSplit"},
        "model":{"type":"BPE","unk_token":"?","vocab":{"?":0,"a":1,"b":2,"c":3,"ab":4,"bc":5},
        "merges":[["b","c"],"a b"]}
    }"#,
        profile(),
        512,
    )
    .unwrap();
    assert_eq!(bpe.encode("abc ab").unwrap().ids, [1, 5, 4]);
    // Whitespace-only input without a post-processor produces zero real tokens.
    assert_eq!(bpe.encode("  ").unwrap().ids.len(), 0);
    assert_eq!(bpe.count("  ").unwrap(), 0);

    let remote = RemoteConservativeTokenizerBudget::new(profile(), 1024).unwrap();
    assert_eq!(remote.max_tokens(), 512);
    // "abc" = 12 twelfths, "ё" = 12 twelfths, "🦀" = 24 twelfths -> 48/12 + 8 = 12.
    assert_eq!(remote.count("abcё🦀").unwrap(), 12);
    assert_eq!(remote.split_hint("abcё🦀", 9), Some(3));
}

#[test]
fn unigram_and_metaspace_models_are_rejected() {
    let unigram = r#"{
        "model":{"type":"Unigram","unk_id":0,"vocab":[["<unk>",-3],["a",-1]]}
    }"#;
    assert!(matches!(
        LocalTokenizerBudget::from_json(unigram.as_bytes(), profile(), 512),
        Err(EmbeddingError::InvalidModel)
    ));

    let metaspace = r###"{
        "pre_tokenizer":{"type":"Metaspace","replacement":"▁","prepend_scheme":"always"},
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"a":1},"unk_token":"[UNK]",
        "continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###;
    assert!(matches!(
        LocalTokenizerBudget::from_json(metaspace.as_bytes(), profile(), 512),
        Err(EmbeddingError::InvalidModel)
    ));
}

#[test]
fn pipeline_depth_and_stage_limits_reject_amplification_configs() {
    let stages = vec![r#"{"type":"ByteLevel","add_prefix_space":true}"#; 30].join(",");
    let deep_bytelevel = format!(
        r###"{{"pre_tokenizer":{{"type":"Sequence","pretokenizers":[{stages}]}},
            "model":{{"type":"WordPiece","vocab":{{"[UNK]":0,"a":1}},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}}}"###
    );
    assert!(matches!(
        LocalTokenizerBudget::from_json(deep_bytelevel.as_bytes(), profile(), 512),
        Err(EmbeddingError::InvalidModel)
    ));

    let mut nested = r#"{"type":"Lowercase"}"#.to_owned();
    for _ in 0..17 {
        nested = format!(r#"{{"type":"Sequence","normalizers":[{nested}]}}"#);
    }
    let deep_normalizer = format!(
        r###"{{"normalizer":{nested},
            "model":{{"type":"WordPiece","vocab":{{"[UNK]":0,"a":1}},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}}}"###
    );
    assert!(matches!(
        LocalTokenizerBudget::from_json(deep_normalizer.as_bytes(), profile(), 512),
        Err(EmbeddingError::InvalidModel)
    ));
}

#[test]
fn tokenizer_enforces_64kib_cap_and_early_count_stop() {
    let tokenizer = LocalTokenizerBudget::from_json(
        br###"{
        "pre_tokenizer":{"type":"WhitespaceSplit"},
        "post_processor":{"type":"BertProcessing","cls":["[CLS]",101],"sep":["[SEP]",102]},
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"a":1},
        "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###,
        profile(),
        16,
    )
    .unwrap();
    let oversized = "a ".repeat(33 * 1024);
    assert!(matches!(
        tokenizer.encode(&oversized),
        Err(EmbeddingError::BudgetExceeded)
    ));
    assert!(matches!(
        tokenizer.count(&oversized),
        Err(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::TokenBudgetExceeded
    ));

    let many_tokens = "a ".repeat(2000);
    assert_eq!(tokenizer.count(&many_tokens).unwrap(), 17);

    // Oversized single word rejects before allocating an offset vector and emits [UNK].
    let long_word = "x".repeat(50 * 1024);
    assert_eq!(tokenizer.encode(&long_word).unwrap().ids, [101, 0, 102]);
}

#[test]
fn tokenizer_uses_scalar_case_mapping_and_prepend_boundaries() {
    for normalizer in [
        r#"{"type":"Lowercase"}"#,
        r#"{"type":"BertNormalizer"}"#,
        r#"{"type":"BertNormalizer","lowercase":true}"#,
    ] {
        let input = format!(
            r###"{{"normalizer":{normalizer},
                "model":{{"type":"WordPiece","vocab":{{"[UNK]":0,"οσ":1,"ο":2,"##ς":3}},
                "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}}}}"###
        );
        let tokenizer = LocalTokenizerBudget::from_json(input.as_bytes(), profile(), 512).unwrap();
        assert_eq!(tokenizer.encode("ΟΣ").unwrap().ids, [1]);
        assert_eq!(tokenizer.count("ΟΣ").unwrap(), 1);
    }

    let input = r###"{
        "normalizer":{"type":"Sequence","normalizers":[
            {"type":"Lowercase"},
            {"type":"Prepend","prepend":"_"}
        ]},
        "pre_tokenizer":{"type":"WhitespaceSplit"},
        "added_tokens":[
            {"id":9,"content":"[T]","normalized":false},
            {"id":10,"content":"TAG","normalized":true}
        ],
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"_hi":1,"hi":2,"world":3,"_world":4},
            "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###;
    let tokenizer = LocalTokenizerBudget::from_json(input.as_bytes(), profile(), 512).unwrap();
    // Empty input does not trigger Prepend.
    assert!(tokenizer.encode("").unwrap().ids.is_empty());
    assert_eq!(tokenizer.count("").unwrap(), 0);
    // Prepend runs only at input start, not after an added token.
    assert_eq!(tokenizer.encode("hi[T]world").unwrap().ids, [1, 9, 3]);
    assert_eq!(tokenizer.encode("[T]world").unwrap().ids, [9, 3]);
    // Normalized added tokens are not polluted with start-of-input Prepend.
    assert_eq!(tokenizer.encode("hi TAG").unwrap().ids, [1, 10]);
}

#[test]
fn tokenizer_matches_reference_on_fallback_controls_and_whitespace() {
    let cases = [
        (
            r#"{"model":{"type":"BPE","byte_fallback":true,
            "vocab":{"<0xC3>":1,"<0xA9>":2,"<0xC3><0xA9>":3},
            "merges":[["<0xC3>","<0xA9>"]]}}"#,
            "é",
            &[3][..],
        ),
        (
            r#"{"model":{"type":"BPE","byte_fallback":true,"unk_token":"<unk>",
            "vocab":{"<unk>":0,"<0xC3>":1,"<0xA9>":2,"a":3},
            "merges":[]}}"#,
            "!éa",
            &[0, 1, 2, 3],
        ),
        (
            r#"{"model":{"type":"BPE","byte_fallback":true,"unk_token":"<unk>","fuse_unk":false,
            "vocab":{"<unk>":0,"<0xC3>":1,"<0xA9>":2},
            "merges":[]}}"#,
            "!!é",
            &[0, 0, 1, 2],
        ),
        (
            r#"{"model":{"type":"BPE","byte_fallback":true,"unk_token":"<unk>","fuse_unk":true,
            "vocab":{"<unk>":0,"<0xC3>":1,"<0xA9>":2},
            "merges":[]}}"#,
            "!!é",
            &[0, 1, 2],
        ),
        (
            r###"{"normalizer":{"type":"StripAccents"},
            "model":{"type":"WordPiece","vocab":{"[UNK]":0,"é":1,"e":2,"क":3,"##ा":4,"a":5},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}"###,
            "é",
            &[1],
        ),
        (
            r###"{"normalizer":{"type":"StripAccents"},
            "model":{"type":"WordPiece","vocab":{"[UNK]":0,"क":3,"##ा":4,"a":5},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}"###,
            "का",
            &[3, 4],
        ),
        (
            r###"{"normalizer":{"type":"StripAccents"},
            "model":{"type":"WordPiece","vocab":{"[UNK]":0,"a":5},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}"###,
            "a\u{0301}",
            &[5],
        ),
        (
            r###"{"normalizer":{"type":"BertNormalizer","clean_text":true,"lowercase":false},
            "model":{"type":"WordPiece","vocab":{"[UNK]":0,"cooperate":1},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}"###,
            "co\u{00ad}\u{000c}operate",
            &[1],
        ),
        (
            r#"{"pre_tokenizer":{"type":"ByteLevel","add_prefix_space":false},
            "model":{"type":"BPE","vocab":{"Ġ":1,"'":2,"Ġ'":3,"s":4,"Ġ's":5},
            "merges":[["Ġ","'"],["Ġ'","s"]]}}"#,
            "  's",
            &[1, 3, 4],
        ),
    ];
    for (json, text, expected) in cases {
        let tokenizer = LocalTokenizerBudget::from_json(json.as_bytes(), profile(), 512)
            .unwrap_or_else(|error| panic!("tokenizer for {text:?}: {error:?}"));
        assert_eq!(tokenizer.encode(text).unwrap().ids, expected, "{text:?}");
        assert_eq!(tokenizer.count(text).unwrap() as usize, expected.len());
    }
}

#[test]
fn bpe_fixes_byte_fallback_oov_duplicate_merges_and_space_splits() {
    // Byte fallback encodes only the scalar bytes, not continuing_subword_prefix / end_of_word_suffix.
    let prefixed = LocalTokenizerBudget::from_json(
        br###"{
        "model":{"type":"BPE","byte_fallback":true,"continuing_subword_prefix":"##",
        "end_of_word_suffix":"</w>",
        "vocab":{"a":1,"<0xC3>":2,"<0xA9>":3},
        "merges":[]}
    }"###,
        profile(),
        512,
    )
    .unwrap();
    assert_eq!(prefixed.encode("aé").unwrap().ids, [1, 2, 3]);

    // Missing OOV scalar without unk_token or byte_fallback fails closed instead of dropping chars.
    let strict = LocalTokenizerBudget::from_json(
        br#"{
        "model":{"type":"BPE","vocab":{"a":1,"b":2,"ab":3},"merges":[["a","b"]]}
    }"#,
        profile(),
        512,
    )
    .unwrap();
    assert!(matches!(
        strict.encode("a!b"),
        Err(EmbeddingError::InvalidModel)
    ));

    // Duplicate merge entries keep the earliest rank; text merges resolve tokens containing spaces.
    let merges = LocalTokenizerBudget::from_json(
        br#"{
        "model":{"type":"BPE",
        "vocab":{"a":1,"b":2,"c":3,"ab":4,"bc":5," b":6,"a b":7},
        "merges":[["a","b"],["b","c"],["a","b"],"a  b"]}
    }"#,
        profile(),
        512,
    )
    .unwrap();
    // ("a", "b") keeps rank 0 over ("b", "c") at rank 1.
    assert_eq!(merges.encode("abc").unwrap().ids, [4, 3]);
}

#[test]
fn split_hint_recovers_when_initial_guess_rounds_below_first_multibyte_char() {
    let tokenizer = LocalTokenizerBudget::from_json(
        br#"{
        "model":{"type":"BPE","byte_fallback":true,
        "vocab":{"<0xF0>":1,"<0x9F>":2,"<0xA6>":3,"<0x80>":4},
        "merges":[]}
    }"#,
        profile(),
        32,
    )
    .unwrap();
    // Each 4-byte emoji takes 4 tokens. With budget = 12 (3 emojis = 12 bytes)
    // and full = 33 (early-stopped at max_tokens + 1), probe 0 must still converge.
    let text = "🦀".repeat(40);
    let hint = tokenizer.split_hint(&text, 12).unwrap();
    assert_eq!(hint, 12);
    assert_eq!(tokenizer.count(&text[..hint]).unwrap(), 12);

    // Budget smaller than a single 4-byte char must return None cleanly.
    assert_eq!(tokenizer.split_hint(&text, 2), None);

    // Force probe 0 proportional guess (104 * 3 / 101 = 3) to fall inside the
    // leading 4-byte scalar and round back to 0; binary search must recover
    // the full 6-byte prefix ("🦀é" = 3 tokens) instead of breaking out early.
    let dense = LocalTokenizerBudget::from_json(
        r#"{
        "model":{"type":"BPE","byte_fallback":true,
        "vocab":{"🦀":1,"<0xC3>":2,"<0xA9>":3},
        "merges":[]}
    }"#
        .as_bytes(),
        profile(),
        512,
    )
    .unwrap();
    let mixed = format!("🦀{}", "é".repeat(50));
    assert_eq!(dense.split_hint(&mixed, 3), Some(6));
    assert_eq!(dense.count(&mixed[..6]).unwrap(), 3);
}

#[test]
fn remote_conservative_budget_validates_cap_and_calibrates_unicode_and_code() {
    assert!(matches!(
        RemoteConservativeTokenizerBudget::new(profile(), 0),
        Err(EmbeddingError::InvalidModel)
    ));
    assert!(matches!(
        RemoteConservativeTokenizerBudget::new(profile(), 8),
        Err(EmbeddingError::InvalidModel)
    ));
    let budget = RemoteConservativeTokenizerBudget::new(profile(), 512).unwrap();
    assert_eq!(budget.max_tokens(), 512);
    // Cyrillic: 1.0 token/char + 8 framing.
    assert_eq!(budget.count("Привет").unwrap(), 14);
    // ASCII punctuation/digits: 1.0 token/char + 8 framing.
    assert_eq!(budget.count("{[123]}").unwrap(), 15);
    // English prose: 1/3 token/char + 8 framing.
    assert_eq!(budget.count("hello world ").unwrap(), 12);
    // CJK: 1.5 tokens/char + 8 framing.
    assert_eq!(budget.count("東京").unwrap(), 11);

    let russian = "Привет мир ".repeat(100);
    let hint = budget.split_hint(&russian, 64).unwrap();
    assert!(budget.count(&russian[..hint]).unwrap() <= 64);
    assert!(hint > 40);
}

#[test]
fn tokenizer_preserves_bert_spacing_marks_and_uses_unicode_word_boundaries() {
    let input = r###"{
        "normalizer":{"type":"BertNormalizer","lowercase":true},
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"क":1,"##ा":2,"a":3,"i":4},
        "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###;
    let tokenizer = LocalTokenizerBudget::from_json(input.as_bytes(), profile(), 512).unwrap();
    assert_eq!(tokenizer.encode("का").unwrap().ids, [1, 2]);
    assert_eq!(tokenizer.count("का").unwrap(), 2);
    assert_eq!(tokenizer.encode("á").unwrap().ids, [3]);
    // Lowercase before strip_accents turns Turkish İ (U+0130) into plain 'i'.
    assert_eq!(tokenizer.encode("İ").unwrap().ids, [4]);

    let added = r###"{
        "added_tokens":[{"id":9,"content":"a","single_word":true,"normalized":false}],
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"a":1,"##́":2},
        "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###;
    let tokenizer = LocalTokenizerBudget::from_json(added.as_bytes(), profile(), 512).unwrap();
    assert_eq!(tokenizer.encode("a").unwrap().ids, [9]);
    assert_eq!(tokenizer.encode("a\u{0301}").unwrap().ids, [1, 2]);
    assert_eq!(tokenizer.count("a\u{0301}").unwrap(), 2);
}

#[test]
fn parse_cpu_max_handles_unlimited_fractional_and_invalid_quotas() {
    assert_eq!(onnx::parse_cpu_max("max 100000\n"), None);
    assert_eq!(onnx::parse_cpu_max("400000 100000\n"), Some(4));
    assert_eq!(onnx::parse_cpu_max("250000 100000\n"), Some(3));
    assert_eq!(onnx::parse_cpu_max("50000 100000\n"), Some(1));
    assert_eq!(onnx::parse_cpu_max("100000 0\n"), None);
    assert_eq!(onnx::parse_cpu_max("invalid"), None);
}

#[test]
fn background_quanta_preserve_order_and_enforce_aggregate_caps() {
    let chunks = bounded_batches(0..8, |_| 400, 1024).unwrap();
    assert_eq!(chunks, [vec![0, 1], vec![2, 3], vec![4, 5], vec![6, 7]]);
    let chunks = bounded_batches(0..17, |_| 1, 1024).unwrap();
    assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [16, 1]);
    assert!(matches!(
        bounded_batches([0], |_| 1025, 1024),
        Err(EmbeddingError::BudgetExceeded)
    ));
}

// Polling through to the first await fixes enqueue order in the test.
async fn queued<T>(mut task: Pin<&mut impl Future<Output = T>>) {
    poll_fn(|ctx| {
        assert!(task.as_mut().poll(ctx).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn scheduler_prioritizes_interactive_then_live_edits_and_removes_expired_jobs() {
    let (scheduler, worker) = EmbeddingScheduler::start();
    let (started, running) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let long = || budget(Duration::from_secs(5));
    let first = scheduler.submit(Priority::BulkImportBackfill, long(), |_| async move {
        started.send(()).unwrap();
        released.await.unwrap();
        Ok(vec![])
    });
    let mut first = pin!(first);
    queued(first.as_mut()).await;
    running.await.unwrap();

    let expired = scheduler
        .submit(
            Priority::InteractiveSearchQuery,
            budget(Duration::from_millis(5)),
            |_| async { panic!("expired queued work must not reach the executor") },
        )
        .await;
    assert!(matches!(expired, Err(EmbeddingError::BudgetExceeded)));

    let events = Arc::new(Mutex::new(Vec::new()));
    let execute = |id| {
        let events = events.clone();
        move |_| async move {
            events.lock().unwrap().push(id);
            Ok(vec![])
        }
    };
    let mut bulk = pin!(scheduler.submit(Priority::BulkImportBackfill, long(), execute(3)));
    let mut live = pin!(scheduler.submit(Priority::LiveNoteEdit, long(), execute(2)));
    let mut query = pin!(scheduler.submit(Priority::InteractiveSearchQuery, long(), execute(1)));
    queued(bulk.as_mut()).await;
    queued(live.as_mut()).await;
    queued(query.as_mut()).await;
    release.send(()).unwrap();
    for outcome in [first.await, query.await, live.await, bulk.await] {
        outcome.unwrap();
    }
    assert_eq!(*events.lock().unwrap(), [1, 2, 3]);
    scheduler.shutdown();
    worker.await.unwrap();
}

#[tokio::test]
async fn scheduler_survives_job_panics_and_continues_serving() {
    let (scheduler, worker) = EmbeddingScheduler::start();
    let panicked = scheduler
        .submit(
            Priority::LiveNoteEdit,
            budget(Duration::from_secs(5)),
            |_| async move {
                panic!("simulated worker panic");
            },
        )
        .await;
    assert!(matches!(panicked, Err(EmbeddingError::ModelUnavailable)));

    let recovered = scheduler
        .submit(
            Priority::InteractiveSearchQuery,
            budget(Duration::from_secs(5)),
            |_| async { Ok(vec![Some(vec![1.0])]) },
        )
        .await
        .unwrap();
    assert_eq!(recovered, [Some(vec![1.0])]);

    scheduler.shutdown();
    worker.await.unwrap();
}

#[tokio::test]
async fn scheduler_signals_running_work_when_query_times_out_or_is_dropped() {
    let (scheduler, worker) = EmbeddingScheduler::start();
    let (timed_out, stopped) = oneshot::channel();
    let result = scheduler
        .submit(
            Priority::InteractiveSearchQuery,
            budget(Duration::from_secs(5)),
            |budget| async move {
                assert!(budget.remaining <= Duration::from_millis(150));
                budget.cancellation.cancelled().await;
                timed_out.send(()).unwrap();
                Err(EmbeddingError::Cancelled)
            },
        )
        .await;
    assert!(matches!(result, Err(EmbeddingError::BudgetExceeded)));
    stopped.await.unwrap();

    let (started, running) = oneshot::channel();
    let (dropped, stopped) = oneshot::channel();
    {
        let mut abandoned = pin!(scheduler.submit(
            Priority::LiveNoteEdit,
            budget(Duration::from_secs(5)),
            |budget| async move {
                started.send(()).unwrap();
                budget.cancellation.cancelled().await;
                dropped.send(()).unwrap();
                Err(EmbeddingError::Cancelled)
            }
        ));
        queued(abandoned.as_mut()).await;
        running.await.unwrap();
    }
    stopped.await.unwrap();
    scheduler.shutdown();
    worker.await.unwrap();
}

#[tokio::test]
async fn remote_queries_are_typed_and_tainted_or_oversize_input_never_dispatches() {
    #[derive(Default)]
    struct Provider {
        calls: Mutex<Vec<EmbeddingRequest>>,
        invalid_row: AtomicBool,
    }
    impl EmbeddingProviderPort for Provider {
        fn query_disclosure(
            &self,
            _: SpaceContext,
            _: ProviderResourceId,
            _: ModelProfileId,
            _: Option<FolderRef>,
        ) -> PortFuture<'_, BTreeSet<DocClass>> {
            Box::pin(async { Ok(BTreeSet::from([DocClass::UserDoc])) })
        }

        fn embed(
            &self,
            _: SpaceContext,
            request: EmbeddingRequest,
        ) -> PortFuture<'_, EmbeddingResult> {
            Box::pin(async move {
                let model = request.model.clone();
                self.calls.lock().unwrap().push(request);
                let vector = if self.invalid_row.load(Ordering::SeqCst) {
                    Err(DomainError::AccessDenied)
                } else {
                    Ok(vec![2.0; 64])
                };
                Ok(EmbeddingResult {
                    model,
                    dimension: 64,
                    vectors: vec![vector],
                    usage: ProviderUsage::Unknown,
                })
            })
        }
    }
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([5; 16]),
        incarnation: HistoryIncarnation::from_bytes([6; 16]),
    };
    let classes = [DocClass::UserDoc].into_iter().collect();
    let grant = SpaceGrant {
        role: SpaceRole::Viewer,
        read_classes: classes,
        write_classes: Default::default(),
        project_root: None,
    };
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([7; 16]),
        GrantId::from_bytes([8; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        false,
    ));
    let ctx = SpaceContext::new(auth, scope, budget(Duration::from_secs(5))).unwrap();
    let provider = Arc::new(Provider::default());
    let remote = RemoteEmbedder::new(
        provider.clone(),
        profile(),
        ProviderResourceId::from_bytes([9; 16]),
        64,
        16,
        ProviderRuntimeEpochs {
            resource: std::num::NonZeroU64::MIN,
            credential: None,
        },
    );
    let input = EmbeddingQueryInput {
        text: "literal query".to_owned(),
        tokens: 12,
        classes: BTreeSet::from([DocClass::UserDoc, DocClass::Profile]),
        project_scope: None,
    };
    let mut oversized = input.clone();
    oversized.tokens = 17;
    assert!(matches!(
        remote.query(ctx.clone(), oversized).await,
        Err(EmbeddingError::BudgetExceeded)
    ));
    let result = remote.query(ctx.clone(), input.clone()).await.unwrap();
    assert_eq!(result, [Some(vec![0.125; 64])]);
    let mut excluded = input.clone();
    excluded.classes.remove(&DocClass::UserDoc);
    assert!(matches!(
        remote.query(ctx.clone(), excluded).await,
        Err(EmbeddingError::ProviderUnavailable)
    ));
    provider.invalid_row.store(true, Ordering::SeqCst);
    assert!(matches!(
        remote.query(ctx.clone(), input.clone()).await,
        Err(EmbeddingError::ProviderUnavailable)
    ));
    ctx.auth().taint().mark_external_read();
    assert!(matches!(
        remote.query(ctx, input).await,
        Err(EmbeddingError::ProviderUnavailable)
    ));
    let calls = provider.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(
        matches!(&calls[0].inputs[..], [EmbeddingInput::Query(input)] if input.classes == BTreeSet::from([DocClass::UserDoc]))
    );
}

#[tokio::test]
async fn remote_parts_distinguish_permanent_denial_from_transient_provider_errors() {
    struct StubProvider {
        error: Mutex<Option<DomainError>>,
        row_error: Mutex<Option<DomainError>>,
        calls: Mutex<usize>,
    }
    impl EmbeddingProviderPort for StubProvider {
        fn embed(
            &self,
            _: SpaceContext,
            request: EmbeddingRequest,
        ) -> PortFuture<'_, EmbeddingResult> {
            Box::pin(async move {
                *self.calls.lock().unwrap() += 1;
                if let Some(error) = self.error.lock().unwrap().clone() {
                    return Err(error.into());
                }
                let row = self
                    .row_error
                    .lock()
                    .unwrap()
                    .clone()
                    .map_or_else(|| Ok(vec![1.0; 64]), Err);
                Ok(EmbeddingResult {
                    model: request.model,
                    dimension: 64,
                    vectors: vec![row],
                    usage: ProviderUsage::Unknown,
                })
            })
        }
    }

    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([5; 16]),
        incarnation: HistoryIncarnation::from_bytes([6; 16]),
    };
    let space = Space {
        id: scope.space_id.clone(),
        lifecycle: SpaceLifecycle::Active,
        kind: SpaceKind::Personal,
    };
    let grant = SpaceGrant {
        role: SpaceRole::Viewer,
        read_classes: BTreeSet::from([DocClass::UserDoc, DocClass::Profile]),
        write_classes: Default::default(),
        project_root: None,
    };
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([7; 16]),
        GrantId::from_bytes([8; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        false,
    ));
    let ctx = SpaceContext::new(auth, scope.clone(), budget(Duration::from_secs(5))).unwrap();
    let provider_id = ProviderResourceId::from_bytes([9; 16]);
    let stub = Arc::new(StubProvider {
        error: Mutex::new(Some(DomainError::validation(
            ValidationReason::TokenBudgetExceeded,
        ))),
        row_error: Mutex::new(None),
        calls: Mutex::new(0),
    });
    let remote = RemoteEmbedder::new(
        stub.clone(),
        profile(),
        provider_id.clone(),
        64,
        64,
        ProviderRuntimeEpochs {
            resource: std::num::NonZeroU64::MIN,
            credential: None,
        },
    );

    let make_part = |class: DocClass| {
        let text = "note body".to_owned();
        let digest = ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes());
        let doc = Arc::new(
            ClassifiedDocument::from_canonical(
                NoteRef {
                    space_id: scope.space_id.clone(),
                    note_id: NoteId::from_bytes([11; 16]),
                },
                RevisionId::from_bytes([12; 16]),
                ResourceFacts {
                    space: space.clone(),
                    class,
                    ancestor_folders: vec![],
                    folder_write_locked: false,
                    ability_package: None,
                },
                Lifecycle::Active,
                text.clone(),
                digest,
            )
            .unwrap(),
        );
        ContentPart::from_chunk(
            doc,
            ChunkDescriptor {
                source: digest,
                model: profile(),
                context: vec![],
                spans: vec![ByteSpan::new(0, text.len()).unwrap()],
                text,
                tokens: 10,
                key: digest,
            },
        )
        .unwrap()
    };

    let indexing_grant = RemoteIndexingGrant {
        ctx: ctx.clone(),
        policy: ProviderPolicy {
            provider: provider_id,
            audience: ProviderAudience::Personal { consented: true },
            allowed_classes: BTreeSet::from([DocClass::UserDoc]),
        },
    };

    // Class rejected by local egress fence returns IndexingDenied without calling provider.
    let denied = remote
        .parts(
            indexing_grant.clone(),
            None,
            vec![make_part(DocClass::Profile)],
        )
        .await
        .unwrap_err();
    assert!(matches!(denied, EmbeddingError::IndexingDenied));
    assert!(denied.is_permanent_note_rejection());
    assert_eq!(*stub.calls.lock().unwrap(), 0);

    // Upstream TokenBudgetExceeded on a chunk is a permanent input rejection.
    let permanent = remote
        .parts(
            indexing_grant.clone(),
            None,
            vec![make_part(DocClass::UserDoc)],
        )
        .await
        .unwrap_err();
    assert!(matches!(permanent, EmbeddingError::PermanentInputRejected));
    assert!(permanent.is_permanent_note_rejection());
    assert_eq!(*stub.calls.lock().unwrap(), 1);

    // Per-row TokenBudgetExceeded without any valid or transient row is also permanent.
    *stub.error.lock().unwrap() = None;
    *stub.row_error.lock().unwrap() = Some(DomainError::validation(
        ValidationReason::TokenBudgetExceeded,
    ));
    let row_permanent = remote
        .parts(
            indexing_grant.clone(),
            None,
            vec![make_part(DocClass::UserDoc)],
        )
        .await
        .unwrap_err();
    assert!(matches!(
        row_permanent,
        EmbeddingError::PermanentInputRejected
    ));
    assert!(row_permanent.is_permanent_note_rejection());

    // AccessDenied stays a non-permanent provider error for retry/backoff compatibility.
    *stub.row_error.lock().unwrap() = None;
    *stub.error.lock().unwrap() = Some(DomainError::AccessDenied);
    let transient = remote
        .parts(indexing_grant, None, vec![make_part(DocClass::UserDoc)])
        .await
        .unwrap_err();
    assert!(matches!(transient, EmbeddingError::ProviderUnavailable));
    assert!(!transient.is_permanent_note_rejection());
}
