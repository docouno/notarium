use super::*;
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman},
    classes::DocClass,
    ids::{
        GrantId, HistoryIncarnation, ModelProfileId, PrincipalId, ProviderResourceId, RequestId,
        SpaceId,
    },
    model::{FolderRef, HistoryScope},
    ports::{
        CallBudget, Cancellation, EmbeddingInput, EmbeddingProviderPort, EmbeddingQueryInput,
        EmbeddingRequest, EmbeddingResult, PortFuture, ProviderRuntimeEpochs, ProviderUsage,
        SpaceContext,
    },
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
fn local_wordpiece_bpe_unigram_and_remote_counts_match_served_input() {
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
    assert_eq!(bpe.count("  ").unwrap(), 1);

    let unigram = LocalTokenizerBudget::from_json(r#"{
        "pre_tokenizer":{"type":"Metaspace","replacement":"▁","prepend_scheme":"always"},
        "model":{"type":"Unigram","unk_id":0,"vocab":[["<unk>",-3],["▁",-1],["кот",-1],["▁кот",-0.5],["dog",-1]]}
    }"#.as_bytes(), profile(), 512).unwrap();
    assert_eq!(unigram.encode("кот dog").unwrap().ids, [3, 1, 4]);
    assert_eq!(unigram.count("кот dog").unwrap(), 3);

    let remote = RemoteConservativeTokenizerBudget::new(profile(), 1024);
    assert_eq!(remote.max_tokens(), 512);
    assert_eq!(remote.count("abcё🦀").unwrap(), 11);
    assert_eq!(remote.split_hint("abcё🦀", 9), Some(3));
}

#[test]
fn tokenizer_uses_scalar_case_mapping_and_original_metaspace_start() {
    for normalizer in [
        r#"{"type":"Lowercase"}"#,
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
        "normalizer":{"type":"Lowercase"},
        "pre_tokenizer":{"type":"Sequence","pretokenizers":[
            {"type":"WhitespaceSplit"},
            {"type":"Metaspace","replacement":"▁","prepend_scheme":"first"}
        ]},
        "added_tokens":[
            {"id":9,"content":"[T]","normalized":false},
            {"id":10,"content":"TAG","normalized":true}
        ],
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"▁hi":1,"hi":2,"world":3,"▁world":4},
            "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###;
    let tokenizer = LocalTokenizerBudget::from_json(input.as_bytes(), profile(), 512).unwrap();
    assert_eq!(tokenizer.encode("hi[T]world").unwrap().ids, [1, 9, 3]);
    assert_eq!(tokenizer.encode("[T]world").unwrap().ids, [9, 3]);
    assert_eq!(tokenizer.encode(" hi").unwrap().ids, [2]);
    assert_eq!(tokenizer.encode("TAG").unwrap().ids, [10]);
    assert_eq!(tokenizer.count("hi[T]world").unwrap(), 3);
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
            r#"{"model":{"type":"Unigram","byte_fallback":true,"unk_id":0,
            "vocab":[["<unk>",0],["<0xC3>",-1],["<0xA9>",-1]]}}"#,
            "é🙂",
            &[0],
        ),
        (
            r###"{"normalizer":{"type":"StripAccents"},
            "model":{"type":"WordPiece","vocab":{"[UNK]":0,"é":1,"e":2},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}"###,
            "é",
            &[1],
        ),
        (
            r###"{"normalizer":{"type":"BertNormalizer","clean_text":true},
            "model":{"type":"WordPiece","vocab":{"[UNK]":0,"cooperate":1},"unk_token":"[UNK]",
            "continuing_subword_prefix":"##","max_input_chars_per_word":100}}"###,
            "co\u{00ad}operate",
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
fn tokenizer_preserves_bert_spacing_marks_and_uses_unicode_word_boundaries() {
    let input = r###"{
        "normalizer":{"type":"BertNormalizer","lowercase":true},
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"क":1,"##ा":2,"a":3},
        "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###;
    let tokenizer = LocalTokenizerBudget::from_json(input.as_bytes(), profile(), 512).unwrap();
    assert_eq!(tokenizer.encode("का").unwrap().ids, [1, 2]);
    assert_eq!(tokenizer.count("का").unwrap(), 2);
    assert_eq!(tokenizer.encode("á").unwrap().ids, [3]);

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
                    Err(notarium_core::DomainError::AccessDenied)
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
